import { test } from "node:test";
import assert from "node:assert/strict";
import { analyzeEntry } from "../analyze.js";
import { DEFAULT_CONFIG } from "../config.js";
import { fixture } from "../testutil.js";

test("clean fixture produces no findings", () => {
  const root = fixture("clean");
  const { analysis } = analyzeEntry(root, { repoRoot: root, config: DEFAULT_CONFIG });
  assert.deepEqual(analysis.findings, []);
});

test("no-regression: the pre-existing fixtures raise none of the three new finding types", () => {
  const cases: [string, string[]][] = [
    ["monorepo", ["services", "api"]],
    ["monorepo", []],
    ["rule-entry", []],
    ["rule-scope-keys", ["app", "api"]],
    ["clean", []],
    ["imports", []],
    ["frontmatter-broken", []],
    ["single-file", ["notes.md"]],
    ["sibling-dup", []],
    ["sibling-clean", []],
  ];
  const NEW = new Set([
    "lint-duplication",
    "stale-boilerplate",
    "dead-reference",
    "max-skills",
    "per-file-budget",
    "skill-index-budget",
  ]);
  for (const [name, sub] of cases) {
    const root = fixture(name);
    const { analysis } = analyzeEntry(fixture(name, ...sub), {
      repoRoot: root,
      config: DEFAULT_CONFIG,
    });
    assert.deepEqual(
      analysis.findings.filter((f) => NEW.has(f.type)),
      [],
      `${name} should raise no new-type finding`,
    );
  }
});

test("analysis is deterministic byte-for-byte", () => {
  const root = fixture("monorepo");
  const a = analyzeEntry(fixture("monorepo", "services", "api"), {
    repoRoot: root,
    config: DEFAULT_CONFIG,
  });
  const b = analyzeEntry(fixture("monorepo", "services", "api"), {
    repoRoot: root,
    config: DEFAULT_CONFIG,
  });
  assert.equal(JSON.stringify(a.analysis), JSON.stringify(b.analysis));
});
