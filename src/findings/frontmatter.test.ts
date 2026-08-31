import { test } from "node:test";
import assert from "node:assert/strict";
import { analyzeEntry } from "../analyze.js";
import { DEFAULT_CONFIG } from "../config.js";
import { fixture } from "../testutil.js";

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
