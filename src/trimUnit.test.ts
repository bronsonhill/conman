import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Analysis, Finding } from "./types.js";
import { computeTrim, renderTrimHuman, renderTrimJson } from "./trim.js";

function fakeAnalysis(findings: Finding[], perFile: Record<string, number>): Analysis {
  return {
    modelVersion: "test",
    entry: "pkg",
    tokenizer: "claude-local",
    blocks: [],
    totals: { stackTokens: 0, perFile, skillIndexTokens: 0 },
    budget: {
      total: 0,
      safetyMargin: 0,
      effective: 0,
      stackTotal: 0,
      delta: 0,
      overBudget: false,
    },
    findings,
  } as Analysis;
}

function dupFinding(detail: Record<string, unknown>): Finding {
  return {
    type: "duplication",
    severity: "warn",
    message: "dup",
    locations: [{ file: "CLAUDE.md" }] as Finding["locations"],
    detail,
  };
}

function withRepo(fn: (root: string) => void): void {
  const root = mkdtempSync(join(tmpdir(), "conman-trim-unit-"));
  try {
    fn(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test("computeTrim skips non-duplication and non-wholeFile findings", () => {
  withRepo((root) => {
    const analysis = fakeAnalysis(
      [
        { type: "value-conflict", severity: "warn", message: "x", locations: [{ file: "a" }] as Finding["locations"] },
        dupFinding({ wholeFileDuplicate: false, files: ["a/CLAUDE.md", "CLAUDE.md"] }),
        dupFinding({ wholeFileDuplicate: true, files: ["only/CLAUDE.md"] }),
      ],
      {},
    );
    const trim = computeTrim(root, analysis);
    assert.deepEqual(trim.deletions, []);
    assert.equal(trim.diff, "");
    assert.equal(trim.tokens, 0);
  });
});

test("computeTrim skips missing files and empty files, keeps the parent", () => {
  withRepo((root) => {
    mkdirSync(join(root, "pkg"));
    writeFileSync(join(root, "CLAUDE.md"), "keep me\n");
    writeFileSync(join(root, "pkg", "CLAUDE.md"), "");
    const analysis = fakeAnalysis(
      [
        dupFinding({
          wholeFileDuplicate: true,
          relation: "ancestor",
          files: ["pkg/CLAUDE.md", "CLAUDE.md", "gone/CLAUDE.md"],
        }),
      ],
      {},
    );
    const trim = computeTrim(root, analysis);
    assert.deepEqual(trim.deletions, []);
  });
});

test("computeTrim ranks by tokens then path and totals recoverable tokens", () => {
  withRepo((root) => {
    for (const d of ["a", "b", "c"]) {
      mkdirSync(join(root, d));
      writeFileSync(join(root, d, "CLAUDE.md"), "line one\nline two\n");
    }
    writeFileSync(join(root, "CLAUDE.md"), "line one\nline two\n");
    const analysis = fakeAnalysis(
      [
        dupFinding({
          wholeFileDuplicate: true,
          files: ["a/CLAUDE.md", "b/CLAUDE.md", "c/CLAUDE.md", "CLAUDE.md"],
        }),
      ],
      { "a/CLAUDE.md": 9, "b/CLAUDE.md": 5, "c/CLAUDE.md": 5 },
    );
    const trim = computeTrim(root, analysis);
    assert.deepEqual(
      trim.deletions.map((x) => x.file),
      ["b/CLAUDE.md", "c/CLAUDE.md", "a/CLAUDE.md"],
    );
    assert.equal(trim.deletions[0]!.keeper, "CLAUDE.md");
    assert.equal(trim.deletions[0]!.lines, 2);
    assert.equal(trim.deletions[0]!.relation, "same-stack");
    assert.equal(trim.tokens, 19);
    assert.equal((trim.diff.match(/deleted file mode/g) ?? []).length, 3);
  });
});

test("computeTrim emits a no-newline marker for files without a trailing newline", () => {
  withRepo((root) => {
    mkdirSync(join(root, "pkg"));
    writeFileSync(join(root, "CLAUDE.md"), "x\ny");
    writeFileSync(join(root, "pkg", "CLAUDE.md"), "x\ny");
    const analysis = fakeAnalysis(
      [dupFinding({ wholeFileDuplicate: true, files: ["pkg/CLAUDE.md", "CLAUDE.md"] })],
      { "pkg/CLAUDE.md": 3 },
    );
    const trim = computeTrim(root, analysis);
    assert.equal(trim.deletions[0]!.lines, 2);
    assert.match(trim.diff, /\\ No newline at end of file/);
    assert.match(trim.diff, /@@ -1,2 \+0,0 @@/);
  });
});

test("renderTrimHuman: empty result says nothing to trim", () => {
  const out = renderTrimHuman({ deletions: [], diff: "", tokens: 0 }, "pkg", "9.9.9");
  assert.match(out, /conman 9\.9\.9 {2}trim/);
  assert.match(out, /entry: pkg/);
  assert.match(out, /nothing to trim/);
});

test("renderTrimHuman: ranked deletions, singular file phrasing, blank entry", () => {
  const result = {
    deletions: [
      { file: "pkg/CLAUDE.md", keeper: "CLAUDE.md", tokens: 12, lines: 3, relation: "ancestor" },
    ],
    diff: "diff --git a/pkg/CLAUDE.md b/pkg/CLAUDE.md\n",
    tokens: 12,
  };
  const out = renderTrimHuman(result, "", "1.0.0");
  assert.match(out, /entry: \./);
  assert.match(out, /RANKED DELETIONS/);
  assert.match(out, /12 tok {2}pkg\/CLAUDE\.md/);
  assert.match(out, /keep CLAUDE\.md {2}\[ancestor\]/);
  assert.match(out, /recoverable: 12 tokens across 1 file\b/);
  assert.doesNotMatch(out, /1 files/);
  assert.match(out, /apply with: git apply/);
});

test("renderTrimHuman: plural file phrasing for multiple deletions", () => {
  const result = {
    deletions: [
      { file: "a/CLAUDE.md", keeper: "CLAUDE.md", tokens: 1, lines: 1, relation: "same-stack" },
      { file: "b/CLAUDE.md", keeper: "CLAUDE.md", tokens: 2, lines: 1, relation: "same-stack" },
    ],
    diff: "d\n",
    tokens: 3,
  };
  const out = renderTrimHuman(result, "pkg", "1.0.0");
  assert.match(out, /recoverable: 3 tokens across 2 files/);
});

test("renderTrimJson: shape and field projection", () => {
  const result = {
    deletions: [
      { file: "pkg/CLAUDE.md", keeper: "CLAUDE.md", tokens: 12, lines: 3, relation: "ancestor" },
    ],
    diff: "d\n",
    tokens: 12,
  };
  const parsed = JSON.parse(renderTrimJson(result, "pkg", "1.0.0"));
  assert.equal(parsed.tool, "conman");
  assert.equal(parsed.mode, "trim");
  assert.equal(parsed.tier, 1);
  assert.equal(parsed.entry, "pkg");
  assert.equal(parsed.recoverableTokens, 12);
  assert.deepEqual(parsed.deletions, [
    { file: "pkg/CLAUDE.md", keeper: "CLAUDE.md", relation: "ancestor", tokens: 12, lines: 3 },
  ]);
  assert.equal(parsed.diff, "d\n");
});
