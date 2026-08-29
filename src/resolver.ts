// Stack resolver: entry point -> ordered list of blocks.
//
// This implements a documented *model* of how Claude Code assembles startup
// context. It is not a claim of bug-for-bug parity; see MODEL.md for the
// ordering rules and the assumptions behind each step.
//
// Load order:
//   1. ancestor memory files, root-most first, entry-closest last;
//      CLAUDE.md before AGENTS.md within a directory;
//      each file's @-imports inlined immediately after it, depth-first
//   2. .claude/rules entries with no path scope (always loaded), path-sorted
//   3. .claude/rules entries whose `globs` matched the entry path, path-sorted
//   4. the skill startup index (name + description per skill), budget-truncated

import { readFileSync, readdirSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import type { Block, BlockKind } from "./types.js";
import type { Config } from "./config.js";
import type { Tokenizer } from "./tokenizer.js";
import { parseFrontmatter } from "./frontmatter.js";
import { isDir, isFile, matchesAnyGlob, relPosix } from "./repo.js";

const MEMORY_NAMES = ["CLAUDE.md", "AGENTS.md"];
const FENCE = /^(\s*)(`{3,}|~{3,})/;

/** Line count that does not overcount a trailing newline. */
function countLines(text: string): number {
  if (text.length === 0) return 0;
  const n = text.split("\n").length;
  return text.endsWith("\n") ? n - 1 : n;
}

export interface Settings {
  claudeMdExcludes: string[];
  skillListingBudget: number | null;
  raw: Record<string, unknown>;
}

export interface ResolveResult {
  mode: "stack" | "single-file";
  entryPosix: string;
  blocks: Omit<Block, "id" | "tokens">[];
  settings: Settings;
  notes: string[];
}

export function loadSettings(repoRoot: string): Settings {
  const merged: Record<string, unknown> = {};
  for (const name of ["settings.json", "settings.local.json"]) {
    const p = join(repoRoot, ".claude", name);
    if (!isFile(p)) continue;
    try {
      const parsed = JSON.parse(readFileSync(p, "utf8"));
      if (parsed && typeof parsed === "object") Object.assign(merged, parsed);
    } catch {
      // ignore malformed settings; resolution proceeds without them
    }
  }
  const excludes =
    pickStringArray(merged, "claudeMdExcludes") ??
    pickStringArray(merged, "claudeMd.excludes") ??
    [];
  const budget =
    pickNumber(merged, "skillListingBudget") ??
    pickNumber(merged, "skillsListingBudget") ??
    pickNumber(merged, "skills.listingBudget") ??
    null;
  return { claudeMdExcludes: excludes, skillListingBudget: budget, raw: merged };
}

function pickStringArray(obj: Record<string, unknown>, key: string): string[] | undefined {
  const v = deepGet(obj, key);
  if (Array.isArray(v) && v.every((x) => typeof x === "string")) return v as string[];
  return undefined;
}
function pickNumber(obj: Record<string, unknown>, key: string): number | undefined {
  const v = deepGet(obj, key);
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}
function deepGet(obj: Record<string, unknown>, dotted: string): unknown {
  let cur: unknown = obj;
  for (const part of dotted.split(".")) {
    if (cur && typeof cur === "object" && part in (cur as Record<string, unknown>)) {
      cur = (cur as Record<string, unknown>)[part];
    } else {
      return undefined;
    }
  }
  return cur;
}

/** Directories from repo root (or filesystem root) down to `entryDir`, inclusive. */
function ancestorDirs(entryDir: string, repoRoot: string, repoBoundary: boolean): string[] {
  const chain: string[] = [];
  let dir = resolve(entryDir);
  const stop = resolve(repoRoot);
  for (;;) {
    chain.push(dir);
    if (repoBoundary && dir === stop) break;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return chain.reverse();
}

interface ImportCtx {
  repoRoot: string;
  tok: Tokenizer;
  depthLimit: number;
  notes: string[];
  /** Repo-relative paths of every block emitted so far, across the whole walk. */
  seen: Set<string>;
}

/** Line indices (0-based) that sit inside a fenced code block. */
function fencedLineSet(lines: string[]): Set<number> {
  const set = new Set<number>();
  let inFence = false;
  let marker = "";
  lines.forEach((line, i) => {
    const m = line.match(FENCE);
    if (inFence) {
      set.add(i);
      if (m && m[2]!.startsWith(marker)) inFence = false;
    } else if (m) {
      set.add(i);
      inFence = true;
      marker = m[2]![0]!.repeat(3);
    }
  });
  return set;
}

function findImports(
  text: string,
  fileAbs: string,
): { path: string; line: number }[] {
  const lines = text.split("\n");
  const fenced = fencedLineSet(lines);
  const found: { path: string; line: number }[] = [];
  const re = /(?:^|\s)@([^\s`]+)/g;
  lines.forEach((line, i) => {
    if (fenced.has(i)) return;
    // strip inline-code spans so `@foo` in backticks is ignored
    const stripped = line.replace(/`[^`]*`/g, (s) => " ".repeat(s.length));
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

function resolveFileBlocks(
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

function findClaudeDirs(entryDir: string, repoRoot: string): string[] {
  const dirs: string[] = [];
  let dir = resolve(entryDir);
  const stop = resolve(repoRoot);
  for (;;) {
    const c = join(dir, ".claude");
    if (isDir(c)) dirs.push(c);
    if (dir === stop) break;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return dirs.reverse(); // root-most first
}

function collectRuleBlocks(
  claudeDirs: string[],
  entryTargetPosix: string,
  ctx: ImportCtx,
): { always: Omit<Block, "id" | "tokens">[]; scoped: Omit<Block, "id" | "tokens">[] } {
  const always: Omit<Block, "id" | "tokens">[] = [];
  const scoped: Omit<Block, "id" | "tokens">[] = [];
  for (const cdir of claudeDirs) {
    const rdir = join(cdir, "rules");
    if (!isDir(rdir)) continue;
    const entries = readdirSync(rdir)
      .filter((f) => f.endsWith(".md"))
      .sort();
    for (const f of entries) {
      const abs = join(rdir, f);
      if (!isFile(abs)) continue;
      const text = readFileSync(abs, "utf8");
      const fm = parseFrontmatter(text);
      const lineCount = countLines(text);
      const rel = relPosix(ctx.repoRoot, abs);
      const globs = toStringArray(fm.data["globs"]);
      const alwaysApply = fm.data["alwaysApply"] === true;
      const block: Omit<Block, "id" | "tokens"> = {
        kind: globs.length > 0 && !alwaysApply ? "rule-scoped" : "rule-always",
        source: rel,
        lineStart: 1,
        lineEnd: Math.max(1, lineCount),
        text,
        depth: 0,
      };
      if (block.kind === "rule-scoped") {
        if (matchesAnyGlob(entryTargetPosix, globs)) scoped.push(block);
        else
          ctx.notes.push(
            `rule ${rel} is path-scoped (${globs.join(", ")}); did not match entry ${entryTargetPosix}`,
          );
      } else {
        always.push(block);
      }
    }
  }
  return { always, scoped };
}

function toStringArray(v: unknown): string[] {
  if (typeof v === "string") return v.trim() ? [v.trim()] : [];
  if (Array.isArray(v)) return v.filter((x) => typeof x === "string").map((x) => (x as string).trim());
  return [];
}

function buildSkillIndex(
  claudeDirs: string[],
  budgetTokens: number | null,
  ctx: ImportCtx,
): Omit<Block, "id" | "tokens"> | null {
  const skills: { name: string; description: string; dirRel: string }[] = [];
  let skillsRootRel = ".claude/skills";
  for (const cdir of claudeDirs) {
    const sdir = join(cdir, "skills");
    if (!isDir(sdir)) continue;
    skillsRootRel = relPosix(ctx.repoRoot, sdir);
    const subs = readdirSync(sdir).sort();
    for (const sub of subs) {
      const skillMd = join(sdir, sub, "SKILL.md");
      if (!isFile(skillMd)) continue;
      const fm = parseFrontmatter(readFileSync(skillMd, "utf8"));
      const name =
        typeof fm.data["name"] === "string" ? (fm.data["name"] as string) : sub;
      const description =
        typeof fm.data["description"] === "string"
          ? (fm.data["description"] as string).replace(/\s+/g, " ").trim()
          : "";
      skills.push({ name, description, dirRel: relPosix(ctx.repoRoot, join(sdir, sub)) });
    }
  }
  if (skills.length === 0) return null;
  skills.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));

  const lineFor = (s: { name: string; description: string }) =>
    `- ${s.name}: ${s.description}`;

  let kept = skills;
  let truncatedNote = "";
  if (budgetTokens !== null) {
    kept = [];
    let running = 0;
    for (const s of skills) {
      const cost = ctx.tok.countTokens(lineFor(s) + "\n");
      if (running + cost > budgetTokens) break;
      running += cost;
      kept.push(s);
    }
    if (kept.length < skills.length) {
      const omitted = skills.length - kept.length;
      truncatedNote = `\n- (${omitted} more skill${omitted === 1 ? "" : "s"} not listed; skill-listing budget ${budgetTokens} tokens exceeded)`;
      ctx.notes.push(
        `skill startup index truncated: ${omitted} of ${skills.length} skills omitted under skill-listing budget ${budgetTokens}`,
      );
    }
  }

  const text = kept.map(lineFor).join("\n") + truncatedNote + "\n";
  return {
    kind: "skill-index",
    source: skillsRootRel,
    lineStart: 1,
    lineEnd: Math.max(1, kept.length),
    text,
    depth: 0,
  };
}

export function resolveStack(
  entryPathAbs: string,
  repoRoot: string,
  config: Config,
  tok: Tokenizer,
  notes: string[] = [],
): ResolveResult {
  const settings = loadSettings(repoRoot);
  const ctx: ImportCtx = {
    repoRoot,
    tok,
    depthLimit: config.resolve.importDepthLimit,
    notes,
    seen: new Set<string>(),
  };

  const entryIsFile = isFile(entryPathAbs);
  const entryIsMemoryFile =
    entryIsFile && MEMORY_NAMES.includes(basename(entryPathAbs));
  const entryDir = entryIsFile ? dirname(entryPathAbs) : entryPathAbs;
  const entryPosix = relPosix(repoRoot, entryPathAbs);

  // Single-file convenience mode: an arbitrary file that is not a memory file.
  if (entryIsFile && !entryIsMemoryFile) {
    const blocks = resolveFileBlocks(
      entryPathAbs,
      "memory",
      0,
      undefined,
      new Set(),
      ctx,
    );
    notes.push(
      "single-file mode: ancestor walk, rules, and skill index are not resolved",
    );
    return { mode: "single-file", entryPosix, blocks, settings, notes };
  }

  const excludes = settings.claudeMdExcludes;
  const dirs = ancestorDirs(entryDir, repoRoot, config.resolve.repoBoundary);
  const memoryBlocks: Omit<Block, "id" | "tokens">[] = [];
  for (const dir of dirs) {
    for (const name of MEMORY_NAMES) {
      const abs = join(dir, name);
      if (!isFile(abs)) continue;
      const rel = relPosix(repoRoot, abs);
      if (excludes.length > 0 && matchesAnyGlob(rel, excludes)) {
        notes.push(`excluded by settings claudeMdExcludes: ${rel}`);
        continue;
      }
      if (ctx.seen.has(rel)) {
        notes.push(
          `${rel} already pulled in via an @-import; not loaded again as a sibling memory file`,
        );
        continue;
      }
      memoryBlocks.push(
        ...resolveFileBlocks(abs, "memory", 0, undefined, new Set(), ctx),
      );
    }
  }

  const claudeDirs = findClaudeDirs(entryDir, repoRoot);
  const entryTargetPosix = entryIsMemoryFile
    ? relPosix(repoRoot, entryDir)
    : entryPosix;
  const { always, scoped } = collectRuleBlocks(claudeDirs, entryTargetPosix || ".", ctx);

  const skillBudget =
    config.resolve.skillListingBudget ?? settings.skillListingBudget ?? null;
  const skillIndex = buildSkillIndex(claudeDirs, skillBudget, ctx);

  const blocks = [
    ...memoryBlocks,
    ...always,
    ...scoped,
    ...(skillIndex ? [skillIndex] : []),
  ];
  return { mode: "stack", entryPosix, blocks, settings, notes };
}
