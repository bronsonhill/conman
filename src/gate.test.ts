import { test } from "node:test";
import assert from "node:assert/strict";
import { analyzeEntry } from "./analyze.js";
import { evaluateGate } from "./gate.js";
import { DEFAULT_CONFIG, type Config } from "./config.js";
import { fixture } from "./testutil.js";

function cfg(over: Partial<Config>): Config {
  return { ...DEFAULT_CONFIG, ...over, budget: { ...DEFAULT_CONFIG.budget, ...over.budget } };
}

test("gate fails on an error-severity finding", () => {
  const root = fixture("monorepo");
  const { analysis } = analyzeEntry(fixture("monorepo", "services", "api"), {
    repoRoot: root,
    config: DEFAULT_CONFIG,
  });
  const gate = evaluateGate(analysis, DEFAULT_CONFIG);
  assert.equal(gate.pass, false);
  assert.equal(gate.exitCode, 1);
  assert.ok(gate.reasons.some((r) => r.includes("duplication")));
});

test("gate fails when the stack is over the effective budget", () => {
  const root = fixture("clean");
  const tiny = cfg({ budget: { total: 20, perFile: 20, skillIndex: 20 } });
  const { analysis } = analyzeEntry(root, { repoRoot: root, config: tiny });
  const gate = evaluateGate(analysis, tiny);
  assert.equal(gate.pass, false);
  assert.ok(gate.reasons.some((r) => r.includes("over the effective budget")));
});

test("gate passes on a clean stack under budget", () => {
  const root = fixture("clean");
  const { analysis } = analyzeEntry(root, { repoRoot: root, config: DEFAULT_CONFIG });
  const gate = evaluateGate(analysis, DEFAULT_CONFIG);
  assert.equal(gate.pass, true);
  assert.equal(gate.exitCode, 0);
});
