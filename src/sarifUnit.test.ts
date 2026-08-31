import { test } from "node:test";
import assert from "node:assert/strict";
import type { Analysis, Finding } from "./types.js";
import { renderSarif } from "./sarif.js";

function analysisWith(findings: Finding[]): Analysis {
  return { findings } as unknown as Analysis;
}

test("sarifLevel maps off to none and warn to warning", () => {
  const doc = JSON.parse(
    renderSarif(
      analysisWith([
        {
          type: "vehicle-fit",
          severity: "off",
          message: "off one",
          locations: [{ file: "a.md", lineStart: 1, lineEnd: 2 }],
        },
        {
          type: "frontmatter",
          severity: "warn",
          message: "warn one",
          locations: [{ file: "b.md", lineStart: 3, lineEnd: 4 }],
        },
      ]),
      "9.9.9",
    ),
  );
  const byId = Object.fromEntries(
    doc.runs[0].results.map((r: any) => [r.ruleId, r]),
  );
  assert.equal(byId["vehicle-fit"].level, "none");
  assert.equal(byId["frontmatter"].level, "warning");
  assert.equal(byId["frontmatter"].message.text, "warn one");
  assert.equal(
    byId["vehicle-fit"].locations[0].physicalLocation.region.startLine,
    1,
  );
});

test("results sort by ruleId, then file, then start line", () => {
  const mk = (
    type: Finding["type"],
    file: string,
    lineStart: number,
  ): Finding => ({
    type,
    severity: "error",
    message: `${type} ${file}:${lineStart}`,
    locations: [{ file, lineStart, lineEnd: lineStart }],
  });
  const doc = JSON.parse(
    renderSarif(
      analysisWith([
        mk("duplication", "z.md", 5),
        mk("duplication", "a.md", 30),
        mk("duplication", "a.md", 10),
        mk("dead-reference", "q.md", 1),
      ]),
      "1.0.0",
    ),
  );
  const seen = doc.runs[0].results.map((r: any) => [
    r.ruleId,
    r.locations[0].physicalLocation.artifactLocation.uri,
    r.locations[0].physicalLocation.region.startLine,
  ]);
  assert.deepEqual(seen, [
    ["dead-reference", "q.md", 1],
    ["duplication", "a.md", 10],
    ["duplication", "a.md", 30],
    ["duplication", "z.md", 5],
  ]);
});

test("finding with no locations still renders and sorts without throwing", () => {
  const doc = JSON.parse(
    renderSarif(
      analysisWith([
        {
          type: "duplication",
          severity: "error",
          message: "no loc",
          locations: [],
        },
        {
          type: "duplication",
          severity: "error",
          message: "has loc",
          locations: [{ file: "a.md", lineStart: 2, lineEnd: 3 }],
        },
      ]),
      "1.0.0",
    ),
  );
  const results = doc.runs[0].results;
  assert.equal(results.length, 2);
  assert.deepEqual(results[0].locations, []);
  assert.equal(results[1].locations[0].physicalLocation.artifactLocation.uri, "a.md");
});

test("empty findings yields an empty results array and a full rule set", () => {
  const doc = JSON.parse(renderSarif(analysisWith([]), "0.0.1"));
  assert.deepEqual(doc.runs[0].results, []);
  assert.ok(doc.runs[0].tool.driver.rules.length > 0);
  for (const r of doc.runs[0].tool.driver.rules) {
    assert.equal(typeof r.fullDescription.text, "string");
    assert.ok(r.help.text.includes("Remediation:"));
    assert.equal(r.helpUri, "https://github.com/bronsonhill/conman#findings");
  }
});
