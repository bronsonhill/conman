// Corpus regression sweep: run `conman map` over every pinned fixture repo whose
// clone is present, assert it resolves crash-free, and diff a compact digest
// (entry-point count, token totals, over-budget count, findings-by-type) against
// the committed baseline in test/corpus-digest.json.
//
//   npm run test:corpus            # fetch the fast subset, then sweep it
//   npm run test:corpus:all        # fetch every fixture, then sweep all of them
//   npm run test:corpus:update     # regenerate test/corpus-digest.json
//
// Not part of `npm test`: it needs the fixture clones (fetched on demand, see
// fixtures/README.md) and posthog/ruflo take a few seconds each.
//
// The baseline is generated on Linux (the `full-sweep` job in
// .github/workflows/corpus.yml). A case-insensitive dev filesystem (macOS)
// over-discovers entry points from lowercase `claude.md` / `agents.md` files in
// the firstmate and ruflo fixtures, so those two repos' records will not match a
// local macOS run - that is expected; CI is the gate. On Linux the digest is
// deterministic per conman build (every fixture is SHA-pinned), so when the
// numbers move it is because findings logic changed: regenerate the baseline
// from the CI `corpus-digest` artifact in the same commit.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  manifestRepos,
  mapRepo,
  digestRepo,
  corpusAggregate,
  buildDigest,
} from "../scripts/corpus-digest.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const BASELINE = join(ROOT, "test", "corpus-digest.json");
const REPOS_DIR = join(ROOT, "fixtures", "repos");
const UPDATE = process.env["UPDATE_CORPUS_DIGEST"] === "1";
const REQUIRE_ALL = process.env["CONMAN_CORPUS_REQUIRE_ALL"] === "1";

const allRepos = manifestRepos();
const present = allRepos.filter((n) => existsSync(join(REPOS_DIR, n)));

if (UPDATE) {
  test("regenerate corpus digest baseline", () => {
    assert.ok(present.length > 0, "no fixture clones present to build a digest from");
    writeFileSync(BASELINE, JSON.stringify(buildDigest(), null, 2) + "\n");
  });
} else if (present.length === 0) {
  test("corpus sweep (skipped: no fixture clones)", { skip: true }, () => {});
} else {
  const baseline = JSON.parse(readFileSync(BASELINE, "utf8"));
  const byRepo = new Map(baseline.repos.map((r) => [r.repo, r]));

  if (REQUIRE_ALL) {
    test("every manifest fixture is cloned", () => {
      assert.deepEqual(present, allRepos, "missing clones; run scripts/fetch-fixtures.sh");
    });
  }

  // Map each present repo once; per-repo tests assert crash-free + digest match,
  // and the aggregate test reuses these maps instead of re-resolving.
  const liveMaps = [];
  const liveRepos = [];
  for (const name of present) {
    test(`conman map resolves ${name} crash-free and matches the digest`, () => {
      const map = mapRepo(name); // throws on non-zero exit
      assert.ok(Array.isArray(map.entryPoints), "map produced no entryPoints array");
      const live = digestRepo(name, map);
      const want = byRepo.get(name);
      assert.ok(want, `${name} has no baseline record; run npm run test:corpus:update`);
      assert.deepEqual(live, want);
      liveMaps.push(map);
      liveRepos.push(live);
    });
  }

  // The corpus aggregate (the README numbers) is only meaningful with the whole
  // pinned set present.
  test("corpus aggregate matches the baseline", {
    skip: present.length !== allRepos.length,
  }, () => {
    assert.equal(liveRepos.length, allRepos.length, "per-repo tests did not all run");
    assert.deepEqual(corpusAggregate(liveRepos, liveMaps), baseline.corpus);
  });
}
