// Dead-reference finding: a pointer in a context file that does not resolve on
// disk. Three sub-cases, checked only on depth-0 blocks (ancestor memory files
// and `.claude/rules` entries) to stay conservative and to avoid guessing about
// nested `@`-import trees the resolver deliberately stopped following:
//
//   - dead-import  — an `@`-import whose target file is missing. Claude Code
//                    drops it from the resolved stack with no error, so content
//                    the author expected silently never loads. Severity: error.
//                    An unresolved ref shaped like an npm scoped package name
//                    in prose (`@superset-ui/core`, `@xyflow/react`) is NOT
//                    flagged: Claude Code parses it as an import and silently
//                    drops it too, but the author never meant it to load, so
//                    nothing is lost. See looksLikeNpmPackage below.
//   - dead-path    — a repo-relative path named in prose (inside backticks) that
//                    does not exist. Only flagged when the path's parent
//                    directory exists and already holds a real file, so a
//                    reference into a not-yet-created tree is not guessed at.
//                    Severity: warn.
//   - dead-script  — `npm|pnpm|yarn run <name>` with no matching entry in the
//                    repo-root `package.json`. Skipped when there is no
//                    `package.json` or it has no `scripts`. Severity: warn.
//
// `config.gate["dead-reference"]` is a ceiling: "warn" caps the import case at
// warn, "off" disables the check.

import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import type { Block, Finding, Severity } from "../types.js";
import type { Config } from "../config.js";
import { isDir, isFile } from "../repo.js";
import { fencedLineSet as fencedLines, maskInlineCode } from "./_fence.js";

