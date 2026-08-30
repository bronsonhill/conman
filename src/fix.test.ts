import { test } from "node:test";
import assert from "node:assert/strict";
import { cpSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { analyzeEntry } from "./analyze.js";
import { computeFixes, applyFixes } from "./fix.js";
import { DEFAULT_CONFIG } from "./config.js";
import { fixture } from "./testutil.js";

function stagedMonorepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "conman-fix-"));
  cpSync(fixture("monorepo"), dir, { recursive: true });
  return dir;
}

function staged(name: string): string {
  const dir = mkdtempSync(join(tmpdir(), "conman-fix-"));
  cpSync(fixture(name), dir, { recursive: true });
  return dir;
}

test("--fix dedupes the child block, sorts skill keys, and is idempotent", () => {
  const root = stagedMonorepo();
  try {
    const entry = join(root, "services", "api");

    const first = analyzeEntry(entry, { repoRoot: root, config: DEFAULT_CONFIG });
    const fixes = computeFixes(root, first.analysis);
    assert.ok(fixes.changes.length > 0, "expected fixes to apply");
    applyFixes(root, fixes);

    // the duplicated paragraph is gone from the child, still present in the parent
    const child = readFileSync(join(root, "services", "api", "CLAUDE.md"), "utf8");
    const parent = readFileSync(join(root, "CLAUDE.md"), "utf8");
    assert.ok(!child.includes("Keep changes scoped to one package per PR."));
    assert.ok(parent.includes("Keep changes scoped to one package per PR."));

    // skill frontmatter keys are sorted (description before name)
    const alpha = readFileSync(join(root, ".claude", "skills", "alpha", "SKILL.md"), "utf8");
    const dIdx = alpha.indexOf("description:");
    const nIdx = alpha.indexOf("name:");
    assert.ok(dIdx > -1 && nIdx > -1 && dIdx < nIdx);

    // second run is a no-op
    const second = analyzeEntry(entry, { repoRoot: root, config: DEFAULT_CONFIG });
    const again = computeFixes(root, second.analysis);
    assert.deepEqual(again.changes, []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("--fix leaves an unlinked CLAUDE.md/AGENTS.md copy untouched", () => {
  // findings-only: linking the pair means a symlink or an @-import pointer,
  // which is a change of substance --fix does not make.
  const root = staged("sibling-dup");
  try {
    const { analysis } = analyzeEntry(root, { repoRoot: root, config: DEFAULT_CONFIG });
    assert.ok(
      analysis.findings.some((f) => f.type === "unlinked-copy"),
      "the fixture raises an unlinked-copy finding",
    );
    const fixes = computeFixes(root, analysis);
    assert.deepEqual(fixes.changes, [], "no fix is proposed for the unlinked copy");

    const beforeA = readFileSync(join(root, "AGENTS.md"), "utf8");
    const beforeC = readFileSync(join(root, "CLAUDE.md"), "utf8");
    applyFixes(root, fixes);
    assert.equal(readFileSync(join(root, "AGENTS.md"), "utf8"), beforeA);
    assert.equal(readFileSync(join(root, "CLAUDE.md"), "utf8"), beforeC);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("--fix never reports a change when the value conflict is the only issue", () => {
  // value conflicts are semantic; --fix must not touch them
  const root = stagedMonorepo();
  try {
    const entry = join(root, "services", "api");
    const { analysis } = analyzeEntry(entry, { repoRoot: root, config: DEFAULT_CONFIG });
    applyFixes(root, computeFixes(root, analysis));
    const child = readFileSync(join(root, "services", "api", "CLAUDE.md"), "utf8");
    // the conflicting value is left exactly as the author wrote it
    assert.ok(child.includes("`Node version`: 22"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
