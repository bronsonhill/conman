import { test } from "node:test";
import assert from "node:assert/strict";
import { cpSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { diffAnalysis, diffMap, findingKey, type DeltaEntry } from "./delta.js";
import { renderDeltaHuman, renderDeltaJson } from "./deltaReport.js";
import type { Analysis, Finding } from "./types.js";
import { fixture, REPO_ROOT } from "./testutil.js";

const CLI = join(REPO_ROOT, "dist", "cli.js");

function finding(over: Partial<Finding> = {}): Finding {
  return {
    type: "duplication",
    severity: "error",
    message: "identical 27-token block appears in 2 files",
    locations: [
      { file: "api/CLAUDE.md", lineStart: 3, lineEnd: 6 },
      { file: "CLAUDE.md", lineStart: 5, lineEnd: 8 },
    ],
    ...over,
  };
}

function entry(name: string, tokens: number, findings: Finding[] = []): DeltaEntry {
  return {
    entry: name,
    analysis: { totals: { stackTokens: tokens, perFile: {}, skillIndexTokens: 0 }, findings } as unknown as Analysis,
  };
}

test("findingKey ignores line numbers, location order, and whitespace runs", () => {
  const a = finding();
  const b = finding({
    message: "identical  27-token block\nappears in 2 files",
    locations: [
      { file: "CLAUDE.md", lineStart: 40, lineEnd: 43 },
      { file: "api/CLAUDE.md", lineStart: 30, lineEnd: 33 },
    ],
  });
  assert.equal(findingKey(a), findingKey(b));
});

test("findingKey separates severity, type, files, and message", () => {
  const k = findingKey(finding());
  assert.notEqual(k, findingKey(finding({ severity: "warn" })));
  assert.notEqual(k, findingKey(finding({ type: "value-conflict" })));
  assert.notEqual(k, findingKey(finding({ message: "other" })));
  assert.notEqual(k, findingKey(finding({ locations: [{ file: "x.md", lineStart: 1, lineEnd: 2 }] })));
});

test("a finding whose lines shifted is unchanged, not resolved + new", () => {
  const moved = finding({
    locations: [
      { file: "api/CLAUDE.md", lineStart: 13, lineEnd: 16 },
      { file: "CLAUDE.md", lineStart: 25, lineEnd: 28 },
    ],
  });
  const d = diffMap(
    { entries: [entry("api", 100, [finding()])] },
    { entries: [entry("api", 110, [moved])] },
  );
  assert.deepEqual(d.findingsAdded, []);
  assert.deepEqual(d.findingsResolved, []);
  assert.equal(d.result, "grew");
});

test("a severity change counts as resolved + added", () => {
  const d = diffMap(
    { entries: [entry("api", 100, [finding({ severity: "error" })])] },
    { entries: [entry("api", 100, [finding({ severity: "warn" })])] },
  );
  assert.equal(d.findingsAdded.length, 1);
  assert.equal(d.findingsAdded[0]!.severity, "warn");
  assert.equal(d.findingsResolved.length, 1);
  assert.equal(d.findingsResolved[0]!.severity, "error");
  assert.equal(d.result, "unchanged");
});

test("entry points partition into added / removed / common", () => {
  const d = diffMap(
    { entries: [entry("a", 10), entry("gone", 30), entry("same", 5)] },
    { entries: [entry("a", 15), entry("new", 20), entry("same", 5)] },
  );
  assert.deepEqual(d.entryPointsAdded, [{ entry: "new", tokens: 20 }]);
  assert.deepEqual(d.entryPointsRemoved, [{ entry: "gone", tokens: 30 }]);
  assert.deepEqual(d.entryPointDeltas, [{ entry: "a", base: 10, head: 15, delta: 5 }]);
  assert.equal(d.delta.tokens, 40 - 45);
  assert.equal(d.result, "shrank");
  assert.equal(d.delta.entryPoints, 0);
});

test("diffAnalysis treats a missing base as a whole new entry point", () => {
  const head = entry("api", 40).analysis;
  Object.assign(head, { entry: "api" });
  const d = diffAnalysis(null, head);
  assert.deepEqual(d.entryPointsAdded, [{ entry: "api", tokens: 40 }]);
  assert.equal(d.result, "grew");
});

test("identical sides report unchanged and render deterministically", () => {
  const side = { entries: [entry("a", 10, [finding()])] };
  const d = diffMap(side, side);
  assert.equal(d.result, "unchanged");
  const ctx = { toolVersion: "0.0.0", scope: "map" as const, configSource: null };
  assert.equal(renderDeltaHuman(d, ctx), renderDeltaHuman(d, ctx));
  assert.match(renderDeltaHuman(d, ctx), /RESULT {2}unchanged/);
  assert.equal(JSON.parse(renderDeltaJson(d, ctx)).command, "diff");
});

function diffCli(args: string[]): string {
  return execFileSync(process.execPath, [CLI, "diff", ...args], { encoding: "utf8" });
}

test("diff --map over the delta fixture: shifted duplication is unchanged", () => {
  const base = fixture("delta", "base");
  const head = fixture("delta", "head");
  const j = JSON.parse(diffCli([head, "--base-dir", base, "--repo-root", head, "--map", "--json"]));
  assert.equal(j.command, "diff");
  assert.deepEqual(j.entryPointsAdded.map((e: { entry: string }) => e.entry), ["web"]);
  assert.deepEqual(j.entryPointsRemoved.map((e: { entry: string }) => e.entry), ["legacy"]);
  // api/CLAUDE.md's duplication moved down the file but is the same finding.
  const files = (l: { files: string[] }[]) => l.map((f) => f.files.join("+"));
  assert.deepEqual(files(j.findingsAdded), ["CLAUDE.md+web/CLAUDE.md"]);
  assert.deepEqual(files(j.findingsResolved), ["CLAUDE.md+api/CLAUDE.md"]);
});

test("diff single entry compares one entry against the same path in base", () => {
  const base = fixture("delta", "base");
  const head = fixture("delta", "head");
  const j = JSON.parse(diffCli([join(head, "api"), "--base-dir", base, "--repo-root", head, "--json"]));
  assert.equal(j.scope, "entry");
  assert.equal(j.base.entryPoints, 1);
  assert.equal(j.entryPointDeltas[0].entry, "api");
  assert.equal(j.findingsAdded.length, 0);
});

test("diff roots the base analysis at the base dir (dead refs resolve there)", () => {
  const dir = mkdtempSync(join(tmpdir(), "conman-delta-"));
  const base = join(dir, "base");
  const head = join(dir, "head");
  cpSync(fixture("dead-ref"), base, { recursive: true });
  cpSync(fixture("dead-ref"), head, { recursive: true });
  // The referenced file exists only on the base side, so the dead reference is new in head.
  writeFileSync(join(base, "docs", "architecture.md"), "# Architecture\n");
  const j = JSON.parse(diffCli([head, "--base-dir", base, "--repo-root", head, "--map", "--json"]));
  const added = j.findingsAdded.map((f: { message: string }) => f.message).join("\n");
  assert.match(added, /docs\/architecture\.md/);
});

function failure(args: string[]): { status: number; stderr: string } {
  try {
    execFileSync(process.execPath, [CLI, ...args], { encoding: "utf8", stdio: "pipe" });
  } catch (err) {
    const e = err as { status?: number; stderr?: string };
    return { status: e.status ?? -1, stderr: e.stderr ?? "" };
  }
  throw new Error("expected a non-zero exit");
}

test("diff arg validation", () => {
  assert.match(failure(["diff"]).stderr, /diff needs --base-dir/);
  assert.match(failure(["diff", "--base-dir", "x", "--format", "sarif"]).stderr, /sarif is not supported/);
  assert.match(failure(["diff", "--base-dir", "x", "--fix"]).stderr, /diff takes no/);
  assert.match(failure(["check", "--base-dir", "x"]).stderr, /--base-dir is only valid with `conman diff`/);
  const r = failure(["diff", "--base-dir", "/nonexistent-conman-base"]);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /not a directory/);
});
