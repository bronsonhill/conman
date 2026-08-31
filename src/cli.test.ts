import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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

/** Run the CLI expecting a non-zero exit; return { status, stderr }. */
function runFail(args: string[]): { status: number; stderr: string } {
  try {
    execFileSync(process.execPath, [CLI, ...args], { encoding: "utf8", stdio: "pipe" });
  } catch (err) {
    const e = err as { status?: number; stderr?: string };
    return { status: e.status ?? -1, stderr: e.stderr ?? "" };
  }
  throw new Error("expected a non-zero exit");
}

test("validateArgs: --map outside `check` is rejected", () => {
  const { status, stderr } = runFail(["some/dir", "--map"]);
  assert.equal(status, 2);
  assert.match(stderr, /--map is only valid with `conman check`/);
});

test("validateArgs: --trim on `map` is rejected", () => {
  const { status, stderr } = runFail(["map", "--trim"]);
  assert.equal(status, 2);
  assert.match(stderr, /--trim is an analyze-only flag/);
});

test("validateArgs: --dry-run without --fix is rejected", () => {
  const { status, stderr } = runFail(["some/dir", "--dry-run"]);
  assert.equal(status, 2);
  assert.match(stderr, /--dry-run has no effect without --fix/);
});

test("validateArgs: --fix with `check` is rejected", () => {
  const { status, stderr } = runFail(["check", "--fix"]);
  assert.equal(status, 2);
  assert.match(stderr, /--fix is not valid with `conman check`/);
});

test("validateArgs: --html without map is rejected", () => {
  const { status, stderr } = runFail(["some/dir", "--html", "out.html"]);
  assert.equal(status, 2);
  assert.match(stderr, /--html is only valid with/);
});

test("validateArgs: explain rejects analysis flags", () => {
  const { status, stderr } = runFail(["explain", "duplication", "--fix"]);
  assert.equal(status, 2);
  assert.match(stderr, /explain takes no analysis flags/);
});

test("validateArgs: non-numeric --budget is rejected", () => {
  const { status, stderr } = runFail(["some/dir", "--budget", "lots"]);
  assert.equal(status, 2);
  assert.match(stderr, /--budget expects a number/);
});

test("conman.json syntax errors name the file and quote the parser", () => {
  const root = mkdtempSync(join(tmpdir(), "conman-badcfg-"));
  try {
    writeFileSync(join(root, "conman.json"), "{ budget: { total: }, ");
    const { status, stderr } = runFail([root, "--repo-root", root]);
    assert.equal(status, 2);
    assert.match(stderr, /conman\.json is not valid JSON5:/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("conman.json with a non-object top level is rejected", () => {
  const root = mkdtempSync(join(tmpdir(), "conman-arrcfg-"));
  try {
    writeFileSync(join(root, "conman.json"), "[1, 2, 3]");
    const { status, stderr } = runFail([root, "--repo-root", root]);
    assert.equal(status, 2);
    assert.match(stderr, /must contain a JSON object at the top level, got an array/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

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
