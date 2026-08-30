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
import { readFileSync, writeFileSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
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
  {
    name: "analyze-monorepo-sarif",
    args: [`${MONO}/services/api`, "--repo-root", MONO, "--format", "sarif"],
  },
  { name: "explain-list", args: ["explain"] },
  { name: "explain-duplication", args: ["explain", "duplication"] },
  { name: "map-monorepo", args: ["map", MONO, "--repo-root", MONO] },
  { name: "map-monorepo-json", args: ["map", MONO, "--repo-root", MONO, "--json"] },
  { name: "map-monorepo-html", args: ["map", MONO, "--repo-root", MONO], html: true },
  {
    name: "check-map-monorepo-html",
    args: ["check", MONO, "--map", "--repo-root", MONO],
    html: true,
  },
  {
    name: "map-rule-entry",
    args: ["map", "test/fixtures/rule-entry", "--repo-root", "test/fixtures/rule-entry"],
  },
  {
    name: "map-rule-entry-json",
    args: ["map", "test/fixtures/rule-entry", "--repo-root", "test/fixtures/rule-entry", "--json"],
  },
  { name: "check-monorepo", args: ["check", `${MONO}/services/api`, "--repo-root", MONO] },
  {
    name: "analyze-frontmatter-broken",
    args: [
      "test/fixtures/frontmatter-broken",
      "--repo-root",
      "test/fixtures/frontmatter-broken",
    ],
  },
  {
    name: "analyze-frontmatter-broken-json",
    args: [
      "test/fixtures/frontmatter-broken",
      "--repo-root",
      "test/fixtures/frontmatter-broken",
      "--json",
    ],
  },
  {
    name: "map-frontmatter-broken",
    args: [
      "map",
      "test/fixtures/frontmatter-broken",
      "--repo-root",
      "test/fixtures/frontmatter-broken",
    ],
  },
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
  {
    name: "map-fix-dryrun-monorepo",
    args: ["map", MONO, "--repo-root", MONO, "--fix", "--dry-run"],
  },
  {
    name: "trim-dup",
    args: [
      "test/fixtures/trim-dup/pkg",
      "--repo-root",
      "test/fixtures/trim-dup",
      "--trim",
    ],
  },
  {
    name: "trim-dup-json",
    args: [
      "test/fixtures/trim-dup/pkg",
      "--repo-root",
      "test/fixtures/trim-dup",
      "--trim",
      "--json",
    ],
  },
  {
    name: "trim-monorepo-noop",
    args: [`${MONO}/services/api`, "--repo-root", MONO, "--trim"],
  },
  {
    name: "analyze-lint-dup",
    args: ["test/fixtures/lint-dup", "--repo-root", "test/fixtures/lint-dup"],
  },
  {
    name: "analyze-stale-init",
    args: ["test/fixtures/stale-init", "--repo-root", "test/fixtures/stale-init"],
  },
  {
    name: "analyze-dead-ref",
    args: ["test/fixtures/dead-ref", "--repo-root", "test/fixtures/dead-ref"],
  },
  {
    name: "analyze-dead-ref-json",
    args: ["test/fixtures/dead-ref", "--repo-root", "test/fixtures/dead-ref", "--json"],
  },
  {
    name: "analyze-codex",
    args: [
      "test/fixtures/agents-only",
      "--repo-root",
      "test/fixtures/agents-only",
      "--agent",
      "codex",
    ],
  },
  {
    name: "analyze-cursor",
    args: [
      "test/fixtures/cursor-rules",
      "--repo-root",
      "test/fixtures/cursor-rules",
      "--agent",
      "cursor",
    ],
  },
  {
    name: "analyze-cursor-json",
    args: [
      "test/fixtures/cursor-rules",
      "--repo-root",
      "test/fixtures/cursor-rules",
      "--agent",
      "cursor",
      "--json",
    ],
  },
  {
    name: "analyze-cursor-frontend",
    args: [
      "test/fixtures/cursor-rules/src/frontend",
      "--repo-root",
      "test/fixtures/cursor-rules",
      "--agent",
      "cursor",
    ],
  },
  {
    name: "map-cursor",
    args: [
      "map",
      "test/fixtures/cursor-rules",
      "--repo-root",
      "test/fixtures/cursor-rules",
      "--agent",
      "cursor",
    ],
  },
  {
    name: "analyze-copilot",
    args: [
      "test/fixtures/copilot",
      "--repo-root",
      "test/fixtures/copilot",
      "--agent",
      "copilot",
    ],
  },
  {
    name: "map-copilot",
    args: [
      "map",
      "test/fixtures/copilot",
      "--repo-root",
      "test/fixtures/copilot",
      "--agent",
      "copilot",
    ],
  },
];

function normalize(s) {
  return s
    .replace(/conman \d+\.\d+\.\d+/g, "conman VERSION")
    .replace(/"version": "\d+\.\d+\.\d+"/g, '"version": "VERSION"');
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
    let code;
    let payload;
    if (c.html) {
      // `--html` writes a file, not stdout. Run it, read the file back, and diff
      // that against the golden. Two runs into two paths also proves the output
      // is byte-identical for identical input.
      const out1 = join(tmpdir(), `conman-golden-${c.name}-1.html`);
      const out2 = join(tmpdir(), `conman-golden-${c.name}-2.html`);
      try {
        run([...c.args, "--html", out1]);
        run([...c.args, "--html", out2]);
        const html1 = readFileSync(out1, "utf8");
        const html2 = readFileSync(out2, "utf8");
        assert.equal(html1, html2, `${c.name}: HTML output differs between two runs`);
        code = 0;
        payload = html1;
      } finally {
        rmSync(out1, { force: true });
        rmSync(out2, { force: true });
      }
    } else {
      const r = run(c.args);
      code = r.code;
      payload = r.stdout;
    }
    const actual = `# exit: ${code}\n` + normalize(payload);
    const goldenPath = join(GOLDEN_DIR, `${c.name}.txt`);

    if (UPDATE || !existsSync(goldenPath)) {
      writeFileSync(goldenPath, actual, "utf8");
      if (UPDATE) return;
    }
    const expected = readFileSync(goldenPath, "utf8");
    assert.equal(actual, expected, `golden mismatch for ${c.name} (UPDATE_GOLDEN=1 to refresh)`);
  });
}
