import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveStack } from "./resolver.js";
import { DEFAULT_CONFIG } from "./config.js";
import { getTokenizer } from "./tokenizer.js";
import { fixture } from "./testutil.js";

const tok = getTokenizer("claude-local");

test("monorepo: ancestor chain, import, rules, skill index, exclude", () => {
  const root = fixture("monorepo");
  const r = resolveStack(fixture("monorepo", "services", "api"), root, DEFAULT_CONFIG, tok, []);
  const kinds = r.blocks.map((b) => `${b.kind}:${b.source}`);

  assert.deepEqual(kinds, [
    "memory:CLAUDE.md",
    "import:docs/style.md",
    "memory:services/api/CLAUDE.md",
    "rule-always:.claude/rules/always.md",
    "rule-scoped:.claude/rules/backend.md",
    "skill-index:.claude/skills",
  ]);

  // services/CLAUDE.md is on the ancestor path but excluded by settings
  assert.ok(r.notes.some((n) => n.includes("claudeMdExcludes: services/CLAUDE.md")));
  // path-scoped rule matched services/**
  assert.ok(r.blocks.some((b) => b.kind === "rule-scoped"));
});

test("import depth limit stops the chain and leaves a note", () => {
  const root = fixture("imports");
  const r = resolveStack(root, root, DEFAULT_CONFIG, tok, []);
  const sources = r.blocks.map((b) => b.source);
  assert.ok(sources.includes("chain-e.md"), "chain-e is at the limit and loads");
  assert.ok(!sources.includes("chain-f.md"), "chain-f is past the limit");
  assert.ok(r.notes.some((n) => n.includes("import depth limit (5) reached")));
});

test("import cycle is broken with a note", () => {
  const root = fixture("imports");
  const r = resolveStack(root, root, DEFAULT_CONFIG, tok, []);
  const cyc = r.blocks.filter((b) => b.source.startsWith("cycle-"));
  assert.equal(cyc.length, 2, "each cycle file loads exactly once");
  assert.ok(r.notes.some((n) => n.includes("import cycle skipped")));
});

test("a file pulled in via @-import is not loaded again as a sibling", () => {
  const root = fixture("pointer");
  const r = resolveStack(root, root, DEFAULT_CONFIG, tok, []);
  const agentsBlocks = r.blocks.filter((b) => b.source === "AGENTS.md");
  assert.equal(agentsBlocks.length, 1);
  assert.equal(agentsBlocks[0]!.kind, "import");
  assert.ok(r.notes.some((n) => n.includes("not loaded again as a sibling")));
});

// --- .claude/rules/ path-scoping keys ---------------------------------------
//
// Claude Code path-scopes a rule on exactly one frontmatter key: `paths`. A
// rule with no `paths` loads always-on. `globs` / `alwaysApply` are Cursor
// `.mdc` keys and do not scope anything. Sources: the memory docs
// (https://code.claude.com/docs/en/memory#path-specific-rules) and Claude
// Code's own rule parser (v2.1.251), which reads `frontmatter.paths` only.

function ruleKinds(entry: string[]) {
  const root = fixture("rule-scope-keys");
  const r = resolveStack(fixture("rule-scope-keys", ...entry), root, DEFAULT_CONFIG, tok, []);
  const rules = r.blocks
    .filter((b) => b.kind === "rule-always" || b.kind === "rule-scoped")
    .map((b) => `${b.kind}:${b.source}`);
  return { rules, notes: r.notes };
}

test("`paths` frontmatter makes a rule path-scoped, and it matches a matching entry", () => {
  const { rules } = ruleKinds(["app", "api"]);
  assert.ok(
    rules.includes("rule-scoped:.claude/rules/paths-scoped.md"),
    "a `paths` rule whose glob matches the entry resolves as rule-scoped",
  );
  assert.ok(
    !rules.includes("rule-always:.claude/rules/paths-scoped.md"),
    "a `paths` rule is never treated as always-on",
  );
});

test("Motrix regression: a `paths`-scoped rule is path-scoped, not always-on", () => {
  // Motrix has 13 rule files, all scoped with `paths`. conman used to look for
  // `globs`, so it loaded every one always-on and never path-scoped at all.
  const matched = ruleKinds(["src", "main"]);
  assert.ok(
    matched.rules.includes("rule-scoped:.claude/rules/motrix-shaped.md"),
    "matches when the entry is under src/",
  );

  const missed = ruleKinds(["app", "api"]);
  assert.ok(
    !missed.rules.some((k) => k.endsWith("motrix-shaped.md")),
    "a src/** rule does not load for an app/ entry",
  );
  assert.ok(
    missed.notes.some(
      (n) => n.includes("motrix-shaped.md") && n.includes("did not match entry app/api"),
    ),
    "the miss leaves a NOTE naming the pattern and the entry",
  );
});

test("a rule with no scoping key stays always-on", () => {
  const { rules } = ruleKinds(["app", "api"]);
  assert.ok(rules.includes("rule-always:.claude/rules/keyless.md"));
  assert.ok(!rules.some((k) => k.startsWith("rule-scoped") && k.endsWith("keyless.md")));
});

test("a rule scoped with the Cursor `globs` key loads always-on, with a NOTE", () => {
  const { rules, notes } = ruleKinds(["app", "api"]);
  assert.ok(
    rules.includes("rule-always:.claude/rules/legacy-globs.md"),
    "Claude Code ignores `globs`, so the rule is unconditional",
  );
  assert.ok(
    notes.some((n) => n.includes("legacy-globs.md") && n.includes("`globs` but not `paths`")),
    "conman flags the likely-unintended always-on load",
  );
});

test("a `paths` of just `**` scopes to everything, so the rule loads always-on", () => {
  const { rules } = ruleKinds(["app", "api"]);
  assert.ok(rules.includes("rule-always:.claude/rules/scope-everything.md"));
});

test("single-file mode: no ancestor walk, no rules", () => {
  const root = fixture("single-file");
  const r = resolveStack(fixture("single-file", "notes.md"), root, DEFAULT_CONFIG, tok, []);
  assert.equal(r.mode, "single-file");
  assert.deepEqual(
    r.blocks.map((b) => b.source),
    ["notes.md", "shared.md"],
  );
});
