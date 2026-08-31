import { test } from "node:test";
import assert from "node:assert/strict";
import { computeBudget } from "./coster.js";
import { DEFAULT_CONFIG } from "./config.js";
import type { Totals } from "./types.js";

const totals = (stackTokens: number): Totals => ({
  stackTokens,
  perFile: {},
  skillIndexTokens: 0,
});

test("computeBudget: effective line is total * (1 - safetyMargin), rounded", () => {
  const b = computeBudget(totals(0), DEFAULT_CONFIG);
  // 12000 * 0.9 = 10800
  assert.equal(b.total, 12000);
  assert.equal(b.safetyMargin, 0.1);
  assert.equal(b.effective, 10800);
});

test("computeBudget: rounds the effective line to the nearest integer", () => {
  const cfg = { ...DEFAULT_CONFIG, budget: { ...DEFAULT_CONFIG.budget, total: 999 }, safetyMargin: 0.1 };
  // 999 * 0.9 = 899.1 -> 899
  assert.equal(computeBudget(totals(0), cfg).effective, 899);
});

test("computeBudget: under the effective line is not over budget, delta negative", () => {
  const b = computeBudget(totals(5000), DEFAULT_CONFIG);
  assert.equal(b.stackTotal, 5000);
  assert.equal(b.delta, 5000 - 10800);
  assert.equal(b.overBudget, false);
});

test("computeBudget: exactly on the effective line is not over budget (delta 0)", () => {
  const b = computeBudget(totals(10800), DEFAULT_CONFIG);
  assert.equal(b.delta, 0);
  assert.equal(b.overBudget, false);
});

test("computeBudget: one token over the effective line flips overBudget", () => {
  const b = computeBudget(totals(10801), DEFAULT_CONFIG);
  assert.equal(b.delta, 1);
  assert.equal(b.overBudget, true);
});

test("computeBudget: safetyMargin 0 makes the effective line equal to total", () => {
  const cfg = { ...DEFAULT_CONFIG, safetyMargin: 0 };
  const b = computeBudget(totals(12000), cfg);
  assert.equal(b.effective, 12000);
  assert.equal(b.delta, 0);
  assert.equal(b.overBudget, false);
});
