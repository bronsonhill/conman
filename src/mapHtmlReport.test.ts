import { test } from "node:test";
import assert from "node:assert/strict";
import { loadConfig } from "./config.js";
import { runMap } from "./map.js";
import { renderMapHtml } from "./mapHtmlReport.js";
import { fixture } from "./testutil.js";

function render(): string {
  const root = fixture("monorepo");
  const { config, source } = loadConfig(root, root);
  const result = runMap(root, config, "claude-local");
  return renderMapHtml(result, "9.9.9", source);
}

test("renders a self-contained HTML document with no external references", () => {
  const html = render();
  assert.ok(html.startsWith("<!DOCTYPE html>"), "has a doctype");
  assert.ok(html.includes("<title>conman map report</title>"));
  assert.ok(html.includes("<style>"), "carries an inline stylesheet");
  assert.ok(!/<script/i.test(html), "no scripts");
  assert.ok(!/https?:\/\//i.test(html), "no absolute URLs / CDN links");
  assert.ok(!/<link\b/i.test(html), "no external stylesheet links");
});

test("covers the same data as the text and JSON map reports", () => {
  const html = render();
  // discovered entry points
  for (const entry of [".", "legacy", "services", "services/api"]) {
    assert.ok(html.includes(`>${entry}</h2>`), `entry section for ${entry}`);
  }
  assert.ok(html.includes("entry points discovered</dt><dd>4</dd>"));
  // per-entry load order (block sources and ids)
  assert.ok(html.includes("<h3>Load order</h3>"));
  assert.ok(html.includes(">b1</td>"));
  assert.ok(html.includes(">.claude/rules/backend.md</td>"));
  assert.ok(html.includes("docs/style.md (via CLAUDE.md:10)"));
  // per-block / per-file token cost
  assert.ok(html.includes("<h3>Token cost by file</h3>"));
  assert.ok(html.includes(">total</th><td class=\"num\">268</td>"));
  // block duplication
  assert.ok(html.includes("duplication &mdash; error"));
  assert.ok(html.includes("27 redundant tokens"));
  // value conflicts
  assert.ok(html.includes("value-conflict &mdash; error"));
  assert.ok(html.includes("node version"));
  assert.ok(html.includes(">20, 22</dd>"));
  // repo rollup + overall result
  assert.ok(html.includes("tokens across 4 entry points"));
  assert.ok(html.includes("result</dt><dd class=\"fail\">fail</dd>"));
});

test("escapes untrusted text from finding messages", () => {
  const html = render();
  assert.ok(!html.includes('"node version"'), "raw quotes are escaped");
  assert.ok(html.includes("&quot;node version&quot;"));
});

test("output is byte-identical across two runs of the same repo state", () => {
  assert.equal(render(), render());
});

test("carries no absolute machine paths", () => {
  const html = render();
  assert.ok(!html.includes(process.cwd()));
  assert.ok(!html.includes(fixture("monorepo")));
  assert.ok(!html.includes("/Users/"));
});
