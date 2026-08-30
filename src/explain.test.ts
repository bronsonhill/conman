import { test } from "node:test";
import assert from "node:assert/strict";
import {
  FINDING_IDS,
  FINDING_INFO,
  renderExplain,
  renderExplainList,
} from "./explain.js";

test("every finding type has a complete entry", () => {
  for (const id of FINDING_IDS) {
    const info = FINDING_INFO[id];
    assert.ok(info.title.length > 0, `${id}: title`);
    assert.ok(info.explanation.length > 40, `${id}: explanation`);
    assert.ok(info.citations.length >= 1, `${id}: at least one citation`);
    assert.ok(
      info.citations.every((c) => c.includes("http")),
      `${id}: citations carry a URL`,
    );
    assert.ok(info.remediation.length > 20, `${id}: remediation`);
  }
});

test("FINDING_IDS is sorted", () => {
  assert.deepEqual(FINDING_IDS, [...FINDING_IDS].sort());
});

test("renderExplainList names every id", () => {
  const out = renderExplainList("9.9.9");
  for (const id of FINDING_IDS) assert.match(out, new RegExp(`\\b${id}\\b`));
});

test("renderExplain returns text for a known id, null for an unknown one", () => {
  const out = renderExplain("duplication", "9.9.9");
  assert.ok(out);
  assert.match(out, /RESEARCH/);
  assert.match(out, /REMEDIATION/);
  assert.match(out, /arxiv\.org/);
  assert.equal(renderExplain("no-such-finding", "9.9.9"), null);
});

test("renderExplain output is deterministic", () => {
  assert.equal(renderExplain("frontmatter", "1.2.3"), renderExplain("frontmatter", "1.2.3"));
});
