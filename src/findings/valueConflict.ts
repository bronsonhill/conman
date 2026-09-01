// Value-conflict finding: the same key is set to two different values at two
// locations in the resolved stack.
//
// The MVP catches one mechanical shape: definitional markdown lines of the form
// `Key`: value  /  **Key:** value  /  - Key: value, where the same key gets two
// different short values in two different files of the stack.
//
// Structured keys (settings.json, frontmatter) are not cross-compared: each
// file's `description` is its own, and settings.json / settings.local.json are
// merged upstream, so a surviving value is intentional. Deeper semantic
// contradiction ("prefer tabs" vs "always use spaces") waits for the LLM layer.
// This is strict on purpose: a missed conflict is cheaper than a false one.

import type { Block, Finding, Location } from "../types.js";
import type { Config } from "../config.js";
import type { Tokenizer } from "../tokenizer.js";
import { fencedLineSet, maskInlineCode } from "./_fence.js";

interface Occurrence {
  value: string;
  file: string;
  line: number;
}

const PATTERNS: RegExp[] = [
  // `Key`: value   |   `Key` = value
  /^\s*[-*]?\s*`([A-Za-z][\w .\-\/]{0,40})`\s*[:=]\s*(\S.{0,60}?)\s*$/d,
  // **Key:** value   |   **Key**: value
  /^\s*[-*]?\s*\*\*([A-Za-z][\w .\-\/]{0,40}?):?\*\*\s*[:=]?\s*(\S.{0,60}?)\s*$/d,
  // - Key: value   (list item; key must start uppercase to cut noise)
  /^\s*[-*]\s+([A-Z][\w .\-\/]{0,40}?)\s*[:=]\s+(\S.{0,60}?)\s*$/d,
];

function normKey(k: string): string {
  return k.toLowerCase().replace(/\s+/g, " ").replace(/[.:=\-\s]+$/, "").trim();
}

function normValue(v: string): string {
  return v
    .trim()
    .replace(/^["'`]+|["'`]+$/g, "")
    .replace(/[.,;]\s*$/, "")
    .trim();
}

function scanMarkdown(blocks: Block[]): Map<string, Occurrence[]> {
  const map = new Map<string, Occurrence[]>();
  for (const b of blocks) {
    if (b.kind === "skill-index") continue;
    const lines = b.text.split("\n");
    const fenced = fencedLineSet(lines);
    // Inline code spans blanked (incl. spans that wrap across lines). A
    // definitional-looking line whose key or value lands inside a code span is
    // a documented example — a verbatim changelog trailer, a config snippet —
    // not a rule the resolved stack applies, so it is not scored as a conflict.
    // A `Key`: value line in ordinary prose still counts: only the backticked
    // key is masked, and the check below allows a masked region there but
    // nowhere else in the match.
    const masked = maskInlineCode(lines, fenced);
    lines.forEach((line, i) => {
      if (fenced.has(i)) return;
      for (let p = 0; p < PATTERNS.length; p++) {
        const re = PATTERNS[p]!;
        const m = line.match(re);
        if (!m || !m.indices) continue;
        // The backticked-key pattern (p === 0) legitimately masks its own key;
        // every other captured span must be free of code-span masking.
        const spans = p === 0 ? [m.indices[2]] : [m.indices[1], m.indices[2]];
        const inCode = spans.some((s) => {
          if (!s) return false;
          for (let k = s[0]; k < s[1]; k++) {
            if (line[k] !== " " && masked[i]![k] === " ") return true;
          }
          return false;
        });
        if (inCode) break;
        const key = normKey(m[1]!);
        const value = normValue(m[2]!);
        if (!key || !value) break;
        // skip values that read like a clause rather than a setting
        if (/\s(and|or|when|if|because|unless|but)\s/i.test(value)) break;
        const arr = map.get(key) ?? [];
        arr.push({ value, file: b.source, line: b.lineStart + i });
        map.set(key, arr);
        break;
      }
    });
  }
  return map;
}

export function findValueConflicts(
  blocks: Block[],
  config: Config,
  tok: Tokenizer,
): Finding[] {
  const severity = config.gate["value-conflict"];
  if (severity === "off") return [];

  const md = scanMarkdown(blocks);
  const findings: Finding[] = [];

  for (const [key, occ] of md) {
    const byValue = new Map<string, Occurrence>();
    for (const o of occ) if (!byValue.has(o.value)) byValue.set(o.value, o);
    if (byValue.size < 2) continue;

    const distinct = [...byValue.values()].sort((a, b) =>
      a.file < b.file ? -1 : a.file > b.file ? 1 : a.line - b.line,
    );
    // a conflict must span two files; two differing values inside one file is
    // usually an enumeration, not a contradiction
    if (new Set(distinct.map((d) => d.file)).size < 2) continue;

    const locations: Location[] = distinct.map((d) => ({
      file: d.file,
      lineStart: d.line,
      lineEnd: d.line,
    }));
    findings.push({
      type: "value-conflict",
      severity,
      message: `key "${key}" is set to different values across the stack: ${distinct
        .map((d) => `"${d.value}"`)
        .join(" vs ")}`,
      locations,
      tokens: distinct.reduce((n, d) => n + tok.countTokens(`${key}: ${d.value}`), 0),
      detail: { key, values: distinct.map((d) => d.value) },
    });
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
