#!/usr/bin/env node
// survey.mjs — produce the empirical "What conman finds in the wild" numbers.
//
// This is standalone tooling, NOT part of conman's analysis path and NOT wired
// into CI or the pinned fixture corpus (that stays ~10-15 repos; see
// fixtures/README.md). It is heavy: a full ~100-repo run shallow-clones roughly
// 15-25 GB in aggregate, one repo at a time, deleting each clone before the
// next. Only the script touches the network; every `conman map` invocation is
// offline.
//
// Pipeline:
//   1. discover  — GitHub code-search (via gh-axi) for public repos carrying a
//                  real agent context stack (.claude/, CLAUDE.md, AGENTS.md),
//                  drop forks + archived, sort, write a candidate list.
//   2. sample    — deterministic pick of --limit repos from the candidate list
//                  (stable sha256(seed + repo) ordering; a rerun over the same
//                  list + seed picks the same repos).
//   3. map       — shallow-clone each sampled repo, run the locally built
//                  `conman map --json --budget 12000` over it, keep the JSON,
//                  delete the clone.
//   4. aggregate — redundant-token %, value-conflict rate, median resolved
//                  stack, over-budget rate; N mapped / N skipped with reasons.
//   5. write     — docs/survey-<YYYY-MM>.md (method + table + per-repo rows)
//                  and patch README's "What conman finds in the wild" section.
//
// Build conman first (`npm run build`); this invokes dist/cli.js from the repo
// it lives in, never a globally installed conman.
//
// USAGE
//   node scripts/survey.mjs [flags]
//
//   --limit N            sample size (default 8; the captain uses 100)
//   --seed S             sample seed string (default "conman-survey")
//   --candidates PATH    read the candidate list from PATH (one owner/repo per
//                        line, '#' comments ok) instead of running discovery
//   --discover-only      run discovery, write the candidate list, then stop
//   --candidates-out P   where discovery writes the candidate list
//                        (default: docs/survey-candidates-<YYYY-MM>.txt)
//   --pages N            code-search pages per query during discovery
//                        (default 4, 100 results/page; GitHub caps at 10)
//   --out PATH           results markdown (default docs/survey-<YYYY-MM>.md)
//   --keep-json DIR      also dump each repo's raw map JSON into DIR
//   --no-readme          do not patch README.md
//   --help
//
// CAPTAIN'S FULL RUN (do NOT run this in a firstmate worktree — clones persist
// and fill the disk; run it in the durable checkout):
//
//   cd ~/Documents/Repositories/conman
//   git checkout fm/conman-survey-100 && npm run build
//   node scripts/survey.mjs --discover-only --pages 10
//   node scripts/survey.mjs \
//     --candidates docs/survey-candidates-$(date +%Y-%m).txt \
//     --limit 100 --seed conman-survey-2026-08
//
//   Expect ~45-90 min wall time (network-bound) and up to ~25 GB of transient
//   clone traffic; peak disk stays near one repo since each clone is deleted
//   before the next. Then review docs/survey-<YYYY-MM>.md and the README diff,
//   commit, and push.

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync, openSync, closeSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const CLI = join(ROOT, "dist", "cli.js");
const DEFAULT_BUDGET = 12000; // conman's built-in default (src/config.ts)

// ---------------------------------------------------------------------------
// args

function parseArgs(argv) {
  const a = {
    limit: 8,
    seed: "conman-survey",
    candidates: null,
    discoverOnly: false,
    candidatesOut: null,
    pages: 4,
    out: null,
    keepJson: null,
    readme: true,
  };
  for (let i = 0; i < argv.length; i++) {
    const v = argv[i];
    const next = () => argv[++i];
    switch (v) {
      case "--help": case "-h": a.help = true; break;
      case "--limit": a.limit = parseInt(next(), 10); break;
      case "--seed": a.seed = next(); break;
      case "--candidates": a.candidates = next(); break;
      case "--discover-only": a.discoverOnly = true; break;
      case "--candidates-out": a.candidatesOut = next(); break;
      case "--pages": a.pages = parseInt(next(), 10); break;
      case "--out": a.out = next(); break;
      case "--keep-json": a.keepJson = next(); break;
      case "--no-readme": a.readme = false; break;
      default:
        console.error(`unknown flag: ${v}`);
        process.exit(2);
    }
  }
  return a;
}

