import { test } from "node:test";
import assert from "node:assert/strict";
import { analyzeEntry } from "../analyze.js";
import { DEFAULT_CONFIG } from "../config.js";
import { fixture } from "../testutil.js";

test("stale-init: the unmodified /init header sentence is one stale-boilerplate warn", () => {
  const root = fixture("stale-init");
  const { analysis } = analyzeEntry(root, { repoRoot: root, config: DEFAULT_CONFIG });
  const sb = analysis.findings.filter((f) => f.type === "stale-boilerplate");
  assert.equal(sb.length, 1);
  assert.equal(sb[0]!.severity, "warn");
  assert.equal(sb[0]!.locations[0]!.file, "CLAUDE.md");
  assert.equal(sb[0]!.locations[0]!.lineStart, 3);
});

test("stale-clean: a rewritten header raises no stale-boilerplate finding", () => {
  const root = fixture("stale-clean");
  const { analysis } = analyzeEntry(root, { repoRoot: root, config: DEFAULT_CONFIG });
  assert.deepEqual(analysis.findings.filter((f) => f.type === "stale-boilerplate"), []);
});
