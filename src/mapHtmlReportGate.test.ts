import { test } from "node:test";
import assert from "node:assert/strict";
import { loadConfig } from "./config.js";
import { runMap } from "./map.js";
import { renderMapHtml } from "./mapHtmlReport.js";
import { fixture } from "./testutil.js";
import type { MapResult } from "./map.js";

function renderGate(name: string): string {
  const root = fixture(name);
  const { config, source } = loadConfig(root, root);
  const result = runMap(root, config, "claude-local");
  return renderMapHtml(result, "9.9.9", source, { gate: true });
}

test("gate verdict renders failing entry points with reasons", () => {
  const html = renderGate("monorepo");
  assert.ok(html.includes("<title>conman check --map report</title>"));
  assert.ok(html.includes('<section id="verdict">'));
  assert.ok(html.includes("<h2>Gate verdict</h2>"));
  assert.ok(html.includes(">FAIL</p>"));
  assert.ok(html.includes("Failing entry points ("));
  assert.ok(html.includes('<dt>safety margin</dt>'));
  assert.ok(html.includes("entry points checked</dt>"));
  assert.ok(html.includes('<ul class="reasons">'));
});

test("gate verdict reports a clean pass when no entry point fails", () => {
  const html = renderGate("clean");
  assert.ok(html.includes(">PASS</p>"));
  assert.ok(html.includes("No entry point fails the gate."));
});

test("gate verdict handles a MapResult with no entry points", () => {
  const empty = {
    pass: true,
    entries: [],
    notes: [],
    blocks: [],
  } as unknown as MapResult;
  const html = renderMapHtml(empty, "9.9.9", null, { gate: true });
  assert.ok(html.includes("<dt>budget</dt><dd>(no entry points)</dd>"));
  assert.ok(html.includes("No entry point fails the gate."));
  assert.ok(html.includes("(no entry points)"));
  assert.ok(html.includes("entry points checked</dt><dd>0</dd>"));
});
