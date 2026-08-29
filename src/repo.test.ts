import { test } from "node:test";
import assert from "node:assert/strict";
import { globToRegExp, matchesAnyGlob } from "./repo.js";

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
