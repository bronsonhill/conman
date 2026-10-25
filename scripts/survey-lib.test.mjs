// Predicate tests for scripts/survey-lib.mjs on hand-built inputs. No network.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  THRESHOLDS, aggregate, borderlineFlags, checkMeta, checkProject, collectionHint, fileKind, findAtImports,
  parseRepoList, projectStats, rejectionCounts, rootMemoryEntry, rootStack, settingsChangesResolution,
  structuralFeatures, suiteLine, summariseRepo,
} from "./survey-lib.mjs";

const NOW = Date.parse("2026-10-25T00:00:00Z");
const daysAgo = (n) => new Date(NOW - n * 86_400_000).toISOString();
const meta = (o = {}) => ({
  full_name: "acme/widget", fork: false, archived: false, is_template: false,
  stargazers_count: 120, pushed_at: daysAgo(10), topics: [], ...o,
});
// ~1 token per word is close enough for threshold tests.
const words = (text) => text.split(/\s+/).filter(Boolean).length;

test("checkMeta: accepts a live, adopted project", () => {
  assert.equal(checkMeta(meta(), NOW), null);
});

test("checkMeta: rejects fork, archived, template flag, in that order", () => {
  assert.equal(checkMeta(meta({ fork: true, archived: true }), NOW), "fork");
  assert.equal(checkMeta(meta({ archived: true, is_template: true }), NOW), "archived");
  assert.equal(checkMeta(meta({ is_template: true }), NOW), "template-flag");
});

test("checkMeta: star floor is inclusive at 50", () => {
  assert.equal(checkMeta(meta({ stargazers_count: 50 }), NOW), null);
  assert.equal(checkMeta(meta({ stargazers_count: 49 }), NOW), "stars<50");
});

test("checkMeta: staleness cutoff is 183 days, inclusive", () => {
  assert.equal(checkMeta(meta({ pushed_at: daysAgo(183) }), NOW), null);
  assert.match(checkMeta(meta({ pushed_at: daysAgo(184) }), NOW), /^stale/);
  assert.match(checkMeta(meta({ pushed_at: "" }), NOW), /^stale/);
});

test("collectionHint: names and topics", () => {
  assert.equal(collectionHint("x/awesome-claude-code"), "name:awesome");
  assert.equal(collectionHint("x/my-starter-kit"), "name:starter");
  assert.equal(collectionHint("x/next-template"), "name:template");
  assert.equal(collectionHint("x/claude-skills"), "name:skills");
  assert.equal(collectionHint("x/widget", ["awesome-list"]), "topic:awesome-list");
  assert.equal(collectionHint("x/widget", ["typescript", "cli"]), null);
  // substrings inside a word do not match
  assert.equal(collectionHint("x/templater"), null);
  assert.equal(collectionHint("x/skillset-api"), null);
});

test("checkMeta: a collection hint rejects before the star check", () => {
  assert.match(checkMeta(meta({ full_name: "x/awesome-agents", stargazers_count: 5 }), NOW), /^collection-hint \(name:awesome\)/);
});

test("fileKind: vendored, binary, and generated files are ignored", () => {
  assert.equal(fileKind("src/a.ts"), "source");
  assert.equal(fileKind("docs/a.md"), "doc");
  assert.equal(fileKind("config.yaml"), "other");
  assert.equal(fileKind("node_modules/x/index.js"), "ignored");
  assert.equal(fileKind("public/logo.png"), "ignored");
  assert.equal(fileKind("static/app.min.js"), "ignored");
  assert.equal(fileKind("package-lock.json"), "other"); // json counts; only *.lock is ignored
  assert.equal(fileKind("Cargo.lock"), "ignored");
});

const many = (n, mk) => Array.from({ length: n }, (_, i) => mk(i));

test("projectStats + checkProject: a normal project passes", () => {
  const paths = [...many(40, (i) => `src/m${i}.ts`), ...many(10, (i) => `docs/d${i}.md`), "package.json", ".claude/skills/a/SKILL.md"];
  const s = projectStats(paths);
  assert.equal(s.sourceFiles, 40);
  assert.equal(s.totalFiles, 52);
  assert.equal(s.sourceShare, 0.769);
  assert.equal(s.agentShare, 0.019);
  assert.equal(checkProject(s), null);
});

test("checkProject: a markdown dump fails on source share", () => {
  const paths = [...many(200, (i) => `notes/n${i}.md`), ...many(12, (i) => `scripts/s${i}.py`)];
  assert.match(checkProject(projectStats(paths)), /^collection \(source share 6% < 30%\)/);
});

