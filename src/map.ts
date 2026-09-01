// `conman map`: discover every entry point in the repo and run the analysis
// across all of them, so a monorepo can be taken in one pass.
//
// A directory is an entry point when either:
//   - it contains a CLAUDE.md or an AGENTS.md (or it is the repo root), or
//   - a `.claude/rules/` file path-scopes to it via `paths` — the directory a
//     glob like `src/renderer/**` points at, even with no memory file of its
//     own. This is the shape `conman map` on Motrix used to miss: `src/main`
//     and `src/renderer` exist only as `paths: [src/**]`-style rule targets.
//
// Discovery is a deterministic depth-first walk with sorted directory listings;
// `.git`, `node_modules`, `dist`, `.treehouse`, and config `ignore` globs are
// skipped. The glob-to-directory rule is documented in MODEL.md.

import { readFileSync, readdirSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import type { Analysis } from "./types.js";
import type { Agent } from "./agent.js";
import type { Config } from "./config.js";
import { analyzeEntry } from "./analyze.js";
import { parseFrontmatter } from "./frontmatter.js";
import { expandBraces, isDir, isFile, matchesAnyGlob, relPosix } from "./repo.js";
import { getTokenizer } from "./tokenizer.js";
import { MEMORY_NAMES, RULE_SCOPE_KEY, toStringArray } from "./claudeContext.js";

const ALWAYS_SKIP = new Set([".git", "node_modules", "dist", ".treehouse"]);

/**
 * A path segment containing any of these ends the literal prefix of a glob.
 * Brace lists are expanded before this runs (`src/{a,b}/**` is split into
 * `src/a/**` and `src/b/**` first), so `{` `}` `,` only appear here as a
 * defensive terminator for a stray unbalanced brace.
 */
const GLOB_META = /[*?[\]{},]/;

export type DiscoverySource = "root" | "memory-file" | "rule-path";

export interface DiscoveredEntry {
  /** Repo-relative POSIX path; "." for the repo root. */
  path: string;
  /** Absolute filesystem path. */
  abs: string;
  /** Why this directory is an entry point. Sorted, deduped, never empty. */
  discovery: DiscoverySource[];
}

/**
 * Reduce a rule `paths` glob to the repo-relative directory it scopes: the
 * longest leading run of path segments that carry no glob metacharacter
 * (`* ? [ ]`). Brace lists are expanded by the caller before this runs.
 * `src/renderer/**` scopes `src/renderer`; `src/**` scopes
 * `src`; `app/api/**` scopes `app/api`; a wildcard mid-path (`src` then `**`
 * then a filename glob) still scopes `src`. If the run names a file rather than
 * a directory, trailing segments are dropped until an existing directory
 * remains. Returns null when the leading literal run is empty (a bare `**`, or
 * any wildcard-first pattern) or resolves to the repo root, or when no existing
 * directory is left — a keyless or `**`-scoped rule adds no entry point, and
 * conman never invents a path that is not on disk. See MODEL.md.
 */
export function globToEntryDir(repoRoot: string, glob: string): string | null {
  const cleaned = glob.trim().replace(/^\.?\//, "").replace(/\/+$/, "");
  if (!cleaned) return null;
  const kept: string[] = [];
  for (const seg of cleaned.split("/")) {
    if (seg === "" || GLOB_META.test(seg)) break;
    kept.push(seg);
  }
  while (kept.length > 0) {
    const rel = kept.join("/");
    if (isDir(join(repoRoot, rel))) return rel;
    kept.pop();
  }
  return null;
}

export function discoverEntryPoints(
  repoRoot: string,
  config: Config,
  agent: Agent = "claude",
): DiscoveredEntry[] {
  const root = resolve(repoRoot);
  // Claude Code special-cases CLAUDE.md; every other agent keys off AGENTS.md.
  const memoryNames = agent === "claude" ? MEMORY_NAMES : ["AGENTS.md"];
  // Which rule directory path-scopes entry points, and on which frontmatter key.
  // Codex and Copilot have no path-scoped rule mechanism conman models.
  const ruleSpec =
    agent === "claude"
      ? { dotDir: ".claude", ext: ".md", key: "paths" }
      : agent === "cursor"
        ? { dotDir: ".cursor", ext: ".mdc", key: "globs" }
        : null;
  // Keyed by repo-relative POSIX path so entries dedupe regardless of how the
  // directory was reached.
  const reasons = new Map<string, Set<DiscoverySource>>();
  const note = (absDir: string, why: DiscoverySource) => {
    const rel = relPosix(root, absDir);
    let set = reasons.get(rel);
    if (!set) {
      set = new Set<DiscoverySource>();
      reasons.set(rel, set);
    }
    set.add(why);
  };
  note(root, "root");

  const ruleDirs: string[] = [];
  const walk = (dir: string) => {
    let entries: string[];
    try {
      entries = readdirSync(dir).sort();
    } catch {
      return;
    }
    for (const name of memoryNames) {
      if (isFile(join(dir, name))) note(dir, "memory-file");
    }
    if (
      ruleSpec &&
      basename(dir) === "rules" &&
      basename(dirname(dir)) === ruleSpec.dotDir
    ) {
      ruleDirs.push(dir);
    }
    for (const e of entries) {
      if (ALWAYS_SKIP.has(e)) continue;
      const abs = join(dir, e);
      if (!isDir(abs)) continue;
      const rel = relPosix(root, abs);
      if (matchesAnyGlob(rel, config.ignore)) continue;
      walk(abs);
    }
  };
  walk(root);

  for (const rdir of ruleSpec ? ruleDirs.sort() : []) {
    let files: string[];
    try {
      files = readdirSync(rdir)
        .filter((f) => f.endsWith(ruleSpec!.ext))
        .sort();
    } catch {
      continue;
    }
    for (const f of files) {
      const abs = join(rdir, f);
      if (!isFile(abs)) continue;
      let patterns: string[];
      try {
        const fm = parseFrontmatter(readFileSync(abs, "utf8"));
        patterns = toStringArray(fm.data[ruleSpec!.key]);
      } catch {
        continue;
      }
      for (const rawPat of patterns) {
        // Claude Code expands `{a,b}` brace lists into separate patterns; each
        // alternative can scope its own entry-point directory.
        for (const pat of expandBraces(rawPat)) {
          if (pat === "**") continue; // scopes to everything: no scope at all
          const rel = globToEntryDir(root, pat);
          if (!rel || rel === ".") continue;
          note(resolve(root, rel), "rule-path");
        }
      }
    }
  }

  const out: DiscoveredEntry[] = [];
  for (const [rel, why] of reasons) {
    out.push({
      path: rel,
      abs: rel === "." ? root : resolve(root, rel),
      discovery: [...why].sort(),
    });
  }
  out.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return out;
}

export interface MapEntryResult {
  entry: string;
  /** Why this entry point was discovered. Sorted, deduped, never empty. */
  discovery: DiscoverySource[];
  analysis: Analysis;
  notes: string[];
  mode: "stack" | "single-file";
  pass: boolean;
  reasons: string[];
}

export interface MapResult {
  repoRoot: string;
  entries: MapEntryResult[];
  pass: boolean;
}

export function runMap(
  repoRoot: string,
  config: Config,
  tokenizerName = "claude-local",
  agent: Agent = "claude",
  userConfigDir?: string,
): MapResult {
  const tok = getTokenizer(tokenizerName);
  const points = discoverEntryPoints(repoRoot, config, agent);
  const entries: MapEntryResult[] = [];
  for (const p of points) {
    const { analysis, notes, mode } = analyzeEntry(p.abs, {
      repoRoot,
      config,
      tokenizer: tok,
      agent,
      userConfigDir,
    });
    const gate = analysis.gate;
    entries.push({
      entry: analysis.entry || ".",
      discovery: p.discovery,
      analysis,
      notes,
      mode,
      pass: gate.pass,
      reasons: gate.reasons,
    });
  }
  entries.sort((a, b) => (a.entry < b.entry ? -1 : a.entry > b.entry ? 1 : 0));
  return { repoRoot, entries, pass: entries.every((e) => e.pass) };
}
