import { test } from "node:test";
import assert from "node:assert/strict";
import { analyzeEntry } from "../analyze.js";
import { DEFAULT_CONFIG } from "../config.js";
import { fixture } from "../testutil.js";

test("lint-dup: prose that restates .prettierrc keys raises one lint-duplication warn per rule", () => {
  const root = fixture("lint-dup");
  const { analysis } = analyzeEntry(root, { repoRoot: root, config: DEFAULT_CONFIG });
  const ld = analysis.findings.filter((f) => f.type === "lint-duplication");
  assert.deepEqual(
    ld.map((f) => f.detail?.["rule"]).sort(),
    ["indent-spaces", "line-length", "quotes-single", "semi-omit"],
  );
  assert.ok(ld.every((f) => f.severity === "warn"));
  assert.ok(ld.every((f) => f.detail?.["config"] === ".prettierrc"));
});

test("lint-clean: config present, prose does not restate it, no lint-duplication finding", () => {
  const root = fixture("lint-clean");
  const { analysis } = analyzeEntry(root, { repoRoot: root, config: DEFAULT_CONFIG });
  assert.deepEqual(analysis.findings.filter((f) => f.type === "lint-duplication"), []);
});

test("lint-duplication: gate.lint-duplication = 'off' disables the check", () => {
  const root = fixture("lint-dup");
  const config = {
    ...DEFAULT_CONFIG,
    gate: { ...DEFAULT_CONFIG.gate, "lint-duplication": "off" as const },
  };
  const { analysis } = analyzeEntry(root, { repoRoot: root, config });
  assert.deepEqual(analysis.findings.filter((f) => f.type === "lint-duplication"), []);
});
