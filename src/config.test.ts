import { test } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_CONFIG, mergeConfig } from "./config.js";

test("mergeConfig: empty override returns the defaults unchanged", () => {
  assert.deepEqual(mergeConfig(DEFAULT_CONFIG, {}), DEFAULT_CONFIG);
});

test("mergeConfig: does not mutate the base config", () => {
  const snapshot = JSON.stringify(DEFAULT_CONFIG);
  mergeConfig(DEFAULT_CONFIG, {
    budget: { total: 999 },
    gate: { duplication: "off" },
    ignore: ["x"],
  });
  assert.equal(JSON.stringify(DEFAULT_CONFIG), snapshot);
});

test("mergeConfig: budget keys merge individually; junk values are ignored", () => {
  const c = mergeConfig(DEFAULT_CONFIG, {
    budget: { total: 20000, perFile: "nope", skillIndex: Infinity, bogus: 1 },
  });
  assert.equal(c.budget.total, 20000);
  assert.equal(c.budget.perFile, DEFAULT_CONFIG.budget.perFile, "non-number rejected");
  assert.equal(c.budget.skillIndex, DEFAULT_CONFIG.budget.skillIndex, "Infinity rejected");
});

test("mergeConfig: safetyMargin clamps to [0, 0.9]", () => {
  assert.equal(mergeConfig(DEFAULT_CONFIG, { safetyMargin: -1 }).safetyMargin, 0);
  assert.equal(mergeConfig(DEFAULT_CONFIG, { safetyMargin: 5 }).safetyMargin, 0.9);
  assert.equal(mergeConfig(DEFAULT_CONFIG, { safetyMargin: 0.25 }).safetyMargin, 0.25);
  assert.equal(
    mergeConfig(DEFAULT_CONFIG, { safetyMargin: Number.NaN }).safetyMargin,
    DEFAULT_CONFIG.safetyMargin,
    "NaN rejected before the clamp",
  );
});

test("mergeConfig: maxSkills takes non-negative integers only", () => {
  assert.equal(mergeConfig(DEFAULT_CONFIG, { maxSkills: 20 }).maxSkills, 20);
  assert.equal(mergeConfig(DEFAULT_CONFIG, { maxSkills: 0 }).maxSkills, 0);
  assert.equal(
    mergeConfig(DEFAULT_CONFIG, { maxSkills: 3.5 }).maxSkills,
    DEFAULT_CONFIG.maxSkills,
    "fractional rejected",
  );
  assert.equal(
    mergeConfig(DEFAULT_CONFIG, { maxSkills: -2 }).maxSkills,
    DEFAULT_CONFIG.maxSkills,
    "negative rejected",
  );
});

test("mergeConfig: gate accepts known keys with valid severities, drops the rest", () => {
  const c = mergeConfig(DEFAULT_CONFIG, {
    gate: { duplication: "warn", "value-conflict": "loud", unknownKey: "off" },
  });
  assert.equal(c.gate.duplication, "warn");
  assert.equal(c.gate["value-conflict"], DEFAULT_CONFIG.gate["value-conflict"], "bad severity dropped");
  assert.ok(!("unknownKey" in c.gate), "unknown gate key not added");
});

test("mergeConfig: resolve sub-keys are type-guarded; skillListingBudget takes null or a finite number", () => {
  const c = mergeConfig(DEFAULT_CONFIG, {
    resolve: {
      repoBoundary: false,
      importDepthLimit: 2,
      skillListingBudget: 1500,
    },
  });
  assert.equal(c.resolve.repoBoundary, false);
  assert.equal(c.resolve.importDepthLimit, 2);
  assert.equal(c.resolve.skillListingBudget, 1500);

  assert.equal(
    mergeConfig(DEFAULT_CONFIG, { resolve: { skillListingBudget: null } }).resolve
      .skillListingBudget,
    null,
  );
  assert.equal(
    mergeConfig(DEFAULT_CONFIG, { resolve: { importDepthLimit: -1 } }).resolve
      .importDepthLimit,
    DEFAULT_CONFIG.resolve.importDepthLimit,
    "negative depth rejected",
  );
  assert.equal(
    mergeConfig(DEFAULT_CONFIG, { resolve: { skillListingBudget: "big" } }).resolve
      .skillListingBudget,
    DEFAULT_CONFIG.resolve.skillListingBudget,
    "non-number, non-null rejected",
  );
});

test("mergeConfig: ignore replaces wholesale, and only when every element is a string", () => {
  assert.deepEqual(mergeConfig(DEFAULT_CONFIG, { ignore: ["a", "b"] }).ignore, ["a", "b"]);
  assert.deepEqual(
    mergeConfig(DEFAULT_CONFIG, { ignore: ["a", 2] }).ignore,
    DEFAULT_CONFIG.ignore,
    "mixed-type array rejected",
  );
});
