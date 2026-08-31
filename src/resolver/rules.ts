// `.claude/rules/*.md` (Claude Code) and `.cursor/rules/*.mdc` (Cursor,
// best-effort): reading each rule's frontmatter, splitting always-on from
// path-scoped, and matching the scope glob against the entry path.

import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import type { Block } from "../types.js";
import { isDir, isFile, matchesAnyGlob, relPosix } from "../repo.js";
import { parseFrontmatter } from "../frontmatter.js";
import { RULE_SCOPE_KEY, toStringArray } from "../claudeContext.js";
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
