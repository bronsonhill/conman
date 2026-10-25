// Rendering for `conman diff`: pure formatters over a `Delta`. Deterministic.

import type { Delta, DeltaFinding } from "./delta.js";
import { MODEL_VERSION } from "./types.js";
import { pad, padStart, sortDeep } from "./reportUtil.js";

export interface DeltaContext {
  toolVersion: string;
  /** "map" for `diff --map`, "entry" for a single entry point. */
  scope: "map" | "entry";
  configSource: string | null;
}

const signed = (n: number): string => (n > 0 ? `+${n}` : String(n));

function findingBlock(out: string[], title: string, list: DeltaFinding[]): void {
  out.push(`${title}  (${list.length})${list.length === 0 ? "  none" : ""}`);
  for (const f of list) {
    out.push(`  ${pad(f.severity, 6)} ${f.type}`);
    for (const file of f.files) out.push(`         ${file}`);
    out.push(`         ${f.message}`);
    out.push(`         in: ${f.entries.join(", ")}`);
  }
  out.push("");
}

export function renderDeltaHuman(d: Delta, ctx: DeltaContext): string {
  const out: string[] = [];
  out.push(`conman ${ctx.toolVersion} diff  model ${MODEL_VERSION}`);
  out.push(`config: ${ctx.configSource ?? "(built-in defaults)"}  (applied to both sides)`);
  out.push("");

  const rows: [string, number, number, number][] = [
    ["entry points", d.base.entryPoints, d.head.entryPoints, d.delta.entryPoints],
    ["tokens", d.base.tokens, d.head.tokens, d.delta.tokens],
    ["redundant tokens", d.base.redundantTokens, d.head.redundantTokens, d.delta.redundantTokens],
    ["errors", d.base.errors, d.head.errors, d.delta.errors],
    ["warnings", d.base.warnings, d.head.warnings, d.delta.warnings],
  ];
  out.push("  " + pad("", 18) + padStart("base", 8) + padStart("head", 8) + padStart("delta", 8));
  for (const [label, b, h, dl] of rows) {
    out.push(
      "  " + pad(label, 18) + padStart(String(b), 8) + padStart(String(h), 8) + padStart(signed(dl), 8),
    );
  }
  out.push("");

  out.push(`NEW ENTRY POINTS  (${d.entryPointsAdded.length})${d.entryPointsAdded.length === 0 ? "  none" : ""}`);
  for (const e of d.entryPointsAdded) out.push(`  ${e.entry}  +${e.tokens} tokens`);
  out.push("");
  out.push(
    `REMOVED ENTRY POINTS  (${d.entryPointsRemoved.length})${d.entryPointsRemoved.length === 0 ? "  none" : ""}`,
  );
  for (const e of d.entryPointsRemoved) out.push(`  ${e.entry}  -${e.tokens} tokens`);
  out.push("");

  out.push(`TOKEN CHANGES  (${d.entryPointDeltas.length})${d.entryPointDeltas.length === 0 ? "  none" : ""}`);
  const w = Math.max(12, ...d.entryPointDeltas.map((e) => e.entry.length));
  for (const e of d.entryPointDeltas) {
    out.push(
      "  " + pad(e.entry, w + 2) + padStart(String(e.base), 7) + " ->" + padStart(String(e.head), 7) +
        padStart(signed(e.delta), 8),
    );
  }
  out.push("");

  findingBlock(out, "NEW FINDINGS", d.findingsAdded);
  findingBlock(out, "RESOLVED FINDINGS", d.findingsResolved);

  out.push(
    `RESULT  ${d.result}  (${signed(d.delta.tokens)} tokens, ` +
      `findings: ${d.findingsAdded.length} new, ${d.findingsResolved.length} resolved)`,
  );
  return out.join("\n") + "\n";
}

export function renderDeltaJson(d: Delta, ctx: DeltaContext): string {
  const payload = {
    tool: "conman",
    toolVersion: ctx.toolVersion,
    modelVersion: MODEL_VERSION,
    command: "diff",
    scope: ctx.scope,
    configSource: ctx.configSource,
    base: d.base,
    head: d.head,
    delta: d.delta,
    entryPointsAdded: d.entryPointsAdded,
    entryPointsRemoved: d.entryPointsRemoved,
    entryPointDeltas: d.entryPointDeltas,
    findingsAdded: d.findingsAdded,
    findingsResolved: d.findingsResolved,
    result: d.result,
  };
  return JSON.stringify(sortDeep(payload), null, 2) + "\n";
}
