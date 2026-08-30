// Orchestrator: entry point -> full Analysis. This is the seam every command
// (single entry, map, check) runs through.

import { resolve } from "node:path";
import type { Analysis } from "./types.js";
import type { Config } from "./config.js";
import { getTokenizer, type Tokenizer } from "./tokenizer.js";
import { resolveStack } from "./resolver.js";
import { costBlocks, computeTotals, computeBudget } from "./coster.js";
import { runFindings } from "./findings/index.js";

export const MODEL_VERSION = "0.2";

export interface AnalyzeOptions {
  repoRoot: string;
  config: Config;
  tokenizerName?: string;
  tokenizer?: Tokenizer;
}

export interface AnalyzeResult {
  analysis: Analysis;
  notes: string[];
  mode: "stack" | "single-file";
}

export function analyzeEntry(
  entryPathAbs: string,
  opts: AnalyzeOptions,
): AnalyzeResult {
  const tok = opts.tokenizer ?? getTokenizer(opts.tokenizerName ?? "claude-local");
  const resolved = resolveStack(resolve(entryPathAbs), opts.repoRoot, opts.config, tok);
  const blocks = costBlocks(resolved.blocks, tok);
  const totals = computeTotals(blocks);
  const budget = computeBudget(totals, opts.config);
  const findings = runFindings(
    blocks,
    opts.config,
    tok,
    resolved.unlinkedAgentsCopies,
    resolved.frontmatterSubjects,
    opts.repoRoot,
  );

  const analysis: Analysis = {
    modelVersion: MODEL_VERSION,
    entry: resolved.entryPosix,
    tokenizer: tok.name,
    blocks,
    totals,
    budget,
    findings,
  };
  return { analysis, notes: resolved.notes, mode: resolved.mode };
}
