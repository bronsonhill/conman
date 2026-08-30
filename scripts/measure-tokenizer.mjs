// One-off measurement: how far does the offline `claude-local` estimate drift
// from Anthropic's `count_tokens` API?
//
// Not part of the build or the test suite. Needs ANTHROPIC_API_KEY and network.
// Run after `npm run build`:
//
//   ANTHROPIC_API_KEY=... node scripts/measure-tokenizer.mjs [<root> ...]
//
// With no args it measures the pinned corpus under fixtures/repos/ if present,
// otherwise the synthetic mini-repos under test/fixtures/. Prints a per-block
// and per-stack distribution of (local - exact) / exact.

import { readdirSync, existsSync, statSync } from "node:fs";
import { resolve, join } from "node:path";
import { execFileSync } from "node:child_process";
import { discoverEntryPoints } from "../dist/map.js";
import { analyzeEntry } from "../dist/analyze.js";
import { loadConfig } from "../dist/config.js";
import { getTokenizer } from "../dist/tokenizer.js";

const REPO_ROOT = resolve(new URL("..", import.meta.url).pathname);

function corpusRoots() {
  const dir = join(REPO_ROOT, "fixtures", "repos");
  if (!existsSync(dir)) return null;
  const names = readdirSync(dir).filter((n) => {
    const p = join(dir, n);
    return statSync(p).isDirectory() && existsSync(join(p, ".git"));
  });
  return names.length ? names.map((n) => join(dir, n)) : null;
}

function fixtureRoots() {
  const dir = join(REPO_ROOT, "test", "fixtures");
  return readdirSync(dir)
    .map((n) => join(dir, n))
    .filter((p) => statSync(p).isDirectory());
}

function gitSha(root) {
  try {
    return execFileSync("git", ["-C", root, "rev-parse", "--short", "HEAD"], {
      encoding: "utf8",
    }).trim();
  } catch {
    return "(no-git)";
  }
}

const local = getTokenizer("claude-local");
const exact = getTokenizer("exact"); // throws here if ANTHROPIC_API_KEY is unset

const roots =
  process.argv.slice(2).length > 0
    ? process.argv.slice(2).map((p) => resolve(p))
    : corpusRoots() ?? fixtureRoots();

const usingCorpus = corpusRoots() !== null && process.argv.slice(2).length === 0;

const blockRatios = [];
const blockRatiosBig = []; // blocks >= 20 local tokens, where framing noise is small
const stackRatios = [];
let blockCount = 0;
let stackCount = 0;
const sources = [];

for (const root of roots) {
  const sha = gitSha(root);
  sources.push(`${root.replace(REPO_ROOT + "/", "")} @ ${sha}`);
  let cfg;
  try {
    cfg = loadConfig(root, root).config;
  } catch (e) {
    console.error(`skip ${root}: ${e.message}`);
    continue;
  }
  let points;
  try {
    points = discoverEntryPoints(root, cfg);
  } catch (e) {
    console.error(`skip ${root}: ${e.message}`);
    continue;
  }
  for (const pt of points) {
    let analysis;
    try {
      analysis = analyzeEntry(pt.abs, { repoRoot: root, config: cfg, tokenizer: local }).analysis;
    } catch (e) {
      console.error(`skip ${root} :: ${pt.path}: ${e.message}`);
      continue;
    }
    if (analysis.blocks.length === 0) continue;
    let stackLocal = 0;
    let stackExact = 0;
    for (const b of analysis.blocks) {
      const l = b.tokens; // local count, already in the block
      const x = exact.countTokens(b.text);
      if (x > 0) {
        blockRatios.push((l - x) / x);
        if (l >= 20) blockRatiosBig.push((l - x) / x);
        blockCount++;
      }
      stackLocal += l;
      stackExact += x;
    }
    if (stackExact > 0) {
      stackRatios.push((stackLocal - stackExact) / stackExact);
      stackCount++;
    }
  }
}

function stats(xs) {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  const mean = s.reduce((n, v) => n + v, 0) / s.length;
  const q = (p) => s[Math.min(s.length - 1, Math.floor(p * (s.length - 1)))];
  return {
    n: s.length,
    mean,
    median: q(0.5),
    p90: q(0.9),
    min: s[0],
    max: s[s.length - 1],
  };
}

function pct(x) {
  return `${(x * 100).toFixed(2)}%`;
}

function line(label, st) {
  if (!st) return `${label}: no data`;
  return (
    `${label} (n=${st.n}): ` +
    `mean ${pct(st.mean)}, median ${pct(st.median)}, ` +
    `p90 ${pct(st.p90)}, min ${pct(st.min)}, max ${pct(st.max)}`
  );
}

console.log("");
console.log(`corpus: ${usingCorpus ? "fixtures/repos (pinned)" : "test/fixtures (synthetic)"}`);
console.log("sources:");
for (const s of sources) console.log(`  ${s}`);
console.log("");
console.log(`exact model: ${process.env.CONMAN_EXACT_MODEL || "claude-opus-5"}`);
console.log("metric: (local - exact) / exact   [positive => local overcounts]");
console.log(line("per block (all)", stats(blockRatios)));
console.log(line("per block (>=20 tok)", stats(blockRatiosBig)));
console.log(line("per stack", stats(stackRatios)));
console.log("");
console.log(`blocks measured: ${blockCount}, stacks measured: ${stackCount}`);
