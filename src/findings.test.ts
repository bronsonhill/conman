import { test } from "node:test";
import assert from "node:assert/strict";
import { analyzeEntry } from "./analyze.js";
import { DEFAULT_CONFIG } from "./config.js";
import { fixture } from "./testutil.js";

test("monorepo/services/api: duplication + value conflict, both with locations", () => {
  const root = fixture("monorepo");
  const { analysis } = analyzeEntry(fixture("monorepo", "services", "api"), {
    repoRoot: root,
    config: DEFAULT_CONFIG,
  });

  const dup = analysis.findings.find((f) => f.type === "duplication");
  assert.ok(dup, "expected a duplication finding");
  assert.equal(dup!.locations.length, 2);
  assert.deepEqual(
    dup!.locations.map((l) => l.file).sort(),
    ["CLAUDE.md", "services/api/CLAUDE.md"],
  );
  assert.ok((dup!.tokens ?? 0) > 0, "duplication finding carries a token cost");

  const conflict = analysis.findings.find((f) => f.type === "value-conflict");
  assert.ok(conflict, "expected a value-conflict finding");
  assert.equal(conflict!.detail?.["key"], "node version");
  assert.deepEqual(conflict!.detail?.["values"], ["20", "22"]);
  assert.equal(conflict!.locations.length, 2);
});

test("clean fixture produces no findings", () => {
  const root = fixture("clean");
  const { analysis } = analyzeEntry(root, { repoRoot: root, config: DEFAULT_CONFIG });
  assert.deepEqual(analysis.findings, []);
});

test("sibling-dup: a byte-identical CLAUDE.md/AGENTS.md pair is one unlinked-copy warn, no duplication", () => {
  const root = fixture("sibling-dup");
  const { analysis } = analyzeEntry(root, { repoRoot: root, config: DEFAULT_CONFIG });

  // The bare AGENTS.md is not stack cost, so it is not a duplication finding.
  assert.equal(
    analysis.findings.filter((f) => f.type === "duplication").length,
    0,
    "a bare AGENTS.md is not loaded, so nothing loads twice",
  );

  const copies = analysis.findings.filter((f) => f.type === "unlinked-copy");
  assert.equal(copies.length, 1, "one finding for the pair");
  const copy = copies[0]!;
  assert.equal(copy.severity, "warn", "maintainability smell, not a gate failure");
  assert.deepEqual(
    copy.locations.map((l) => l.file).sort(),
    ["AGENTS.md", "CLAUDE.md"],
  );
  assert.match(copy.message, /replace one with a symlink/);
  assert.equal(copy.tokens, undefined, "not a token cost: the copy never loads");

  // The AGENTS.md tokens stay out of the resolved stack entirely.
  assert.ok(
    !analysis.blocks.some((b) => b.source === "AGENTS.md"),
    "AGENTS.md is not a block",
  );
});

test("sibling-dup: warn-only, so `conman check` still passes on it", () => {
  const root = fixture("sibling-dup");
  const { analysis } = analyzeEntry(root, { repoRoot: root, config: DEFAULT_CONFIG });
  assert.equal(
    analysis.findings.filter((f) => f.severity === "error").length,
    0,
  );
});

test("sibling-clean: sibling files with different content raise nothing", () => {
  const root = fixture("sibling-clean");
  const { analysis } = analyzeEntry(root, { repoRoot: root, config: DEFAULT_CONFIG });
  assert.deepEqual(analysis.findings, []);
});

test("sibling-symlink: CLAUDE.md -> AGENTS.md loads once and raises nothing", () => {
  const root = fixture("sibling-symlink");
  const { analysis } = analyzeEntry(root, { repoRoot: root, config: DEFAULT_CONFIG });
  assert.deepEqual(analysis.findings, [], "the recommended layout is silent");
  const memory = analysis.blocks.filter((b) => b.kind === "memory");
  assert.equal(memory.length, 1, "the shared content is counted exactly once");
});

test("agents-only: a bare AGENTS.md raises nothing and costs nothing", () => {
  const root = fixture("agents-only");
  const { analysis } = analyzeEntry(root, { repoRoot: root, config: DEFAULT_CONFIG });
  assert.deepEqual(analysis.findings, []);
  assert.equal(analysis.totals.stackTokens, 0, "Claude Code loads nothing here");
});

