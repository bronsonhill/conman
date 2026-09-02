// Config loading and defaults.
//
// conman.json lives at the repo root. Absent -> the built-in defaults below.
// Values are conservative starting points, not published hard limits; see
// MODEL.md for provenance. Projects override per repo.

import { readFileSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import JSON5 from "json5";
import type { FindingType, Severity } from "./types.js";

export interface Config {
  budget: {
    total: number;
    perFile: number;
    skillIndex: number;
  };
  /**
   * Count cap on how many skills one entry point's startup index lists. A
   * performance signal (does the agent still pick the right skill?), distinct
   * from `budget.skillIndex`, which caps the token cost of the same listing.
   * See MODEL.md "Default budget numbers".
   */
  maxSkills: number;
  safetyMargin: number;
  gate: Record<FindingType | "over-budget", Severity>;
  resolve: {
    repoBoundary: boolean;
    importDepthLimit: number;
    /** null -> fall back to settings.json, then to no limit. */
    skillListingBudget: number | null;
  };
  ignore: string[];
}

// The four budget defaults below (budget.total / perFile / skillIndex and
// maxSkills) are calibrated in MODEL.md's "Default budget numbers, and why"
// section and pinned to MODEL_VERSION (src/types.ts): re-review these literals
// against that section on every MODEL_VERSION bump. src/modelDoc.test.ts guards
// the anchor prose; the calibration itself is a manual re-check.
export const DEFAULT_CONFIG: Config = {
  budget: {
    total: 12000,
    perFile: 4000,
    skillIndex: 1000,
  },
  maxSkills: 8,
  safetyMargin: 0.1,
  gate: {
    "over-budget": "error",
    duplication: "error",
    "unlinked-copy": "warn",
    "value-conflict": "error",
    "vehicle-fit": "warn",
    // Acts as a severity ceiling for the frontmatter finding, which assigns
    // "error" or "warn" per sub-case (see src/findings/frontmatter.ts):
    // "error" lets both through, "warn" caps every sub-case at warn, "off"
    // disables the check.
    frontmatter: "error",
    "lint-duplication": "warn",
    "stale-boilerplate": "warn",
    // Ceiling for the dead-reference finding, which assigns per sub-case:
    // "error" for a dead `@`-import (silently dropped from the resolved stack),
    // "warn" for a dead prose path or script name. "warn" caps the import case
    // at warn; "off" disables the check.
    "dead-reference": "error",
    // Ceiling for the max-skills finding, which assigns per sub-case: "warn" for
    // 9-15 skills in one startup index, "error" for >15. "warn" caps the >15
    // case at warn; "off" disables the check. See src/findings/maxSkills.ts.
    "max-skills": "error",
    // Budget caps enforced as findings (src/findings/budgetCaps.ts). "warn" by
    // default: they flag outliers, they do not fail `conman check` on their own.
    // Raise to "error" per repo to make either a gate failure; "off" disables.
    "per-file-budget": "warn",
    "skill-index-budget": "warn",
  },
  resolve: {
    repoBoundary: true,
    importDepthLimit: 5,
    skillListingBudget: null,
  },
  ignore: ["**/node_modules/**", "**/.git/**"],
};

export interface LoadedConfig {
  config: Config;
  /** Repo-relative path the config was read from, or null for defaults. */
  source: string | null;
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * Shallow-ish merge: known nested objects merge key by key, scalars overwrite.
 * Exported for unit tests; `loadConfig` is the normal entry point.
 */
export function mergeConfig(base: Config, over: Record<string, unknown>): Config {
  const out: Config = {
    budget: { ...base.budget },
    maxSkills: base.maxSkills,
    safetyMargin: base.safetyMargin,
    gate: { ...base.gate },
    resolve: { ...base.resolve },
    ignore: [...base.ignore],
  };
  if (isObject(over.budget)) {
    for (const k of ["total", "perFile", "skillIndex"] as const) {
      const v = over.budget[k];
      if (typeof v === "number" && Number.isFinite(v)) out.budget[k] = v;
    }
  }
  if (
    typeof over.maxSkills === "number" &&
    Number.isInteger(over.maxSkills) &&
    over.maxSkills >= 0
  ) {
    out.maxSkills = over.maxSkills;
  }
  if (typeof over.safetyMargin === "number" && Number.isFinite(over.safetyMargin)) {
    out.safetyMargin = Math.max(0, Math.min(0.9, over.safetyMargin));
  }
  if (isObject(over.gate)) {
    for (const [k, v] of Object.entries(over.gate)) {
      if ((v === "error" || v === "warn" || v === "off") && k in out.gate) {
        out.gate[k as keyof Config["gate"]] = v;
      }
    }
  }
  if (isObject(over.resolve)) {
    if (typeof over.resolve.repoBoundary === "boolean") {
      out.resolve.repoBoundary = over.resolve.repoBoundary;
    }
    if (
      typeof over.resolve.importDepthLimit === "number" &&
      Number.isInteger(over.resolve.importDepthLimit) &&
      over.resolve.importDepthLimit >= 0
    ) {
      out.resolve.importDepthLimit = over.resolve.importDepthLimit;
    }
    const slb = over.resolve.skillListingBudget;
    if (slb === null || (typeof slb === "number" && Number.isFinite(slb))) {
      out.resolve.skillListingBudget = slb;
    }
  }
  if (Array.isArray(over.ignore) && over.ignore.every((x) => typeof x === "string")) {
    out.ignore = over.ignore as string[];
  }
  return out;
}

/**
 * Parse a conman.json body as JSON5, turning a syntax error into a message that
 * names the file and quotes the parser's own complaint. Also rejects a top-level
 * value that is not an object (a bare array, string, or number).
 */
function parseConfigText(raw: string, relLabel: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON5.parse(raw);
  } catch (err) {
    const msg = (err as Error)?.message ?? String(err);
    throw new Error(`${relLabel} is not valid JSON5: ${msg}`);
  }
  if (!isObject(parsed)) {
    throw new Error(
      `${relLabel} must contain a JSON object at the top level, got ${
        Array.isArray(parsed) ? "an array" : typeof parsed
      }`,
    );
  }
  return parsed;
}

/**
 * Walk up from `startDir` to `repoRoot` looking for conman.json. The first hit
 * wins. `explicitPath`, when given, is used directly.
 */
export function loadConfig(
  startDir: string,
  repoRoot: string,
  explicitPath?: string,
): LoadedConfig {
  if (explicitPath) {
    const abs = resolve(explicitPath);
    const raw = readFileSync(abs, "utf8");
    const parsed = parseConfigText(raw, relPosix(repoRoot, abs));
    return {
      config: mergeConfig(DEFAULT_CONFIG, parsed),
      source: relPosix(repoRoot, abs),
    };
  }
  let dir = resolve(startDir);
  const stopAt = resolve(repoRoot);
  for (;;) {
    const candidate = join(dir, "conman.json");
    if (existsSync(candidate)) {
      const parsed = parseConfigText(
        readFileSync(candidate, "utf8"),
        relPosix(repoRoot, candidate),
      );
      return {
        config: mergeConfig(DEFAULT_CONFIG, parsed),
        source: relPosix(repoRoot, candidate),
      };
    }
    if (dir === stopAt) break;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return { config: DEFAULT_CONFIG, source: null };
}

function relPosix(from: string, to: string): string {
  const rel = resolve(to).slice(resolve(from).length).replace(/^[/\\]/, "");
  return rel.split(/[/\\]/).join("/") || ".";
}
