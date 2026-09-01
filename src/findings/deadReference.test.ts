import { test } from "node:test";
import assert from "node:assert/strict";
import { analyzeEntry } from "../analyze.js";
import { DEFAULT_CONFIG } from "../config.js";
import { fixture } from "../testutil.js";

test("dead-ref: a missing @-import is error, a missing prose path and script are warn", () => {
  const root = fixture("dead-ref");
  const { analysis } = analyzeEntry(root, { repoRoot: root, config: DEFAULT_CONFIG });
  const dr = analysis.findings.filter((f) => f.type === "dead-reference");
  assert.deepEqual(
    dr.map((f) => [f.detail?.["subcase"], f.severity]).sort(),
    [
      ["dead-import", "error"],
      ["dead-import", "error"],
      ["dead-path", "warn"],
      ["dead-script", "warn"],
      ["dead-script", "warn"],
    ],
  );
});

test("dead-ref: a script named in bare prose is caught, not just one in backticks", () => {
  // dead-script scans the whole line. `npm run lint` sits in backticks in the
  // fixture and `npm run typecheck` does not; both must flag.
  const root = fixture("dead-ref");
  const { analysis } = analyzeEntry(root, { repoRoot: root, config: DEFAULT_CONFIG });
  const scripts = analysis.findings
    .filter((f) => f.type === "dead-reference" && f.detail?.["subcase"] === "dead-script")
    .map((f) => f.detail?.["ref"])
    .sort();
  assert.deepEqual(scripts, ["lint", "typecheck"]);
});

test("dead-ref: npm scoped package names in prose are not dead imports", () => {
  const root = fixture("dead-ref");
  const { analysis } = analyzeEntry(root, { repoRoot: root, config: DEFAULT_CONFIG });
  const refs = analysis.findings
    .filter((f) => f.type === "dead-reference" && f.detail?.["subcase"] === "dead-import")
    .map((f) => f.detail?.["ref"])
    .sort();
  // `@superset-ui/core` and `@xyflow/react` are package names in prose:
  // suppressed. `@docs/style-notes` is npm-shaped but `docs/` is a real
  // directory next to the file, so the missing target still flags (with the
  // trailing period the line-scan captured).
  assert.deepEqual(refs, ["./missing-setup.md", "docs/style-notes."]);
});

test("dead-reference: gate.dead-reference = 'warn' caps the import case at warn", () => {
  const root = fixture("dead-ref");
  const config = {
    ...DEFAULT_CONFIG,
    gate: { ...DEFAULT_CONFIG.gate, "dead-reference": "warn" as const },
  };
  const { analysis } = analyzeEntry(root, { repoRoot: root, config });
  const dr = analysis.findings.filter((f) => f.type === "dead-reference");
  assert.equal(dr.length, 5);
  assert.ok(dr.every((f) => f.severity === "warn"));
});

test("dead-reference: gate.dead-reference = 'off' disables the check", () => {
  const root = fixture("dead-ref");
  const config = {
    ...DEFAULT_CONFIG,
    gate: { ...DEFAULT_CONFIG.gate, "dead-reference": "off" as const },
  };
  const { analysis } = analyzeEntry(root, { repoRoot: root, config });
  assert.deepEqual(analysis.findings.filter((f) => f.type === "dead-reference"), []);
});

test("dead-ref-clean: resolving imports, paths, and scripts raise no dead-reference finding", () => {
  const root = fixture("dead-ref-clean");
  const { analysis } = analyzeEntry(root, { repoRoot: root, config: DEFAULT_CONFIG });
  assert.deepEqual(analysis.findings.filter((f) => f.type === "dead-reference"), []);
});