test("checkProject: a skills/prompts dump with scripts fails on agent-dir share", () => {
  const paths = [
    ...many(30, (i) => `skills/s${i}/helper.py`),
    ...many(30, (i) => `skills/s${i}/SKILL.md`),
    ...many(10, (i) => `src/a${i}.py`),
  ];
  const s = projectStats(paths);
  assert.ok(s.sourceShare >= THRESHOLDS.minSourceShare);
  assert.match(checkProject(s), /^collection \(agent-dir share 86% > 40%\)/);
});

test("checkProject: too few source files", () => {
  assert.match(checkProject(projectStats(many(9, (i) => `a${i}.ts`))), /only 9 source files/);
  assert.equal(checkProject(projectStats(many(10, (i) => `a${i}.ts`))), null);
});

test("findAtImports: skips fences, inline code, and home-dir imports", () => {
  const text = ["See @docs/a.md and @AGENTS.md.", "`@nope.md` inline", "```", "@fenced.md", "```", "@~/global.md", "email me@x.com"].join("\n");
  assert.deepEqual(findAtImports(text), ["docs/a.md", "AGENTS.md."]);
});

test("rootMemoryEntry: a bare AGENTS.md does not load", () => {
  assert.equal(rootMemoryEntry([{ path: "AGENTS.md", mode: "100644" }]), null);
  assert.deepEqual(rootMemoryEntry([{ path: "CLAUDE.md", mode: "100644" }]), { path: "CLAUDE.md", symlink: false });
  assert.deepEqual(rootMemoryEntry([{ path: ".claude/CLAUDE.md", mode: "100644" }]), { path: ".claude/CLAUDE.md", symlink: false });
  assert.equal(rootMemoryEntry([{ path: "CLAUDE.md", mode: "120000" }]).symlink, true);
});

const reader = (files) => (p) => (p in files ? files[p] : null);

test("rootStack: counts a plain CLAUDE.md", () => {
  const r = rootStack({ path: "CLAUDE.md", symlink: false }, ["CLAUDE.md"], reader({ "CLAUDE.md": "one two three" }), words);
  assert.equal(r.tokens, 3);
  assert.deepEqual(r.files, ["CLAUDE.md"]);
});

test("rootStack: follows a CLAUDE.md -> AGENTS.md symlink", () => {
  const files = { "CLAUDE.md": "AGENTS.md", "AGENTS.md": "alpha beta gamma delta" };
  const r = rootStack({ path: "CLAUDE.md", symlink: true }, ["CLAUDE.md", "AGENTS.md"], reader(files), words);
  assert.equal(r.tokens, 4);
  assert.deepEqual(r.files, ["AGENTS.md"]);
});

test("rootStack: a dangling symlink loads nothing", () => {
  const r = rootStack({ path: "CLAUDE.md", symlink: true }, ["CLAUDE.md"], reader({ "CLAUDE.md": "gone.md" }), words);
  assert.equal(r.tokens, 0);
});

test("rootStack: adds depth-1 @-imports that exist in the tree, ignores ones that do not", () => {
  const files = { "CLAUDE.md": "@AGENTS.md @docs/guide.md @missing.md", "AGENTS.md": "a b c", "docs/guide.md": "d e" };
  const r = rootStack({ path: "CLAUDE.md", symlink: false }, Object.keys(files), reader(files), words);
  assert.deepEqual(r.imports, ["AGENTS.md", "docs/guide.md"]);
  assert.equal(r.tokens, 3 + 3 + 2);
});

test("structuralFeatures: counts each kind, nested and not root", () => {
  const paths = [
    "CLAUDE.md", ".claude/CLAUDE.md", "api/CLAUDE.md", "web/CLAUDE.md", "node_modules/p/CLAUDE.md",
    ".claude/rules/style.md", ".claude/rules/sub/db.md", "web/.claude/rules/x.md",
    ".claude/skills/a/SKILL.md", ".claude/skills/a/notes.md",
  ];
  assert.deepEqual(structuralFeatures(paths, { memoryPath: "CLAUDE.md" }), {
    "nested-claude-md": 2, rules: 3, skills: 1,
  });
});

test("structuralFeatures: a root @AGENTS.md pointer is not layering; a real import is", () => {
  assert.deepEqual(structuralFeatures([], { memoryPath: "CLAUDE.md", imports: ["AGENTS.md"] }), {});
  assert.deepEqual(structuralFeatures([], { memoryPath: "CLAUDE.md", imports: ["AGENTS.md", "docs/arch.md"] }), { "@-imports": 1 });
});

