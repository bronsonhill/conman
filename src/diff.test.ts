import { test } from "node:test";
import assert from "node:assert/strict";
import { unifiedDiff } from "./diff.js";

test("no change yields an empty diff", () => {
  assert.equal(unifiedDiff("a\nb\n", "a\nb\n", "f"), "");
});

test("a single deleted line shows as a - line with context", () => {
  const out = unifiedDiff("keep\ndrop\nkeep2\n", "keep\nkeep2\n", "f.md");
  assert.ok(out.startsWith("--- a/f.md\n+++ b/f.md\n@@ -1,4 +1,3 @@\n"));
  assert.ok(out.includes("\n-drop\n"));
  assert.ok(out.includes("\n keep\n"));
});

test("replacement shows both - and +", () => {
  const out = unifiedDiff("x\nold\n", "x\nnew\n", "f");
  assert.ok(out.includes("\n-old\n"));
  assert.ok(out.includes("\n+new\n"));
});
