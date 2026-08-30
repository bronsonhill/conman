#!/usr/bin/env node
// Build a compact, deterministic digest of `conman map --json` over the pinned
// fixture corpus. One record per repo whose clone is present under
// fixtures/repos/. The digest is the regression baseline the corpus sweep
// (test/corpus-sweep.js) asserts against, and the source of the numbers in the
// README's "What conman finds in the wild" section.
//
//   node scripts/corpus-digest.mjs                 # print digest JSON to stdout
//   node scripts/corpus-digest.mjs --write <path>  # also write it to <path>
//
// Fixture SHAs are pinned, so for a given conman build the output is stable.
// When findings logic changes on purpose, regenerate with
// `npm run test:corpus:update` and commit the diff.

import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, existsSync, openSync, closeSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const CLI = join(ROOT, "dist", "cli.js");
const REPOS_DIR = join(ROOT, "fixtures", "repos");
const MANIFEST = join(ROOT, "fixtures", "manifest.toml");

/** Repo names in manifest order (flat `name = "..."` lines). */
export function manifestRepos() {
  const txt = readFileSync(MANIFEST, "utf8");
  const names = [];
  for (const line of txt.split("\n")) {
    const m = line.match(/^\s*name\s*=\s*"([^"]+)"/);
    if (m) names.push(m[1]);
  }
  return names;
}

/**
 * Run `conman map --json` for one fetched repo. Throws on a non-zero exit.
 *
 * Output goes to a temp file rather than a captured pipe: the CLI calls
 * `process.exit()`, which truncates a large async stdout write to a pipe at the
 * ~64 KB pipe buffer (posthog and ruflo blow past that). A file fd flushes.
 */
export function mapRepo(name) {
  const target = join(REPOS_DIR, name);
  const outPath = join(tmpdir(), `conman-corpus-${name.replace(/[^\w.-]/g, "_")}.json`);
  const fd = openSync(outPath, "w");
  try {
    execFileSync(process.execPath, [CLI, "map", target, "--json"], {
      stdio: ["ignore", fd, "inherit"],
    });
  } finally {
    closeSync(fd);
  }
  const txt = readFileSync(outPath, "utf8");
  rmSync(outPath, { force: true });
  return JSON.parse(txt);
}

/** Compact per-repo record: totals plus a sorted findings-by-type histogram. */
export function digestRepo(name, map) {
  const entries = map.entryPoints;
  const byType = {};
  let redundantTokens = 0;
  let stackTokens = 0;
  let overBudget = 0;
  let valueConflictEntries = 0;
  for (const e of entries) {
    stackTokens += e.stackTokens;
    redundantTokens += e.redundant.tokens;
    if (e.budget.overBudget) overBudget += 1;
    let vc = 0;
    for (const f of e.findings) {
      byType[f.type] = (byType[f.type] ?? 0) + 1;
      if (f.type === "value-conflict") vc += 1;
    }
    if (vc > 0) valueConflictEntries += 1;
  }
  const findingsByType = {};
  for (const k of Object.keys(byType).sort()) findingsByType[k] = byType[k];
  return {
    repo: name,
    entryPoints: entries.length,
    stackTokens,
    redundantTokens,
    overBudgetEntryPoints: overBudget,
    valueConflictEntryPoints: valueConflictEntries,
    findingsByType,
  };
}

/** Roll per-repo digests + their raw maps into the corpus aggregate block. */
export function corpusAggregate(repos, maps) {
  const totalEntryPoints = repos.reduce((n, r) => n + r.entryPoints, 0);
  const totalStack = repos.reduce((n, r) => n + r.stackTokens, 0);
  const totalRedundant = repos.reduce((n, r) => n + r.redundantTokens, 0);
  const overBudget = repos.reduce((n, r) => n + r.overBudgetEntryPoints, 0);
  const vcEntries = repos.reduce((n, r) => n + r.valueConflictEntryPoints, 0);

  // Median resolved stack size across every entry point in the corpus.
  const sizes = [];
  for (const map of maps) {
    for (const e of map.entryPoints) sizes.push(e.stackTokens);
  }
  sizes.sort((a, b) => a - b);
  const mid = sizes.length >> 1;
  const median = sizes.length === 0 ? 0
    : sizes.length % 2 ? sizes[mid] : (sizes[mid - 1] + sizes[mid]) / 2;

  return {
    repoCount: repos.length,
    totalEntryPoints,
    redundantTokenPct: totalStack ? +((totalRedundant / totalStack) * 100).toFixed(2) : 0,
    redundantTokens: totalRedundant,
    stackTokens: totalStack,
    valueConflictEntryPoints: vcEntries,
    valueConflictRatePct: totalEntryPoints ? +((vcEntries / totalEntryPoints) * 100).toFixed(2) : 0,
    medianResolvedStackTokens: median,
    overBudgetEntryPoints: overBudget,
    overBudgetRatePct: totalEntryPoints ? +((overBudget / totalEntryPoints) * 100).toFixed(2) : 0,
  };
}

export function buildDigest() {
  const present = manifestRepos().filter((n) => existsSync(join(REPOS_DIR, n)));
  // Map each repo exactly once; posthog and motrix are slow to resolve.
  const maps = present.map((n) => ({ name: n, map: mapRepo(n) }));
  const repos = maps.map(({ name, map }) => digestRepo(name, map));

  return {
    tool: "conman",
    modelVersion: maps.length ? maps[0].map.modelVersion : null,
    repos,
    corpus: corpusAggregate(repos, maps.map((m) => m.map)),
  };
}

function main() {
  const argv = process.argv.slice(2);
  const digest = buildDigest();
  const json = JSON.stringify(digest, null, 2) + "\n";
  const wi = argv.indexOf("--write");
  if (wi !== -1 && argv[wi + 1]) writeFileSync(argv[wi + 1], json);
  process.stdout.write(json);
}

if (import.meta.url === `file://${process.argv[1]}`) main();
