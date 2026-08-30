// Duplication finding: a byte-identical segment (>= MIN_DUP_TOKENS tokens) that
// appears in two or more files of one resolved stack. The check is stack-level,
// not a parent/child special case: any repeat inside the stack is waste the
// session pays for. Each finding records how the two files are related in
// `detail.relation`:
//
//   - "parent-child": one file's directory is an ancestor of the other's
//   - "import":       one file @-imports the other (directly or through a chain)
//   - "same-stack":   neither — two files that just happen to share text
//
// When every qualifying segment of one file also appears in another (a whole-file
// duplicate), the pair is rolled up into a single finding instead of one finding
// per shared segment, so a child CLAUDE.md that repeats its parent wholesale
// reads as one line, not sixty.
//
// A bare AGENTS.md sitting beside a byte-identical CLAUDE.md is NOT this finding:
// the resolver leaves it out of the stack (Claude Code never loads it), and the
// `unlinked-copy` warn finding covers the drift risk instead.

import type { Block, Finding, Location } from "../types.js";
import type { Config } from "../config.js";
import type { Tokenizer } from "../tokenizer.js";
import { splitSegments } from "../segments.js";

const MIN_DUP_TOKENS = 8;

export type DuplicationRelation = "parent-child" | "import" | "same-stack";

// Most specific first. A finding over a set of files reports the strongest
// relation present among any pair in the set.
const RELATION_RANK: Record<DuplicationRelation, number> = {
  "parent-child": 0,
  import: 1,
  "same-stack": 2,
};

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

function relationBetween(
  a: string,
  b: string,
  importParents: Map<string, string>,
): DuplicationRelation {
  if (isAncestorPath(a, b) || isAncestorPath(b, a)) return "parent-child";
  if (importChainHas(b, a, importParents) || importChainHas(a, b, importParents)) {
    return "import";
  }
  return "same-stack";
}

/** Strongest (most specific) relation among any pair in `files`. */
function strongestRelation(
  files: string[],
  importParents: Map<string, string>,
): DuplicationRelation {
  let best: DuplicationRelation = "same-stack";
  for (let i = 0; i < files.length; i++) {
    for (let j = i + 1; j < files.length; j++) {
      const r = relationBetween(files[i]!, files[j]!, importParents);
      if (RELATION_RANK[r] < RELATION_RANK[best]) best = r;
    }
    if (best === "parent-child") break;
  }
  return best;
}

interface Occ {
  file: string;
  lineStart: number;
  lineEnd: number;
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

  // normalized segment text -> occurrences across the stack
  const groups = new Map<string, { tokens: number; occ: Occ[] }>();
  // file -> the set of its qualifying segment texts, and their summed tokens
  const fileSegs = new Map<string, Set<string>>();
  const fileSegTokens = new Map<string, number>();
  // file -> full line span, for whole-file-duplicate locations
  const fileSpan = new Map<string, { lineStart: number; lineEnd: number }>();

  for (const b of considered) {
    const prev = fileSpan.get(b.source);
    fileSpan.set(b.source, {
      lineStart: prev ? Math.min(prev.lineStart, b.lineStart) : b.lineStart,
      lineEnd: prev ? Math.max(prev.lineEnd, b.lineEnd) : b.lineEnd,
    });
    for (const seg of splitSegments(b.source, b.text, b.lineStart, tok)) {
      if (seg.headingOnly) continue;
      if (seg.tokens < MIN_DUP_TOKENS) continue;
      const key = seg.text;

      const g = groups.get(key) ?? { tokens: seg.tokens, occ: [] };
      if (!g.occ.some((o) => o.file === seg.source && o.lineStart === seg.lineStart)) {
        g.occ.push({ file: seg.source, lineStart: seg.lineStart, lineEnd: seg.lineEnd });
      }
      groups.set(key, g);

      let set = fileSegs.get(seg.source);
      if (!set) {
        set = new Set<string>();
        fileSegs.set(seg.source, set);
      }
      if (!set.has(key)) {
        set.add(key);
        fileSegTokens.set(seg.source, (fileSegTokens.get(seg.source) ?? 0) + seg.tokens);
      }
    }
  }

  const findings: Finding[] = [];

