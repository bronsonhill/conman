// Rendering for `conman map`: a per-entry rollup plus a repo total. Deterministic.

import type { MapResult } from "./map.js";
import { MODEL_VERSION } from "./analyze.js";
import { redundancy } from "./report.js";

/** Redundant tokens across every entry point, and that as a share of the rollup. */
export function mapRedundancy(result: MapResult): { tokens: number; pctOfStack: number } {
  const stack = result.entries.reduce((n, e) => n + e.analysis.totals.stackTokens, 0);
  const tokens = result.entries.reduce((n, e) => n + redundancy(e.analysis).tokens, 0);
  return { tokens, pctOfStack: stack > 0 ? Math.round((tokens / stack) * 100) : 0 };
}

function pad(s: string, w: number): string {
  return s.length >= w ? s : s + " ".repeat(w - s.length);
}
function padStart(s: string, w: number): string {
  return s.length >= w ? s : " ".repeat(w - s.length) + s;
}

export function renderMapHuman(
  result: MapResult,
  toolVersion: string,
  configSource: string | null,
): string {
  const out: string[] = [];
  out.push(`conman ${toolVersion} map  model ${MODEL_VERSION}`);
  out.push(`config: ${configSource ?? "(built-in defaults)"}`);
  out.push(`entry points discovered: ${result.entries.length}`);
  out.push("");

  const entryW = Math.max(12, ...result.entries.map((e) => e.entry.length));
  out.push(
    "  " +
      pad("entry", entryW + 2) +
      pad("mode", 13) +
      padStart("tokens", 8) +
      padStart("delta", 9) +
      "   " +
      pad("findings", 22) +
      "result",
  );
  for (const e of result.entries) {
    const a = e.analysis;
    const err = a.findings.filter((f) => f.severity === "error").length;
    const warn = a.findings.filter((f) => f.severity === "warn").length;
    out.push(
      "  " +
        pad(e.entry, entryW + 2) +
        pad(e.mode, 13) +
        padStart(String(a.totals.stackTokens), 8) +
        padStart((a.budget.delta >= 0 ? "+" : "") + a.budget.delta, 9) +
        "   " +
        pad(`${err} error, ${warn} warn`, 22) +
        (e.pass ? "pass" : "FAIL"),
    );
  }
  out.push("");

  const ruleOnly = result.entries.filter(
    (e) => e.discovery.includes("rule-path") && !e.discovery.includes("memory-file"),
  );
  if (ruleOnly.length > 0) {
    out.push("discovered via a path-scoped rule (no CLAUDE.md / AGENTS.md of their own):");
    for (const e of ruleOnly) out.push(`  ${e.entry}`);
    out.push("");
  }

  const totalTokens = result.entries.reduce(
    (n, e) => n + e.analysis.totals.stackTokens,
    0,
  );
  const red = mapRedundancy(result);
  out.push(`repo rollup: ${totalTokens} tokens across ${result.entries.length} entry points`);
  out.push(`redundant tokens: ${red.tokens} (${red.pctOfStack}% of stack)`);
  out.push("");

  const failing = result.entries.filter((e) => !e.pass);
  out.push(`RESULT  ${result.pass ? "pass" : "fail"}`);
  for (const e of failing) {
    out.push(`  ${e.entry}`);
    for (const r of e.reasons) out.push(`    - ${r}`);
  }
  return out.join("\n") + "\n";
}

function sortDeep(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sortDeep);
  if (v && typeof v === "object") {
    const o: Record<string, unknown> = {};
    for (const k of Object.keys(v as Record<string, unknown>).sort()) {
      o[k] = sortDeep((v as Record<string, unknown>)[k]);
    }
    return o;
  }
  return v;
}

export function renderMapJson(
  result: MapResult,
  toolVersion: string,
  configSource: string | null,
): string {
  const payload = {
    tool: "conman",
    toolVersion,
    modelVersion: MODEL_VERSION,
    command: "map",
    configSource,
    pass: result.pass,
    redundant: mapRedundancy(result),
    entryPoints: result.entries.map((e) => ({
      entry: e.entry,
      discovery: e.discovery,
      mode: e.mode,
      tokenizer: e.analysis.tokenizer,
      stackTokens: e.analysis.totals.stackTokens,
      redundant: redundancy(e.analysis),
      budget: e.analysis.budget,
      blocks: e.analysis.blocks.map((b) => ({
        id: b.id,
        kind: b.kind,
        source: b.source,
        lineStart: b.lineStart,
        lineEnd: b.lineEnd,
        depth: b.depth,
        via: b.via ?? null,
        tokens: b.tokens,
      })),
      findings: e.analysis.findings,
      notes: e.notes,
      result: { pass: e.pass, reasons: e.reasons },
    })),
  };
  return JSON.stringify(sortDeep(payload), null, 2) + "\n";
}
