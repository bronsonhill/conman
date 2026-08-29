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

test("single-file mode: no ancestor walk, no rules", () => {
  const root = fixture("single-file");
  const r = resolveStack(fixture("single-file", "notes.md"), root, DEFAULT_CONFIG, tok, []);
  assert.equal(r.mode, "single-file");
  assert.deepEqual(
    r.blocks.map((b) => b.source),
    ["notes.md", "shared.md"],
  );
});
