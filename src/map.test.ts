import { test } from "node:test";
import assert from "node:assert/strict";
import { discoverEntryPoints, globToEntryDir, runMap } from "./map.js";
import { DEFAULT_CONFIG } from "./config.js";
import { fixture } from "./testutil.js";

// --- entry-point discovery via path-scoped rules ---------------------------
//
// `conman map` used to find only directories with a CLAUDE.md / AGENTS.md.
// A directory that is an entry point solely because a `.claude/rules/` file
// path-scopes to it (via `paths`) was missed — the shape that made `map` on
// Motrix report only the repo root and skip `src/main` / `src/renderer`.

const RULE_ENTRY = fixture("rule-entry");

function discovered(root: string) {
  const entries = discoverEntryPoints(root, DEFAULT_CONFIG);
  const byPath = new Map(entries.map((e) => [e.path, e.discovery]));
  return { paths: entries.map((e) => e.path), byPath };
}

test("a path-scoped rule makes its target directory an entry point with no memory file", () => {
  const { paths, byPath } = discovered(RULE_ENTRY);
  // src/main and src/renderer hold only a .gitkeep; they are entry points only
  // because .claude/rules/{main,renderer}.md scope `src/main/**` / `src/renderer/**`.
  assert.ok(paths.includes("src/main"), "src/main discovered");
  assert.ok(paths.includes("src/renderer"), "src/renderer discovered");
  assert.deepEqual(byPath.get("src/main"), ["rule-path"]);
  assert.deepEqual(byPath.get("src/renderer"), ["rule-path"]);
});

test("Motrix regression shape: a `src/**`-style scoped rule resolves to the `src` entry", () => {
  const { paths, byPath } = discovered(RULE_ENTRY);
  assert.ok(paths.includes("src"), "the src/** rule prefix resolves to src/");
  assert.deepEqual(byPath.get("src"), ["rule-path"]);
});

test("a glob one level below a directory resolves to that directory", () => {
  // docs-files.md scopes `docs/*.md`; docs/ has no memory file.
  const { paths, byPath } = discovered(RULE_ENTRY);
  assert.ok(paths.includes("docs"));
  assert.deepEqual(byPath.get("docs"), ["rule-path"]);
});

test("a keyless rule and a `**`-scoped rule spawn no phantom entries", () => {
  const { paths } = discovered(RULE_ENTRY);
  // keyless.md has no `paths`; root-scoped.md has `paths: ["**"]`. Neither adds
  // an entry point, so discovery stays at exactly this set.
  assert.deepEqual(paths, [
    ".",
    "docs",
    "pkg/cli",
    "pkg/core",
    "src",
    "src/main",
    "src/renderer",
    "src/webview",
  ]);
});

test("a rule in a `.claude/rules/` subdirectory scopes its target directory", () => {
  // Claude Code walks `.claude/rules/` recursively, so `.claude/rules/nested/
  // webview.md` (paths: src/webview/**) must make src/webview an entry point.
  const { paths, byPath } = discovered(RULE_ENTRY);
  assert.ok(paths.includes("src/webview"), "src/webview discovered from a nested rule");
  assert.deepEqual(byPath.get("src/webview"), ["rule-path"]);
});

test("a brace list in `paths` yields one entry point per alternative", () => {
  // brace.md scopes `pkg/{cli,core}/**`. Claude Code expands that into
  // `pkg/cli/**` and `pkg/core/**`, so discovery must add both directories,
  // not a single literal `pkg`.
  const { paths, byPath } = discovered(RULE_ENTRY);
  assert.ok(paths.includes("pkg/cli"), "pkg/cli discovered from the brace list");
  assert.ok(paths.includes("pkg/core"), "pkg/core discovered from the brace list");
  assert.ok(!paths.includes("pkg"), "no literal `pkg` entry point");
  assert.deepEqual(byPath.get("pkg/cli"), ["rule-path"]);
  assert.deepEqual(byPath.get("pkg/core"), ["rule-path"]);
});

test("a rule scoping a path that is not on disk invents no entry point", () => {
  // missing.md scopes `packages/nowhere/**`; neither directory exists.
  const { paths } = discovered(RULE_ENTRY);
  assert.ok(!paths.some((p) => p.startsWith("packages")));
});

test("the repo root is always an entry point, tagged root plus its memory file", () => {
  const { byPath } = discovered(RULE_ENTRY);
  assert.deepEqual(byPath.get("."), ["memory-file", "root"]);
});

test("--agent copilot: an instructions file's applyTo scopes a directory entry point", () => {
  const root = fixture("copilot");
  const entries = discoverEntryPoints(root, DEFAULT_CONFIG, "copilot");
  const byPath = new Map(entries.map((e) => [e.path, e.discovery]));
  // src/frontend holds only component.tsx; it is an entry point only because
  // .github/instructions/frontend.instructions.md has applyTo: src/frontend/**.
  assert.ok(byPath.has("src/frontend"), "src/frontend discovered");
  assert.deepEqual(byPath.get("src/frontend"), ["rule-path"]);
});

test("discovery is deterministic and sorted", () => {
  const a = discoverEntryPoints(RULE_ENTRY, DEFAULT_CONFIG).map((e) => e.path);
  const b = discoverEntryPoints(RULE_ENTRY, DEFAULT_CONFIG).map((e) => e.path);
  assert.deepEqual(a, b);
  assert.deepEqual(a, [...a].sort());
});

test("runMap analyzes the rule-discovered entry points and carries the discovery tag", () => {
  const result = runMap(RULE_ENTRY, DEFAULT_CONFIG);
  const main = result.entries.find((e) => e.entry === "src/main");
  assert.ok(main, "src/main is analyzed");
  assert.deepEqual(main!.discovery, ["rule-path"]);
  assert.equal(main!.analysis.entry, "src/main");
  // a scoped rule reaching under src/ resolves into the src/main stack
  assert.ok(
    main!.analysis.blocks.some(
      (b) => b.kind === "rule-scoped" && b.source.endsWith("broad.md"),
    ),
    "the src/** rule resolves into the src/main stack",
  );
});

test("a memory-file directory that a rule also targets is tagged with both", () => {
  // monorepo: services/ has services/CLAUDE.md and is scoped by backend.md (services/**).
  const { byPath } = discovered(fixture("monorepo"));
  assert.deepEqual(byPath.get("services"), ["memory-file", "rule-path"]);
});

// --- glob -> entry directory rule -----------------------------------------

test("globToEntryDir: longest literal prefix that names an existing directory", () => {
  const g = (p: string) => globToEntryDir(RULE_ENTRY, p);
  assert.equal(g("src/renderer/**"), "src/renderer");
  assert.equal(g("src/**"), "src");
  assert.equal(g("src/*/index.ts"), "src");
  assert.equal(g("docs/*.md"), "docs");
  assert.equal(g("./src/**"), "src", "a leading ./ is stripped");
  assert.equal(g("src/{main,renderer}/**"), "src", "a brace list ends the prefix");
});

test("globToEntryDir: a bare or wildcard-first glob resolves to nothing", () => {
  const g = (p: string) => globToEntryDir(RULE_ENTRY, p);
  assert.equal(g("**"), null);
  assert.equal(g("*.md"), null);
  assert.equal(g(""), null);
});

test("globToEntryDir: a file-scoped glob drops to its containing directory", () => {
  assert.equal(globToEntryDir(RULE_ENTRY, "docs/GUIDE.md"), "docs");
});

test("globToEntryDir: a prefix that is not on disk resolves to nothing", () => {
  assert.equal(globToEntryDir(RULE_ENTRY, "packages/nowhere/**"), null);
});
