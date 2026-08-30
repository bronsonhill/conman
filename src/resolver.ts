// Stack resolver: entry point -> ordered list of blocks.
//
// This implements a documented *model* of how Claude Code assembles startup
// context. It is not a claim of bug-for-bug parity; see MODEL.md for the
// ordering rules and the assumptions behind each step.
//
// Load order:
//   1. ancestor CLAUDE.md files, root-most first, entry-closest last;
//      each file's @-imports inlined immediately after it, depth-first.
//      A bare AGENTS.md is NOT loaded: Claude Code reads CLAUDE.md only. An
//      AGENTS.md reaches the stack only when CLAUDE.md @-imports it, or the two
//      are the same file (a CLAUDE.md -> AGENTS.md symlink, the multi-tool norm).
//   2. .claude/rules entries with no path scope (always loaded), path-sorted
//   3. .claude/rules entries whose `paths` matched the entry path, path-sorted
//   4. the skill startup index (name + description per skill), budget-truncated

import { readFileSync, readdirSync, realpathSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import type { Block, BlockKind } from "./types.js";
import type { Agent } from "./agent.js";
import type { Config } from "./config.js";
import type { Tokenizer } from "./tokenizer.js";
import { parseFrontmatter } from "./frontmatter.js";
import { isDir, isFile, matchesAnyGlob, relPosix } from "./repo.js";
import { MEMORY_NAMES, RULE_SCOPE_KEY, toStringArray } from "./claudeContext.js";

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

/**
 * A directory that ships a CLAUDE.md and an AGENTS.md as two separate,
 * byte-identical files — not a symlink, not an `@`-import. Claude Code loads the
 * CLAUDE.md and never opens the AGENTS.md, so this is not a cost, but the two
 * copies drift. Fuel for the `unlinked-copy` finding.
 */
export interface UnlinkedAgentsCopy {
  claudeMd: string;
  agentsMd: string;
  /** Line count of the shared content, for the finding's locations. */
  lines: number;
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

export interface ResolveResult {
  mode: "stack" | "single-file";
  entryPosix: string;
  blocks: Omit<Block, "id" | "tokens">[];
  settings: Settings;
  notes: string[];
  unlinkedAgentsCopies: UnlinkedAgentsCopy[];
  frontmatterSubjects: FrontmatterSubject[];
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
function realOrSelf(p: string): string {
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
function normalizeForCompare(s: string): string {
  return s
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map((l) => l.replace(/[ \t]+$/, ""))
    .join("\n")
    .replace(/^\n+/, "")
    .replace(/\n+$/, "");
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
  excludes: string[],
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
      // `claudeMdExcludes` covers rules files too: the settings docs' own
      // example excludes a `.claude/rules/**` glob, and Claude Code's
      // changelog (v2.1.2xx) fixes exclusion of symlinked rules entries.
      const relForExclude = relPosix(ctx.repoRoot, abs);
      if (excludes.length > 0 && matchesAnyGlob(relForExclude, excludes)) {
        ctx.notes.push(`excluded by settings claudeMdExcludes: ${relForExclude}`);
        continue;
      }
      const text = readFileSync(abs, "utf8");
      const fm = parseFrontmatter(text);
      const lineCount = countLines(text);
      const rel = relPosix(ctx.repoRoot, abs);
      ctx.frontmatterSubjects.push({ file: rel, role: "rule", text });

      // Claude Code path-scopes a rule on one frontmatter key: `paths`. A rule
      // with no `paths` loads unconditionally. See MODEL.md for the source.
      const patterns = toStringArray(fm.data[RULE_SCOPE_KEY]);
      // A `paths` of `**` (or nothing usable) scopes to everything, which Claude
      // Code treats as no scope at all.
      const scopedByPath =
        patterns.length > 0 && !patterns.every((p) => p === "**");

      const block: Omit<Block, "id" | "tokens"> = {
        kind: scopedByPath ? "rule-scoped" : "rule-always",
        source: rel,
        lineStart: 1,
        lineEnd: Math.max(1, lineCount),
        text,
        depth: 0,
      };
      if (block.kind === "rule-scoped") {
        if (matchesAnyGlob(entryTargetPosix, patterns)) scoped.push(block);
        else
          ctx.notes.push(
            `rule ${rel} is path-scoped (${patterns.join(", ")}); did not match entry ${entryTargetPosix}`,
          );
      } else {
        always.push(block);
        // A rule copied from a Cursor `.mdc` file scopes on `globs`, which Claude
        // Code ignores: the rule silently loads always-on. Surface that.
        if (fm.data[RULE_SCOPE_KEY] === undefined && fm.data["globs"] !== undefined) {
          ctx.notes.push(
            `rule ${rel} sets \`globs\` but not \`paths\`; Claude Code path-scopes rules only on \`paths\`, so this rule loads always-on`,
          );
        }
      }
    }
  }
  return { always, scoped };
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
      const skillText = readFileSync(skillMd, "utf8");
      ctx.frontmatterSubjects.push({
        file: relPosix(ctx.repoRoot, skillMd),
        role: "skill",
        text: skillText,
      });
      const fm = parseFrontmatter(skillText);
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
  agent: Agent = "claude",
): ResolveResult {
  if (agent !== "claude") {
    return resolveNonClaude(entryPathAbs, repoRoot, config, tok, notes, agent);
  }
  const settings = loadSettings(repoRoot);
  const ctx: ImportCtx = {
    repoRoot,
    tok,
    depthLimit: config.resolve.importDepthLimit,
    notes,
    seen: new Set<string>(),
    seenReal: new Map<string, string>(),
    frontmatterSubjects: [],
  };
  const unlinkedAgentsCopies: UnlinkedAgentsCopy[] = [];

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
    return {
      mode: "single-file",
      entryPosix,
      blocks,
      settings,
      notes,
      unlinkedAgentsCopies,
      frontmatterSubjects: ctx.frontmatterSubjects,
    };
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

      // Claude Code reads CLAUDE.md, not AGENTS.md. A bare AGENTS.md costs a
      // Claude Code session nothing. It enters the stack only when CLAUDE.md
      // @-imports it (the ctx.seen check above already caught that) or the two
      // are the same file on disk (a CLAUDE.md -> AGENTS.md symlink).
      if (name === "AGENTS.md") {
        classifyAgentsMd(dir, abs, rel, repoRoot, ctx, unlinkedAgentsCopies);
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
  const { always, scoped } = collectRuleBlocks(
    claudeDirs,
    entryTargetPosix || ".",
    excludes,
    ctx,
  );

  const skillBudget =
    config.resolve.skillListingBudget ?? settings.skillListingBudget ?? null;
  const skillIndex = buildSkillIndex(claudeDirs, skillBudget, ctx);

  const blocks = [
    ...memoryBlocks,
    ...always,
    ...scoped,
    ...(skillIndex ? [skillIndex] : []),
  ];
  return {
    mode: "stack",
    entryPosix,
    blocks,
    settings,
    notes,
    unlinkedAgentsCopies,
    frontmatterSubjects: ctx.frontmatterSubjects,
  };
}

/**
 * Decide what a directory's AGENTS.md means for the resolved stack, given that
 * it was not already pulled in as an `@`-import. Never adds a block — a bare
 * AGENTS.md is not stack cost — but records a note, and an `unlinkedAgentsCopy`
 * when it is a separate byte-identical twin of the sibling CLAUDE.md.
 */
function classifyAgentsMd(
  dir: string,
  agentsAbs: string,
  agentsRel: string,
  repoRoot: string,
  ctx: ImportCtx,
  out: UnlinkedAgentsCopy[],
): void {
  // Same underlying file as something already loaded — the common
  // `CLAUDE.md -> AGENTS.md` symlink, or the reverse. Counted once already.
  const real = realOrSelf(agentsAbs);
  const loadedAs = ctx.seenReal.get(real);
  if (loadedAs) {
    ctx.notes.push(
      `${agentsRel} is the same file as ${loadedAs} (symlink); Claude Code loads it once, as ${loadedAs}`,
    );
    return;
  }

  const claudeAbs = join(dir, "CLAUDE.md");
  const claudeRel = relPosix(repoRoot, claudeAbs);

  if (!isFile(claudeAbs)) {
    ctx.notes.push(
      `${agentsRel} present but not loaded: Claude Code reads CLAUDE.md, and this directory has none, so no project instructions load here`,
    );
    return;
  }
  if (!ctx.seen.has(claudeRel)) {
    // CLAUDE.md exists but was excluded or otherwise not loaded; nothing to
    // compare the AGENTS.md against.
    ctx.notes.push(
      `${agentsRel} present but not loaded by Claude Code (it reads ${claudeRel})`,
    );
    return;
  }

  const agentsText = readFileSync(agentsAbs, "utf8");
  const claudeText = readFileSync(claudeAbs, "utf8");
  if (normalizeForCompare(agentsText) === normalizeForCompare(claudeText)) {
    ctx.notes.push(
      `${agentsRel} present but not loaded: Claude Code reads ${claudeRel}, not AGENTS.md, and the two are byte-identical here`,
    );
    out.push({
      claudeMd: claudeRel,
      agentsMd: agentsRel,
      lines: Math.max(1, countLines(claudeText)),
    });
  } else {
    ctx.notes.push(
      `${agentsRel} present but not loaded by Claude Code (it reads ${claudeRel}); the two files differ`,
    );
  }
}

// --- Non-Claude agents (best-effort) ------------------------------------------
//
// See MODEL.md, "Other agents (best-effort)". These rulesets are a static
// parser's reading of each vendor's documented file-loading behavior; the real
// tool may differ, and none of this is version-anchored the way the Claude Code
// model is. All of it feeds the same coster and findings as the Claude path.

/** Ancestor directories that hold a `<dirName>` directory, root-most first. */
function findDirsNamed(entryDir: string, repoRoot: string, dirName: string): string[] {
  const dirs: string[] = [];
  let dir = resolve(entryDir);
  const stop = resolve(repoRoot);
  for (;;) {
    const c = join(dir, dirName);
    if (isDir(c)) dirs.push(c);
    if (dir === stop) break;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return dirs.reverse();
}

/**
 * Map Cursor `.mdc` frontmatter onto conman's always-on vs path-scoped split:
 * `alwaysApply: true` -> always-on; a non-empty `globs` -> path-scoped, matched
 * against the entry path; neither -> Cursor pulls the rule in on agent request,
 * which a static resolver cannot predict, so conman loads it always-on and adds
 * a NOTE.
 */
function collectCursorRules(
  cursorDirs: string[],
  entryTargetPosix: string,
  ctx: ImportCtx,
): { always: Omit<Block, "id" | "tokens">[]; scoped: Omit<Block, "id" | "tokens">[] } {
  const always: Omit<Block, "id" | "tokens">[] = [];
  const scoped: Omit<Block, "id" | "tokens">[] = [];
  for (const cdir of cursorDirs) {
    const rdir = join(cdir, "rules");
    if (!isDir(rdir)) continue;
    const entries = readdirSync(rdir)
      .filter((f) => f.endsWith(".mdc"))
      .sort();
    for (const f of entries) {
      const abs = join(rdir, f);
      if (!isFile(abs)) continue;
      const text = readFileSync(abs, "utf8");
      const fm = parseFrontmatter(text);
      const rel = relPosix(ctx.repoRoot, abs);
      const lineCount = countLines(text);
      const globs = toStringArray(fm.data["globs"]);
      const alwaysApply = fm.data["alwaysApply"] === true;

      let kind: "rule-always" | "rule-scoped" = "rule-always";
      let matched = true;
      if (alwaysApply) {
        kind = "rule-always";
      } else if (globs.length > 0 && !globs.every((g) => g === "**")) {
        kind = "rule-scoped";
        matched = matchesAnyGlob(entryTargetPosix, globs);
      } else {
        ctx.notes.push(
          `${rel}: Cursor loads this rule on agent request (no \`globs\`, \`alwaysApply\` unset); conman treats it as always-on (best-effort)`,
        );
      }

      const block: Omit<Block, "id" | "tokens"> = {
        kind,
        source: rel,
        lineStart: 1,
        lineEnd: Math.max(1, lineCount),
        text,
        depth: 0,
      };
      if (kind === "rule-scoped") {
        if (matched) scoped.push(block);
        else
          ctx.notes.push(
            `${rel} is glob-scoped (${globs.join(", ")}); did not match entry ${entryTargetPosix}`,
          );
      } else {
        always.push(block);
      }
    }
  }
  return { always, scoped };
}

function resolveNonClaude(
  entryPathAbs: string,
  repoRoot: string,
  config: Config,
  tok: Tokenizer,
  notes: string[],
  agent: Agent,
): ResolveResult {
  const settings: Settings = {
    claudeMdExcludes: [],
    skillListingBudget: null,
    raw: {},
  };
  const ctx: ImportCtx = {
    repoRoot,
    tok,
    depthLimit: 0, // no `@`-import following for non-Claude agents
    notes,
    seen: new Set<string>(),
    seenReal: new Map<string, string>(),
    frontmatterSubjects: [],
  };

  const entryIsFile = isFile(entryPathAbs);
  const entryBase = entryIsFile ? basename(entryPathAbs) : "";
  const entryIsMemoryFile = entryIsFile && entryBase === "AGENTS.md";
  const entryDir = entryIsFile ? dirname(entryPathAbs) : entryPathAbs;
  const entryPosix = relPosix(repoRoot, entryPathAbs);

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
      `single-file mode (--agent ${agent}): ancestor walk and rules are not resolved`,
    );
    return {
      mode: "single-file",
      entryPosix,
      blocks,
      settings,
      notes,
      unlinkedAgentsCopies: [],
      frontmatterSubjects: ctx.frontmatterSubjects,
    };
  }

  const blocks: Omit<Block, "id" | "tokens">[] = [];

  // Copilot: the repo-wide `.github/copilot-instructions.md`, first.
  if (agent === "copilot") {
    const ci = join(repoRoot, ".github", "copilot-instructions.md");
    if (isFile(ci)) {
      blocks.push(
        ...resolveFileBlocks(ci, "memory", 0, undefined, new Set(), ctx),
      );
    } else {
      notes.push(
        ".github/copilot-instructions.md not found; Copilot stack carries AGENTS.md only",
      );
    }
  }

  // Codex, Cursor, and Copilot all read AGENTS.md. Ancestor walk, root-most
  // first, entry-closest last. No CLAUDE.md special-casing.
  const dirs = ancestorDirs(entryDir, repoRoot, config.resolve.repoBoundary);
  for (const dir of dirs) {
    const abs = join(dir, "AGENTS.md");
    if (!isFile(abs)) continue;
    const rel = relPosix(repoRoot, abs);
    if (ctx.seen.has(rel)) continue;
    blocks.push(
      ...resolveFileBlocks(abs, "memory", 0, undefined, new Set(), ctx),
    );
  }

  // Cursor: legacy `.cursorrules` (repo root, always-on) then `.cursor/rules/*.mdc`.
  if (agent === "cursor") {
    const legacy = join(repoRoot, ".cursorrules");
    if (isFile(legacy)) {
      blocks.push(
        ...resolveFileBlocks(legacy, "rule-always", 0, undefined, new Set(), ctx),
      );
    }
    const cursorDirs = findDirsNamed(entryDir, repoRoot, ".cursor");
    const entryTargetPosix = entryIsMemoryFile
      ? relPosix(repoRoot, entryDir)
      : entryPosix;
    const { always, scoped } = collectCursorRules(
      cursorDirs,
      entryTargetPosix || ".",
      ctx,
    );
    blocks.push(...always, ...scoped);
  }

  return {
    mode: "stack",
    entryPosix,
    blocks,
    settings,
    notes,
    unlinkedAgentsCopies: [],
    frontmatterSubjects: ctx.frontmatterSubjects,
  };
}
