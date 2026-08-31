import { test } from "node:test";
import assert from "node:assert/strict";
import { FENCE, fencedFlags, fencedLineSet } from "./findings/_fence.js";

/** Sorted array form, easier to assert against. */
function inside(src: string): number[] {
  return [...fencedLineSet(src.split("\n"))].sort((a, b) => a - b);
}

test("backtick fence: open and close lines and body are all 'inside'", () => {
  assert.deepEqual(inside("a\n```\ncode\n```\nb"), [1, 2, 3]);
});

test("tilde fence works the same as backtick", () => {
  assert.deepEqual(inside("a\n~~~\ncode\n~~~\nb"), [1, 2, 3]);
});

test("a backtick run does not close a tilde fence (and vice versa)", () => {
  // ~~~ opens; ``` is body, not a close; the trailing ~~~ closes.
  assert.deepEqual(inside("~~~\n```\nstill code\n~~~\nout"), [0, 1, 2, 3]);
});

test("the opener marker is normalized to 3 chars: any same-char run of >= 3 closes", () => {
  // ``` opens; ```` (longer) closes.
  assert.deepEqual(inside("```\nx\n````\nout"), [0, 1, 2]);
  // ```` opens; ``` (shorter) still closes -- the stored marker is always ```.
  assert.deepEqual(inside("````\nx\n```\nstill"), [0, 1, 2]);
});

test("indented fences are recognized on open and close", () => {
  assert.deepEqual(inside("a\n  ```\n  code\n  ```\nb"), [1, 2, 3]);
});

test("an info string on the opening fence is fine; a bare marker still closes", () => {
  assert.deepEqual(inside("```ts\nconst a = 1;\n```\nafter"), [0, 1, 2]);
});

test("an unterminated fence swallows the rest of the file", () => {
  assert.deepEqual(inside("before\n```\none\ntwo"), [1, 2, 3]);
});

test("fencedFlags is the boolean-array view of fencedLineSet", () => {
  const lines = "a\n```\ncode\n```\nb".split("\n");
  const set = fencedLineSet(lines);
  assert.deepEqual(
    fencedFlags(lines),
    lines.map((_, i) => set.has(i)),
  );
});

test("FENCE matches the opener shapes and rejects short runs and inline spans", () => {
  assert.ok(FENCE.test("```"));
  assert.ok(FENCE.test("~~~~ ruby"));
  assert.ok(FENCE.test("   ```"));
  assert.ok(!FENCE.test("`` not a fence"));
  assert.ok(!FENCE.test("text ``` mid-line"));
});
