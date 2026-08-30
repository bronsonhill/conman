// Small filesystem helpers: repo-root detection, path normalization, and a
// minimal glob matcher (enough for gitignore-style patterns in config and
// rule frontmatter `paths`). No external glob dependency, so behavior is fixed
// and testable.

import { existsSync, statSync } from "node:fs";
import { dirname, relative, resolve, sep } from "node:path";

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

export function matchesAnyGlob(pathPosix: string, globs: string[]): boolean {
  return globs.some((g) => {
    const norm = g.replace(/^\.\//, "");
    return globToRegExp(norm).test(pathPosix) || globToRegExp(norm).test("/" + pathPosix);
  });
}
