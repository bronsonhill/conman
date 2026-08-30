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

export const DEFAULT_CONFIG: Config = {
  budget: {
    total: 12000,
    perFile: 4000,
    skillIndex: 2000,
  },
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

/** Shallow-ish merge: known nested objects merge key by key, scalars overwrite. */
function mergeConfig(base: Config, over: Record<string, unknown>): Config {
  const out: Config = {
    budget: { ...base.budget },
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
    const parsed = JSON5.parse(raw) as Record<string, unknown>;
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
      const parsed = JSON5.parse(readFileSync(candidate, "utf8")) as Record<
        string,
        unknown
      >;
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