test("frontmatter-broken: each rule/skill sub-case raises one frontmatter finding at the right severity", () => {
  const root = fixture("frontmatter-broken");
  const { analysis } = analyzeEntry(root, { repoRoot: root, config: DEFAULT_CONFIG });
  const fm = analysis.findings.filter((f) => f.type === "frontmatter");
  const bySubcase = new Map(
    fm.map((f) => [`${f.detail?.["role"]}:${f.detail?.["subcase"]}`, f]),
  );

  // errors: a path-scoped rule whose scope cannot be read
  for (const sc of [
    "rule:unterminated-fence",
    "rule:scope-wrong-type",
    "rule:unparseable-yaml",
  ]) {
    assert.equal(bySubcase.get(sc)?.severity, "error", `${sc} is an error`);
  }
  // warns: softer cases
  for (const sc of [
    "rule:scope-scalar-string",
    "rule:scope-key-absent",
    "skill:skill-missing-description",
  ]) {
    assert.equal(bySubcase.get(sc)?.severity, "warn", `${sc} is a warn`);
  }

  // the unparseable skill reports as warn, not error (no scoping stakes)
  const skillParse = fm.find(
    (f) =>
      f.detail?.["role"] === "skill" && f.detail?.["subcase"] === "unparseable-yaml",
  );
  assert.equal(skillParse?.severity, "warn");

  // the one valid rule and the one valid skill raise nothing
  assert.ok(
    !fm.some((f) => f.locations[0]!.file.endsWith("valid.md")),
    "the correctly scoped rule is silent",
  );
  assert.ok(
    !fm.some((f) => f.locations[0]!.file.includes("skills/good/")),
    "the valid skill is silent",
  );

  // every finding carries a file:line location
  for (const f of fm) {
    assert.ok(f.locations[0]!.file && f.locations[0]!.lineStart >= 1);
  }

  assert.ok(
    analysis.findings.some((f) => f.type === "frontmatter" && f.severity === "error"),
    "the fixture fails `conman check`",
  );
});

test("frontmatter: gate.frontmatter = 'warn' caps every sub-case at warn", () => {
  const root = fixture("frontmatter-broken");
  const config = {
    ...DEFAULT_CONFIG,
    gate: { ...DEFAULT_CONFIG.gate, frontmatter: "warn" as const },
  };
  const { analysis } = analyzeEntry(root, { repoRoot: root, config });
  const fm = analysis.findings.filter((f) => f.type === "frontmatter");
  assert.ok(fm.length > 0, "findings still fire");
  assert.ok(fm.every((f) => f.severity === "warn"), "none at error");
});

test("frontmatter: gate.frontmatter = 'off' disables the check", () => {
  const root = fixture("frontmatter-broken");
  const config = {
    ...DEFAULT_CONFIG,
    gate: { ...DEFAULT_CONFIG.gate, frontmatter: "off" as const },
  };
  const { analysis } = analyzeEntry(root, { repoRoot: root, config });
  assert.equal(
    analysis.findings.filter((f) => f.type === "frontmatter").length,
    0,
  );
});

test("clean fixtures carry valid frontmatter: no frontmatter findings anywhere", () => {
  for (const name of ["monorepo", "rule-entry", "clean"]) {
    const root = fixture(name);
    const { analysis } = analyzeEntry(root, { repoRoot: root, config: DEFAULT_CONFIG });
    assert.deepEqual(
      analysis.findings.filter((f) => f.type === "frontmatter"),
      [],
      `${name} should raise no frontmatter finding`,
    );
  }
});

test("rule-scope-keys: the Cursor `globs` rule is the one frontmatter finding, at warn", () => {
  const root = fixture("rule-scope-keys");
  const { analysis } = analyzeEntry(fixture("rule-scope-keys", "app", "api"), {
    repoRoot: root,
    config: DEFAULT_CONFIG,
  });
  const fm = analysis.findings.filter((f) => f.type === "frontmatter");
  assert.equal(fm.length, 1);
  assert.equal(fm[0]!.severity, "warn");
  assert.equal(fm[0]!.detail?.["subcase"], "scope-key-absent");
  assert.equal(fm[0]!.locations[0]!.file, ".claude/rules/legacy-globs.md");
});

test("monorepo parent/child duplication is tagged relation: parent-child", () => {
  const root = fixture("monorepo");
  const { analysis } = analyzeEntry(fixture("monorepo", "services", "api"), {
    repoRoot: root,
    config: DEFAULT_CONFIG,
  });
  const dup = analysis.findings.find((f) => f.type === "duplication");
  assert.ok(dup);
  assert.equal(dup!.detail?.["relation"], "parent-child");
  assert.ok(!dup!.detail?.["wholeFileDuplicate"], "a partial overlap, not a whole-file rollup");
});

