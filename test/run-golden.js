// Golden-output tests: run the built CLI against the synthetic fixtures and diff
// stdout + exit code against test/golden/<name>.txt.
//
//   node --test test/run-golden.js        # check
//   UPDATE_GOLDEN=1 node --test test/run-golden.js   # regenerate goldens
//
// The tool version in the first output line is normalized so a version bump does
// not churn every golden.

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const CLI = join(ROOT, "dist", "cli.js");
const GOLDEN_DIR = join(ROOT, "test", "golden");
const UPDATE = process.env["UPDATE_GOLDEN"] === "1";

const MONO = "test/fixtures/monorepo";

/** @type {{name:string, args:string[]}[]} */
const CASES = [
  { name: "analyze-monorepo", args: [`${MONO}/services/api`, "--repo-root", MONO] },
  { name: "analyze-monorepo-json", args: [`${MONO}/services/api`, "--repo-root", MONO, "--json"] },
  { name: "map-monorepo", args: ["map", MONO, "--repo-root", MONO] },
  { name: "map-monorepo-json", args: ["map", MONO, "--repo-root", MONO, "--json"] },
  { name: "check-monorepo", args: ["check", `${MONO}/services/api`, "--repo-root", MONO] },
  { name: "analyze-imports", args: ["test/fixtures/imports", "--repo-root", "test/fixtures/imports"] },
  {
    name: "analyze-single-file",
    args: ["test/fixtures/single-file/notes.md", "--repo-root", "test/fixtures/single-file"],
  },
  { name: "check-clean", args: ["check", "test/fixtures/clean", "--repo-root", "test/fixtures/clean"] },
  {
    name: "fix-dryrun-monorepo",
    args: [`${MONO}/services/api`, "--repo-root", MONO, "--fix", "--dry-run"],
  },
];

function normalize(s) {
  return s.replace(/conman \d+\.\d+\.\d+/g, "conman VERSION");
}

function run(args) {
  try {
    const stdout = execFileSync(process.execPath, [CLI, ...args], {
      cwd: ROOT,
      encoding: "utf8",
    });
    return { code: 0, stdout };
  } catch (err) {
    return { code: err.status ?? 1, stdout: (err.stdout ?? "").toString() };
  }
}

if (!existsSync(GOLDEN_DIR)) mkdirSync(GOLDEN_DIR, { recursive: true });

for (const c of CASES) {
  test(c.name, () => {
    const { code, stdout } = run(c.args);
    const actual = `# exit: ${code}\n` + normalize(stdout);
    const goldenPath = join(GOLDEN_DIR, `${c.name}.txt`);

    if (UPDATE || !existsSync(goldenPath)) {
      writeFileSync(goldenPath, actual, "utf8");
      if (UPDATE) return;
    }
    const expected = readFileSync(goldenPath, "utf8");
    assert.equal(actual, expected, `golden mismatch for ${c.name} (UPDATE_GOLDEN=1 to refresh)`);
  });
}
