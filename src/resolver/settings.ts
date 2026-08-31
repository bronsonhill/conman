// Repo-root settings resolution: layering `~/.claude` (opt-in) and the two
// `.claude/*.json` files into one merged settings object, and pulling the
// handful of keys the resolver cares about (`claudeMdExcludes`,
// `skillListingBudget`) out of it.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { isFile } from "../repo.js";

export interface Settings {
  claudeMdExcludes: string[];
  skillListingBudget: number | null;
  raw: Record<string, unknown>;
}

/**
 * Repo-root settings sources, lowest precedence first. Claude Code layers
 * `~/.claude/settings.json` (user) < `.claude/settings.json` (project) <
 * `.claude/settings.local.json` (local) < managed/policy. The user file is
 * opt-in (`--user`): when `loadSettings` is given a `userConfigDir` it merges
 * `<dir>/settings.json` in first, below every repo-root file.
 */
const SETTINGS_SOURCES = ["settings.json", "settings.local.json"] as const;

/** Stable labels emitted for user-level files so output stays machine-independent. */
export const USER_MEMORY_LABEL = "~/.claude/CLAUDE.md";
export const USER_SKILLS_LABEL = "~/.claude/skills";
export const USER_RULES_LABEL = "~/.claude/rules";

/**
 * Deep-merge two settings objects the way Claude Code's `i5` customizer does:
 * arrays are concatenated then de-duplicated (by JSON identity), plain objects
 * merge key-by-key, everything else takes the override when it is present.
 * Evidence: `claude 2.1.251`, merge customizer
 * `function i5(e,t,r){ ... if(Array.isArray(e)&&Array.isArray(t)){ ... return te([...e,...t]) } ... }`
 * where `te` de-dupes. `claudeMdExcludes` is a plain string array, so a
 * `settings.local.json` entry *adds to* the project list rather than replacing it.
 */
function mergeSettingsValue(base: unknown, override: unknown): unknown {
  if (Array.isArray(base) && Array.isArray(override)) {
    const seen = new Set<string>();
    const out: unknown[] = [];
    for (const item of [...base, ...override]) {
      const key = JSON.stringify(item) ?? String(item);
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(item);
    }
    return out;
  }
  if (isPlainObject(base) && isPlainObject(override)) {
    const out: Record<string, unknown> = { ...base };
    for (const [k, v] of Object.entries(override)) {
      out[k] = k in out ? mergeSettingsValue(out[k], v) : v;
    }
    return out;
  }
  return override === undefined ? base : override;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

export function loadSettings(repoRoot: string, userConfigDir?: string): Settings {
  let merged: Record<string, unknown> = {};
  const paths: string[] = [];
  if (userConfigDir) paths.push(join(userConfigDir, "settings.json"));
  for (const name of SETTINGS_SOURCES) paths.push(join(repoRoot, ".claude", name));
  for (const p of paths) {
    if (!isFile(p)) continue;
    try {
      const parsed = JSON.parse(readFileSync(p, "utf8"));
      if (isPlainObject(parsed)) {
        merged = mergeSettingsValue(merged, parsed) as Record<string, unknown>;
      }
    } catch {
      // ignore malformed settings; resolution proceeds without them
    }
  }
  const excludes =
    pickStringArray(merged, "claudeMdExcludes") ??
    pickStringArray(merged, "claudeMd.excludes") ??
    [];
  const budget =
    pickNumber(merged, "skillListingBudget") ??
    pickNumber(merged, "skillsListingBudget") ??
    pickNumber(merged, "skills.listingBudget") ??
    null;
  return { claudeMdExcludes: excludes, skillListingBudget: budget, raw: merged };
}

function pickStringArray(obj: Record<string, unknown>, key: string): string[] | undefined {
  const v = deepGet(obj, key);
  if (Array.isArray(v) && v.every((x) => typeof x === "string")) return v as string[];
  return undefined;
}
function pickNumber(obj: Record<string, unknown>, key: string): number | undefined {
  const v = deepGet(obj, key);
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}
function deepGet(obj: Record<string, unknown>, dotted: string): unknown {
  let cur: unknown = obj;
  for (const part of dotted.split(".")) {
    if (cur && typeof cur === "object" && part in (cur as Record<string, unknown>)) {
      cur = (cur as Record<string, unknown>)[part];
    } else {
      return undefined;
    }
  }
  return cur;
}
