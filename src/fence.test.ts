import { test } from "node:test";
import assert from "node:assert/strict";
import {
  FENCE,
  fencedFlags,
  fencedLineSet,
  inlineCodeSpans,
  maskInlineCode,
} from "./findings/_fence.js";

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

test("maskInlineCode blanks a simple single-backtick span, delimiters included", () => {
  const out = maskInlineCode(["see `@foo/bar` here"]);
  assert.equal(out[0], "see " + " ".repeat(10) + " here");
  assert.equal(out[0]!.length, "see `@foo/bar` here".length);
});

test("maskInlineCode leaves prose and length untouched", () => {
  const out = maskInlineCode(["plain @foo/bar line"]);
  assert.deepEqual(out, ["plain @foo/bar line"]);
});

test("maskInlineCode matches backtick runs by length", () => {
  // A single backtick inside a ``-delimited span does not close it.
  const out = maskInlineCode(["a ``x `@y` z`` b"]);
  assert.equal(out[0], "a" + " ".repeat(13) + " b");
  assert.ok(!out[0]!.includes("@y"));
});

test("maskInlineCode: an opener with no matching closer is literal text", () => {
  assert.deepEqual(maskInlineCode(["a ` @foo/bar and on"]), ["a ` @foo/bar and on"]);
});

test("maskInlineCode: a span that wraps across lines is blanked on every line", () => {
  const lines = ["start `code span", "still @foo/bar in span` end"];
  const masked = maskInlineCode(lines);
  assert.equal(masked[0], "start           ");
  assert.ok(!masked[1]!.includes("@foo/bar"));
  assert.ok(masked[1]!.endsWith(" end"));
  assert.equal(masked[0]!.length, lines[0]!.length);
  assert.equal(masked[1]!.length, lines[1]!.length);
});

test("maskInlineCode: wekan CLAUDE.md:516 case from issue #36", () => {
  const lines = [
    "- FerretDB Upcoming structure — `### New Features 🎉`, `### Fixed 🐛`, `### Other Changes",
    "  🤖`; entries end `... by @xet7. Thanks to xet7.`",
  ];
  const masked = maskInlineCode(lines);
  assert.ok(!masked[1]!.includes("@xet7"), "@xet7 must be inside a masked span");
  assert.equal(masked[0]!.length, lines[0]!.length);
  assert.equal(masked[1]!.length, lines[1]!.length);
});

test("maskInlineCode: backticks inside a fenced block do not open a span", () => {
  const lines = ["`@a/b`", "```", "`@c/d", "```", "`@e/f`"];
  const masked = maskInlineCode(lines);
  assert.ok(!masked[0]!.includes("@a/b"));
  assert.equal(masked[2], "`@c/d"); // fenced line passed through verbatim
  assert.ok(!masked[4]!.includes("@e/f"));
});

test("inlineCodeSpans returns interior text and the opening line for each span", () => {
  const spans = inlineCodeSpans(["run `npm run lint` then `src/index.ts` ok"]);
  assert.deepEqual(spans, [
    { line: 0, text: "npm run lint" },
    { line: 0, text: "src/index.ts" },
  ]);
});

test("inlineCodeSpans matches backtick runs by length and skips unclosed openers", () => {
  assert.deepEqual(inlineCodeSpans(["a ``x `y` z`` b"]), [{ line: 0, text: "x `y` z" }]);
  assert.deepEqual(inlineCodeSpans(["a ` unclosed"]), []);
});

test("inlineCodeSpans: a span wrapping across lines is reported once on its opening line", () => {
  const spans = inlineCodeSpans(["intro `docs/arch", "notes.md` tail"]);
  assert.deepEqual(spans, [{ line: 0, text: "docs/arch\nnotes.md" }]);
});

test("inlineCodeSpans: backticks inside a fenced block open no span", () => {
  assert.deepEqual(inlineCodeSpans(["```", "`src/x.ts`", "```", "`src/y.ts`"]), [
    { line: 3, text: "src/y.ts" },
  ]);
});

test("maskInlineCode: a lone backtick does not pair across a blank line", () => {
  // The bug this guards: scanning the file as one string let the stray backtick
  // on line 0 close against the opener of the real span on line 2, unmasking
  // `@foo/bar.md` and reintroducing the issue-#36 false positive.
  const lines = ["Use the ` character with care.", "", "See `@foo/bar.md` for details."];
  const masked = maskInlineCode(lines);
  assert.equal(masked[0], lines[0], "the unpaired backtick line is literal text");
  assert.ok(!masked[2]!.includes("@foo/bar.md"), "the real span is still masked");
});

test("maskInlineCode: a span does not pair across a fenced block", () => {
  const lines = ["opener ` here", "```", "code", "```", "closer ` @foo/bar.md there"];
  const masked = maskInlineCode(lines);
  assert.equal(masked[0], lines[0]);
  assert.equal(masked[4], lines[4]);
});

test("inlineCodeSpans: pairing is bounded to one paragraph", () => {
  assert.deepEqual(inlineCodeSpans(["a ` b", "", "c ` d"]), []);
  // Within one paragraph the wrap still works.
  assert.deepEqual(inlineCodeSpans(["a `b", "c` d"]), [{ line: 0, text: "b\nc" }]);
});

test("FENCE matches the opener shapes and rejects short runs and inline spans", () => {
  assert.ok(FENCE.test("```"));
  assert.ok(FENCE.test("~~~~ ruby"));
  assert.ok(FENCE.test("   ```"));
  assert.ok(!FENCE.test("`` not a fence"));
  assert.ok(!FENCE.test("text ``` mid-line"));
});
