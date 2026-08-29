// Mechanical, semantics-free fixes. Three operations, and nothing that touches
// prose or meaning:
//
//   1. dedupe a byte-identical block that a child file repeats from a parent:
//      delete it from the child, keep the parent's copy
//   2. sort skill frontmatter keys alphabetically (values kept verbatim)
//   3. normalize whitespace: strip trailing spaces, collapse consecutive blank
//      lines to one (they render identically), single trailing newline, drop a
//      leading BOM
//
// Every operation is idempotent: a second `--fix` run produces no further change.

import { readFileSync, writeFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { Analysis, Finding } from "./types.js";
import { parseFrontmatter } from "./frontmatter.js";
import { isDir, isFile, relPosix } from "./repo.js";

const FENCE = /^(\s*)(`{3,}|~{3,})/;

export interface FileChange {
  file: string;
  operations: string[];
  before: string;
  after: string;
}
export interface FixResult {
  changes: FileChange[];
  notes: string[];
}

function fencedFlags(lines: string[]): boolean[] {
  const flags = new Array<boolean>(lines.length).fill(false);
  let inFence = false;
  let marker = "";
  lines.forEach((line, i) => {
    const m = line.match(FENCE);
    if (inFence) {
      flags[i] = true;
      if (m && m[2]!.startsWith(marker)) inFence = false;
    } else if (m) {
      flags[i] = true;
      inFence = true;
      marker = m[2]![0]!.repeat(3);
    }
  });
  return flags;
}

function normalizeWhitespace(text: string): string {
  let t = text.replace(/^﻿/, "");
  const lines = t.split("\n");
  const fenced = fencedFlags(lines);
  const stripped = lines.map((l, i) => (fenced[i] ? l : l.replace(/[ \t]+$/, "")));

  const out: string[] = [];
  let blankRun = 0;
  for (let i = 0; i < stripped.length; i++) {
    const line = stripped[i]!;
    const isBlank = line === "" && !fenced[i];
    if (isBlank) {
      blankRun++;
      if (blankRun >= 2) continue; // collapse consecutive blank lines to one
      out.push(line);
    } else {
      blankRun = 0;
      out.push(line);
    }
  }
  t = out.join("\n").replace(/\n+$/, "") + "\n";
  return t;
}

function dirSegs(p: string): string[] {
  const dir = p.includes("/") ? p.slice(0, p.lastIndexOf("/")) : ".";
  return dir === "." || dir === "" ? [] : dir.split("/");
}
function isAncestorPath(a: string, b: string): boolean {
  const as = dirSegs(a);
  const bs = dirSegs(b);
  if (as.length >= bs.length) return false;
  return as.every((s, i) => s === bs[i]);
}

/** Pick the file to keep the shared block in. */
function parentFile(files: string[]): string {
  for (const f of files) {
    if (files.every((g) => g === f || isAncestorPath(f, g))) return f;
  }
  return [...files].sort()[0]!;
}

function applyDedupe(
  repoRoot: string,
  findings: Finding[],
  perFile: Map<string, { lines: string[]; ops: Set<string> }>,
  notes: string[],
): void {
  const deletions = new Map<string, { start: number; end: number; keep: string }[]>();
  for (const f of findings) {
    if (f.type !== "duplication") continue;
    const files = [...new Set(f.locations.map((l) => l.file))];
    if (files.length < 2) continue;
    const keep = parentFile(files);
    for (const loc of f.locations) {
      if (loc.file === keep) continue;
      const arr = deletions.get(loc.file) ?? [];
      arr.push({ start: loc.lineStart, end: loc.lineEnd, keep });
      deletions.set(loc.file, arr);
    }
  }

  for (const [file, ranges] of deletions) {
    const abs = join(repoRoot, file);
    if (!isFile(abs)) {
      notes.push(`dedupe skipped: ${file} not found`);
      continue;
    }
    const entry = perFile.get(file) ?? {
      lines: readFileSync(abs, "utf8").split("\n"),
      ops: new Set<string>(),
    };
    // delete from the bottom up so earlier ranges keep their indices
    const sorted = ranges.slice().sort((a, b) => b.start - a.start);
    for (const r of sorted) {
      const from = r.start - 1;
      const count = r.end - r.start + 1;
      if (from < 0 || from + count > entry.lines.length) continue;
      entry.lines.splice(from, count);
      entry.ops.add(`deduped block repeated from ${r.keep}`);
    }
    perFile.set(file, entry);
  }
}

/** Reorder top-level frontmatter keys. Returns null if it can't be done safely. */
function sortFrontmatterKeys(text: string): string | null {
  const fm = parseFrontmatter(text);
  if (!fm.present) return null;
  const yamlLines = fm.rawYaml.split("\n");

  interface Chunk {
    key: string;
    lines: string[];
  }
  const chunks: Chunk[] = [];
  let pending: string[] = []; // comments / blanks that precede a key
  let cur: Chunk | null = null;
  for (const line of yamlLines) {
    const top = line.match(/^([A-Za-z0-9_-]+)\s*:/);
    if (top) {
      if (cur) chunks.push(cur);
      cur = { key: top[1]!, lines: [...pending, line] };
      pending = [];
    } else if (cur && (line.startsWith(" ") || line.startsWith("\t") || line === "")) {
      cur.lines.push(line);
    } else if (!cur && (line.trimStart().startsWith("#") || line === "")) {
      pending.push(line);
    } else {
      return null; // unclassifiable line; leave this file alone
    }
  }
  if (cur) cur.lines.push(...pending);
  if (cur) chunks.push(cur);
  if (chunks.length < 2) return null;

  const sorted = chunks
    .map((c, i) => ({ c, i }))
    .sort((x, y) => (x.c.key < y.c.key ? -1 : x.c.key > y.c.key ? 1 : x.i - y.i))
    .map((x) => x.c);
  if (sorted.every((c, i) => c === chunks[i])) return null; // already sorted

  const newYaml = sorted.flatMap((c) => c.lines).join("\n");
  const all = text.split("\n");
  const rebuilt = [
    ...all.slice(0, fm.startLine), // opening ---
    ...newYaml.split("\n"),
    ...all.slice(fm.endLine - 1), // closing --- onward
  ];
  return rebuilt.join("\n");
}

function discoverSkillFiles(repoRoot: string): string[] {
  const out: string[] = [];
  const sdir = join(repoRoot, ".claude", "skills");
  if (!isDir(sdir)) return out;
  for (const sub of readdirSync(sdir).sort()) {
    const p = join(sdir, sub, "SKILL.md");
    if (isFile(p)) out.push(p);
  }
  return out;
}

export function computeFixes(repoRoot: string, analysis: Analysis): FixResult {
  const notes: string[] = [];
  const perFile = new Map<string, { lines: string[]; ops: Set<string> }>();

  // 1. dedupe
  applyDedupe(repoRoot, analysis.findings, perFile, notes);

  // seed whitespace-normalize targets: every real file in the stack
  const stackFiles = new Set<string>();
  for (const b of analysis.blocks) {
    if (b.kind === "skill-index") continue;
    stackFiles.add(b.source);
  }
  for (const file of stackFiles) {
    if (!perFile.has(file)) {
      const abs = join(repoRoot, file);
      if (!isFile(abs)) continue;
      perFile.set(file, {
        lines: readFileSync(abs, "utf8").split("\n"),
        ops: new Set<string>(),
      });
    }
  }

  // 2. skill frontmatter key sort (+ whitespace) on SKILL.md files
  for (const abs of discoverSkillFiles(repoRoot)) {
    const rel = relPosix(repoRoot, abs);
    const original = readFileSync(abs, "utf8");
    const sorted = sortFrontmatterKeys(original);
    const entry = { lines: (sorted ?? original).split("\n"), ops: new Set<string>() };
    if (sorted !== null) entry.ops.add("sorted skill frontmatter keys");
    perFile.set(rel, entry);
  }

  // 3. whitespace normalize across everything queued
  const changes: FileChange[] = [];
  for (const [file, entry] of [...perFile].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
    const abs = join(repoRoot, file);
    if (!isFile(abs)) continue;
    const before = readFileSync(abs, "utf8");
    const afterDedupeSort = entry.lines.join("\n");
    const after = normalizeWhitespace(afterDedupeSort);
    if (after !== afterDedupeSort || afterDedupeSort !== before) {
      if (after !== afterDedupeSort) entry.ops.add("normalized whitespace");
    }
    if (after === before) continue;
    changes.push({
      file,
      operations: [...entry.ops].sort(),
      before,
      after,
    });
  }

  return { changes, notes };
}

export function applyFixes(repoRoot: string, result: FixResult): void {
  for (const c of result.changes) {
    writeFileSync(join(repoRoot, c.file), c.after, "utf8");
  }
}
