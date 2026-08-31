import { test } from "node:test";
import assert from "node:assert/strict";
import { parseFrontmatter } from "./frontmatter.js";

test("no fence: body is the whole document, present/opened false", () => {
  const fm = parseFrontmatter("# Title\n\nbody\n");
  assert.equal(fm.present, false);
  assert.equal(fm.opened, false);
  assert.equal(fm.unterminated, false);
  assert.deepEqual(fm.data, {});
  assert.equal(fm.body, "# Title\n\nbody\n");
  assert.equal(fm.bodyStartLine, 1);
});

test("leading blank line before `---` is not frontmatter", () => {
  const fm = parseFrontmatter("\n---\nname: x\n---\n");
  assert.equal(fm.present, false);
  assert.equal(fm.opened, false);
});

test("opening fence, no closing fence: unterminated", () => {
  const fm = parseFrontmatter("---\nname: x\nstill going\n");
  assert.equal(fm.opened, true);
  assert.equal(fm.unterminated, true);
  assert.equal(fm.present, false);
  assert.deepEqual(fm.data, {});
});

test("well-formed frontmatter: data, line numbers, body split", () => {
  const fm = parseFrontmatter("---\nname: demo\ncount: 3\n---\nline five\nline six\n");
  assert.equal(fm.present, true);
  assert.equal(fm.startLine, 1);
  assert.equal(fm.endLine, 4);
  assert.equal(fm.bodyStartLine, 5);
  assert.deepEqual(fm.data, { name: "demo", count: 3 });
  assert.equal(fm.body, "line five\nline six\n");
  assert.equal(fm.rawYaml, "name: demo\ncount: 3");
});

test("empty frontmatter block parses to {} and is still present", () => {
  const fm = parseFrontmatter("---\n---\nbody\n");
  assert.equal(fm.present, true);
  assert.equal(fm.endLine, 2);
  assert.deepEqual(fm.data, {});
});

test("scalar frontmatter (not a mapping) yields {} but stays present", () => {
  const fm = parseFrontmatter("---\njust a string\n---\n");
  assert.equal(fm.present, true);
  assert.deepEqual(fm.data, {});
  assert.equal(fm.parseError, undefined);
});

test("list frontmatter (not a mapping) yields {}", () => {
  const fm = parseFrontmatter("---\n- one\n- two\n---\n");
  assert.equal(fm.present, true);
  assert.deepEqual(fm.data, {});
});

test("invalid YAML sets parseError to a location-stripped first line", () => {
  const fm = parseFrontmatter("---\nname: : :\n bad\n---\n");
  assert.equal(fm.present, true);
  assert.deepEqual(fm.data, {});
  assert.ok(fm.parseError && fm.parseError.length > 0);
  assert.doesNotMatch(fm.parseError!, /at line \d+, column \d+/);
});

test("first of two closing fences wins", () => {
  const fm = parseFrontmatter("---\nname: x\n---\nbody\n---\nmore\n");
  assert.equal(fm.endLine, 3);
  assert.deepEqual(fm.data, { name: "x" });
  assert.equal(fm.body, "body\n---\nmore\n");
});

test("CRLF line endings: `---\\r` is not treated as a fence", () => {
  const fm = parseFrontmatter("---\r\nname: x\r\n---\r\n");
  assert.equal(fm.present, false, "the exact-match fence check is LF-only");
});
