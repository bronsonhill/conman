// Report rendering. Two shapes: `human` (default, for a terminal or a review)
// and `json` (for CI and tooling). Both are deterministic byte-for-byte given
// the same Analysis.

import { MODEL_VERSION, type Analysis } from "./types.js";
import { modelFreshness, type Agent } from "./agent.js";
import type { Config } from "./config.js";
import { KIND_LABEL, pad, padStart, severityCounts, sortDeep } from "./reportUtil.js";

export interface RenderContext {
  analysis: Analysis;
  config: Config;
  configSource: string | null;
  notes: string[];
  mode: "stack" | "single-file";
  toolVersion: string;
  /** Resolution ruleset in effect; selects the model-freshness header note. */
  agent: Agent;
  /**
   * The stack includes machine-local config that CI never sees: `--user`'s
   * `~/.claude` files, or a gitignored `CLAUDE.local.md` in the checkout.
   */
  machineSpecific?: boolean;
}

export function renderHuman(ctx: RenderContext): string {
  const { analysis: a } = ctx;
  const gate = a.gate;
  const out: string[] = [];

  out.push(
    `conman ${ctx.toolVersion}  model ${MODEL_VERSION}  ${modelFreshness(ctx.agent)}  tokenizer ${a.tokenizer}`,
  );
  out.push(`entry: ${a.entry || "."}   mode: ${ctx.mode}`);
  out.push(`config: ${ctx.configSource ?? "(built-in defaults)"}`);
  out.push(
    `tokenizer: ${a.tokenizer} (estimate; see README "How accurate is the token estimate?")`,
  );
  if (ctx.machineSpecific) {
    out.push(
      "scope: machine-specific (includes machine-local config: ~/.claude user config and/or a gitignored CLAUDE.local.md; not reproducible on another machine)",
    );
  }
  out.push("");

  // load order table
  out.push("LOAD ORDER");
  const srcW = Math.max(
    10,
    ...a.blocks.map((b) => b.source.length + (b.via ? ` (via ${b.via})`.length : 0)),
  );
  out.push(
    "  " +
      pad("#", 5) +
      pad("kind", 13) +
      pad("source", srcW + 2) +
      pad("lines", 12) +
      padStart("tokens", 8),
  );
  for (const b of a.blocks) {
    const src = b.source + (b.via ? ` (via ${b.via})` : "");
    out.push(
      "  " +
        pad(b.id, 5) +
        pad(KIND_LABEL[b.kind] ?? b.kind, 13) +
        pad(src, srcW + 2) +
        pad(`${b.lineStart}-${b.lineEnd}`, 12) +
        padStart(String(b.tokens), 8),
    );
  }
  out.push("  " + "-".repeat(5 + 13 + srcW + 2 + 12 + 8));
  out.push(
    "  " +
      pad("total", 5 + 13 + srcW + 2 + 12) +
      padStart(String(a.totals.stackTokens), 8),
  );
  out.push("");

  // budget
  const b = a.budget;
  out.push("BUDGET");
  out.push(`  budget          ${b.total}`);
  out.push(
    `  safety margin   ${Math.round(b.safetyMargin * 100)}%   ->  effective ${b.effective}`,
  );
  out.push(`  stack total     ${b.stackTotal}`);
  out.push(
    `  delta           ${b.delta >= 0 ? "+" : ""}${b.delta}  (${b.overBudget ? "OVER budget" : "under budget"})`,
  );
  out.push("");

  // savings: what removing duplicated content would recover
  const red = redundancy(a);
  out.push("SAVINGS");
  out.push(`  redundant tokens: ${red.tokens} (${red.pctOfStack}% of stack)`);
  out.push("");

  // findings
  const counts = severityCounts(a.findings);
  out.push(
    `FINDINGS  (${counts.error} error, ${counts.warn} warn)` +
      (a.findings.length === 0 ? "  none" : ""),
  );
  for (const f of a.findings) {
    out.push(`  ${pad(f.severity, 6)} ${f.type}`);
    for (const loc of f.locations) {
      out.push(`         ${loc.file}:${loc.lineStart}-${loc.lineEnd}`);
    }
    out.push(`         ${f.message}`);
  }
  out.push("");

  // notes
  const notes = [...ctx.notes];
  if (a.findings.some((f) => f.type === "vehicle-fit")) {
    notes.push(
      "vehicle-fit advice is structural only (block size and shape); left unsharpened until the opt-in LLM layer",
    );
  }
  if (notes.length > 0) {
    out.push("NOTES");
    for (const n of notes) out.push(`  - ${n}`);
    out.push("");
  }

  out.push(`RESULT  ${gate.pass ? "pass" : "fail"}`);
  for (const r of gate.reasons) out.push(`  - ${r}`);
  return out.join("\n") + "\n";
}

/**
 * Redundant tokens the duplication findings account for, and that as a share of
 * the resolved stack. `tokens` on each duplication finding is already the
 * "remove one copy" saving, and the whole-file rollup and per-segment passes
 * never count the same copy twice, so a plain sum is the stack-wide figure.
 */
export function redundancy(a: Analysis): { tokens: number; pctOfStack: number } {
  const tokens = a.findings
    .filter((f) => f.type === "duplication")
    .reduce((n, f) => n + (f.tokens ?? 0), 0);
  const stack = a.totals.stackTokens;
  return { tokens, pctOfStack: stack > 0 ? Math.round((tokens / stack) * 100) : 0 };
}

export function renderJson(ctx: RenderContext): string {
  const gate = ctx.analysis.gate;
  const payload = {
    tool: "conman",
    toolVersion: ctx.toolVersion,
    modelVersion: MODEL_VERSION,
    mode: ctx.mode,
    machineSpecific: ctx.machineSpecific === true,
    configSource: ctx.configSource,
    entry: ctx.analysis.entry,
    tokenizer: ctx.analysis.tokenizer,
    tokenizerNote:
      'estimate; see README "How accurate is the token estimate?"',
    blocks: ctx.analysis.blocks.map((b) => ({
      id: b.id,
      kind: b.kind,
      source: b.source,
      lineStart: b.lineStart,
      lineEnd: b.lineEnd,
      depth: b.depth,
      via: b.via ?? null,
      tokens: b.tokens,
    })),
    totals: ctx.analysis.totals,
    budget: ctx.analysis.budget,
    redundant: redundancy(ctx.analysis),
    findings: ctx.analysis.findings,
    notes: ctx.notes,
    result: { pass: gate.pass, reasons: gate.reasons },
  };
  return JSON.stringify(sortDeep(payload), null, 2) + "\n";
}
