// Stale-boilerplate finding: a stock sentence that Claude Code's `/init` writes
// into a fresh CLAUDE.md, still sitting there unmodified. The author ran `/init`
// and never replaced the placeholder prose, so the stack carries filler that
// says nothing project-specific.
//
// The match set is a small curated list of known `/init` template sentences,
// compared near-verbatim (whitespace collapsed, case-insensitive). Only memory
// files (`CLAUDE.md` / `AGENTS.md`) are in scope — that is what `/init` writes.
//
// Severity: warn (`config.gate["stale-boilerplate"]`; "off" disables).

import type { Block, Finding } from "../types.js";
import type { Config } from "../config.js";

/** Known `/init` template sentences, normalized (lowercase, single-spaced). */
const TEMPLATE_PHRASES: { id: string; text: string }[] = [
  {
    id: "init-guidance-header",
    text: "this file provides guidance to claude code (claude.ai/code) when working with code in this repository.",
  },
  {
    id: "init-guidance-header",
    text: "this file provides guidance to claude code when working with code in this repository.",
  },
  {
    id: "init-guidance-header",
    text: "this file provides guidance to claude when working with code in this repository.",
  },
];

function norm(s: string): string {
  return s.toLowerCase().replace(/\s+/g, " ").trim();
}

export function findStaleBoilerplate(blocks: Block[], config: Config): Finding[] {
  const severity = config.gate["stale-boilerplate"];
  if (severity === "off") return [];

  const findings: Finding[] = [];
  const emitted = new Set<string>();

  for (const b of blocks) {
    if (b.kind !== "memory") continue;
    const lines = b.text.split("\n");
    // Locate each phrase: the line that contains it outright, else the first
    // line of the two-line window that does. First hit per phrase id wins.
    const locate = (): { i: number; id: string } | null => {
      for (let i = 0; i < lines.length; i++) {
        if (TEMPLATE_PHRASES.some((p) => norm(lines[i]!).includes(p.text))) {
          return { i, id: TEMPLATE_PHRASES.find((p) => norm(lines[i]!).includes(p.text))!.id };
        }
      }
      for (let i = 0; i < lines.length; i++) {
        const win = norm(lines[i] + " " + (lines[i + 1] ?? ""));
        const p = TEMPLATE_PHRASES.find((q) => win.includes(q.text));
        if (p) return { i, id: p.id };
      }
      return null;
    };
    const found = locate();
    if (found) {
      const key = `${b.source} ${found.id}`;
      if (emitted.has(key)) continue;
      emitted.add(key);
      const ln = b.lineStart + found.i;
      findings.push({
        type: "stale-boilerplate",
        severity,
        message:
          'unmodified `/init` template sentence still present ("This file provides guidance to Claude Code…"); replace it with project-specific guidance or delete it',
        locations: [{ file: b.source, lineStart: ln, lineEnd: ln }],
        detail: { phrase: found.id },
      });
    }
  }

  findings.sort((a, b) =>
    a.locations[0]!.file < b.locations[0]!.file
      ? -1
      : a.locations[0]!.file > b.locations[0]!.file
        ? 1
        : a.locations[0]!.lineStart - b.locations[0]!.lineStart,
  );
  return findings;
}
