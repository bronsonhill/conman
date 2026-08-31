// Formatting helpers shared by the three renderers (`report`, `mapReport`,
// `mapHtmlReport`). Each used to carry its own copy of these; they are pure and
// deterministic, so one home keeps the text and HTML tables aligned.

import type { Finding } from "./types.js";

/** Block-kind display label; falls through to the raw kind for anything new. */
export const KIND_LABEL: Record<string, string> = {
  memory: "memory",
  import: "import",
  "rule-always": "rule-always",
  "rule-scoped": "rule-scoped",
  "skill-index": "skill-index",
};

/** Left-justify `s` to width `w` with spaces; never truncates. */
export function pad(s: string, w: number): string {
  return s.length >= w ? s : s + " ".repeat(w - s.length);
}

/** Right-justify `s` to width `w` with spaces; never truncates. */
export function padStart(s: string, w: number): string {
  return s.length >= w ? s : " ".repeat(w - s.length) + s;
}

/** Recursively sort object keys so `JSON.stringify` output is stable. */
export function sortDeep(v: unknown): unknown {
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

/** Count findings by the two reported severities. */
export function severityCounts(findings: Finding[]): { error: number; warn: number } {
  let error = 0;
  let warn = 0;
  for (const f of findings) {
    if (f.severity === "error") error++;
    else if (f.severity === "warn") warn++;
  }
  return { error, warn };
}
