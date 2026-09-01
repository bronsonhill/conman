// Version-anchor drift test.
//
// MODEL.md's "Accurate as of" section pins conman's resolution model to a
// specific Claude Code release. This test snapshots the *observable* resolved
// output for a handful of fixtures that, between them, exercise every rule that
// anchor covers:
//
//   - ancestor CLAUDE.md walk order and the repo-boundary stop
//   - @-import inline position, depth-first order, the 5-hop depth limit,
//     cycle breaking
//   - .claude/rules/ always-on vs `paths`-scoped, ordering, `globs` ignored,
//     `**` / keyless treated as always-on, `{a,b}` brace lists expanded
//   - the skill startup index and its settings.json budget truncation
//   - claudeMdExcludes from settings.json
//
// If a newer Claude Code release changes any of these, this test fails loudly.
// That failure is the signal for a conman maintainer to re-verify against the
// new release and bump the anchor — see "Bumping the version anchor" in
// MODEL.md. Do not just paste the new output into EXPECTED.

import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveStack } from "./resolver/index.js";
import { DEFAULT_CONFIG } from "./config.js";
import { getTokenizer } from "./tokenizer.js";
import { fixture } from "./testutil.js";

/**
 * The Claude Code release this snapshot was verified against. Keep in sync with
 * MODEL.md's "Accurate as of" section; bumping one without the other is a bug.
 */
const ANCHOR = { version: "v2.1.251", verified: "2026-09-01" };

const tok = getTokenizer("claude-local");

/** The fixture + entry each snapshot resolves. */
const SCENARIOS: Record<string, { fixture: string; entry: string[] }> = {
  "monorepo services/api": { fixture: "monorepo", entry: ["services", "api"] },
  "rule-scope-keys app/api": { fixture: "rule-scope-keys", entry: ["app", "api"] },
  "rule-scope-keys src/main": { fixture: "rule-scope-keys", entry: ["src", "main"] },
  "imports root": { fixture: "imports", entry: [] },
};

/** Compact, deterministic view of a resolved stack. */
function snapshot(fixtureName: string, entryParts: string[]) {
  const root = fixture(fixtureName);
  const r = resolveStack(fixture(fixtureName, ...entryParts), root, DEFAULT_CONFIG, tok, []);
  return {
    mode: r.mode,
    entry: r.entryPosix,
    blocks: r.blocks.map((b) => `${b.kind}:${b.source}` + (b.via ? ` via ${b.via}` : "")),
    notes: r.notes,
    unlinkedAgentsCopies: r.unlinkedAgentsCopies,
  };
}

/** The frozen output for the anchored release. */
const EXPECTED: Record<string, ReturnType<typeof snapshot>> = {
  "monorepo services/api": {
    mode: "stack",
    entry: "services/api",
    blocks: [
      "memory:CLAUDE.md",
      "import:docs/style.md via CLAUDE.md:10",
      "memory:services/api/CLAUDE.md",
      "rule-always:.claude/rules/always.md",
      "rule-scoped:.claude/rules/backend.md",
      "skill-index:.claude/skills",
    ],
    notes: [
      "excluded by settings claudeMdExcludes: services/CLAUDE.md",
      "excluded by settings claudeMdExcludes: .claude/rules/excluded.md",
      "skill startup index truncated: 1 of 3 skills omitted under skill-listing budget 45",
    ],
    unlinkedAgentsCopies: [],
  },
  "rule-scope-keys app/api": {
    mode: "stack",
    entry: "app/api",
    blocks: [
      "memory:CLAUDE.md",
      "rule-always:.claude/rules/keyless.md",
      "rule-always:.claude/rules/legacy-globs.md",
      "rule-always:.claude/rules/scope-everything.md",
      "rule-scoped:.claude/rules/paths-scoped.md",
    ],
    notes: [
      "rule .claude/rules/brace-scoped.md is path-scoped (src/{main,renderer}); did not match entry app/api",
      "rule .claude/rules/legacy-globs.md sets `globs` but not `paths`; Claude Code path-scopes rules only on `paths`, so this rule loads always-on",
      "rule .claude/rules/motrix-shaped.md is path-scoped (src/**); did not match entry app/api",
    ],
    unlinkedAgentsCopies: [],
  },
  "rule-scope-keys src/main": {
    mode: "stack",
    entry: "src/main",
    blocks: [
      "memory:CLAUDE.md",
      "rule-always:.claude/rules/keyless.md",
      "rule-always:.claude/rules/legacy-globs.md",
      "rule-always:.claude/rules/scope-everything.md",
      "rule-scoped:.claude/rules/brace-scoped.md",
      "rule-scoped:.claude/rules/motrix-shaped.md",
    ],
    notes: [
      "rule .claude/rules/legacy-globs.md sets `globs` but not `paths`; Claude Code path-scopes rules only on `paths`, so this rule loads always-on",
      "rule .claude/rules/paths-scoped.md is path-scoped (app/**); did not match entry src/main",
    ],
    unlinkedAgentsCopies: [],
  },
  "imports root": {
    mode: "stack",
    entry: ".",
    blocks: [
      "memory:CLAUDE.md",
      "import:chain-a.md via CLAUDE.md:3",
      "import:chain-b.md via chain-a.md:1",
      "import:chain-c.md via chain-b.md:1",
      "import:chain-d.md via chain-c.md:1",
      "import:chain-e.md via chain-d.md:1",
      "import:cycle-1.md via CLAUDE.md:3",
      "import:cycle-2.md via cycle-1.md:1",
    ],
    notes: [
      "import depth limit (5) reached at chain-e.md; 1 nested import(s) not followed",
      "import cycle skipped at cycle-1.md",
    ],
    unlinkedAgentsCopies: [],
  },
};

const DRIFT_HINT =
  `\n\n  Resolution output drifted from the anchored Claude Code release ` +
  `(${ANCHOR.version}, verified ${ANCHOR.verified}).\n` +
  `  If this is a deliberate resolver change, follow "Bumping the version anchor" ` +
  `in MODEL.md:\n` +
  `  re-verify every resolution rule against the current release, update the ` +
  `"Accurate as of"\n` +
  `  section and the ANCHOR constant here, then refresh EXPECTED and the goldens.\n` +
  `  Do not paste the new output in without re-verifying.\n`;

for (const [name, expected] of Object.entries(EXPECTED)) {
  const scenario = SCENARIOS[name]!;
  test(`anchor: ${name} resolves as documented for ${ANCHOR.version}`, () => {
    const actual = snapshot(scenario.fixture, scenario.entry);
    assert.deepEqual(actual, expected, DRIFT_HINT);
  });
}
