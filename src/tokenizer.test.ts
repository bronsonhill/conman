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

// The exact path is gated twice: `--tokenizer exact` AND ANTHROPIC_API_KEY in
// the environment. These tests exercise the guard only -- no request is made.
test("exact tokenizer without ANTHROPIC_API_KEY refuses, naming the env var", () => {
  const saved = process.env.ANTHROPIC_API_KEY;
  delete process.env.ANTHROPIC_API_KEY;
  try {
    assert.throws(() => getTokenizer("exact"), /ANTHROPIC_API_KEY/);
  } finally {
    if (saved !== undefined) process.env.ANTHROPIC_API_KEY = saved;
  }
});

test("exact tokenizer with a key constructs without making a call", () => {
  const saved = process.env.ANTHROPIC_API_KEY;
  process.env.ANTHROPIC_API_KEY = "sk-ant-test-not-a-real-key";
  try {
    const t = getTokenizer("exact");
    assert.equal(t.name, "exact");
    // Construction alone must not touch the network; countTokens is not called.
  } finally {
    if (saved === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = saved;
  }
});

test("unknown tokenizer name throws", () => {
  assert.throws(() => getTokenizer("gpt-4"), /unknown tokenizer/);
});