const IMPORT_RE = /(?:^|\s)@([^\s`]+)/g;

/** One npm scope or name segment: lowercase, digits, `-` `_` `~`, no dots. */
const NPM_SEGMENT = /^[a-z0-9~][a-z0-9_~-]*$/;

/**
 * True when an unresolved `@`-ref reads as an npm scoped package name in prose
 * (`@superset-ui/core`, `@xyflow/react`, optionally with a subpath like
 * `@superset-ui/core/components`) rather than a file the author expected to
 * load. Claude Code's import parser (v2.1.251) makes no such distinction — it
 * treats the token as an import and silently skips the missing target — so the
 * resolved stack is identical either way; the only question is author intent,
 * and a scoped package name endemic to JS-repo prose is not a dead import.
 * Conservative on purpose: any dot anywhere in the ref (an extension or dotted
 * name), an uppercase letter, a relative/absolute path prefix, or a real
 * directory matching the scope segment keeps the ref flagged as a genuine
 * missing import.
 */
function looksLikeNpmPackage(ref: string, fileDir: string): boolean {
  // A sentence-ending "@xyflow/react." captures the punctuation, and a bold
  // "**Use @superset-ui/core**" captures the closing emphasis markers (Claude
  // Code scans marked inline tokens, so it sees neither); shed both before the
  // shape check (a real file extension still has a dot mid-token).
  const bare = ref.replace(/[.,;:!?)\]*_]+$/, "");
  if (bare.startsWith("./") || bare.startsWith("../") || bare.startsWith("/")) return false;
  if (bare.includes(".")) return false;
  const segs = bare.split("/");
  if (segs.length < 2 || segs.some((s) => s === "")) return false;
  if (!NPM_SEGMENT.test(segs[0]!) || !NPM_SEGMENT.test(segs[1]!)) return false;
  if (isDir(resolve(fileDir, segs[0]!))) return false;
  return true;
}
const SCRIPT_RE = /\b(npm|pnpm|yarn)\s+run\s+([A-Za-z0-9:_.\-]+)/g;
const INLINE_CODE_RE = /`([^`]+)`/g;
/** A clean repo-relative path: segments of word/dot/dash, at least one `/`, an
 *  extension on the last segment, no globs, no `..`, not absolute. */
const PATH_LIKE = /^[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)+\.[A-Za-z0-9]{1,8}$/;

function loadScripts(repoRoot: string): Set<string> | null {
  const p = join(repoRoot, "package.json");
  if (!isFile(p)) return null;
  try {
    const pkg = JSON.parse(readFileSync(p, "utf8"));
    if (!pkg || typeof pkg !== "object" || typeof pkg.scripts !== "object" || pkg.scripts === null)
      return null;
    return new Set(Object.keys(pkg.scripts));
  } catch {
    return null;
  }
}

/** True when `dir` exists and holds at least one non-dotfile regular file. */
function dirHasRealFile(dir: string): boolean {
  try {
    return readdirSync(dir, { withFileTypes: true }).some(
      (e) => e.isFile() && !e.name.startsWith("."),
    );
  } catch {
    return false;
  }
}

export function findDeadReferences(
  blocks: Block[],
  config: Config,
  repoRoot: string,
): Finding[] {
  const ceiling = config.gate["dead-reference"];
  if (ceiling === "off" || !repoRoot) return [];
  const cap = (s: Severity): Severity => (ceiling === "warn" && s === "error" ? "warn" : s);

  const scripts = loadScripts(repoRoot);
  const findings: Finding[] = [];
  const emitted = new Set<string>();
  const push = (
    severity: Severity,
    file: string,
    ln: number,
    message: string,
    subcase: string,
    ref: string,
  ) => {
    const key = `${file} ${subcase} ${ref}`;
    if (emitted.has(key)) return;
    emitted.add(key);
    findings.push({
      type: "dead-reference",
      severity: cap(severity),
      message,
      locations: [{ file, lineStart: ln, lineEnd: ln }],
      detail: { subcase, ref },
    });
  };

  for (const b of blocks) {
    if (b.depth !== 0) continue;
    if (b.kind !== "memory" && b.kind !== "rule-always" && b.kind !== "rule-scoped") continue;
    const fileDir = dirname(join(repoRoot, b.source));
    const lines = b.text.split("\n");
    const fenced = fencedLines(lines);
    // Inline-code spans blanked, including spans that wrap across lines.
    const masked = maskInlineCode(lines, fenced);

    lines.forEach((raw, i) => {
      if (fenced.has(i)) return;
      const ln = b.lineStart + i;

      // dead-import
      const noCode = masked[i]!;
      IMPORT_RE.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = IMPORT_RE.exec(noCode)) !== null) {
        const ref = m[1]!;
        if (ref.startsWith("~")) continue;
        // Only treat path-shaped tokens as imports; a bare `@handle` is prose.
        if (!ref.includes("/") && !ref.includes(".")) continue;
        if (looksLikeNpmPackage(ref, fileDir)) continue;
        if (!isFile(resolve(fileDir, ref))) {
          push(
            "error",
            b.source,
            ln,
            `\`@${ref}\` in ${b.source} does not resolve on disk; Claude Code silently drops the import from the resolved stack`,
            "dead-import",
            ref,
          );
        }
      }

      // dead-script
      SCRIPT_RE.lastIndex = 0;
      while ((m = SCRIPT_RE.exec(raw)) !== null) {
        const pm = m[1]!;
        const name = m[2]!;
        if (scripts && !scripts.has(name)) {
          push(
            "warn",
            b.source,
            ln,
            `\`${pm} run ${name}\` names a script with no matching entry in package.json`,
            "dead-script",
            name,
          );
        }
      }

      // dead-path (inside backticks only)
      INLINE_CODE_RE.lastIndex = 0;
      while ((m = INLINE_CODE_RE.exec(raw)) !== null) {
        let p = m[1]!.trim().replace(/^\.\//, "");
        if (!PATH_LIKE.test(p)) continue;
        if (p.includes("..") || p.startsWith("node_modules/") || p.includes("/node_modules/"))
          continue;
        const abs = join(repoRoot, p);
        if (isFile(abs) || isDir(abs)) continue;
        if (!dirHasRealFile(dirname(abs))) continue;
        push(
          "warn",
          b.source,
          ln,
          `referenced path \`${p}\` does not exist in the repo`,
          "dead-path",
          p,
        );
      }
    });
  }

  findings.sort(
    (a, b) =>
      (a.locations[0]!.file < b.locations[0]!.file ? -1 : a.locations[0]!.file > b.locations[0]!.file ? 1 : 0) ||
      a.locations[0]!.lineStart - b.locations[0]!.lineStart ||
      (String(a.detail!["subcase"]) < String(b.detail!["subcase"]) ? -1 : 1) ||
      (String(a.detail!["ref"]) < String(b.detail!["ref"]) ? -1 : 1),
  );
  return findings;
}
