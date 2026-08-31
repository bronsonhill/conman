// Rendering for `conman map`: a per-entry rollup plus a repo total. Deterministic.

import type { MapResult } from "./map.js";
import { MODEL_VERSION } from "./types.js";
import { redundancy } from "./report.js";

/** Redundant tokens across every entry point, and that as a share of the rollup. */
export function mapRedundancy(result: MapResult): { tokens: number; pctOfStack: number } {
  const stack = result.entries.reduce((n, e) => n + e.analysis.totals.stackTokens, 0);
  const tokens = result.entries.reduce((n, e) => n + redundancy(e.analysis).tokens, 0);
  return { tokens, pctOfStack: stack > 0 ? Math.round((tokens / stack) * 100) : 0 };
}

// A resolver note of the form "<prefix>; did not match entry <entry>" is emitted
// once per entry point per non-matching path-scoped rule. On a monorepo that is
// O(entries x rules) lines that differ only in the trailing entry name. These
// helpers hoist them to a single map-level list with a count, and separately
// name any path-scoped rule that matched no discovered entry point at all.
const DID_NOT_MATCH_RE = /^(.*); did not match entry (.+)$/;
const PATHS_RULE_ID_RE = /^rule (.+?) is path-scoped \(/;
const GLOBS_RULE_ID_RE = /^(.+?) is glob-scoped \(/;

function ruleIdFromPrefix(prefix: string): string | null {
  const m = PATHS_RULE_ID_RE.exec(prefix) ?? GLOBS_RULE_ID_RE.exec(prefix);
  return m?.[1] ?? null;
}

export interface MapNoteSummary {
  /** One line per non-matching path-scoped rule, counted, sorted by prefix. */
  collapsed: string[];
  /** Path-scoped rules that matched no discovered entry point, sorted. */
  deadRules: string[];
  /** Per-entry notes with the hoisted "did not match entry" lines removed. */
  perEntry: Map<string, string[]>;
}

export function summarizeMapNotes(result: MapResult): MapNoteSummary {
  // prefix -> set of entry names that reported "did not match"
  const groups = new Map<string, Set<string>>();
  const perEntry = new Map<string, string[]>();
  for (const e of result.entries) {
    const kept: string[] = [];
    for (const n of e.notes) {
      const m = DID_NOT_MATCH_RE.exec(n);
      if (!m || m[1] === undefined || m[2] === undefined) {
        kept.push(n);
        continue;
      }
      const prefix = m[1];
      let set = groups.get(prefix);
      if (!set) {
        set = new Set<string>();
        groups.set(prefix, set);
      }
      set.add(m[2]);
    }
    perEntry.set(e.entry, kept);
  }

  // A path-scoped rule is "live" if it loaded for at least one entry point,
  // i.e. it shows up as a rule-scoped block somewhere in the map.
  const live = new Set<string>();
  for (const e of result.entries) {
    for (const b of e.analysis.blocks) {
      if (b.kind === "rule-scoped") live.add(b.source);
    }
  }

  const prefixes = [...groups.keys()].sort();
  const collapsed: string[] = [];
  const deadRules: string[] = [];
  for (const prefix of prefixes) {
    const entries = [...groups.get(prefix)!].sort();
    collapsed.push(
      entries.length === 1
        ? `${prefix}; did not match entry ${entries[0]}`
        : `${prefix}; did not match ${entries.length} entry points`,
    );
    const id = ruleIdFromPrefix(prefix);
    if (id && !live.has(id)) {
      deadRules.push(`${prefix}; matched no discovered entry point`);
    }
  }
  deadRules.sort();
  return { collapsed, deadRules, perEntry };
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

  const noteSummary = summarizeMapNotes(result);
  if (noteSummary.collapsed.length > 0) {
    out.push("path-scoped rules that did not match every entry point:");
    for (const line of noteSummary.collapsed) out.push(`  ${line}`);
    out.push("");
  }
  if (noteSummary.deadRules.length > 0) {
    out.push("path-scoped rules that matched no entry point (dead scope):");
    for (const line of noteSummary.deadRules) out.push(`  ${line}`);
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
  const noteSummary = summarizeMapNotes(result);
  const payload = {
    tool: "conman",
    toolVersion,
    modelVersion: MODEL_VERSION,
    command: "map",
    configSource,
    pass: result.pass,
    redundant: mapRedundancy(result),
    // Map-level rollup of the repeated "did not match entry <x>" resolver notes.
    // The raw lines used to sit once per entry in each entryPoints[].notes; the
    // per-entry arrays now carry only their genuinely unique notes and these two
    // arrays carry the collapsed view. `deadPathScopedRules` names rules that
    // loaded for no entry point at all.
    pathScopedRuleNotes: noteSummary.collapsed,
    deadPathScopedRules: noteSummary.deadRules,
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
      notes: noteSummary.perEntry.get(e.entry) ?? e.notes,
      result: { pass: e.pass, reasons: e.reasons },
    })),
  };
  return JSON.stringify(sortDeep(payload), null, 2) + "\n";
}
