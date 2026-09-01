import { test } from "node:test";
import assert from "node:assert/strict";
import { analyzeEntry } from "./analyze.js";
import { DEFAULT_CONFIG } from "./config.js";
import { fixture } from "./testutil.js";
import { renderSarif, renderSarifMap } from "./sarif.js";
import { runMap } from "./map.js";
import { FINDING_IDS } from "./explain.js";

function sarifFor(name: string, ...sub: string[]) {
  const root = fixture(name);
  const { analysis } = analyzeEntry(fixture(name, ...sub), {
    repoRoot: root,
    config: DEFAULT_CONFIG,
  });
  return JSON.parse(renderSarif(analysis, "1.2.3"));
}

test("valid SARIF 2.1.0 envelope with a rule per finding type", () => {
  const doc = sarifFor("monorepo", "services", "api");
  assert.equal(doc.version, "2.1.0");
  assert.equal(doc.runs[0].tool.driver.name, "conman");
  assert.equal(doc.runs[0].tool.driver.version, "1.2.3");
  assert.deepEqual(
    doc.runs[0].tool.driver.rules.map((r: any) => r.id),
    [...FINDING_IDS],
  );
  for (const r of doc.runs[0].tool.driver.rules) {
    assert.ok(r.shortDescription.text.length > 0, `${r.id}: shortDescription`);
  }
});

test("each finding maps to a result with ruleId, level and a repo-relative location", () => {
  const doc = sarifFor("monorepo", "services", "api");
  const results = doc.runs[0].results;
  assert.ok(results.length >= 2);
  for (const res of results) {
    assert.ok(FINDING_IDS.includes(res.ruleId));
    assert.ok(["error", "warning", "none"].includes(res.level));
    const uri = res.locations[0].physicalLocation.artifactLocation.uri;
    assert.ok(!uri.startsWith("/"), "uri is repo-relative");
    assert.ok(res.locations[0].physicalLocation.region.startLine >= 1);
  }
  const dup = results.find((r: any) => r.ruleId === "duplication");
  assert.equal(dup.level, "error");
});

test("deterministic: results sorted by ruleId then file then line, stable across runs", () => {
  const root = fixture("monorepo");
  const { analysis } = analyzeEntry(fixture("monorepo", "services", "api"), {
    repoRoot: root,
    config: DEFAULT_CONFIG,
  });
  const a = renderSarif(analysis, "1.2.3");
  const b = renderSarif(analysis, "1.2.3");
  assert.equal(a, b);
  const ids = JSON.parse(a).runs[0].results.map((r: any) => r.ruleId);
  assert.deepEqual(ids, [...ids].sort());
});

test("no timestamps anywhere in the document", () => {
  const doc = sarifFor("monorepo", "services", "api");
  assert.ok(!JSON.stringify(doc).match(/\d{4}-\d{2}-\d{2}T/));
});

test("renderSarifMap aggregates every entry point into one deterministic document", () => {
  const root = fixture("monorepo");
  const result = runMap(root, DEFAULT_CONFIG);
  const a = renderSarifMap(result, "1.2.3");
  const b = renderSarifMap(result, "1.2.3");
  assert.equal(a, b);
  const doc = JSON.parse(a);
  assert.equal(doc.version, "2.1.0");
  assert.equal(doc.runs[0].tool.driver.name, "conman");
  const results = doc.runs[0].results;
  assert.ok(results.length >= 1);
  for (const res of results) {
    assert.ok(FINDING_IDS.includes(res.ruleId));
    assert.ok(!res.locations[0].physicalLocation.artifactLocation.uri.startsWith("/"));
  }
  // sorted by ruleId
  const ids = results.map((r: any) => r.ruleId);
  assert.deepEqual(ids, [...ids].sort());
});

test("renderSarifMap collapses a finding that repeats across entry points", () => {
  // Root CLAUDE.md carries a dead @-import; pkg-a and pkg-b inherit it, so the
  // same finding is reported by all three entry points.
  const result = runMap(fixture("map-sarif-dedup"), DEFAULT_CONFIG);
  const perEntry = result.entries.flatMap((e) =>
    e.analysis.findings.map((f) => `${f.type}:${f.message}`),
  );
  assert.equal(perEntry.length, 3, "three entry points each report the finding");
  const results = JSON.parse(renderSarifMap(result, "1.2.3")).runs[0].results;
  assert.equal(results.length, 1, "collapsed to a single result");
  assert.equal(results[0].ruleId, "dead-reference");
  assert.equal(
    results[0].locations[0].physicalLocation.artifactLocation.uri,
    "CLAUDE.md",
  );
});
