import { test } from "node:test";
import assert from "node:assert/strict";
import { cpSync, existsSync, mkdtempSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { analyzeEntry } from "./analyze.js";
import { computeTrim } from "./trim.js";
import { parentFile } from "./fix.js";
import { DEFAULT_CONFIG } from "./config.js";
import { fixture } from "./testutil.js";

function staged(name: string): string {
  const dir = mkdtempSync(join(tmpdir(), "conman-trim-"));
  cpSync(fixture(name), dir, { recursive: true });
  return dir;
}

test("computeTrim ranks the redundant whole-file copy and keeps the parent", () => {
  const root = staged("trim-dup");
  try {
    const entry = join(root, "pkg");
    const { analysis } = analyzeEntry(entry, { repoRoot: root, config: DEFAULT_CONFIG });
    const trim = computeTrim(root, analysis);

    assert.equal(trim.deletions.length, 1);
    assert.equal(trim.deletions[0]!.file, "pkg/CLAUDE.md");
    assert.equal(trim.deletions[0]!.keeper, "CLAUDE.md");
    assert.ok(trim.tokens > 0);
    assert.match(trim.diff, /^diff --git a\/pkg\/CLAUDE\.md b\/pkg\/CLAUDE\.md$/m);
    assert.match(trim.diff, /\+\+\+ \/dev\/null/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the emitted diff applies with git apply and a second run is a no-op", () => {
  const root = staged("trim-dup");
  try {
    execFileSync("git", ["init", "-q"], { cwd: root });
    execFileSync("git", ["add", "-A"], { cwd: root });
    execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "init"], {
      cwd: root,
    });

    const entry = join(root, "pkg");
    const first = analyzeEntry(entry, { repoRoot: root, config: DEFAULT_CONFIG });
    const trim = computeTrim(root, first.analysis);
    execFileSync("git", ["apply"], { cwd: root, input: trim.diff });

    assert.ok(!existsSync(join(root, "pkg", "CLAUDE.md")), "redundant copy removed");
    assert.ok(existsSync(join(root, "CLAUDE.md")), "keeper retained");

    const second = analyzeEntry(entry, { repoRoot: root, config: DEFAULT_CONFIG });
    const again = computeTrim(root, second.analysis);
    assert.deepEqual(again.deletions, []);
    assert.equal(again.diff, "");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("keeper: CLAUDE.md wins over a sibling AGENTS.md, parent wins over child", () => {
  assert.equal(parentFile(["sub/AGENTS.md", "sub/CLAUDE.md"]), "sub/CLAUDE.md");
  assert.equal(parentFile(["a/b/CLAUDE.md", "CLAUDE.md"]), "CLAUDE.md");
  assert.equal(parentFile(["b/CLAUDE.md", "a/CLAUDE.md"]), "a/CLAUDE.md");
});
