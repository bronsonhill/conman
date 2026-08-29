// Duplication finding: a byte-identical segment that appears in both a parent
// file and a child file in the resolved stack. "Parent/child" means one file's
// directory is an ancestor of the other's, or one file @-imports the other
// (directly or through a chain). Sibling files that happen to share text are not
// flagged in the MVP.

import type { Block, Finding, Location } from "../types.js";
import type { Config } from "../config.js";
import type { Tokenizer } from "../tokenizer.js";
import { splitSegments } from "../segments.js";

const MIN_DUP_TOKENS = 8;

function dirSegs(pathPosix: string): string[] {
  const dir = pathPosix.includes("/")
    ? pathPosix.slice(0, pathPosix.lastIndexOf("/"))
    : ".";
  return dir === "." || dir === "" ? [] : dir.split("/");
}

function isAncestorPath(a: string, b: string): boolean {
  if (a === b) return false;
  const as = dirSegs(a);
  const bs = dirSegs(b);
  if (as.length >= bs.length) return false;
  return as.every((s, i) => s === bs[i]);
}

/** Map child source -> parent source, from @-import `via` markers. */
function buildImportParents(blocks: Block[]): Map<string, string> {
  const m = new Map<string, string>();
  for (const b of blocks) {
    if (b.kind === "import" && b.via) {
      const parent = b.via.slice(0, b.via.lastIndexOf(":"));
      if (!m.has(b.source)) m.set(b.source, parent);
    }
  }
  return m;
}

function importChainHas(
  child: string,
  ancestorCandidate: string,
  importParents: Map<string, string>,
): boolean {
  let cur: string | undefined = child;
  const seen = new Set<string>();
  while (cur && !seen.has(cur)) {
    seen.add(cur);
    const p = importParents.get(cur);
    if (p === ancestorCandidate) return true;
    cur = p;
  }
  return false;
}

function isParentChild(
  a: string,
  b: string,
  importParents: Map<string, string>,
): boolean {
  return (
    isAncestorPath(a, b) ||
    isAncestorPath(b, a) ||
    importChainHas(b, a, importParents) ||
    importChainHas(a, b, importParents)
  );
}

export function findDuplication(
  blocks: Block[],
  config: Config,
  tok: Tokenizer,
): Finding[] {
  const severity = config.gate.duplication;
  if (severity === "off") return [];

  const importParents = buildImportParents(blocks);
  const considered = blocks.filter(
    (b) => b.kind === "memory" || b.kind === "import" || b.kind.startsWith("rule-"),
  );

  // normalized segment text -> occurrences
  const groups = new Map<
    string,
    { tokens: number; occ: { file: string; lineStart: number; lineEnd: number }[] }
  >();

  for (const b of considered) {
    for (const seg of splitSegments(b.source, b.text, b.lineStart, tok)) {
      if (seg.headingOnly) continue;
      if (seg.tokens < MIN_DUP_TOKENS) continue;
      const key = seg.text;
      const g = groups.get(key) ?? { tokens: seg.tokens, occ: [] };
      // de-dupe identical (file,line) occurrences
      if (!g.occ.some((o) => o.file === seg.source && o.lineStart === seg.lineStart)) {
        g.occ.push({ file: seg.source, lineStart: seg.lineStart, lineEnd: seg.lineEnd });
      }
      groups.set(key, g);
    }
  }

  const findings: Finding[] = [];
  for (const [text, g] of groups) {
    if (g.occ.length < 2) continue;
    const files = [...new Set(g.occ.map((o) => o.file))];
    if (files.length < 2) continue;
    const hasParentChild = files.some((f1) =>
      files.some((f2) => f1 !== f2 && isParentChild(f1, f2, importParents)),
    );
    if (!hasParentChild) continue;

    const locations: Location[] = g.occ
      .slice()
      .sort((a, b) =>
        a.file < b.file ? -1 : a.file > b.file ? 1 : a.lineStart - b.lineStart,
      )
      .map((o) => ({ file: o.file, lineStart: o.lineStart, lineEnd: o.lineEnd }));

    const redundant = g.tokens * (g.occ.length - 1);
    const preview = text.split("\n")[0]!.slice(0, 60);
    findings.push({
      type: "duplication",
      severity,
      message: `identical ${g.tokens}-token block "${preview}${text.length > 60 ? "…" : ""}" appears in ${g.occ.length} files (${redundant} redundant tokens)`,
      locations,
      tokens: redundant,
      detail: { segmentTokens: g.tokens, occurrences: g.occ.length },
    });
  }

  findings.sort(
    (a, b) =>
      (b.tokens ?? 0) - (a.tokens ?? 0) ||
      (a.locations[0]!.file < b.locations[0]!.file ? -1 : 1),
  );
  return findings;
}
