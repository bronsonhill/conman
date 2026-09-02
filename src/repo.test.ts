import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  expandBraces,
  globToRegExp,
  matchesAnyGlob,
  walkFilesRecursive,
} from "./repo.js";

test("globToRegExp: * stays within a segment", () => {
  assert.match("src/a.ts", globToRegExp("src/*.ts"));
  assert.doesNotMatch("src/nested/a.ts", globToRegExp("src/*.ts"));
});

test("globToRegExp: trailing ** matches everything below", () => {
  assert.match("services/api", globToRegExp("services/**"));
  assert.match("services/api/src/index.ts", globToRegExp("services/**"));
  assert.doesNotMatch("web/api", globToRegExp("services/**"));
});

test("globToRegExp: **/ matches zero or more leading segments", () => {
  assert.match("CLAUDE.md", globToRegExp("**/CLAUDE.md"));
  assert.match("a/b/CLAUDE.md", globToRegExp("**/CLAUDE.md"));
});

test("matchesAnyGlob: exact path and ./ prefix both work", () => {
  assert.equal(matchesAnyGlob("services/CLAUDE.md", ["services/CLAUDE.md"]), true);
  assert.equal(matchesAnyGlob("services/CLAUDE.md", ["./services/CLAUDE.md"]), true);
  assert.equal(matchesAnyGlob("services/api/CLAUDE.md", ["legacy/**"]), false);
});

test("expandBraces: single group, multiple groups, nesting, and no-op", () => {
  assert.deepEqual(expandBraces("src/{main,renderer}/**"), [
    "src/main/**",
    "src/renderer/**",
  ]);
  // cartesian product of two groups
  assert.deepEqual(expandBraces("{a,b}/{x,y}.ts"), [
    "a/x.ts",
    "a/y.ts",
    "b/x.ts",
    "b/y.ts",
  ]);
  // nested groups expand recursively
  assert.deepEqual(expandBraces("src/{a,{b,c}}/**"), [
    "src/a/**",
    "src/b/**",
    "src/c/**",
  ]);
  // a group with no comma is left literal
  assert.deepEqual(expandBraces("src/{only}/**"), ["src/{only}/**"]);
  // no braces: returned unchanged as a one-element list
  assert.deepEqual(expandBraces("src/**/*.ts"), ["src/**/*.ts"]);
  // duplicates collapse
  assert.deepEqual(expandBraces("src/{a,a}/**"), ["src/a/**"]);
});

test("matchesAnyGlob: brace lists match the way Claude Code expands them", () => {
  assert.equal(matchesAnyGlob("src/main/app.ts", ["src/**/*.{ts,tsx}"]), true);
  assert.equal(matchesAnyGlob("src/main/app.tsx", ["src/**/*.{ts,tsx}"]), true);
  assert.equal(matchesAnyGlob("src/main/app.js", ["src/**/*.{ts,tsx}"]), false);
  assert.equal(matchesAnyGlob("src/renderer", ["src/{main,renderer}"]), true);
  assert.equal(matchesAnyGlob("app/api", ["src/{main,renderer}"]), false);
});

test("walkFilesRecursive: recurses, filters by suffix, sorts, and honours relTo", () => {
  const root = mkdtempSync(join(tmpdir(), "conman-walk-"));
  try {
    mkdirSync(join(root, "rules/nested/deep"), { recursive: true });
    writeFileSync(join(root, "rules/b.md"), "b");
    writeFileSync(join(root, "rules/a.md"), "a");
    writeFileSync(join(root, "rules/skip.txt"), "x");
    writeFileSync(join(root, "rules/nested/c.md"), "c");
    writeFileSync(join(root, "rules/nested/deep/d.md"), "d");

    assert.deepEqual(walkFilesRecursive(join(root, "rules"), { ext: ".md" }), [
      "a.md",
      "b.md",
      "nested/c.md",
      "nested/deep/d.md",
    ]);
    // A directory named like a match is not reported (isFile guard).
    mkdirSync(join(root, "rules/weird.md"));
    assert.ok(
      !walkFilesRecursive(join(root, "rules"), { ext: ".md" }).includes("weird.md"),
    );
    // relTo returns repo-relative POSIX paths.
    assert.deepEqual(
      walkFilesRecursive(join(root, "rules/nested"), { ext: ".md", relTo: root }),
      ["rules/nested/c.md", "rules/nested/deep/d.md"],
    );
    // A missing directory is swallowed, not thrown.
    assert.deepEqual(walkFilesRecursive(join(root, "nope"), { ext: ".md" }), []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
