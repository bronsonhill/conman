import { test } from "node:test";
import assert from "node:assert/strict";
import { getTokenizer } from "./tokenizer.js";

test("claude-local is deterministic and non-trivial", () => {
  const t = getTokenizer("claude-local");
  const a = t.countTokens("The quick brown fox jumps over the lazy dog.");
  const b = t.countTokens("The quick brown fox jumps over the lazy dog.");
  assert.equal(a, b);
  assert.ok(a > 5 && a < 20, `expected a sane count, got ${a}`);
  assert.equal(t.countTokens(""), 0);
});

test("exact tokenizer is a seam that refuses to run", () => {
  const t = getTokenizer("exact");
  assert.throws(() => t.countTokens("x"), /not implemented in the MVP/);
});

test("unknown tokenizer name throws", () => {
  assert.throws(() => getTokenizer("gpt-4"), /unknown tokenizer/);
});
