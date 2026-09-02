// Small filesystem helpers: repo-root detection, path normalization, and a
// minimal glob matcher (enough for gitignore-style patterns in config and
// rule frontmatter `paths`). No external glob dependency, so behavior is fixed
// and testable. The matcher expands `{a,b}` brace lists the way Claude Code
// (via minimatch) does before matching each alternative literally.

import { existsSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";

export function findRepoRoot(startDir: string): string {
  let dir = resolve(startDir);
  for (;;) {
    if (existsSync(resolve(dir, ".git"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return resolve(startDir); // no .git: treat start as root
    dir = parent;
  }
}

export function relPosix(from: string, to: string): string {
  const r = relative(resolve(from), resolve(to));
  const posix = r.split(sep).join("/");
  return posix === "" ? "." : posix;
}

export function isDir(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

export function isFile(p: string): boolean {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
}

/**
 * Depth-first list of files under `dir` whose name ends with one of `ext`,
 * recursively. Directory listings are sorted at every level and the final list
 * is sorted again, so output is deterministic regardless of on-disk order. A
 * `readdirSync` that throws (missing dir, `dir` is a file, permission) ends that
 * subtree quietly and the walk continues with the siblings. Each hit is checked
 * with `isFile` so a directory named `foo.md` is not reported.
 *
 * With `relTo`, paths come back repo-relative POSIX (`relPosix(relTo, abs)`);
 * without it, they are `/`-joined relative to `dir`.
 */
export function walkFilesRecursive(
  dir: string,
  opts: { ext: string | readonly string[]; relTo?: string },
): string[] {
  const exts = typeof opts.ext === "string" ? [opts.ext] : opts.ext;
  const out: string[] = [];
  const walk = (d: string, prefix: string) => {
    let names: string[];
    try {
      names = readdirSync(d).sort();
    } catch {
      return;
    }
    for (const n of names) {
      const abs = join(d, n);
      const rel = prefix ? `${prefix}/${n}` : n;
      if (isDir(abs)) walk(abs, rel);
      else if (exts.some((e) => n.endsWith(e)) && isFile(abs)) {
        out.push(opts.relTo ? relPosix(opts.relTo, abs) : rel);
      }
    }
  };
  walk(dir, "");
  return out.sort();
}

/**
 * Expand `{a,b,c}` brace lists into the list of patterns Claude Code — via
 * minimatch — expands them to before matching. `src/{main,renderer}/**` becomes
 * `["src/main/**", "src/renderer/**"]`. Several groups in one pattern produce
 * the cartesian product; nested groups (`{a,{b,c}}`) expand recursively. A group
 * with no top-level comma (`{foo}`) is left literal, as minimatch does. Order is
 * preserved and duplicates are dropped. A pattern with no brace group comes back
 * unchanged as a one-element list.
 */
export function expandBraces(pattern: string): string[] {
  const group = firstBraceGroup(pattern);
  if (!group) return [pattern];
  const prefix = pattern.slice(0, group.start);
  const body = pattern.slice(group.start + 1, group.end);
  const suffix = pattern.slice(group.end + 1);
  const options = splitTopLevelCommas(body);
  if (options.length < 2) {
    // `{foo}` with no comma is a literal brace in minimatch. Keep it verbatim,
    // but keep expanding any groups that follow it.
    return dedupe(expandBraces(suffix).map((s) => `${prefix}{${body}}${s}`));
  }
  const out: string[] = [];
  for (const opt of options) {
    for (const expanded of expandBraces(prefix + opt + suffix)) out.push(expanded);
  }
  return dedupe(out);
}

/** The first balanced `{...}` group sitting at brace-nesting depth 0. */
function firstBraceGroup(s: string): { start: number; end: number } | null {
  let start = -1;
  let depth = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s[i]!;
    if (c === "\\") {
      i++;
      continue;
    }
    if (c === "{") {
      if (depth === 0) start = i;
      depth++;
    } else if (c === "}" && depth > 0) {
      depth--;
      if (depth === 0) return { start, end: i };
    }
  }
  return null;
}

/** Split on the commas of `body` that sit at brace-nesting depth 0. */
function splitTopLevelCommas(body: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let cur = "";
  for (let i = 0; i < body.length; i++) {
    const c = body[i]!;
    if (c === "\\") {
      cur += c + (body[i + 1] ?? "");
      i++;
      continue;
    }
    if (c === "{") depth++;
    else if (c === "}") depth--;
    if (c === "," && depth === 0) {
      parts.push(cur);
      cur = "";
    } else {
      cur += c;
    }
  }
  parts.push(cur);
  return parts;
}

function dedupe(xs: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const x of xs) {
    if (!seen.has(x)) {
      seen.add(x);
      out.push(x);
    }
  }
  return out;
}

/**
 * Translate a glob to a RegExp. Supports `**`, `*`, `?`, and character classes.
 * `**` matches any number of path segments; `*` matches within one segment.
 * Anchored at both ends. Matching is done against POSIX-style relative paths.
 */
export function globToRegExp(glob: string): RegExp {
  let re = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]!;
    if (c === "*") {
      if (glob[i + 1] === "*") {
        i++;
        if (glob[i + 1] === "/") {
          i++;
          // `**/` matches zero or more leading path segments
          re += "(?:[^/]*/)*";
        } else {
          // `**` (trailing or bare) matches anything, slashes included
          re += ".*";
        }
      } else {
        re += "[^/]*";
      }
    } else if (c === "?") {
      re += "[^/]";
    } else if (c === "/") {
      re += "/";
    } else if ("+.^${}()|[]\\".includes(c)) {
      re += "\\" + c;
    } else {
      re += c;
    }
  }
  return new RegExp("^" + re + "$");
}

/**
 * The directory segments of a repo-relative POSIX path. A path with no slash
 * (or a directory of "." / "") yields `[]`. `src/a/CLAUDE.md` -> `["src", "a"]`.
 */
export function dirSegs(pathPosix: string): string[] {
  const dir = pathPosix.includes("/")
    ? pathPosix.slice(0, pathPosix.lastIndexOf("/"))
    : ".";
  return dir === "." || dir === "" ? [] : dir.split("/");
}

/** True when `a`'s directory is a strict ancestor of `b`'s directory. */
export function isAncestorPath(a: string, b: string): boolean {
  if (a === b) return false;
  const as = dirSegs(a);
  const bs = dirSegs(b);
  if (as.length >= bs.length) return false;
  return as.every((s, i) => s === bs[i]);
}

export function matchesAnyGlob(pathPosix: string, globs: string[]): boolean {
  return globs.some((g) =>
    expandBraces(g).some((expanded) => {
      const norm = expanded.replace(/^\.\//, "");
      return globToRegExp(norm).test(pathPosix) || globToRegExp(norm).test("/" + pathPosix);
    }),
  );
}
