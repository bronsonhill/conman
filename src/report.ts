// Report rendering. Two shapes: `human` (default, for a terminal or a review)
// and `json` (for CI and tooling). Both are deterministic byte-for-byte given
// the same Analysis.

import { MODEL_VERSION, type Analysis, type Finding } from "./types.js";
import { evaluateGate } from "./gate.js";
import type { Config } from "./config.js";

const KIND_LABEL: Record<string, string> = {
  memory: "memory",
  import: "import",
  "rule-always": "rule-always",
  "rule-scoped": "rule-scoped",
  "skill-index": "skill-index",
};

function pad(s: string, w: number): string {
  return s.length >= w ? s : s + " ".repeat(w - s.length);
}
function padStart(s: string, w: number): string {
  return s.length >= w ? s : " ".repeat(w - s.length) + s;
}

export interface RenderContext {
  analysis: Analysis;
  config: Config;
  configSource: string | null;
  notes: string[];
  mode: "stack" | "single-file";
  toolVersion: string;
}

export function renderHuman(ctx: RenderContext): string {
  const { analysis: a } = ctx;
  const gate = evaluateGate(a, ctx.config);
  const out: string[] = [];

  out.push(
    `conman ${ctx.toolVersion}  model ${MODEL_VERSION}  tokenizer ${a.tokenizer}`,
  );
  out.push(`entry: ${a.entry || "."}   mode: ${ctx.mode}`);
  out.push(`config: ${ctx.configSource ?? "(built-in defaults)"}`);
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
  const counts = countBySeverity(a.findings);
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

function countBySeverity(findings: Finding[]) {
  let error = 0;
  let warn = 0;
  for (const f of findings) {
    if (f.severity === "error") error++;
    else if (f.severity === "warn") warn++;
  }
  return { error, warn };
}

/** Recursively sort object keys so JSON.stringify output is stable. */
function sortDeep(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sortDeep);
  if (v && typeof v === "object") {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(v as Record<string, unknown>).sort()) {
      out[k] = sortDeep((v as Record<string, unknown>)[k]);
    }
    return out;
  }
  return v;
}

export function renderJson(ctx: RenderContext): string {
  const gate = evaluateGate(ctx.analysis, ctx.config);
  const payload = {
    tool: "conman",
    toolVersion: ctx.toolVersion,
    modelVersion: MODEL_VERSION,
    mode: ctx.mode,
    configSource: ctx.configSource,
    entry: ctx.analysis.entry,
    tokenizer: ctx.analysis.tokenizer,
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
