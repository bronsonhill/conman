// Model-anchor coupling test.
//
// The anchor facts — model version, anchored Claude Code release, verification
// date — are written in four places that must agree:
//
//   - MODEL_VERSION           (src/types.ts)
//   - ANCHOR.version/.verified (src/anchor.ts)
//   - MODEL.md's "Accurate as of" line ("Claude Code vX, verified YYYY-MM-DD")
//   - MODEL.md's "`X.Y` today" prose and the "## Model version history" head
//
// Until now this was enforced by a code comment and a contributor checklist
// only: a PR that bumps MODEL_VERSION and the goldens but forgets a MODEL.md
// line ships green. This test closes that gap. No production code depends on it.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { REPO_ROOT } from "./testutil.js";
import { ANCHOR } from "./anchor.js";
import { MODEL_VERSION } from "./types.js";

const modelMd = readFileSync(join(REPO_ROOT, "MODEL.md"), "utf8");

function match(re: RegExp): RegExpMatchArray {
  const m = modelMd.match(re);
  assert.ok(m, `MODEL.md has no match for ${re}`);
  return m!;
}

test("MODEL.md 'Accurate as of' line agrees with ANCHOR", () => {
  const m = match(
    /\*\*Claude Code (v[0-9][0-9.]*), verified ([0-9]{4}-[0-9]{2}-[0-9]{2})\.\*\*/,
  );
  assert.equal(m[1], ANCHOR.version, "Accurate-as-of version vs ANCHOR.version");
  assert.equal(m[2], ANCHOR.verified, "Accurate-as-of date vs ANCHOR.verified");
});

test("MODEL.md '`X.Y` today' prose agrees with MODEL_VERSION", () => {
  const v = match(/`([0-9]+\.[0-9]+)` today/)[1];
  assert.equal(v, MODEL_VERSION, "'X.Y today' prose vs MODEL_VERSION");
});

test("MODEL.md version-history head agrees with MODEL_VERSION", () => {
  const head = match(/## Model version history\s*\n+\s*- \*\*([0-9]+\.[0-9]+)\*\*/)[1];
  assert.equal(head, MODEL_VERSION, "version-history head vs MODEL_VERSION");
});
