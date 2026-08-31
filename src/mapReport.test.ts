import { test } from "node:test";
import assert from "node:assert/strict";
import { loadConfig } from "./config.js";
import { runMap, type MapResult } from "./map.js";
import {
  mapRedundancy,
  summarizeMapNotes,
  renderMapHuman,
  renderMapJson,
} from "./mapReport.js";
import { fixture } from "./testutil.js";

function mapOf(name: string): MapResult {
  const root = fixture(name);
  const { config } = loadConfig(root, root);
  return runMap(root, config, "claude-local");
}

function humanOf(name: string): string {
  const root = fixture(name);
  const { config, source } = loadConfig(root, root);
  return renderMapHuman(runMap(root, config, "claude-local"), "9.9.9", source);
}

function jsonOf(name: string): unknown {
  const root = fixture(name);
  const { config, source } = loadConfig(root, root);
  return JSON.parse(
    renderMapJson(runMap(root, config, "claude-local"), "9.9.9", source),
  );
}

test("renderMapHuman covers the failing-entry path (monorepo)", () => {
  const out = humanOf("monorepo");
  assert.ok(out.startsWith("conman 9.9.9 map  model "));
  assert.ok(out.includes("entry points discovered: 4"));
  assert.ok(out.includes("services/api"));
  assert.ok(out.includes("FAIL"));
  assert.ok(out.includes("path-scoped rules that did not match every entry point:"));
  assert.ok(out.includes("repo rollup: 812 tokens across 4 entry points"));
  assert.ok(out.includes("redundant tokens: 27 (3% of stack)"));
  assert.ok(out.includes("RESULT  fail"));
  assert.ok(out.includes("    - 1 duplication finding at error severity"));
  assert.ok(out.endsWith("\n"));
});

test("renderMapHuman covers rule-only discovery and dead-scope sections", () => {
  const out = humanOf("rule-entry");
  assert.ok(
    out.includes(
      "discovered via a path-scoped rule (no CLAUDE.md / AGENTS.md of their own):",
    ),
  );
  assert.ok(out.includes("path-scoped rules that matched no entry point (dead scope):"));
  assert.ok(out.includes("RESULT  pass"));
});

test("renderMapHuman falls back to built-in defaults label with no config source", () => {
  const map = mapOf("clean");
  const out = renderMapHuman(map, "9.9.9", null);
  assert.ok(out.includes("config: (built-in defaults)"));
});

test("renderMapHuman is byte-identical across runs", () => {
  assert.equal(humanOf("rule-entry"), humanOf("rule-entry"));
});

test("renderMapHuman carries no absolute paths", () => {
  const out = humanOf("monorepo");
  assert.ok(!out.includes("/Users/"));
  assert.ok(!out.includes(process.cwd()));
});

test("renderMapJson mirrors the human report data", () => {
  const payload = jsonOf("monorepo") as {
    tool: string;
    toolVersion: string;
    command: string;
    pass: boolean;
    redundant: { tokens: number; pctOfStack: number };
    pathScopedRuleNotes: string[];
    entryPoints: { entry: string; blocks: unknown[] }[];
  };
  assert.equal(payload.tool, "conman");
  assert.equal(payload.toolVersion, "9.9.9");
  assert.equal(payload.command, "map");
  assert.equal(payload.pass, false);
  assert.equal(payload.redundant.tokens, 27);
  assert.ok(payload.pathScopedRuleNotes.length >= 1);
  assert.equal(payload.entryPoints.length, 4);
  assert.ok(payload.entryPoints.every((e) => Array.isArray(e.blocks)));
});

test("renderMapJson keeps deadPathScopedRules for a fixture with dead scope", () => {
  const payload = jsonOf("rule-entry") as { deadPathScopedRules: string[] };
  assert.ok(payload.deadPathScopedRules.length >= 1);
  assert.ok(
    payload.deadPathScopedRules.every((l) => l.endsWith("matched no discovered entry point")),
  );
});

test("renderMapJson is byte-identical across runs", () => {
  const root = fixture("monorepo");
  const { config, source } = loadConfig(root, root);
  const a = renderMapJson(runMap(root, config, "claude-local"), "9.9.9", source);
  const b = renderMapJson(runMap(root, config, "claude-local"), "9.9.9", source);
  assert.equal(a, b);
});

test("renderMapJson accepts a null config source", () => {
  const map = mapOf("clean");
  const payload = JSON.parse(renderMapJson(map, "9.9.9", null)) as {
    configSource: string | null;
  };
  assert.equal(payload.configSource, null);
});

