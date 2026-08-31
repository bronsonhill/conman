import { test } from "node:test";
import assert from "node:assert/strict";
import { analyzeEntry } from "../analyze.js";
import { DEFAULT_CONFIG, loadConfig } from "../config.js";
import { evaluateGate } from "../gate.js";
import { fixture } from "../testutil.js";

test("max-skills: 10 skills in one index is one warn finding naming the count and location", () => {
  const root = fixture("max-skills");
  const { analysis } = analyzeEntry(root, { repoRoot: root, config: DEFAULT_CONFIG });
  const ms = analysis.findings.filter((f) => f.type === "max-skills");
  assert.equal(ms.length, 1);
  assert.equal(ms[0]!.severity, "warn");
  assert.equal(ms[0]!.detail?.["count"], 10);
  assert.match(ms[0]!.message, /lists 10 skills/);
  assert.equal(ms[0]!.locations[0]!.file, ".claude/skills");
});

test("max-skills: 18 skills is an error finding that fails the gate", () => {
  const root = fixture("max-skills-over");
  const { analysis } = analyzeEntry(root, { repoRoot: root, config: DEFAULT_CONFIG });
  const ms = analysis.findings.filter((f) => f.type === "max-skills");
  assert.equal(ms.length, 1);
  assert.equal(ms[0]!.severity, "error");
  assert.equal(ms[0]!.detail?.["count"], 18);
  assert.equal(evaluateGate(analysis, DEFAULT_CONFIG).pass, false);
});

test("max-skills: <= 8 skills raises nothing (monorepo has 3)", () => {
  const root = fixture("monorepo");
  const { analysis } = analyzeEntry(fixture("monorepo", "services", "api"), {
    repoRoot: root,
    config: DEFAULT_CONFIG,
  });
  assert.deepEqual(analysis.findings.filter((f) => f.type === "max-skills"), []);
});

test("max-skills: conman.json maxSkills override lifts the cap so 10 skills is clean", () => {
  const root = fixture("max-skills-override");
  const { config } = loadConfig(root, root);
  assert.equal(config.maxSkills, 20, "conman.json override is read");
  const { analysis } = analyzeEntry(root, { repoRoot: root, config });
  assert.deepEqual(analysis.findings.filter((f) => f.type === "max-skills"), []);

  // Same fixture under the default cap of 8 does fire, proving the override is
  // what silenced it.
  const dflt = analyzeEntry(root, { repoRoot: root, config: DEFAULT_CONFIG }).analysis;
  assert.equal(dflt.findings.filter((f) => f.type === "max-skills").length, 1);
});

test("max-skills: gate ceiling 'warn' caps the >15 case at warn; 'off' disables", () => {
  const root = fixture("max-skills-over");
  const capped = analyzeEntry(root, {
    repoRoot: root,
    config: { ...DEFAULT_CONFIG, gate: { ...DEFAULT_CONFIG.gate, "max-skills": "warn" as const } },
  }).analysis;
  assert.equal(capped.findings.find((f) => f.type === "max-skills")!.severity, "warn");

  const off = analyzeEntry(root, {
    repoRoot: root,
    config: { ...DEFAULT_CONFIG, gate: { ...DEFAULT_CONFIG.gate, "max-skills": "off" as const } },
  }).analysis;
  assert.deepEqual(off.findings.filter((f) => f.type === "max-skills"), []);
});
