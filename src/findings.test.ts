import { test } from "node:test";
import assert from "node:assert/strict";
import { analyzeEntry } from "./analyze.js";
import { DEFAULT_CONFIG } from "./config.js";
import { fixture } from "./testutil.js";

test("monorepo/services/api: duplication + value conflict, both with locations", () => {
  const root = fixture("monorepo");
  const { analysis } = analyzeEntry(fixture("monorepo", "services", "api"), {
    repoRoot: root,
    config: DEFAULT_CONFIG,
  });

  const dup = analysis.findings.find((f) => f.type === "duplication");
  assert.ok(dup, "expected a duplication finding");
  assert.equal(dup!.locations.length, 2);
  assert.deepEqual(
    dup!.locations.map((l) => l.file).sort(),
    ["CLAUDE.md", "services/api/CLAUDE.md"],
  );
  assert.ok((dup!.tokens ?? 0) > 0, "duplication finding carries a token cost");

  const conflict = analysis.findings.find((f) => f.type === "value-conflict");
  assert.ok(conflict, "expected a value-conflict finding");
  assert.equal(conflict!.detail?.["key"], "node version");
  assert.deepEqual(conflict!.detail?.["values"], ["20", "22"]);
  assert.equal(conflict!.locations.length, 2);
});

test("clean fixture produces no findings", () => {
  const root = fixture("clean");
  const { analysis } = analyzeEntry(root, { repoRoot: root, config: DEFAULT_CONFIG });
  assert.deepEqual(analysis.findings, []);
});

test("sibling-dup: a byte-identical CLAUDE.md/AGENTS.md pair rolls up to one same-stack finding", () => {
  const root = fixture("sibling-dup");
  const { analysis } = analyzeEntry(root, { repoRoot: root, config: DEFAULT_CONFIG });

  const dups = analysis.findings.filter((f) => f.type === "duplication");
  assert.equal(dups.length, 1, "one rolled-up finding, not one per shared segment");
  const dup = dups[0]!;
  assert.equal(dup.severity, "error");
  assert.equal(dup.detail?.["relation"], "same-stack");
  assert.equal(dup.detail?.["wholeFileDuplicate"], true);
  assert.deepEqual(
    dup.locations.map((l) => l.file).sort(),
    ["AGENTS.md", "CLAUDE.md"],
  );
  assert.ok((dup.tokens ?? 0) > 0, "carries a redundant-token count");
});

test("sibling-clean: distinct sibling files raise no duplication finding", () => {
  const root = fixture("sibling-clean");
  const { analysis } = analyzeEntry(root, { repoRoot: root, config: DEFAULT_CONFIG });
  assert.equal(
    analysis.findings.filter((f) => f.type === "duplication").length,
    0,
  );
});

test("monorepo parent/child duplication is tagged relation: parent-child", () => {
  const root = fixture("monorepo");
  const { analysis } = analyzeEntry(fixture("monorepo", "services", "api"), {
    repoRoot: root,
    config: DEFAULT_CONFIG,
  });
  const dup = analysis.findings.find((f) => f.type === "duplication");
  assert.ok(dup);
  assert.equal(dup!.detail?.["relation"], "parent-child");
  assert.ok(!dup!.detail?.["wholeFileDuplicate"], "a partial overlap, not a whole-file rollup");
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
