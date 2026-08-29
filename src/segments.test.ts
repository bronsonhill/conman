import { test } from "node:test";
import assert from "node:assert/strict";
import { splitSegments } from "./segments.js";

const tok = { name: "fake", countTokens: (s: string) => s.split(/\s+/).filter(Boolean).length };

test("splits on blank lines, keeps absolute line numbers", () => {
  const text = "first para line\nstill first\n\nsecond para";
  const segs = splitSegments("f.md", text, 1, tok);
  assert.equal(segs.length, 2);
  assert.deepEqual(
    segs.map((s) => [s.lineStart, s.lineEnd]),
    [
      [1, 2],
      [4, 4],
    ],
  );
});

test("a heading starts a new segment; a lone heading is headingOnly", () => {
  const text = "intro line\n## A heading\n\nbody after";
  const segs = splitSegments("f.md", text, 10, tok);
  assert.equal(segs.length, 3);
  assert.equal(segs[0]!.text, "intro line");
  assert.equal(segs[1]!.headingOnly, true);
  assert.equal(segs[1]!.lineStart, 11);
  assert.equal(segs[2]!.text, "body after");
});

test("a fenced block is one segment and blank lines inside do not split it", () => {
  const text = "```js\nconst a = 1;\n\nconst b = 2;\n```\nafter";
  const segs = splitSegments("f.md", text, 1, tok);
  assert.equal(segs.length, 2);
  assert.equal(segs[0]!.fenced, true);
  assert.equal(segs[0]!.lineStart, 1);
  assert.equal(segs[0]!.lineEnd, 5);
  assert.equal(segs[1]!.text, "after");
});
