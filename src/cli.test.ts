import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { preferredKeeper } from "./fix.js";
import { fixture, REPO_ROOT } from "./testutil.js";

const CLI = join(REPO_ROOT, "dist", "cli.js");

function stage(name: string): string {
  const dir = mkdtempSync(join(tmpdir(), "conman-cli-"));
  cpSync(fixture(name), dir, { recursive: true });
  return dir;
}

function run(args: string[]): string {
  return execFileSync(process.execPath, [CLI, ...args], { encoding: "utf8" });
}

test("map --fix applies fixes across every discovered entry point", () => {
  const root = stage("monorepo");
  try {
    const out = run(["map", root, "--repo-root", root, "--fix"]);
    // no longer a silent no-op
    assert.match(out, /^fixed /m);
    assert.match(out, /fixed services\/api\/CLAUDE\.md/);

    // the child dedupe actually landed on disk
    const child = readFileSync(join(root, "services", "api", "CLAUDE.md"), "utf8");
    assert.ok(!child.includes("Keep changes scoped to one package per PR."));
    // a skill file discovered from the root entry point was fixed too
    const alpha = readFileSync(join(root, ".claude", "skills", "alpha", "SKILL.md"), "utf8");
    assert.ok(alpha.indexOf("description:") < alpha.indexOf("name:"));

    // idempotent: a second pass reports nothing
    const again = run(["map", root, "--repo-root", root, "--fix"]);
    assert.match(again, /no mechanical fixes to apply/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("leaf-path --fix warns before rewriting files above the entry point", () => {
  const root = stage("monorepo");
  try {
    const out = run([
      join(root, "services", "api"),
      "--repo-root",
      root,
      "--fix",
      "--dry-run",
    ]);
    assert.match(out, /warning: services\/api\/ inherits from ancestor context files/);
    assert.match(out, /^ {2}\.claude\/skills\/alpha\/SKILL\.md$/m);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("preferredKeeper keeps CLAUDE.md over AGENTS.md deterministically", () => {
  assert.equal(preferredKeeper(["sub/AGENTS.md", "sub/CLAUDE.md"]), "sub/CLAUDE.md");
  assert.equal(preferredKeeper(["sub/CLAUDE.md", "sub/AGENTS.md"]), "sub/CLAUDE.md");
  // no CLAUDE.md present: AGENTS.md wins over an arbitrary third file
  assert.equal(preferredKeeper(["z/AGENTS.md", "a/other.md"]), "z/AGENTS.md");
  // neither memory name: lexicographically first
  assert.equal(preferredKeeper(["b/x.md", "a/y.md"]), "a/y.md");
});
