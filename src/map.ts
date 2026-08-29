// `conman map`: discover every entry point in the repo and run the analysis
// across all of them, so a monorepo can be taken in one pass.
//
// An entry point is any directory that contains a CLAUDE.md or an AGENTS.md,
// plus the repo root itself. Discovery is a deterministic depth-first walk with
// sorted directory listings; `.git`, `node_modules`, and config `ignore` globs
// are skipped.

import { readdirSync } from "node:fs";
import { join } from "node:path";
import type { Analysis } from "./types.js";
import type { Config } from "./config.js";
import { analyzeEntry } from "./analyze.js";
import { evaluateGate } from "./gate.js";
import { isDir, isFile, matchesAnyGlob, relPosix } from "./repo.js";
import { getTokenizer } from "./tokenizer.js";

const ALWAYS_SKIP = new Set([".git", "node_modules", "dist", ".treehouse"]);
const MEMORY_NAMES = ["CLAUDE.md", "AGENTS.md"];

export function discoverEntryPoints(repoRoot: string, config: Config): string[] {
  const found = new Set<string>();
  found.add(repoRoot);

  const walk = (dir: string) => {
    let entries: string[];
    try {
      entries = readdirSync(dir).sort();
    } catch {
      return;
    }
    for (const name of MEMORY_NAMES) {
      if (isFile(join(dir, name))) found.add(dir);
    }
    for (const e of entries) {
      if (ALWAYS_SKIP.has(e)) continue;
      const abs = join(dir, e);
      if (!isDir(abs)) continue;
      const rel = relPosix(repoRoot, abs);
      if (matchesAnyGlob(rel, config.ignore)) continue;
      walk(abs);
    }
  };
  walk(repoRoot);

  return [...found].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

export interface MapEntryResult {
  entry: string;
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
): MapResult {
  const tok = getTokenizer(tokenizerName);
  const points = discoverEntryPoints(repoRoot, config);
  const entries: MapEntryResult[] = [];
  for (const p of points) {
    const { analysis, notes, mode } = analyzeEntry(p, {
      repoRoot,
      config,
      tokenizer: tok,
    });
    const gate = evaluateGate(analysis, config);
    entries.push({
      entry: analysis.entry || ".",
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
