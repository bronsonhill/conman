import { test } from "node:test";
import assert from "node:assert/strict";
import { analyzeEntry } from "../analyze.js";
import { loadConfig } from "../config.js";
import { evaluateGate } from "../gate.js";
import { fixture } from "../testutil.js";

test("per-file-budget: a file over budget.perFile is one warn finding naming the file, tokens, and cap", () => {
  const root = fixture("per-file-budget");
  const { config } = loadConfig(root, root);
  const { analysis } = analyzeEntry(root, { repoRoot: root, config });
  const pf = analysis.findings.filter((f) => f.type === "per-file-budget");
  assert.equal(pf.length, 1);
  assert.equal(pf[0]!.severity, "warn");
  assert.equal(pf[0]!.detail?.["cap"], 150);
  assert.equal(pf[0]!.detail?.["file"], "CLAUDE.md");
  assert.equal(pf[0]!.locations[0]!.file, "CLAUDE.md");
  assert.match(pf[0]!.message, /over the 150-token per-file budget/);
  // warn only: the gate still passes.
  assert.equal(evaluateGate(analysis, config).pass, true);
});

test("per-file-budget: gate 'error' makes it fail the gate; 'off' disables it", () => {
  const root = fixture("per-file-budget");
  const { config } = loadConfig(root, root);
  const err = analyzeEntry(root, {
    repoRoot: root,
    config: { ...config, gate: { ...config.gate, "per-file-budget": "error" as const } },
  }).analysis;
  assert.equal(err.findings.find((f) => f.type === "per-file-budget")!.severity, "error");
  assert.equal(
    evaluateGate(err, { ...config, gate: { ...config.gate, "per-file-budget": "error" as const } })
      .pass,
    false,
  );

  const off = analyzeEntry(root, {
    repoRoot: root,
    config: { ...config, gate: { ...config.gate, "per-file-budget": "off" as const } },
  }).analysis;
  assert.deepEqual(off.findings.filter((f) => f.type === "per-file-budget"), []);
});

test("budget-cap-override: raising budget.perFile above the file cost clears the finding", () => {
  const root = fixture("budget-cap-override");
  const { config } = loadConfig(root, root);
  assert.equal(config.budget.perFile, 5000, "conman.json override is read");
  const { analysis } = analyzeEntry(root, { repoRoot: root, config });
  assert.deepEqual(analysis.findings.filter((f) => f.type === "per-file-budget"), []);
});

test("skill-index-budget: a listing over budget.skillIndex is one warn finding at the skills root", () => {
  const root = fixture("skill-index-budget");
  const { config } = loadConfig(root, root);
  const { analysis } = analyzeEntry(root, { repoRoot: root, config });
  const si = analysis.findings.filter((f) => f.type === "skill-index-budget");
  assert.equal(si.length, 1);
  assert.equal(si[0]!.severity, "warn");
  assert.equal(si[0]!.detail?.["cap"], 40);
  assert.equal(si[0]!.detail?.["tokens"], analysis.totals.skillIndexTokens);
  assert.equal(si[0]!.locations[0]!.file, ".claude/skills");
  assert.match(si[0]!.message, /over the 40-token skill-index budget/);
  assert.equal(evaluateGate(analysis, config).pass, true);

  // Raising the cap above the listing cost clears it.
  const clear = analyzeEntry(root, {
    repoRoot: root,
    config: { ...config, budget: { ...config.budget, skillIndex: 5000 } },
  }).analysis;
  assert.deepEqual(clear.findings.filter((f) => f.type === "skill-index-budget"), []);
});
