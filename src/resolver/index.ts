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
//
// This module orchestrates the stages; each stage lives in a sibling file
// (`settings`, `imports`, `rules`, `skills`, `agentsMd`).

import { readFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import type { Block } from "../types.js";
import { AGENT_RULE_SPEC, type Agent } from "../agent.js";
import type { Config } from "../config.js";
import type { Tokenizer } from "../tokenizer.js";
import { isDir, isFile, matchesAnyGlob, relPosix } from "../repo.js";
import { LOCAL_MEMORY_NAMES, MEMORY_NAMES } from "../claudeContext.js";
import {
  countLines,
  findImports,
  resolveFileBlocks,
  type FrontmatterSubject,
  type ImportCtx,
} from "./imports.js";
import {
  loadSettings,
  USER_MEMORY_LABEL,
  type Settings,
} from "./settings.js";
import {
  collectCopilotInstructions,
  collectCursorRules,
  collectRuleBlocks,
  findClaudeDirs,
} from "./rules.js";
import { buildSkillIndex } from "./skills.js";
import { classifyAgentsMd, type UnlinkedAgentsCopy } from "./agentsMd.js";

// Re-export the stages' public surface so `./resolver.js` importers see one API.
export {
  loadSettings,
  USER_MEMORY_LABEL,
  USER_SKILLS_LABEL,
  USER_RULES_LABEL,
} from "./settings.js";
export type { Settings } from "./settings.js";
export type { UnlinkedAgentsCopy } from "./agentsMd.js";
export type { FrontmatterSubject } from "./imports.js";

export interface ResolveResult {
  mode: "stack" | "single-file";
  entryPosix: string;
  blocks: Omit<Block, "id" | "tokens">[];
  settings: Settings;
  notes: string[];
  unlinkedAgentsCopies: UnlinkedAgentsCopy[];
  frontmatterSubjects: FrontmatterSubject[];
  /**
   * True when `--user` pulled machine-local config (`~/.claude/CLAUDE.md` and/or
   * `~/.claude/settings.json`) into this result. The output is then specific to
   * the machine it ran on and will not reproduce elsewhere.
   */
  machineSpecific: boolean;
  /** Skills listed in the resolved startup index (post budget-truncation). */
  skillCount: number;
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

export function resolveStack(
  entryPathAbs: string,
  repoRoot: string,
  config: Config,
  tok: Tokenizer,
  notes: string[] = [],
  agent: Agent = "claude",
  userConfigDir?: string,
): ResolveResult {
  if (agent !== "claude") {
    // User-level config is Claude Code's own memory model; other agents have
    // their own home-directory files, which conman does not read.
    if (userConfigDir) {
      notes.push(
        `--user has no effect with --agent ${agent}: user-level config is modelled for Claude Code only`,
      );
    }
    return resolveNonClaude(entryPathAbs, repoRoot, config, tok, notes, agent);
  }
  const settings = loadSettings(repoRoot, userConfigDir);
  // `--user` folds in `~/.claude`, and a loaded `CLAUDE.local.md` (set below in
  // the ancestor walk) also makes the report machine-specific: both pull in
  // config that a desk-run session sees but CI does not.
  let machineSpecific = userConfigDir !== undefined;
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
      machineSpecific,
      skillCount: 0,
    };
  }

  const excludes = settings.claudeMdExcludes;

  // User-level memory (`~/.claude/CLAUDE.md`), opt-in via `--user`. It is the
  // most global instruction file — it applies to every repo on the machine — so
  // it loads first, ahead of the repo's own root memory. Loaded as one block:
  // conman does not follow `@`-imports out of the user file (that would drag in
  // more machine-local paths), and emits a stable `~/.claude/CLAUDE.md` label
  // rather than a machine-specific path so the load-order table stays portable.
  const userBlocks: Omit<Block, "id" | "tokens">[] = [];
  if (userConfigDir !== undefined) {
    notes.push(
      "machine-specific: --user pulled in this machine's ~/.claude config; this report will not reproduce on another machine",
    );
    const userMd = join(userConfigDir, "CLAUDE.md");
    if (isFile(userMd)) {
      const text = readFileSync(userMd, "utf8");
      const lc = countLines(text);
      userBlocks.push({
        kind: "memory",
        source: USER_MEMORY_LABEL,
        lineStart: 1,
        lineEnd: Math.max(1, lc),
        text,
        depth: 0,
      });
      ctx.seen.add(USER_MEMORY_LABEL);
      const imps = findImports(text, userMd);
      if (imps.length > 0) {
        notes.push(
          `${USER_MEMORY_LABEL}: ${imps.length} @-import(s) not followed (user memory loads as a single block)`,
        );
      }
    } else {
      notes.push(
        "--user: no ~/.claude/CLAUDE.md found; only ~/.claude/settings.json (if present) was merged",
      );
    }
  }

  const dirs = ancestorDirs(entryDir, repoRoot, config.resolve.repoBoundary);
  const memoryBlocks: Omit<Block, "id" | "tokens">[] = [];
  let localMemoryNoted = false;
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

      // `CLAUDE.local.md` is Claude Code's gitignored personal memory. It loads
      // right after this directory's `CLAUDE.md` and is treated the same way
      // (imports followed). It lives inside the checkout, so a desk-run session
      // assembles it while CI never does: flag the whole report machine-specific
      // and record a NOTE, the same convention `--user` uses for `~/.claude`.
      if (LOCAL_MEMORY_NAMES.includes(name) && !localMemoryNoted) {
        machineSpecific = true;
        localMemoryNoted = true;
        notes.push(
          `machine-specific: ${rel} is Claude Code's gitignored personal memory; it loads in a desk-run session but not in CI, so this report will not reproduce elsewhere`,
        );
      }

      memoryBlocks.push(
        ...resolveFileBlocks(abs, "memory", 0, undefined, new Set(), ctx),
      );
    }
  }

  // `--user` folds `~/.claude` in as the root-most `.claude` dir, so its
  // `skills/` and `rules/` feed the same startup index and rule collection as
  // the repo's own — Claude Code loads user-level skills and rules too. It sits
  // first (root-most) to match how `~/.claude/CLAUDE.md` loads ahead of the
  // repo's root memory. The stage collectors emit a stable `~/.claude/...`
  // label for anything found under it, so the report stays machine-independent.
  const claudeDirs = [
    ...(userConfigDir !== undefined ? [userConfigDir] : []),
    ...findClaudeDirs(entryDir, repoRoot),
  ];
  const entryTargetPosix = entryIsMemoryFile
    ? relPosix(repoRoot, entryDir)
    : entryPosix;
  const { always, scoped } = collectRuleBlocks(
    claudeDirs,
    entryTargetPosix || ".",
    excludes,
    ctx,
    userConfigDir,
  );

  const skillBudget =
    config.resolve.skillListingBudget ?? settings.skillListingBudget ?? null;
  const skillIndex = buildSkillIndex(claudeDirs, skillBudget, ctx, userConfigDir);

  const blocks = [
    ...userBlocks,
    ...memoryBlocks,
    ...always,
    ...scoped,
    ...(skillIndex ? [skillIndex.block] : []),
  ];
  return {
    mode: "stack",
    entryPosix,
    blocks,
    settings,
    notes,
    unlinkedAgentsCopies,
    frontmatterSubjects: ctx.frontmatterSubjects,
    machineSpecific,
    skillCount: skillIndex?.skillCount ?? 0,
  };
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
      machineSpecific: false,
      skillCount: 0,
    };
  }

  const blocks: Omit<Block, "id" | "tokens">[] = [];
  // Same per-agent table `conman map` reads, so discovery and resolution cannot
  // disagree on directory names or the rule extension.
  const spec = AGENT_RULE_SPEC[agent];

  // Copilot: the repo-wide `.github/copilot-instructions.md`, first.
  if (agent === "copilot") {
    const ci = join(repoRoot, ".github", "copilot-instructions.md");
    if (isFile(ci)) {
      blocks.push(
        ...resolveFileBlocks(ci, "memory", 0, undefined, new Set(), ctx),
      );
    } else {
      notes.push(
        ".github/copilot-instructions.md not found; Copilot stack carries AGENTS.md and any .github/instructions/*.instructions.md",
      );
    }
  }

  // Codex, Cursor, and Copilot all read AGENTS.md. Ancestor walk, root-most
  // first, entry-closest last. No CLAUDE.md special-casing.
  const dirs = ancestorDirs(entryDir, repoRoot, config.resolve.repoBoundary);
  for (const dir of dirs) {
    for (const name of spec.memoryNames) {
      const abs = join(dir, name);
      if (!isFile(abs)) continue;
      const rel = relPosix(repoRoot, abs);
      if (ctx.seen.has(rel)) continue;
      blocks.push(
        ...resolveFileBlocks(abs, "memory", 0, undefined, new Set(), ctx),
      );
    }
  }

  // Copilot: `.github/instructions/*.instructions.md`, after the repo-wide
  // instructions and the AGENTS.md walk. Always-on (`applyTo: **` or absent)
  // before matched path-scoped, mirroring the Claude/Cursor rule order.
  if (agent === "copilot" && spec.rules) {
    const entryTargetPosix = entryIsMemoryFile
      ? relPosix(repoRoot, entryDir)
      : entryPosix;
    const { always, scoped } = collectCopilotInstructions(
      join(repoRoot, spec.rules.dotDir, spec.rules.ruleDir),
      entryTargetPosix || ".",
      ctx,
    );
    blocks.push(...always, ...scoped);
  }

  // Cursor: legacy `.cursorrules` (repo root, always-on) then `.cursor/rules/*.mdc`.
  if (agent === "cursor" && spec.rules) {
    const legacy = join(repoRoot, ".cursorrules");
    if (isFile(legacy)) {
      blocks.push(
        ...resolveFileBlocks(legacy, "rule-always", 0, undefined, new Set(), ctx),
      );
    }
    const cursorDirs = findDirsNamed(entryDir, repoRoot, spec.rules.dotDir);
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
    machineSpecific: false,
    skillCount: 0,
  };
}
