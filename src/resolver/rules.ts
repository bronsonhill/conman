// `.claude/rules/*.md` (Claude Code) and `.cursor/rules/*.mdc` (Cursor,
// best-effort): reading each rule's frontmatter, splitting always-on from
// path-scoped, and matching the scope glob against the entry path.

import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import type { Block } from "../types.js";
import { isDir, isFile, matchesAnyGlob, relPosix } from "../repo.js";
import { parseFrontmatter } from "../frontmatter.js";
import { RULE_SCOPE_KEY, toStringArray } from "../claudeContext.js";
import { USER_RULES_LABEL } from "./settings.js";
import { countLines, type ImportCtx } from "./imports.js";

export function findClaudeDirs(entryDir: string, repoRoot: string): string[] {
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

export function collectRuleBlocks(
  claudeDirs: string[],
  entryTargetPosix: string,
  excludes: string[],
  ctx: ImportCtx,
  userConfigDir?: string,
): { always: Omit<Block, "id" | "tokens">[]; scoped: Omit<Block, "id" | "tokens">[] } {
  const always: Omit<Block, "id" | "tokens">[] = [];
  const scoped: Omit<Block, "id" | "tokens">[] = [];
  for (const cdir of claudeDirs) {
    const isUserDir = userConfigDir !== undefined && cdir === userConfigDir;
    const rdir = join(cdir, "rules");
    if (!isDir(rdir)) continue;
    const entries = readdirSync(rdir)
      .filter((f) => f.endsWith(".md"))
      .sort();
    for (const f of entries) {
      const abs = join(rdir, f);
      if (!isFile(abs)) continue;
      // User-level rules (`~/.claude/rules/`, only with `--user`) are labelled
      // with the stable `~/.claude/rules/<file>` path so the report stays
      // machine-independent; `claudeMdExcludes` globs are repo-relative and so
      // never match them, which is correct — they are not in the repo.
      const rel = isUserDir
        ? `${USER_RULES_LABEL}/${f}`
        : relPosix(ctx.repoRoot, abs);
      // `claudeMdExcludes` covers rules files too: the settings docs' own
      // example excludes a `.claude/rules/**` glob, and Claude Code's
      // changelog (v2.1.2xx) fixes exclusion of symlinked rules entries.
      if (excludes.length > 0 && matchesAnyGlob(rel, excludes)) {
        ctx.notes.push(`excluded by settings claudeMdExcludes: ${rel}`);
        continue;
      }
      const text = readFileSync(abs, "utf8");
      const fm = parseFrontmatter(text);
      const lineCount = countLines(text);
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

/**
 * Map Cursor `.mdc` frontmatter onto conman's always-on vs path-scoped split:
 * `alwaysApply: true` -> always-on; a non-empty `globs` -> path-scoped, matched
 * against the entry path; neither -> Cursor pulls the rule in on agent request,
 * which a static resolver cannot predict, so conman loads it always-on and adds
 * a NOTE.
 */
export function collectCursorRules(
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

/** `*.instructions.md` under `dir`, recursively, as repo-relative POSIX paths, sorted. */
function findInstructionFiles(dir: string, repoRoot: string): string[] {
  if (!isDir(dir)) return [];
  const out: string[] = [];
  const walk = (d: string) => {
    let names: string[];
    try {
      names = readdirSync(d).sort();
    } catch {
      return;
    }
    for (const n of names) {
      const abs = join(d, n);
      if (isDir(abs)) walk(abs);
      else if (n.endsWith(".instructions.md") && isFile(abs)) {
        out.push(relPosix(repoRoot, abs));
      }
    }
  };
  walk(dir);
  return out.sort();
}

/**
 * GitHub Copilot's `.github/instructions/*.instructions.md` path-scoped files.
 * The `applyTo` frontmatter is one or more comma-separated file globs; conman
 * maps it onto the same always-on vs path-scoped split it uses for Claude
 * `paths` and Cursor `globs`:
 *
 * - `applyTo: "**"` (or missing) -> always-on (`rule-always`).
 * - any other `applyTo` -> path-scoped (`rule-scoped`), loaded only when one
 *   glob matches the entry path, matched through the shared `matchesAnyGlob`
 *   (brace lists expanded), exactly as `paths` is matched for Claude.
 *
 * Best-effort: see MODEL.md, "Other agents". Not linted by the `frontmatter`
 * finding, which is Claude-specific.
 */
export function collectCopilotInstructions(
  instrDir: string,
  entryTargetPosix: string,
  ctx: ImportCtx,
): { always: Omit<Block, "id" | "tokens">[]; scoped: Omit<Block, "id" | "tokens">[] } {
  const always: Omit<Block, "id" | "tokens">[] = [];
  const scoped: Omit<Block, "id" | "tokens">[] = [];
  for (const rel of findInstructionFiles(instrDir, ctx.repoRoot)) {
    const abs = join(ctx.repoRoot, rel);
    const text = readFileSync(abs, "utf8");
    const fm = parseFrontmatter(text);
    const lineCount = countLines(text);
    // Not pushed to ctx.frontmatterSubjects: the `frontmatter` finding is
    // Claude-specific (it reads `paths` / `globs`), like the Cursor `.mdc` path.

    // `applyTo` is a string like `**/*.ts,**/*.tsx`; split the comma list.
    const applyTo = toStringArray(fm.data["applyTo"])
      .flatMap((s) => s.split(","))
      .map((s) => s.trim())
      .filter(Boolean);
    const scopedByPath = applyTo.length > 0 && !applyTo.every((p) => p === "**");

    const block: Omit<Block, "id" | "tokens"> = {
      kind: scopedByPath ? "rule-scoped" : "rule-always",
      source: rel,
      lineStart: 1,
      lineEnd: Math.max(1, lineCount),
      text,
      depth: 0,
    };
    if (applyTo.length === 0) {
      ctx.notes.push(
        `${rel} has no \`applyTo\`; Copilot applies it to every file, so conman loads it always-on (best-effort)`,
      );
    }
    // conman resolves an entry *directory*, but `applyTo` is a file glob. A
    // `dir/**` pattern is also matched against the bare directory so a
    // directory entry picks up the instructions Copilot would apply to every
    // file under it. Patterns that name a file shape (`**/*.ts`) still cannot
    // match a directory — a static resolver has no file to test.
    const matchGlobs = [
      ...applyTo,
      ...applyTo.map((p) => p.replace(/\/\*\*\/?\*?$/, "")).filter(Boolean),
    ];
    if (block.kind === "rule-scoped") {
      if (matchesAnyGlob(entryTargetPosix, matchGlobs)) scoped.push(block);
      else
        ctx.notes.push(
          `${rel} is applyTo-scoped (${applyTo.join(", ")}); did not match entry ${entryTargetPosix}`,
        );
    } else {
      always.push(block);
    }
  }
  return { always, scoped };
}
