import { test } from "node:test";
import assert from "node:assert/strict";
import { analyzeEntry } from "../analyze.js";
import { DEFAULT_CONFIG } from "../config.js";
import { fixture } from "../testutil.js";
import { findValueConflicts } from "./valueConflict.js";
import { getTokenizer } from "../tokenizer.js";
import type { Block } from "../types.js";

const tok = getTokenizer("claude-local");

function block(source: string, text: string): Block {
  return { id: source, kind: "memory", source, lineStart: 1, lineEnd: 1, text, depth: 0, tokens: 0 };
}

test("monorepo/services/api: value-conflict on `node version` with both values and locations", () => {
  const root = fixture("monorepo");
  const { analysis } = analyzeEntry(fixture("monorepo", "services", "api"), {
    repoRoot: root,
    config: DEFAULT_CONFIG,
  });

  const conflict = analysis.findings.find((f) => f.type === "value-conflict");
  assert.ok(conflict, "expected a value-conflict finding");
  assert.equal(conflict!.detail?.["key"], "node version");
  assert.deepEqual(conflict!.detail?.["values"], ["20", "22"]);
  assert.equal(conflict!.locations.length, 2);
});

test("value-conflict: a definitional line inside an inline code span is not a conflict", () => {
  // Both files show a verbatim changelog trailer as an example; the `- Max
  // Agents: N` line lives entirely inside a wrapped inline code span. Nothing
  // loads it as a rule, so the differing values must not raise a conflict.
  const a = block(
    "CLAUDE.md",
    "Changelog trailers look like `... by @xet7.\n- Max Agents: 8` verbatim.",
  );
  const b = block(
    "pkg/CLAUDE.md",
    "Changelog trailers look like `... by @xet7.\n- Max Agents: 5` verbatim.",
  );
  const found = findValueConflicts([a, b], DEFAULT_CONFIG, tok);
  assert.deepEqual(found, []);
});

test("value-conflict: a definitional line inside a fenced block is not a conflict", () => {
  const a = block("CLAUDE.md", "```\n- Max Agents: 8\n```");
  const b = block("pkg/CLAUDE.md", "```\n- Max Agents: 5\n```");
  assert.deepEqual(findValueConflicts([a, b], DEFAULT_CONFIG, tok), []);
});

test("value-conflict: a backticked-key line in ordinary prose still conflicts", () => {
  const a = block("CLAUDE.md", "- `Max Agents`: 8");
  const b = block("pkg/CLAUDE.md", "- `Max Agents`: 5");
  const found = findValueConflicts([a, b], DEFAULT_CONFIG, tok);
  assert.equal(found.length, 1);
  assert.deepEqual(found[0]!.detail?.["values"], ["8", "5"]);
});