test("settingsChangesResolution: only resolution keys count", () => {
  assert.equal(settingsChangesResolution('{"claudeMdExcludes":["a/**"]}'), true);
  assert.equal(settingsChangesResolution('{"claudeMd":{"excludes":["a"]}}'), true);
  assert.equal(settingsChangesResolution('{"skills":{"listingBudget":2000}}'), true);
  assert.equal(settingsChangesResolution('{"permissions":{"allow":["Bash(ls)"]},"env":{}}'), false);
  assert.equal(settingsChangesResolution("not json"), false);
  assert.deepEqual(structuralFeatures([], { memoryPath: "CLAUDE.md", settingsText: '{"skillListingBudget":100}' }), { "settings-keys": 1 });
});

test("borderlineFlags: flags near-threshold picks only", () => {
  const base = { rootTokens: 2000, stars: 400, ageDays: 20, stats: { sourceShare: 0.7, agentShare: 0.05 }, features: { rules: 2, skills: 1 } };
  assert.deepEqual(borderlineFlags(base), []);
  const flags = borderlineFlags({ ...base, rootTokens: 520, stars: 55, ageDays: 170, features: { "settings-keys": 1 } });
  assert.equal(flags.length, 4);
  assert.match(flags[0], /520 tok/);
  assert.match(flags[3], /only structural feature is settings-keys/);
});

test("suiteLine: names features and carries the borderline comment", () => {
  const r = { repo: "a/b", features: { rules: 4, skills: 1 }, rootTokens: 900, stars: 61, stats: { sourceShare: 0.52 }, borderline: [] };
  assert.equal(suiteLine(r), "a/b # features: rules x4, skills; root 900 tok; 61 stars; source 52%");
  assert.match(suiteLine({ ...r, borderline: ["61 stars, near the 50 floor"] }), / # borderline: 61 stars, near the 50 floor$/);
  // the line still parses as a repo list entry
  assert.deepEqual(parseRepoList(suiteLine({ ...r, borderline: ["x"] }) + "\n# c\n\nnot a repo\n"), ["a/b"]);
});

test("rejectionCounts: groups by code, most common first", () => {
  const rej = ["fork", "stars<50", "stars<50", "collection (source share 6% < 30%)", "collection (only 3 source files)", "collection (x)"].map((reason) => ({ reason }));
  assert.deepEqual(rejectionCounts(rej), [["collection", 3], ["stars", 2], ["fork", 1]]);
});

// --- aggregation -----------------------------------------------------------

const mapOf = (sizes, { over = 0, redundant = 0 } = {}) => ({
  entryPoints: sizes.map((n, i) => ({
    stackTokens: n,
    redundant: { tokens: i === 0 ? redundant : 0 },
    budget: { overBudget: i < over },
    findings: [],
  })),
});

test("summariseRepo: per-repo median of entry-point stacks", () => {
  const s = summariseRepo("a/b", mapOf([100, 300, 200], { over: 1, redundant: 30 }));
  assert.equal(s.medianStackTokens, 200);
  assert.equal(s.stackTokens, 600);
  assert.equal(s.overBudgetEntryPoints, 1);
  assert.equal(s.redundantPct, 5);
});

test("aggregate: one huge repo moves pooled numbers but not per-repo ones", () => {
  const small = [1, 2, 3, 4].map((i) => summariseRepo(`s/r${i}`, mapOf([1000, 1200])));
  const huge = summariseRepo("h/huge", mapOf(Array(100).fill(20000), { over: 100 }));
  const agg = aggregate([...small, huge]);
  assert.equal(agg.reposMapped, 5);
  assert.equal(agg.entryPoints, 108);
  // pooled: 100 of 108 entry points are the huge repo
  assert.equal(agg.medianResolvedStackTokens, 20000);
  assert.equal(agg.overBudgetEntryPointRatePct, 92.6);
  assert.equal(agg.largestRepoEntryPointSharePct, 92.6);
  // per repo: the huge repo is one vote in five
  assert.equal(agg.medianOfRepoMedianStackTokens, 1100);
  assert.equal(agg.overBudgetRepoRatePct, 20);
  assert.equal(agg.repoWeightedOverBudgetEntryPointPct, 20);
});

test("aggregate: repo-level redundancy rate", () => {
  const a = summariseRepo("a/a", mapOf([100], { redundant: 10 }));
  const b = summariseRepo("b/b", mapOf([100]));
  const agg = aggregate([a, b]);
  assert.equal(agg.redundantRepos, 1);
  assert.equal(agg.redundantRepoRatePct, 50);
});
