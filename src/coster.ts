// Costing: assign a token count to every block, then roll up totals and the
// budget delta. Deterministic — the tokenizer is a pure function of the text.

import type { Block, BudgetReport, Totals } from "./types.js";
import type { Config } from "./config.js";
import type { Tokenizer } from "./tokenizer.js";

export function costBlocks(
  raw: Omit<Block, "id" | "tokens">[],
  tok: Tokenizer,
): Block[] {
  return raw.map((b, i) => ({
    ...b,
    id: `b${i + 1}`,
    tokens: tok.countTokens(b.text),
  }));
}

export function computeTotals(blocks: Block[]): Totals {
  const perFile: Record<string, number> = {};
  let stackTokens = 0;
  let skillIndexTokens = 0;
  for (const b of blocks) {
    stackTokens += b.tokens;
    perFile[b.source] = (perFile[b.source] ?? 0) + b.tokens;
    if (b.kind === "skill-index") skillIndexTokens += b.tokens;
  }
  const sortedPerFile: Record<string, number> = {};
  for (const k of Object.keys(perFile).sort()) sortedPerFile[k] = perFile[k]!;
  return { stackTokens, perFile: sortedPerFile, skillIndexTokens };
}

export function computeBudget(totals: Totals, config: Config): BudgetReport {
  const total = config.budget.total;
  const safetyMargin = config.safetyMargin;
  const effective = Math.round(total * (1 - safetyMargin));
  const stackTotal = totals.stackTokens;
  const delta = stackTotal - effective;
  return {
    total,
    safetyMargin,
    effective,
    stackTotal,
    delta,
    overBudget: delta > 0,
  };
}