test("lint-dup: prose that restates .prettierrc keys raises one lint-duplication warn per rule", () => {
  const root = fixture("lint-dup");
  const { analysis } = analyzeEntry(root, { repoRoot: root, config: DEFAULT_CONFIG });
  const ld = analysis.findings.filter((f) => f.type === "lint-duplication");
  assert.deepEqual(
    ld.map((f) => f.detail?.["rule"]).sort(),
    ["indent-spaces", "line-length", "quotes-single", "semi-omit"],
  );
  assert.ok(ld.every((f) => f.severity === "warn"));
  assert.ok(ld.every((f) => f.detail?.["config"] === ".prettierrc"));
});

test("lint-clean: config present, prose does not restate it, no lint-duplication finding", () => {
  const root = fixture("lint-clean");
  const { analysis } = analyzeEntry(root, { repoRoot: root, config: DEFAULT_CONFIG });
  assert.deepEqual(analysis.findings.filter((f) => f.type === "lint-duplication"), []);
});

test("lint-duplication: gate.lint-duplication = 'off' disables the check", () => {
  const root = fixture("lint-dup");
  const config = {
    ...DEFAULT_CONFIG,
    gate: { ...DEFAULT_CONFIG.gate, "lint-duplication": "off" as const },
  };
  const { analysis } = analyzeEntry(root, { repoRoot: root, config });
  assert.deepEqual(analysis.findings.filter((f) => f.type === "lint-duplication"), []);
});

test("stale-init: the unmodified /init header sentence is one stale-boilerplate warn", () => {
  const root = fixture("stale-init");
  const { analysis } = analyzeEntry(root, { repoRoot: root, config: DEFAULT_CONFIG });
  const sb = analysis.findings.filter((f) => f.type === "stale-boilerplate");
  assert.equal(sb.length, 1);
  assert.equal(sb[0]!.severity, "warn");
  assert.equal(sb[0]!.locations[0]!.file, "CLAUDE.md");
  assert.equal(sb[0]!.locations[0]!.lineStart, 3);
});

test("stale-clean: a rewritten header raises no stale-boilerplate finding", () => {
  const root = fixture("stale-clean");
  const { analysis } = analyzeEntry(root, { repoRoot: root, config: DEFAULT_CONFIG });
  assert.deepEqual(analysis.findings.filter((f) => f.type === "stale-boilerplate"), []);
});

test("dead-ref: a missing @-import is error, a missing prose path and script are warn", () => {
  const root = fixture("dead-ref");
  const { analysis } = analyzeEntry(root, { repoRoot: root, config: DEFAULT_CONFIG });
  const dr = analysis.findings.filter((f) => f.type === "dead-reference");
  assert.deepEqual(
    dr.map((f) => [f.detail?.["subcase"], f.severity]).sort(),
    [
      ["dead-import", "error"],
      ["dead-path", "warn"],
      ["dead-script", "warn"],
    ],
  );
});

test("dead-reference: gate.dead-reference = 'warn' caps the import case at warn", () => {
  const root = fixture("dead-ref");
  const config = {
    ...DEFAULT_CONFIG,
    gate: { ...DEFAULT_CONFIG.gate, "dead-reference": "warn" as const },
  };
  const { analysis } = analyzeEntry(root, { repoRoot: root, config });
  const dr = analysis.findings.filter((f) => f.type === "dead-reference");
  assert.equal(dr.length, 3);
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

test("no-regression: the pre-existing fixtures raise none of the three new finding types", () => {
  const cases: [string, string[]][] = [
    ["monorepo", ["services", "api"]],
    ["monorepo", []],
    ["rule-entry", []],
    ["rule-scope-keys", ["app", "api"]],
    ["clean", []],
    ["imports", []],
    ["frontmatter-broken", []],
    ["single-file", ["notes.md"]],
    ["sibling-dup", []],
    ["sibling-clean", []],
  ];
  const NEW = new Set(["lint-duplication", "stale-boilerplate", "dead-reference"]);
  for (const [name, sub] of cases) {
    const root = fixture(name);
    const { analysis } = analyzeEntry(fixture(name, ...sub), {
      repoRoot: root,
      config: DEFAULT_CONFIG,
    });
    assert.deepEqual(
      analysis.findings.filter((f) => NEW.has(f.type)),
      [],
      `${name} should raise no new-type finding`,
    );
  }
});

test("analysis is deterministic byte-for-byte", () => {
  const root = fixture("monorepo");
  const a = analyzeEntry(fixture("monorepo", "services", "api"), {
    repoRoot: root,
    config: DEFAULT_CONFIG,
  });
  const b = analyzeEntry(fixture("monorepo", "services", "api"), {
    repoRoot: root,
    config: DEFAULT_CONFIG,
  });
  assert.equal(JSON.stringify(a.analysis), JSON.stringify(b.analysis));
});
