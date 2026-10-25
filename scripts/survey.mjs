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
//   1b. qualify  — (--qualify / --qualify-only) GitHub-API-only filter that applies
//                  docs/suite-criteria.md criteria 1-3 and records a reason for
//                  every rejection. No clones. Predicates live in survey-lib.mjs.
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
//   --qualify            run the qualify stage on the candidates before sampling
//   --qualify-only       qualify, write the suite file + rejection report, stop
//   --suite [PATH]       map the curated suite (default docs/survey-suite.txt)
//                        instead of hash-sampling; --limit and --seed are ignored
//   --suite-out PATH     where qualify writes the suite (default docs/survey-suite.txt)
//   --suite-size N       cap on suite length (default 50); when more repos qualify,
//                        keep the first N by stable sha256(seed + repo) ordering
//   --qualify-cache PATH JSONL cache of per-repo qualify verdicts; a rerun (or a
//                        rate-limit crash) resumes instead of refetching
//   --help
//
// CAPTAIN'S FULL RUN (do NOT run this in a firstmate worktree — clones persist
// and fill the disk; run it in the durable checkout):
//
//   cd ~/Documents/Repositories/conman
//   git pull && npm run build
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
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  THRESHOLDS, aggregate, ageDays, borderlineFlags, checkMeta, checkProject, parseRepoList,
  projectStats, rejectionCounts, rootMemoryEntry, rootStack, structuralFeatures, suiteLine, summariseRepo,
} from "./survey-lib.mjs";

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
    qualify: false,
    qualifyOnly: false,
    suite: null,
    suiteOut: null,
    suiteSize: 50,
    qualifyCache: null,
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
      case "--qualify": a.qualify = true; break;
      case "--qualify-only": a.qualify = true; a.qualifyOnly = true; break;
      case "--suite": {
        const nx = argv[i + 1];
        a.suite = nx && !nx.startsWith("--") ? argv[++i] : join(ROOT, "docs", "survey-suite.txt");
        break;
      }
      case "--suite-out": a.suiteOut = next(); break;
      case "--suite-size": a.suiteSize = parseInt(next(), 10); break;
      case "--qualify-cache": a.qualifyCache = next(); break;
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
  const out = execFileSync("gh-axi", ["api", path, "--jq", jq, "--full"], {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  if (/^\s*truncated:\s*true/m.test(out)) throw new Error(`gh-axi truncated the response for ${path}`);
  const m = out.match(/body:\s*("(?:[^"\\]|\\.)*")/s);
  // Short single-line bodies come back unquoted.
  const plain = m ? null : out.match(/^\s*body:[ \t]*(.*)$/m);
  const body = m ? JSON.parse(m[1]) : plain ? plain[1] : out;
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
  "path:.claude/rules",
  "filename:SKILL.md path:.claude/skills",
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
// qualify — GitHub API only (repo metadata, one recursive tree listing, and the
// root CLAUDE.md / @-imported blobs). Never clones.

function repoMeta(repo) {
  const [row] = ghLines(
    `/repos/${repo}`,
    '[.full_name, .fork, .archived, .is_template, .stargazers_count, .pushed_at, .default_branch, (.topics // [] | join(","))] | @tsv',
  );
  const [full_name, fork, archived, tmpl, stars, pushed, branch, topics] = row.split("\t");
  return {
    full_name, fork: fork === "true", archived: archived === "true", is_template: tmpl === "true",
    stargazers_count: parseInt(stars, 10), pushed_at: pushed, default_branch: branch,
    topics: topics ? topics.split(",") : [],
  };
}

/** Recursive tree as [{mode, type, sha, path}] plus GitHub's `truncated` flag. */
function repoTree(repo, branch) {
  const lines = ghLines(
    `/repos/${repo}/git/trees/${encodeURIComponent(branch)}?recursive=1`,
    '(.tree[] | [.mode, .type, .sha, .path] | @tsv), ("#truncated\t" + (.truncated | tostring))',
  );
  const entries = [];
  let truncated = false;
  for (const l of lines) {
    const f = l.split("\t");
    if (f[0] === "#truncated") { truncated = f[1] === "true"; continue; }
    entries.push({ mode: f[0], type: f[1], sha: f[2], path: f.slice(3).join("\t") });
  }
  return { entries, truncated };
}

function fetchBlobText(repo, sha) {
  const b64 = ghLines(`/repos/${repo}/git/blobs/${sha}`, ".content").join("");
  return Buffer.from(b64, "base64").toString("utf8");
}

/** Qualify one repo. Returns {ok:true, ...record} or {ok:false, reason}. */
function qualifyRepo(repo, now, countTokens) {
  let meta;
  try {
    meta = repoMeta(repo);
  } catch {
    return { ok: false, reason: "meta-failed" }; // 404 or rate limit; retried on rerun
  }
  const metaReject = checkMeta(meta, now);
  if (metaReject) return { ok: false, reason: metaReject };

  let tree;
  try {
    tree = repoTree(repo, meta.default_branch);
  } catch {
    return { ok: false, reason: "tree-failed" };
  }
  const blobs = tree.entries.filter((e) => e.type === "blob");
  const paths = blobs.map((e) => e.path);
  const shaOf = new Map(blobs.map((e) => [e.path, e.sha]));
  const stats = projectStats(paths);
  const projectReject = checkProject(stats);
  if (projectReject) return { ok: false, reason: projectReject };

  const entry = rootMemoryEntry(blobs);
  if (!entry) return { ok: false, reason: "no-root-memory (no CLAUDE.md that loads)" };
  const texts = [];
  const read = (p) => {
    try {
      if (!shaOf.has(p)) return null;
      const t = fetchBlobText(repo, shaOf.get(p));
      texts.push(t);
      return t;
    } catch { return null; }
  };
  const stack = rootStack(entry, paths, read, countTokens);
  const rootHash = createHash("sha256").update(texts.join("\0")).digest("hex").slice(0, 12);
  if (stack.tokens < THRESHOLDS.minRootTokens) {
    return { ok: false, reason: `root-memory-below-floor (${stack.tokens} < ${THRESHOLDS.minRootTokens} tok)` };
  }
  let features = structuralFeatures(paths, { memoryPath: stack.files[0], imports: stack.imports });
  if (Object.keys(features).length === 0 && shaOf.has(".claude/settings.json")) {
    features = structuralFeatures(paths, {
      memoryPath: stack.files[0], imports: stack.imports, settingsText: read(".claude/settings.json"),
    });
  }
  if (Object.keys(features).length === 0) return { ok: false, reason: "no-structural-feature" };

  const age = ageDays(meta.pushed_at, now);
  const rec = {
    repo, branch: meta.default_branch, stars: meta.stargazers_count, ageDays: age,
    rootTokens: stack.tokens, rootHash, features, stats, truncated: !!tree.truncated,
  };
  rec.borderline = borderlineFlags(rec);
  if (rec.truncated) rec.borderline.push("git tree truncated by GitHub; file mix and features may be undercounted");
  return { ok: true, ...rec };
}

async function qualifyAll(repos, { cachePath, now, countTokens }) {
  const cache = new Map();
  if (cachePath && existsSync(cachePath)) {
    for (const l of readFileSync(cachePath, "utf8").split("\n").filter(Boolean)) {
      const r = JSON.parse(l);
      cache.set(r.repo, r);
    }
  }
  const accepted = [];
  const rejected = [];
  let i = 0;
  for (const repo of repos) {
    i++;
    let res = cache.get(repo);
    if (!res) {
      res = { repo, ...qualifyRepo(repo, now, countTokens) };
      if (res.reason === "meta-failed" || res.reason === "tree-failed") {
        // Transient (rate limit, 404). Do not cache; the rerun retries.
      } else if (cachePath) {
        writeFileSync(cachePath, JSON.stringify(res) + "\n", { flag: "a" });
      }
      await sleep(150);
    }
    console.error(`[qualify ${i}/${repos.length}] ${repo}: ${res.ok ? "ok " + Object.keys(res.features).join(",") : "reject " + res.reason}`);
    (res.ok ? accepted : rejected).push(res);
  }
  // Copies and generated mirrors share a root memory byte for byte. Keep them,
  // but flag every member of the group so the captain can rule on it.
  const byHash = new Map();
  for (const r of accepted) byHash.set(r.rootHash, [...(byHash.get(r.rootHash) || []), r.repo]);
  for (const r of accepted) {
    const twins = byHash.get(r.rootHash).filter((x) => x !== r.repo);
    if (twins.length) r.borderline = [...r.borderline, `root memory byte-identical to ${twins.join(", ")}`];
  }
  return { accepted, rejected };
}

function suiteFileText({ month, accepted, selected, rejected, args, candidateCount }) {
  const L = [
    `# conman curated survey suite — ${month}`,
    `# Criteria: docs/suite-criteria.md. ${selected.length} repos selected from ${accepted.length} that qualified (${candidateCount} candidates).`,
    `# regenerate: node scripts/survey.mjs --candidates <list> --qualify-only${args.suiteSize ? ` --suite-size ${args.suiteSize}` : ""}`,
    "# lines marked '# borderline:' passed every threshold but sit near one; the captain rules on them.",
    "",
  ];
  for (const r of selected) L.push(suiteLine(r));
  L.push("");
  return L.join("\n");
}

function rejectionReport({ rejected, accepted, selected, candidateCount }) {
  const L = [`candidates: ${candidateCount}`, `qualified: ${accepted.length}`, `selected: ${selected.length}`, "", "rejections by reason:"];
  for (const [code, n] of rejectionCounts(rejected)) L.push(`  ${String(n).padStart(4)}  ${code}`);
  return L.join("\n");
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
  if (args.suite || args.qualify) {
    L.push(`- **Sample**: the curated suite, ${sample.length} repos, no sampling. Inclusion rules: \`docs/suite-criteria.md\`.`);
  } else {
    L.push(`- **Sample**: ${sample.length} repos, seed \`${args.seed}\`, picked by stable \`sha256(seed + "\\0" + repo)\` ordering — a rerun over the same candidate list and seed picks the same repos.`);
  }
  L.push(`- **Per repo**: \`git clone --depth 1\`, \`conman map --json\`, capture, then delete the clone before the next.`);
  L.push(`- **Mapped**: ${agg.reposMapped}. **Skipped**: ${skips.length}.`);
  L.push("");
  L.push("## Aggregate");
  L.push("");
  L.push("Pooled rows weigh every entry point equally, so a repo with many entry");
  L.push("points moves them most. Per-repo rows weigh every repo equally.");
  L.push("");
  L.push("| measure | result |");
  L.push("|---------|--------|");
  L.push(`| repos mapped | **${agg.reposMapped}** (of ${sample.length} sampled; ${skips.length} skipped) |`);
  L.push(`| entry points resolved | **${agg.entryPoints}** |`);
  L.push(`| redundant tokens, % of resolved stack (per repo) | **median ${agg.redundantTokenPctMedian}%, mean ${agg.redundantTokenPctMean}%** |`);
  L.push(`| repos with ≥1 error-severity value conflict | **${agg.valueConflictRepos} of ${agg.reposMapped} — ${agg.valueConflictRepoRatePct}%** |`);
  L.push(`| repos with any redundant tokens | **${agg.redundantRepos} of ${agg.reposMapped} — ${agg.redundantRepoRatePct}%** |`);
  L.push(`| median resolved stack, per repo (median of per-repo medians) | **${agg.medianOfRepoMedianStackTokens.toLocaleString("en-US")} tokens** |`);
  L.push(`| median resolved stack, pooled (all entry points) | ${agg.medianResolvedStackTokens.toLocaleString("en-US")} tokens |`);
  L.push(`| entry points over budget, repo-weighted (mean of per-repo rates) | **${agg.repoWeightedOverBudgetEntryPointPct}%** |`);
  L.push(`| largest single repo, share of all entry points | ${agg.largestRepoEntryPointSharePct}% |`);
  L.push(`| repos with ≥1 over-budget entry point | **${agg.overBudgetRepos} of ${agg.reposMapped} — ${agg.overBudgetRepoRatePct}%** |`);
  L.push(`| entry points over budget, pooled | ${agg.overBudgetEntryPoints} of ${agg.entryPoints} — ${agg.overBudgetEntryPointRatePct}% |`);
  L.push("");
  L.push("## Per-repo rows");
  L.push("");
  L.push("| repo | entry points | resolved tokens | median EP stack | redundant tokens | redundant % | over-budget EPs | value-conflict EPs |");
  L.push("|------|-------------:|----------------:|----------------:|-----------------:|------------:|----------------:|-------------------:|");
  for (const r of [...repoSummaries].sort((a, b) => (a.repo < b.repo ? -1 : 1))) {
    L.push(
      `| \`${r.repo}\` | ${r.entryPoints} | ${r.stackTokens.toLocaleString("en-US")} | ${r.medianStackTokens.toLocaleString("en-US")} | ${r.redundantTokens.toLocaleString("en-US")} | ${r.redundantPct}% | ${r.overBudgetEntryPoints} | ${r.valueConflictEntryPoints} |`,
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
  L.push("git pull");
  L.push("npm run build");
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

function surveyBlock({ month, sample, agg, skips, small, suite }) {
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
    L.push(`\`scripts/survey.mjs\` shallow-cloned and mapped ${suite ? "the curated" : "a random"} ${agg.reposMapped}-repo ${suite ? "suite (docs/suite-criteria.md)" : "sample"} of`);
    L.push(`public repos carrying a real agent context stack. Full method and per-repo rows: [\`${rel}\`](${rel}).`);
  }
  L.push("");
  L.push("| measure | sample result |");
  L.push("|---------|---------------|");
  L.push(`| redundant tokens (% of resolved stack, per repo) | **median ${agg.redundantTokenPctMedian}%, mean ${agg.redundantTokenPctMean}%** |`);
  L.push(`| repos with a direct value conflict (error severity) | **${agg.valueConflictRepos} of ${agg.reposMapped} — ${agg.valueConflictRepoRatePct}%** |`);
  L.push(`| median resolved stack, per repo | **${agg.medianOfRepoMedianStackTokens.toLocaleString("en-US")} tokens** |`);
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
  if (args.suite) {
    candidates = parseRepoList(readFileSync(args.suite, "utf8"));
    discoverySource = `curated suite \`${args.suite.startsWith(ROOT) ? args.suite.slice(ROOT.length + 1) : args.suite}\` (docs/suite-criteria.md)`;
    console.error(`loaded ${candidates.length} suite repos from ${args.suite}`);
  } else if (args.candidates) {
    candidates = parseRepoList(readFileSync(args.candidates, "utf8"));
    discoverySource = `candidate list \`${args.candidates}\``;
    console.error(`loaded ${candidates.length} candidates from ${args.candidates}`);
  } else {
    console.error(`discovering candidates (pages=${args.pages})...`);
    const raw = await discover(args.pages);
    // With --qualify the qualify stage rejects forks/archived itself (and records
    // why), so skip the extra per-repo metadata pass here.
    let dropped = [];
    if (args.qualify) {
      candidates = raw;
    } else {
      console.error(`filtering ${raw.length} repos (fork/archived)...`);
      const f = await filterRepos(raw);
      dropped = f.dropped;
      candidates = f.kept.map((k) => k.repo).sort();
    }
    discoverySource = `GitHub code-search on ${new Date().toISOString().slice(0, 10)} (${dropped.length} forks/archived/failed dropped)`;
    const header = [
      `# conman survey candidates — ${month}`,
      `# ${candidates.length} public repos${args.qualify ? " (unfiltered; qualify stage rejects forks/archived)" : ", forks + archived removed"}`,
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

  // --- qualify ---
  if (args.qualify && !args.suite) {
    const { getTokenizer } = await import(pathToFileURL(join(ROOT, "dist", "tokenizer.js")).href);
    const countTokens = (t) => getTokenizer("claude-local").countTokens(t);
    const { accepted, rejected } = await qualifyAll(candidates, {
      cachePath: args.qualifyCache, now: Date.now(), countTokens,
    });
    const selected = sampleCandidates(accepted, args.seed, args.suiteSize).sort((a, b) => (a.repo < b.repo ? -1 : 1));
    const suiteOut = args.suiteOut || join(ROOT, "docs", "survey-suite.txt");
    writeFileSync(suiteOut, suiteFileText({ month, accepted, selected, rejected, args, candidateCount: candidates.length }));
    const rejOut = suiteOut.replace(/\.txt$/, "") + "-rejections.txt";
    const report = rejectionReport({ rejected, accepted, selected, candidateCount: candidates.length });
    writeFileSync(
      rejOut,
      [`# qualify-stage rejections — ${month}`, ...report.split("\n").map((l) => "# " + l), "",
        ...[...rejected].sort((a, b) => (a.repo < b.repo ? -1 : 1)).map((r) => `${r.repo} # ${r.reason}`), ""].join("\n"),
    );
    console.error(`\n${report}\nwrote ${suiteOut} and ${rejOut}`);
    if (args.qualifyOnly) return;
    candidates = selected.map((r) => r.repo);
  } else if (args.qualifyOnly) {
    console.error("--qualify-only does not combine with --suite.");
    process.exit(2);
  }

  // --- sample ---
  const sample = args.suite || args.qualify
    ? candidates
    : sampleCandidates(candidates, args.seed, args.limit);
  console.error(`${args.suite || args.qualify ? "mapping" : "sampled"} ${sample.length} of ${candidates.length} candidates (seed "${args.seed}")`);

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
      agg, skips, small, suite: !!(args.suite || args.qualify),
    });
    const how = patchReadme(join(ROOT, "README.md"), block);
    console.error(`README.md: ${how} survey block`);
  }

  console.error("");
  console.error(`done: ${agg.reposMapped} mapped, ${skips.length} skipped.`);
  console.error(`  redundant %: median ${agg.redundantTokenPctMedian}, mean ${agg.redundantTokenPctMean}`);
  console.error(`  value-conflict repos: ${agg.valueConflictRepos}/${agg.reposMapped} (${agg.valueConflictRepoRatePct}%)`);
  console.error(`  median resolved stack: per repo ${agg.medianOfRepoMedianStackTokens}, pooled ${agg.medianResolvedStackTokens} tokens`);
  console.error(`  over-budget repos: ${agg.overBudgetRepos}/${agg.reposMapped} (${agg.overBudgetRepoRatePct}%)`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
