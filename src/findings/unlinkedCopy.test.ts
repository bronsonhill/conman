import { test } from "node:test";
import assert from "node:assert/strict";
import { analyzeEntry } from "../analyze.js";
import { DEFAULT_CONFIG } from "../config.js";
import { fixture } from "../testutil.js";

test("sibling-dup: a byte-identical CLAUDE.md/AGENTS.md pair is one unlinked-copy warn, no duplication", () => {
  const root = fixture("sibling-dup");
  const { analysis } = analyzeEntry(root, { repoRoot: root, config: DEFAULT_CONFIG });

  // The bare AGENTS.md is not stack cost, so it is not a duplication finding.
  assert.equal(
    analysis.findings.filter((f) => f.type === "duplication").length,
    0,
    "a bare AGENTS.md is not loaded, so nothing loads twice",
  );

  const copies = analysis.findings.filter((f) => f.type === "unlinked-copy");
  assert.equal(copies.length, 1, "one finding for the pair");
  const copy = copies[0]!;
  assert.equal(copy.severity, "warn", "maintainability smell, not a gate failure");
  assert.deepEqual(
    copy.locations.map((l) => l.file).sort(),
    ["AGENTS.md", "CLAUDE.md"],
  );
  assert.match(copy.message, /replace one with a symlink/);
  assert.equal(copy.tokens, undefined, "not a token cost: the copy never loads");

  // The AGENTS.md tokens stay out of the resolved stack entirely.
  assert.ok(
    !analysis.blocks.some((b) => b.source === "AGENTS.md"),
    "AGENTS.md is not a block",
  );
});

test("sibling-dup: warn-only, so `conman check` still passes on it", () => {
  const root = fixture("sibling-dup");
  const { analysis } = analyzeEntry(root, { repoRoot: root, config: DEFAULT_CONFIG });
  assert.equal(
    analysis.findings.filter((f) => f.severity === "error").length,
    0,
  );
});

test("sibling-clean: sibling files with different content raise nothing", () => {
  const root = fixture("sibling-clean");
  const { analysis } = analyzeEntry(root, { repoRoot: root, config: DEFAULT_CONFIG });
  assert.deepEqual(analysis.findings, []);
});

test("sibling-symlink: CLAUDE.md -> AGENTS.md loads once and raises nothing", () => {
  const root = fixture("sibling-symlink");
  const { analysis } = analyzeEntry(root, { repoRoot: root, config: DEFAULT_CONFIG });
  assert.deepEqual(analysis.findings, [], "the recommended layout is silent");
  const memory = analysis.blocks.filter((b) => b.kind === "memory");
  assert.equal(memory.length, 1, "the shared content is counted exactly once");
});

test("agents-only: a bare AGENTS.md raises nothing and costs nothing", () => {
  const root = fixture("agents-only");
  const { analysis } = analyzeEntry(root, { repoRoot: root, config: DEFAULT_CONFIG });
  assert.deepEqual(analysis.findings, []);
  assert.equal(analysis.totals.stackTokens, 0, "Claude Code loads nothing here");
});