// --- synthetic MapResult to reach the narrow branches the fixtures don't hit ---

function fakeEntry(over: {
  entry: string;
  notes?: string[];
  blocks?: { kind: string; source: string }[];
  stackTokens?: number;
  dupTokens?: number;
}): MapResult["entries"][number] {
  const findings = over.dupTokens
    ? [{ type: "duplication", tokens: over.dupTokens }]
    : [];
  return {
    entry: over.entry,
    discovery: ["memory-file"],
    notes: over.notes ?? [],
    mode: "stack",
    pass: true,
    reasons: [],
    analysis: {
      entry: over.entry,
      tokenizer: "claude-local",
      totals: { stackTokens: over.stackTokens ?? 0 },
      budget: { delta: -1 },
      blocks: over.blocks ?? [],
      findings,
    },
  } as unknown as MapResult["entries"][number];
}

test("summarizeMapNotes uses the singular phrasing for a single non-matching entry", () => {
  const result: MapResult = {
    repoRoot: "/x",
    pass: true,
    entries: [
      fakeEntry({
        entry: "a",
        notes: [
          "rule .claude/rules/x.md is path-scoped (p/**); did not match entry a",
          "some unrelated note",
        ],
        blocks: [{ kind: "rule-scoped", source: ".claude/rules/x.md" }],
      }),
      fakeEntry({ entry: "b" }),
    ],
  };
  const s = summarizeMapNotes(result);
  assert.deepEqual(s.collapsed, [
    "rule .claude/rules/x.md is path-scoped (p/**); did not match entry a",
  ]);
  // x.md loaded as a rule-scoped block somewhere, so it is not dead.
  assert.deepEqual(s.deadRules, []);
  assert.deepEqual(s.perEntry.get("a"), ["some unrelated note"]);
  assert.deepEqual(s.perEntry.get("b"), []);
});

test("summarizeMapNotes flags a rule that loaded nowhere as dead scope", () => {
  const result: MapResult = {
    repoRoot: "/x",
    pass: true,
    entries: [
      fakeEntry({
        entry: "a",
        notes: [
          "rule .claude/rules/dead.md is path-scoped (q/**); did not match entry a",
        ],
      }),
    ],
  };
  const s = summarizeMapNotes(result);
  assert.deepEqual(s.deadRules, [
    "rule .claude/rules/dead.md is path-scoped (q/**); matched no discovered entry point",
  ]);
});

test("summarizeMapNotes collapses multiple entries with a count", () => {
  const mk = (entry: string) =>
    fakeEntry({
      entry,
      notes: [
        `rule .claude/rules/x.md is path-scoped (p/**); did not match entry ${entry}`,
      ],
    });
  const s = summarizeMapNotes({
    repoRoot: "/x",
    pass: true,
    entries: [mk("a"), mk("b"), mk("c")],
  });
  assert.deepEqual(s.collapsed, [
    "rule .claude/rules/x.md is path-scoped (p/**); did not match 3 entry points",
  ]);
});

test("summarizeMapNotes handles the glob-scoped prefix form", () => {
  const s = summarizeMapNotes({
    repoRoot: "/x",
    pass: true,
    entries: [
      fakeEntry({
        entry: "a",
        notes: [
          ".cursor/rules/y.mdc is glob-scoped (app/**); did not match entry a",
        ],
      }),
    ],
  });
  assert.deepEqual(s.deadRules, [
    ".cursor/rules/y.mdc is glob-scoped (app/**); matched no discovered entry point",
  ]);
});

test("mapRedundancy sums per-entry redundant tokens and the stack share", () => {
  const result: MapResult = {
    repoRoot: "/x",
    pass: true,
    entries: [
      fakeEntry({ entry: "a", stackTokens: 100, dupTokens: 10 }),
      fakeEntry({ entry: "b", stackTokens: 100, dupTokens: 30 }),
    ],
  };
  assert.deepEqual(mapRedundancy(result), { tokens: 40, pctOfStack: 20 });
});

test("mapRedundancy reports a zero share when the rollup is empty", () => {
  const result: MapResult = {
    repoRoot: "/x",
    pass: true,
    entries: [fakeEntry({ entry: "a", stackTokens: 0, dupTokens: 0 })],
  };
  assert.deepEqual(mapRedundancy(result), { tokens: 0, pctOfStack: 0 });
});
