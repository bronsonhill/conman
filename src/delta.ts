// Pure comparison of two resolved analyses (base vs head). Plain data in, plain
// data out: no fs, no git, no clock. Not to be confused with `diff.ts`, which
// renders unified text diffs for `--fix --dry-run`.

import type { Analysis, Finding, FindingType, Severity } from "./types.js";
import { redundancy } from "./report.js";

/** The slice of a map entry the delta needs. `MapResult["entries"]` satisfies it. */
export interface DeltaEntry {
  entry: string;
  analysis: Analysis;
}

export interface DeltaInput {
  entries: DeltaEntry[];
}

export interface SideSummary {
  entryPoints: number;
  tokens: number;
  redundantTokens: number;
  /** Distinct findings (by identity key) per severity. */
  errors: number;
  warnings: number;
}

export interface TokenChange {
  entry: string;
  base: number;
  head: number;
  delta: number;
}

export interface DeltaFinding {
  type: FindingType;
  severity: Severity;
  message: string;
  /** Sorted file paths the finding points at; no line numbers. */
  files: string[];
  /** Entry points the finding appears under, sorted. */
  entries: string[];
}

export interface EntryStack {
  entry: string;
  tokens: number;
}

export interface Delta {
  base: SideSummary;
  head: SideSummary;
  delta: { entryPoints: number; tokens: number; redundantTokens: number; errors: number; warnings: number };
  entryPointsAdded: EntryStack[];
  entryPointsRemoved: EntryStack[];
  /** Common entry points whose stack size changed, sorted by entry. */
  entryPointDeltas: TokenChange[];
  findingsAdded: DeltaFinding[];
  findingsResolved: DeltaFinding[];
  result: "grew" | "shrank" | "unchanged";
}

/**
 * Identity of a finding across two checkouts. Line numbers are left out so an
 * edit that only shifts a finding down the file does not read as resolved + new.
 * Severity is part of the key: a severity change reports as resolved + added.
 */
export function findingKey(f: Finding): string {
  const files = f.locations.map((l) => l.file).sort();
  const message = f.message.replace(/\s+/g, " ").trim();
  return JSON.stringify([f.type, f.severity, files, message]);
}

function collect(entries: DeltaEntry[]): Map<string, DeltaFinding> {
  const out = new Map<string, DeltaFinding>();
  for (const e of entries) {
    for (const f of e.analysis.findings) {
      if (f.severity === "off") continue;
      const key = findingKey(f);
      const have = out.get(key);
      if (have) {
        if (!have.entries.includes(e.entry)) have.entries.push(e.entry);
      } else {
        out.set(key, {
          type: f.type,
          severity: f.severity,
          message: f.message.replace(/\s+/g, " ").trim(),
          files: f.locations.map((l) => l.file).sort(),
          entries: [e.entry],
        });
      }
    }
  }
  for (const f of out.values()) f.entries.sort();
  return out;
}

function sortFindings(list: DeltaFinding[]): DeltaFinding[] {
  const sev = (s: Severity): number => (s === "error" ? 0 : 1);
  return list.sort(
    (a, b) =>
      sev(a.severity) - sev(b.severity) ||
      cmp(a.type, b.type) ||
      cmp(a.files.join("\n"), b.files.join("\n")) ||
      cmp(a.message, b.message),
  );
}

function cmp(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function summarize(entries: DeltaEntry[], findings: Map<string, DeltaFinding>): SideSummary {
  let errors = 0;
  let warnings = 0;
  for (const f of findings.values()) {
    if (f.severity === "error") errors++;
    else warnings++;
  }
  return {
    entryPoints: entries.length,
    tokens: entries.reduce((n, e) => n + e.analysis.totals.stackTokens, 0),
    redundantTokens: entries.reduce((n, e) => n + redundancy(e.analysis).tokens, 0),
    errors,
    warnings,
  };
}

/** Compare two whole-repo analyses (or two single-entry ones wrapped in a list). */
export function diffMap(base: DeltaInput, head: DeltaInput): Delta {
  const baseBy = new Map(base.entries.map((e) => [e.entry, e]));
  const headBy = new Map(head.entries.map((e) => [e.entry, e]));

  const entryPointsAdded: EntryStack[] = [];
  const entryPointsRemoved: EntryStack[] = [];
  const entryPointDeltas: TokenChange[] = [];
  for (const [entry, h] of headBy) {
    const b = baseBy.get(entry);
    if (!b) {
      entryPointsAdded.push({ entry, tokens: h.analysis.totals.stackTokens });
      continue;
    }
    const bt = b.analysis.totals.stackTokens;
    const ht = h.analysis.totals.stackTokens;
    if (bt !== ht) entryPointDeltas.push({ entry, base: bt, head: ht, delta: ht - bt });
  }
  for (const [entry, b] of baseBy) {
    if (!headBy.has(entry)) {
      entryPointsRemoved.push({ entry, tokens: b.analysis.totals.stackTokens });
    }
  }
  const byEntry = (a: { entry: string }, b: { entry: string }): number => cmp(a.entry, b.entry);
  entryPointsAdded.sort(byEntry);
  entryPointsRemoved.sort(byEntry);
  entryPointDeltas.sort(byEntry);

  const baseFindings = collect(base.entries);
  const headFindings = collect(head.entries);
  const findingsAdded = sortFindings(
    [...headFindings].filter(([k]) => !baseFindings.has(k)).map(([, f]) => f),
  );
  const findingsResolved = sortFindings(
    [...baseFindings].filter(([k]) => !headFindings.has(k)).map(([, f]) => f),
  );

  const b = summarize(base.entries, baseFindings);
  const h = summarize(head.entries, headFindings);
  const tokens = h.tokens - b.tokens;
  return {
    base: b,
    head: h,
    delta: {
      entryPoints: h.entryPoints - b.entryPoints,
      tokens,
      redundantTokens: h.redundantTokens - b.redundantTokens,
      errors: h.errors - b.errors,
      warnings: h.warnings - b.warnings,
    },
    entryPointsAdded,
    entryPointsRemoved,
    entryPointDeltas,
    findingsAdded,
    findingsResolved,
    result: tokens > 0 ? "grew" : tokens < 0 ? "shrank" : "unchanged",
  };
}

/** Single-entry comparison: the same shape, over at most one entry per side. */
export function diffAnalysis(base: Analysis | null, head: Analysis | null): Delta {
  const wrap = (a: Analysis | null): DeltaInput => ({
    entries: a ? [{ entry: a.entry || ".", analysis: a }] : [],
  });
  return diffMap(wrap(base), wrap(head));
}