  // --- Whole-file duplicates: cluster files whose qualifying-segment sets are
  //     equal, or where one set is contained in the other. One finding per
  //     cluster; the non-kept members are marked so their segments do not also
  //     produce per-segment findings below.
  const files = [...fileSegs.keys()].sort();
  const uf = new Map<string, string>();
  const find = (x: string): string => {
    let r = x;
    while (uf.get(r) !== r) r = uf.get(r)!;
    while (uf.get(x) !== r) {
      const n = uf.get(x)!;
      uf.set(x, r);
      x = n;
    }
    return r;
  };
  const union = (a: string, b: string) => uf.set(find(a), find(b));
  for (const f of files) uf.set(f, f);

  const subsetOf = (small: Set<string>, big: Set<string>): boolean => {
    if (small.size === 0 || small.size > big.size) return false;
    for (const s of small) if (!big.has(s)) return false;
    return true;
  };

  for (let i = 0; i < files.length; i++) {
    for (let j = i + 1; j < files.length; j++) {
      const sa = fileSegs.get(files[i]!)!;
      const sb = fileSegs.get(files[j]!)!;
      if (subsetOf(sa, sb) || subsetOf(sb, sa)) union(files[i]!, files[j]!);
    }
  }

  const clusters = new Map<string, string[]>();
  for (const f of files) {
    const root = find(f);
    const arr = clusters.get(root) ?? [];
    arr.push(f);
    clusters.set(root, arr);
  }

  const coveredFiles = new Set<string>();
  for (const members of clusters.values()) {
    if (members.length < 2) continue;
    members.sort();
    // Keep the member with the most qualifying tokens; ties break lexically, so
    // the token maths below is stable. The finding names every file, so which
    // one is "kept" is not a delete instruction.
    let keeper = members[0]!;
    for (const m of members) {
      if ((fileSegTokens.get(m) ?? 0) > (fileSegTokens.get(keeper) ?? 0)) keeper = m;
    }
    const total = members.reduce((n, m) => n + (fileSegTokens.get(m) ?? 0), 0);
    const redundant = total - (fileSegTokens.get(keeper) ?? 0);
    for (const m of members) if (m !== keeper) coveredFiles.add(m);

    const keeperSize = fileSegs.get(keeper)!.size;
    const allEqual = members.every((m) => fileSegs.get(m)!.size === keeperSize);
    const relation = strongestRelation(members, importParents);
    const message = allEqual
      ? `identical content across ${members.length} files: ${members.join(", ")} (${redundant} redundant tokens, relation: ${relation})`
      : `whole-file duplication: every block of ${members
          .filter((m) => m !== keeper)
          .join(", ")} also appears in ${keeper} (${redundant} redundant tokens, relation: ${relation})`;
    const locations: Location[] = members.map((m) => ({
      file: m,
      lineStart: fileSpan.get(m)?.lineStart ?? 1,
      lineEnd: fileSpan.get(m)?.lineEnd ?? 1,
    }));
    findings.push({
      type: "duplication",
      severity,
      message,
      locations,
      tokens: redundant,
      detail: {
        relation,
        wholeFileDuplicate: true,
        files: members,
        occurrences: members.length,
      },
    });
  }

  // --- Per-segment duplicates: any remaining segment shared by >= 2 files that
  //     a whole-file rollup did not already account for.
  for (const [text, g] of groups) {
    const occ = g.occ.filter((o) => !coveredFiles.has(o.file));
    if (occ.length < 2) continue;
    const distinctFiles = [...new Set(occ.map((o) => o.file))];
    if (distinctFiles.length < 2) continue;

    const relation = strongestRelation(distinctFiles, importParents);
    const locations: Location[] = occ
      .slice()
      .sort((a, b) =>
        a.file < b.file ? -1 : a.file > b.file ? 1 : a.lineStart - b.lineStart,
      )
      .map((o) => ({ file: o.file, lineStart: o.lineStart, lineEnd: o.lineEnd }));

    const redundant = g.tokens * (occ.length - 1);
    const preview = text.split("\n")[0]!.slice(0, 60);
    findings.push({
      type: "duplication",
      severity,
      message: `identical ${g.tokens}-token block "${preview}${text.length > 60 ? "…" : ""}" appears in ${occ.length} files (${redundant} redundant tokens, relation: ${relation})`,
      locations,
      tokens: redundant,
      detail: { relation, segmentTokens: g.tokens, occurrences: occ.length },
    });
  }

  findings.sort(
    (a, b) =>
      (b.tokens ?? 0) - (a.tokens ?? 0) ||
      (a.locations[0]!.file < b.locations[0]!.file ? -1 : 1),
  );
  return findings;
}
