import { test } from "node:test";
import assert from "node:assert/strict";
import { analyzeEntry } from "../analyze.js";
import { DEFAULT_CONFIG } from "../config.js";
import { fixture } from "../testutil.js";

test("monorepo/services/api: parent/child duplication finding with both locations and a token cost", () => {
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
