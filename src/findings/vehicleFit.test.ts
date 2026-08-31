import { test } from "node:test";
import assert from "node:assert/strict";
import { findVehicleFit } from "./vehicleFit.js";
import { DEFAULT_CONFIG } from "../config.js";
import { getTokenizer } from "../tokenizer.js";
import type { Block, BlockKind } from "../types.js";

const tok = getTokenizer();

const BIG_PROSE =
  "This sentence has a fair number of tokens in it and keeps going along. ".repeat(
    120,
  );
const SMALL_PROSE = "Short note. Nothing large here at all.";

function block(over: Partial<Block> & { kind: BlockKind; source: string; text: string }): Block {
  return {
    id: "b1",
    depth: 0,
    lineStart: 1,
    lineEnd: 10,
    tokens: tok.countTokens(over.text),
    ...over,
  };
}

test("vehicle-fit: severity off short-circuits to no findings", () => {
  const config = { ...DEFAULT_CONFIG, gate: { ...DEFAULT_CONFIG.gate, "vehicle-fit": "off" as const } };
  const out = findVehicleFit([block({ kind: "memory", source: "CLAUDE.md", text: BIG_PROSE })], config, tok);
  assert.deepEqual(out, []);
});

test("vehicle-fit: skill-index blocks are skipped", () => {
  const out = findVehicleFit(
    [block({ kind: "skill-index", source: "<skills>", text: BIG_PROSE })],
    DEFAULT_CONFIG,
    tok,
  );
  assert.deepEqual(out, []);
});

test("vehicle-fit: large always-loaded rule yields a rule-always finding", () => {
  const b = block({ kind: "rule-always", source: ".claude/rules/big.md", text: BIG_PROSE });
  const out = findVehicleFit([b], DEFAULT_CONFIG, tok);
  const ruleShape = out.find((f) => f.detail?.shape === "rule-always");
  assert.ok(ruleShape, "expected a rule-always shaped finding");
  assert.equal(ruleShape!.severity, "warn");
  assert.equal(ruleShape!.type, "vehicle-fit");
  assert.match(ruleShape!.message, /always-loaded rule/);
  assert.equal(ruleShape!.locations[0]!.file, ".claude/rules/big.md");
  assert.equal(ruleShape!.detail!.coarse, true);
});

test("vehicle-fit: large prose segment flagged, with vehicle name per block kind", () => {
  for (const [kind, name] of [
    ["memory", "always-loaded memory"],
    ["import", "always-loaded memory"],
    ["rule-always", "an always-loaded rule"],
    ["rule-scoped", "a path-scoped rule"],
  ] as const) {
    const out = findVehicleFit(
      [block({ kind, source: "f.md", text: BIG_PROSE })],
      DEFAULT_CONFIG,
      tok,
    );
    const prose = out.find((f) => f.detail?.shape === "prose-segment");
    assert.ok(prose, `expected prose finding for ${kind}`);
    assert.ok(prose!.message.includes(name), `message names ${name} for ${kind}`);
  }
});

test("vehicle-fit: fenced code, heading-only, and small prose raise nothing", () => {
  const blocks = [
    block({ kind: "memory", source: "a.md", text: "```\n" + BIG_PROSE + "\n```" }),
    block({ kind: "memory", source: "b.md", text: "# Just a heading" }),
    block({ kind: "memory", source: "c.md", text: SMALL_PROSE }),
  ];
  assert.deepEqual(findVehicleFit(blocks, DEFAULT_CONFIG, tok), []);
});

test("vehicle-fit: findings sort by tokens desc then file asc", () => {
  const blocks = [
    block({ kind: "memory", source: "z.md", text: BIG_PROSE }),
    block({ kind: "memory", source: "a.md", text: BIG_PROSE }),
  ];
  const out = findVehicleFit(blocks, DEFAULT_CONFIG, tok);
  assert.equal(out.length, 2);
  assert.equal(out[0]!.locations[0]!.file, "a.md");
  assert.equal(out[1]!.locations[0]!.file, "z.md");
});