function printHelp() {
  // The header comment is the manual; echo the usage block from it.
  const src = readFileSync(fileURLToPath(import.meta.url), "utf8");
  const lines = src.split("\n");
  const start = lines.findIndex((l) => l.startsWith("// USAGE"));
  const end = lines.findIndex((l, i) => i > start && !l.startsWith("//"));
  console.log(lines.slice(start, end).map((l) => l.replace(/^\/\/ ?/, "")).join("\n"));
}

// ---------------------------------------------------------------------------
// dates / paths

function yyyymm() {
  // No Date-based nondeterminism in conman itself; the survey doc is dated by
  // design. Allow an override so a rerun targets the same file.
  const env = process.env.SURVEY_MONTH;
  if (env && /^\d{4}-\d{2}$/.test(env)) return env;
  const d = new Date();
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

// ---------------------------------------------------------------------------
// gh-axi helpers

/**
 * `gh-axi api --jq` wraps its output as:
 *   api_response:
 *     body: "<jq output, with \n escaped>"
 *     truncated: false
 * Pull the body string back out. Returns "" if the shape is unexpected.
 */
function ghLines(path, jq, { dropEmpty = true } = {}) {
  const out = execFileSync("gh-axi", ["api", path, "--jq", jq], {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  const m = out.match(/body:\s*("(?:[^"\\]|\\.)*")/s);
  const body = m ? JSON.parse(m[1]) : out;
  const lines = body.split("\n").map((s) => s.trim());
  return dropEmpty ? lines.filter(Boolean) : lines;
}

/** Sleep helper (ms). */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * One code-search page. Returns { repos: string[], rateLimited, done }.
 * gh-axi prints a structured error block on RATE_LIMITED rather than throwing a
 * parseable status, so sniff the text.
 */
function codeSearchPage(q, page) {
  const path = `/search/code?q=${encodeURIComponent(q)}&per_page=100&page=${page}`;
  try {
    return { repos: ghLines(path, ".items[].repository.full_name") };
  } catch (e) {
    const txt = `${e.stdout || ""}${e.stderr || ""}${e.message || ""}`;
    if (/RATE_LIMIT|rate limit/i.test(txt)) return { repos: [], rateLimited: true };
    // A 422 past the 1000-result window just means "no more pages".
    if (/422|Only the first/i.test(txt)) return { repos: [], done: true };
    throw e;
  }
}

async function waitForCodeSearchBudget() {
  try {
    const [remaining, reset] = ghLines(
      "/rate_limit",
      ".resources.code_search.remaining, .resources.code_search.reset",
    ).map((s) => parseInt(s, 10));
    if (!Number.isFinite(remaining) || remaining > 0) return;
    const waitMs = Math.max(2000, reset * 1000 - Date.now() + 2000);
    console.error(`  code-search budget exhausted; sleeping ${Math.round(waitMs / 1000)}s for reset`);
    await sleep(waitMs);
  } catch {
    await sleep(60_000);
  }
}

// ---------------------------------------------------------------------------
// discovery

// Queries chosen to surface repos with a non-trivial stack. `filename:` matches
// are broad; the stub filter happens after the map (empty/zero-token stacks are
// skipped), and forks/archived are dropped here.
const QUERIES = [
  "path:.claude/settings.json",
  "path:.claude/settings.local.json",
  "path:.claude/commands",
  "filename:CLAUDE.md",
  "filename:AGENTS.md",
];

async function discover(pages) {
  const seen = new Set();
  for (const q of QUERIES) {
    for (let page = 1; page <= pages; page++) {
      await waitForCodeSearchBudget();
      const res = codeSearchPage(q, page);
      if (res.rateLimited) {
        await waitForCodeSearchBudget();
        page--; // retry same page
        continue;
      }
      for (const r of res.repos) seen.add(r);
      console.error(`  [${q}] page ${page}: +${res.repos.length} (${seen.size} unique)`);
      if (res.done || res.repos.length === 0) break;
      await sleep(7000); // ~10 code-search req/min ceiling
    }
  }
  return [...seen].sort();
}

/** Drop forks + archived; keep default_branch + a little metadata. Core API. */
async function filterRepos(fullNames) {
  const kept = [];
  const dropped = [];
  for (const name of fullNames) {
    try {
      const [fork, archived, branch, stars, sizeKb, pushed] = ghLines(
        `/repos/${name}`,
        ".fork, .archived, .default_branch, .stargazers_count, .size, .pushed_at",
        { dropEmpty: false },
      );
      if (fork === "true") { dropped.push([name, "fork"]); continue; }
      if (archived === "true") { dropped.push([name, "archived"]); continue; }
      kept.push({
        repo: name,
        branch: branch || "HEAD",
        stars: parseInt(stars || "0", 10),
        sizeKb: parseInt(sizeKb || "0", 10),
        pushedAt: pushed || "",
      });
    } catch (e) {
      dropped.push([name, "meta-failed"]);
    }
    await sleep(120);
  }
  return { kept, dropped };
}

// ---------------------------------------------------------------------------
// sampling — deterministic

function sampleCandidates(candidates, seed, limit) {
  const keyed = candidates.map((c) => {
    const repo = typeof c === "string" ? c : c.repo;
    const h = createHash("sha256").update(`${seed}\0${repo}`).digest("hex");
    return { c, repo, h };
  });
  keyed.sort((a, b) => (a.h < b.h ? -1 : a.h > b.h ? 1 : 0));
  return keyed.slice(0, limit).map((k) => k.c);
}

// ---------------------------------------------------------------------------
// clone + map

function mapOne(repo, branch) {
  const dir = mkdtempSync(join(tmpdir(), "conman-survey-"));
  const clone = join(dir, "r");
  try {
    execFileSync(
      "git",
      ["clone", "--depth", "1", "--quiet", `https://github.com/${repo}.git`, clone],
      { stdio: ["ignore", "ignore", "pipe"], timeout: 180_000 },
    );
    const outPath = join(dir, "map.json");
    // Write to a file, not a pipe: the CLI process.exit()s and truncates a big
    // async stdout write at the pipe buffer (see scripts/corpus-digest.mjs).
    const fd = openSync(outPath, "w");
    try {
      execFileSync(process.execPath, [CLI, "map", clone, "--json", "--budget", String(DEFAULT_BUDGET)], {
        stdio: ["ignore", fd, "pipe"],
        timeout: 180_000,
      });
    } finally {
      closeSync(fd);
    }
    const map = JSON.parse(readFileSync(outPath, "utf8"));
    return { ok: true, map };
  } catch (e) {
    const txt = `${e.stderr || ""}${e.message || ""}`.slice(0, 300).replace(/\s+/g, " ").trim();
    return { ok: false, reason: classify(txt) };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function classify(txt) {
  if (/timed out|ETIMEDOUT|timeout/i.test(txt)) return "clone-or-map-timeout";
  if (/could not read|Repository not found|Authentication|remote:/i.test(txt)) return "clone-failed";
  if (/Unexpected token|JSON/i.test(txt)) return "map-bad-json";
  return `map-failed: ${txt.slice(0, 120)}`;
}

// ---------------------------------------------------------------------------
// aggregate

function summariseRepo(name, map) {
  const eps = map.entryPoints || [];
  let stackTokens = 0;
  let redundantTokens = 0;
  let overBudgetEps = 0;
  let valueConflictEps = 0;
  const stackSizes = [];
  for (const e of eps) {
    stackTokens += e.stackTokens || 0;
    redundantTokens += e.redundant?.tokens || 0;
    stackSizes.push(e.stackTokens || 0);
    if (e.budget?.overBudget) overBudgetEps++;
    const vc = (e.findings || []).some(
      (f) => f.type === "value-conflict" && f.severity === "error",
    );
    if (vc) valueConflictEps++;
  }
  return {
    repo: name,
    entryPoints: eps.length,
    stackTokens,
    redundantTokens,
    redundantPct: stackTokens ? +((redundantTokens / stackTokens) * 100).toFixed(2) : 0,
    overBudgetEntryPoints: overBudgetEps,
    valueConflictEntryPoints: valueConflictEps,
    stackSizes,
  };
}

const median = (xs) => {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);

function aggregate(repoSummaries) {
  const mapped = repoSummaries.filter((r) => r.entryPoints > 0);
  const redundantPcts = mapped.map((r) => r.redundantPct);
  const allStackSizes = mapped.flatMap((r) => r.stackSizes);
  const vcRepos = mapped.filter((r) => r.valueConflictEntryPoints > 0).length;
  const overBudgetRepos = mapped.filter((r) => r.overBudgetEntryPoints > 0).length;
  const totalEps = mapped.reduce((n, r) => n + r.entryPoints, 0);
  const overBudgetEps = mapped.reduce((n, r) => n + r.overBudgetEntryPoints, 0);
  return {
    reposMapped: mapped.length,
    entryPoints: totalEps,
    redundantTokenPctMedian: +median(redundantPcts).toFixed(2),
    redundantTokenPctMean: +mean(redundantPcts).toFixed(2),
    valueConflictRepoRatePct: mapped.length ? +((vcRepos / mapped.length) * 100).toFixed(1) : 0,
    valueConflictRepos: vcRepos,
    medianResolvedStackTokens: median(allStackSizes),
    overBudgetRepoRatePct: mapped.length ? +((overBudgetRepos / mapped.length) * 100).toFixed(1) : 0,
    overBudgetRepos,
    overBudgetEntryPointRatePct: totalEps ? +((overBudgetEps / totalEps) * 100).toFixed(1) : 0,
    overBudgetEntryPoints: overBudgetEps,
  };
}

// ---------------------------------------------------------------------------
// output

function toolVersion() {
  try {
    return JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")).version;
  } catch {
    return "unknown";
  }
}

function resultsDoc({ month, args, candidateCount, discoverySource, sample, repoSummaries, skips, agg, modelVersion }) {
  const L = [];
  L.push(`# conman "in the wild" survey — ${month}`);
  L.push("");
  L.push("Generated by `scripts/survey.mjs` (standalone tooling, not CI, not the");
  L.push("pinned fixture corpus). Every `conman map` run here is offline; only the");
  L.push("script clones.");
  L.push("");
  L.push("## Method");
  L.push("");
  L.push(`- **conman**: \`${toolVersion()}\`, resolution model \`${modelVersion ?? "?"}\`, built from this branch's HEAD.`);
  L.push(`- **Budget**: built-in default, \`--budget ${DEFAULT_BUDGET}\` with the 0.10 safety margin (10,800-token gate line).`);
  L.push(`- **Candidates**: ${candidateCount} public repos, from ${discoverySource}.`);
  L.push(`  Forks and archived repos dropped. Discovery queries: ${QUERIES.map((q) => `\`${q}\``).join(", ")}.`);
  L.push(`- **Sample**: ${sample.length} repos, seed \`${args.seed}\`, picked by stable \`sha256(seed + "\\0" + repo)\` ordering — a rerun over the same candidate list and seed picks the same repos.`);
  L.push(`- **Per repo**: \`git clone --depth 1\`, \`conman map --json\`, capture, then delete the clone before the next.`);
  L.push(`- **Mapped**: ${agg.reposMapped}. **Skipped**: ${skips.length}.`);
  L.push("");
  L.push("## Aggregate");
  L.push("");
  L.push("| measure | result |");
  L.push("|---------|--------|");
  L.push(`| repos mapped | **${agg.reposMapped}** (of ${sample.length} sampled; ${skips.length} skipped) |`);
  L.push(`| entry points resolved | **${agg.entryPoints}** |`);
  L.push(`| redundant tokens, % of resolved stack (per repo) | **median ${agg.redundantTokenPctMedian}%, mean ${agg.redundantTokenPctMean}%** |`);
  L.push(`| repos with ≥1 error-severity value conflict | **${agg.valueConflictRepos} of ${agg.reposMapped} — ${agg.valueConflictRepoRatePct}%** |`);
  L.push(`| median resolved stack (across all entry points) | **${agg.medianResolvedStackTokens.toLocaleString("en-US")} tokens** |`);
  L.push(`| repos with ≥1 over-budget entry point | **${agg.overBudgetRepos} of ${agg.reposMapped} — ${agg.overBudgetRepoRatePct}%** |`);
  L.push(`| entry points over budget | **${agg.overBudgetEntryPoints} of ${agg.entryPoints} — ${agg.overBudgetEntryPointRatePct}%** |`);
  L.push("");
  L.push("## Per-repo rows");
  L.push("");
  L.push("| repo | entry points | resolved tokens | redundant tokens | redundant % | over-budget EPs | value-conflict EPs |");
  L.push("|------|-------------:|----------------:|-----------------:|------------:|----------------:|-------------------:|");
  for (const r of [...repoSummaries].sort((a, b) => (a.repo < b.repo ? -1 : 1))) {
    L.push(
      `| \`${r.repo}\` | ${r.entryPoints} | ${r.stackTokens.toLocaleString("en-US")} | ${r.redundantTokens.toLocaleString("en-US")} | ${r.redundantPct}% | ${r.overBudgetEntryPoints} | ${r.valueConflictEntryPoints} |`,
    );
  }
  L.push("");
  if (skips.length) {
    L.push("## Skipped");
    L.push("");
    L.push("| repo | reason |");
    L.push("|------|--------|");
    for (const s of [...skips].sort((a, b) => (a.repo < b.repo ? -1 : 1))) {
      L.push(`| \`${s.repo}\` | ${s.reason} |`);
    }
    L.push("");
  }
  L.push("## Reproducing / the full run");
  L.push("");
  L.push("This sample was produced with:");
  L.push("");
  L.push("```");
  L.push(`node scripts/survey.mjs --candidates <candidate-list> --limit ${args.limit} --seed ${args.seed}`);
  L.push("```");
  L.push("");
  L.push("The captain's full run (durable checkout, clones persist there):");
  L.push("");
  L.push("```");
  L.push("cd ~/Documents/Repositories/conman");
  L.push("git checkout fm/conman-survey-100 && npm run build");
  L.push("node scripts/survey.mjs --discover-only --pages 10");
  L.push(`node scripts/survey.mjs --candidates docs/survey-candidates-${month}.txt --limit 100 --seed conman-survey-${month}`);
  L.push("```");
  L.push("");
  L.push("Expect ~45-90 min wall time (network-bound) and up to ~25 GB of transient");
  L.push("clone traffic; peak disk stays near a single repo because each clone is");
  L.push("deleted before the next. Review this file and the README diff, then commit.");
  L.push("");
  return L.join("\n");
}

const README_START = "## What conman finds in the wild";
const SURVEY_MARK_BEGIN = "<!-- survey:begin -->";
const SURVEY_MARK_END = "<!-- survey:end -->";

function surveyBlock({ month, sample, agg, skips, small }) {
  const rel = `docs/survey-${month}.md`;
  const L = [];
  L.push(SURVEY_MARK_BEGIN);
  L.push("");
  L.push(`### Broader sample${small ? " (small-sample validation run)" : ""}`);
  L.push("");
  if (small) {
    L.push(`A wider, non-deterministic sweep lives in [\`${rel}\`](${rel}). The run below is a`);
    L.push(`**small-sample validation** of \`scripts/survey.mjs\` (${agg.reposMapped} repos mapped of`);
    L.push(`${sample.length} sampled), not the full survey — treat the pinned-corpus table above as the`);
    L.push("load-bearing numbers until the ~100-repo run lands.");
  } else {
    L.push(`\`scripts/survey.mjs\` shallow-cloned and mapped a random ${agg.reposMapped}-repo sample of`);
    L.push(`public repos carrying a real agent context stack. Full method and per-repo rows: [\`${rel}\`](${rel}).`);
  }
  L.push("");
  L.push("| measure | sample result |");
  L.push("|---------|---------------|");
  L.push(`| redundant tokens (% of resolved stack, per repo) | **median ${agg.redundantTokenPctMedian}%, mean ${agg.redundantTokenPctMean}%** |`);
  L.push(`| repos with a direct value conflict (error severity) | **${agg.valueConflictRepos} of ${agg.reposMapped} — ${agg.valueConflictRepoRatePct}%** |`);
  L.push(`| median resolved stack | **${agg.medianResolvedStackTokens.toLocaleString("en-US")} tokens** |`);
  L.push(`| repos with an over-budget entry point | **${agg.overBudgetRepos} of ${agg.reposMapped} — ${agg.overBudgetRepoRatePct}%** |`);
  L.push("");
  L.push(SURVEY_MARK_END);
  return L.join("\n");
}

function patchReadme(readmePath, block) {
  let txt = readFileSync(readmePath, "utf8");
  if (txt.includes(SURVEY_MARK_BEGIN)) {
    txt = txt.replace(
      new RegExp(`${SURVEY_MARK_BEGIN}[\\s\\S]*?${SURVEY_MARK_END}`),
      block,
    );
    writeFileSync(readmePath, txt);
    return "replaced";
  }
  const idx = txt.indexOf(README_START);
  if (idx === -1) throw new Error(`"${README_START}" not found in README.md`);
  // Insert the block just before the next "## " heading after the section.
  const after = txt.indexOf("\n## ", idx + README_START.length);
  const cut = after === -1 ? txt.length : after + 1;
  txt = txt.slice(0, cut).replace(/\n+$/, "\n") + "\n" + block + "\n\n" + txt.slice(cut);
  writeFileSync(readmePath, txt);
  return "inserted";
}

// ---------------------------------------------------------------------------
// main

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) return printHelp();

  if (!existsSync(CLI)) {
    console.error(`conman build not found at ${CLI} — run \`npm run build\` first.`);
    process.exit(1);
  }

  const month = yyyymm();
  const candidatesOut = args.candidatesOut || join(ROOT, "docs", `survey-candidates-${month}.txt`);
  const outPath = args.out || join(ROOT, "docs", `survey-${month}.md`);
  mkdirSync(join(ROOT, "docs"), { recursive: true });

  // --- discovery / candidate list ---
  let candidates;
  let discoverySource;
  if (args.candidates) {
    candidates = readFileSync(args.candidates, "utf8")
      .split("\n")
      .map((s) => s.replace(/#.*/, "").trim())
      .filter((s) => /^[\w.-]+\/[\w.-]+$/.test(s));
    candidates = [...new Set(candidates)].sort();
    discoverySource = `candidate list \`${args.candidates}\``;
    console.error(`loaded ${candidates.length} candidates from ${args.candidates}`);
  } else {
    console.error(`discovering candidates (pages=${args.pages})...`);
    const raw = await discover(args.pages);
    console.error(`filtering ${raw.length} repos (fork/archived)...`);
    const { kept, dropped } = await filterRepos(raw);
    candidates = kept.map((k) => k.repo).sort();
    discoverySource = `GitHub code-search on ${new Date().toISOString().slice(0, 10)} (${dropped.length} forks/archived/failed dropped)`;
    const header = [
      `# conman survey candidates — ${month}`,
      `# ${candidates.length} public repos, forks + archived removed`,
      `# regenerate: node scripts/survey.mjs --discover-only --pages ${args.pages}`,
      "",
    ].join("\n");
    writeFileSync(candidatesOut, header + candidates.join("\n") + "\n");
    console.error(`wrote candidate list -> ${candidatesOut}`);
  }

  if (candidates.length === 0) {
    console.error("no candidates — aborting.");
    process.exit(1);
  }
  if (args.discoverOnly) {
    console.error("--discover-only: done.");
    return;
  }

  // --- sample ---
  const sample = sampleCandidates(candidates, args.seed, args.limit);
  console.error(`sampled ${sample.length} of ${candidates.length} candidates (seed "${args.seed}")`);

  // --- clone + map ---
  if (args.keepJson) mkdirSync(args.keepJson, { recursive: true });
  const repoSummaries = [];
  const skips = [];
  let modelVersion = null;
  let i = 0;
  for (const c of sample) {
    const repo = typeof c === "string" ? c : c.repo;
    const branch = typeof c === "string" ? "HEAD" : c.branch;
    i++;
    process.stderr.write(`[${i}/${sample.length}] ${repo} ... `);
    const res = mapOne(repo, branch);
    if (!res.ok) {
      console.error(`skip (${res.reason})`);
      skips.push({ repo, reason: res.reason });
      continue;
    }
    modelVersion = modelVersion ?? res.map.modelVersion;
    if (args.keepJson) {
      writeFileSync(join(args.keepJson, `${repo.replace(/\//g, "__")}.json`), JSON.stringify(res.map, null, 2));
    }
    const s = summariseRepo(repo, res.map);
    if (s.entryPoints === 0 || s.stackTokens === 0) {
      console.error(`skip (empty-stack)`);
      skips.push({ repo, reason: "empty-stack (no entry points / zero tokens)" });
      continue;
    }
    console.error(`${s.entryPoints} EPs, ${s.stackTokens} tok`);
    repoSummaries.push(s);
  }

  if (repoSummaries.length === 0) {
    console.error("no repos mapped successfully — not writing outputs.");
    process.exit(1);
  }

  // --- aggregate + write ---
  const agg = aggregate(repoSummaries);
  const doc = resultsDoc({
    month, args, candidateCount: candidates.length, discoverySource,
    sample: sample.map((c) => (typeof c === "string" ? c : c.repo)),
    repoSummaries, skips, agg, modelVersion,
  });
  writeFileSync(outPath, doc);
  console.error(`wrote ${outPath}`);

  if (args.readme) {
    const small = args.limit < 40 || agg.reposMapped < 40;
    const block = surveyBlock({
      month,
      sample: sample.map((c) => (typeof c === "string" ? c : c.repo)),
      agg, skips, small,
    });
    const how = patchReadme(join(ROOT, "README.md"), block);
    console.error(`README.md: ${how} survey block`);
  }

  console.error("");
  console.error(`done: ${agg.reposMapped} mapped, ${skips.length} skipped.`);
  console.error(`  redundant %: median ${agg.redundantTokenPctMedian}, mean ${agg.redundantTokenPctMean}`);
  console.error(`  value-conflict repos: ${agg.valueConflictRepos}/${agg.reposMapped} (${agg.valueConflictRepoRatePct}%)`);
  console.error(`  median resolved stack: ${agg.medianResolvedStackTokens} tokens`);
  console.error(`  over-budget repos: ${agg.overBudgetRepos}/${agg.reposMapped} (${agg.overBudgetRepoRatePct}%)`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
