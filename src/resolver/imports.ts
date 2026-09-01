// The `@`-import walk: turning one context file into an ordered list of blocks,
// following `@path` references depth-first, cycle-guarded, depth-limited. Also
// the small text helpers (`countLines`, `normalizeForCompare`, `realOrSelf`)
// shared by the rule, skill, and AGENTS.md stages.

import { readFileSync, realpathSync } from "node:fs";
import { dirname, resolve } from "node:path";
import type { Block, BlockKind } from "../types.js";
import type { Tokenizer } from "../tokenizer.js";
import { isFile, relPosix } from "../repo.js";
import { fencedLineSet, maskInlineCode } from "../findings/_fence.js";

/** Line count that does not overcount a trailing newline. */
export function countLines(text: string): number {
  if (text.length === 0) return 0;
  const n = text.split("\n").length;
  return text.endsWith("\n") ? n - 1 : n;
}

/**
 * A context file whose YAML frontmatter the resolver reads keys from: a
 * `.claude/rules` entry (its `paths` scope key) or a skill `SKILL.md` (its
 * `name` / `description`). Carried out of resolution so the frontmatter finding
 * can lint the raw text without re-walking the tree.
 */
export interface FrontmatterSubject {
  /** Repo-relative POSIX path. */
  file: string;
  role: "rule" | "skill";
  /** Full raw file text. */
  text: string;
}

export interface ImportCtx {
  repoRoot: string;
  tok: Tokenizer;
  depthLimit: number;
  notes: string[];
  /** Repo-relative paths of every block emitted so far, across the whole walk. */
  seen: Set<string>;
  /**
   * Real (symlink-resolved) absolute path of every file loaded as a block ->
   * the repo-relative path it was loaded under. Lets the sibling walk spot a
   * CLAUDE.md -> AGENTS.md symlink and not count the target a second time.
   */
  seenReal: Map<string, string>;
  /** Rule / SKILL.md files whose frontmatter the resolver read keys from. */
  frontmatterSubjects: FrontmatterSubject[];
}

/** Symlink-resolved absolute path, or the input unchanged if it cannot resolve. */
export function realOrSelf(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
}

/**
 * Trailing-whitespace- and blank-edge-insensitive view of a file's bytes, for
 * deciding whether two memory files are "the same content".
 */
export function normalizeForCompare(s: string): string {
  return s
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map((l) => l.replace(/[ \t]+$/, ""))
    .join("\n")
    .replace(/^\n+/, "")
    .replace(/\n+$/, "");
}

export function findImports(
  text: string,
  fileAbs: string,
): { path: string; line: number }[] {
  const lines = text.split("\n");
  const fenced = fencedLineSet(lines);
  // Blank inline-code spans (incl. ones that wrap across lines) so `@foo` in
  // backticks is not read as an import.
  const masked = maskInlineCode(lines, fenced);
  const found: { path: string; line: number }[] = [];
  const re = /(?:^|\s)@([^\s`]+)/g;
  lines.forEach((line, i) => {
    if (fenced.has(i)) return;
    const stripped = masked[i]!;
    let m: RegExpExecArray | null;
    re.lastIndex = 0;
    while ((m = re.exec(stripped)) !== null) {
      const raw = m[1]!;
      if (raw.startsWith("~")) continue; // home-dir import, outside the repo
      found.push({ path: raw, line: i + 1 });
    }
  });
  return found;
}

export function resolveFileBlocks(
  fileAbs: string,
  kind: BlockKind,
  depth: number,
  via: string | undefined,
  visited: Set<string>,
  ctx: ImportCtx,
): Omit<Block, "id" | "tokens">[] {
  const norm = resolve(fileAbs);
  if (visited.has(norm)) {
    ctx.notes.push(`import cycle skipped at ${relPosix(ctx.repoRoot, norm)}`);
    return [];
  }
  if (!isFile(norm)) return [];
  visited.add(norm);

  const text = readFileSync(norm, "utf8");
  const lineCount = countLines(text);
  const rel = relPosix(ctx.repoRoot, norm);
  ctx.seen.add(rel);
  if (!ctx.seenReal.has(realOrSelf(norm))) ctx.seenReal.set(realOrSelf(norm), rel);
  const out: Omit<Block, "id" | "tokens">[] = [
    {
      kind,
      source: rel,
      lineStart: 1,
      lineEnd: Math.max(1, lineCount),
      text,
      depth,
      ...(via ? { via } : {}),
    },
  ];

  if (depth >= ctx.depthLimit) {
    const imports = findImports(text, norm);
    if (imports.length > 0) {
      ctx.notes.push(
        `import depth limit (${ctx.depthLimit}) reached at ${rel}; ${imports.length} nested import(s) not followed`,
      );
    }
    visited.delete(norm);
    return out;
  }

  for (const imp of findImports(text, norm)) {
    const target = resolve(dirname(norm), imp.path);
    if (!isFile(target)) {
      ctx.notes.push(`unresolved @-import "${imp.path}" in ${rel}:${imp.line}`);
      continue;
    }
    out.push(
      ...resolveFileBlocks(
        target,
        "import",
        depth + 1,
        `${rel}:${imp.line}`,
        visited,
        ctx,
      ),
    );
  }
  visited.delete(norm);
  return out;
}
