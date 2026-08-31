// HTML rendering for `conman map`: one self-contained file covering the same
// data as the text and JSON reports (discovered entry points, per-entry load
// order, per-block token cost, block duplication, and value conflicts).
//
// Constraints, per VISION.md: no model, no network. The output embeds its own
// CSS, pulls in no scripts or fonts, and renders from a direct file open. It is
// byte-identical for identical input: no timestamps, no absolute paths, no
// run-specific ids, and every collection is already sorted upstream
// (`runMap` sorts entries, the resolver fixes load order, the findings engine
// sorts findings) or is sorted here before rendering.

import type { MapResult, MapEntryResult } from "./map.js";
import { MODEL_VERSION, type Finding } from "./types.js";
import { redundancy } from "./report.js";
import { mapRedundancy, summarizeMapNotes } from "./mapReport.js";

const KIND_LABEL: Record<string, string> = {
  memory: "memory",
  import: "import",
  "rule-always": "rule-always",
  "rule-scoped": "rule-scoped",
  "skill-index": "skill-index",
};

// Entry-level keys this renderer lays out explicitly. Anything else on a
// MapEntryResult (e.g. fields a later discovery pass adds) is dumped verbatim in
// an "other fields" list rather than silently dropped.
const KNOWN_ENTRY_KEYS = new Set<keyof MapEntryResult | string>([
  "entry",
  "analysis",
  "notes",
  "mode",
  "pass",
  "reasons",
]);

function esc(s: unknown): string {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function signed(n: number): string {
  return (n >= 0 ? "+" : "") + n;
}

function formatDetailValue(v: unknown): string {
  if (Array.isArray(v)) return v.map((x) => String(x)).join(", ");
  if (v && typeof v === "object") return JSON.stringify(v);
  return String(v);
}

function severityCounts(findings: Finding[]): { error: number; warn: number } {
  let error = 0;
  let warn = 0;
  for (const f of findings) {
    if (f.severity === "error") error++;
    else if (f.severity === "warn") warn++;
  }
  return { error, warn };
}

const STYLE = `
  :root { color-scheme: light dark; }
  * { box-sizing: border-box; }
  body {
    margin: 0;
    font: 15px/1.55 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto,
      Helvetica, Arial, sans-serif;
    color: #1a1a1a;
    background: #fafafa;
  }
  main { max-width: 960px; margin: 0 auto; padding: 2rem 1.25rem 4rem; }
  h1 { font-size: 1.5rem; margin: 0 0 0.75rem; }
  h2 {
    font-size: 1.2rem;
    margin: 2.5rem 0 0.75rem;
    padding-bottom: 0.25rem;
    border-bottom: 1px solid #d8d8d8;
  }
  h3 { font-size: 1rem; margin: 1.5rem 0 0.4rem; }
  h4 { font-size: 0.95rem; margin: 0 0 0.3rem; }
  p { margin: 0.4rem 0; }
  table {
    border-collapse: collapse;
    width: 100%;
    margin: 0.5rem 0;
    font-size: 0.9rem;
  }
  th, td { text-align: left; padding: 0.35rem 0.6rem; border-bottom: 1px solid #e4e4e4; }
  thead th { border-bottom: 2px solid #c7c7c7; }
  tfoot th, tfoot td { border-top: 2px solid #c7c7c7; border-bottom: none; font-weight: 600; }
  td.num, th.num { text-align: right; font-variant-numeric: tabular-nums; }
  .mono, td.src, code { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
  td.src, code { font-size: 0.85em; }
  dl.kv { display: grid; grid-template-columns: max-content 1fr; gap: 0.15rem 1.25rem; margin: 0.4rem 0; }
  dl.kv dt { font-weight: 600; color: #555; }
  dl.kv dd { margin: 0; }
  section.entry { margin-top: 1.5rem; padding-top: 0.5rem; }
  .finding {
    border-left: 3px solid #b0b0b0;
    padding: 0.5rem 0.85rem;
    margin: 0.6rem 0;
    background: #fff;
  }
  .finding.sev-error { border-left-color: #c0392b; }
  .finding.sev-warn { border-left-color: #b9770e; }
  .finding .message { margin: 0.3rem 0; }
  ul.locations, ul.notes, ul.reasons { margin: 0.3rem 0; padding-left: 1.15rem; }
  ul.locations { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 0.85em; }
  .pass { color: #1e7e34; font-weight: 600; }
  .fail { color: #c0392b; font-weight: 600; }
  .toc a { margin-right: 0.9rem; white-space: nowrap; }
  @media (prefers-color-scheme: dark) {
    body { color: #e6e6e6; background: #17191b; }
    h2 { border-bottom-color: #33373a; }
    th, td { border-bottom-color: #2b2f31; }
    thead th { border-bottom-color: #3d4245; }
    tfoot th, tfoot td { border-top-color: #3d4245; }
    dl.kv dt { color: #9aa4ab; }
    .finding { background: #1e2123; border-left-color: #4a4f52; }
    .finding.sev-error { border-left-color: #e06c5b; }
    .finding.sev-warn { border-left-color: #d9a441; }
    .pass { color: #52c46b; }
    .fail { color: #e06c5b; }
  }
`.trim();

function renderLoadOrder(e: MapEntryResult): string {
  const rows = e.analysis.blocks
    .map((b) => {
      const src = b.source + (b.via ? ` (via ${b.via})` : "");
      return (
        "        <tr>" +
        `<td class="mono">${esc(b.id)}</td>` +
        `<td>${esc(KIND_LABEL[b.kind] ?? b.kind)}</td>` +
        `<td class="src">${esc(src)}</td>` +
        `<td class="num">${esc(b.lineStart)}-${esc(b.lineEnd)}</td>` +
        `<td class="num">${esc(b.depth)}</td>` +
        `<td class="num">${esc(b.tokens)}</td>` +
        "</tr>"
      );
    })
    .join("\n");
  return `      <table>
        <thead><tr><th>#</th><th>kind</th><th>source</th><th class="num">lines</th><th class="num">depth</th><th class="num">tokens</th></tr></thead>
        <tbody>
${rows}
        </tbody>
        <tfoot><tr><th colspan="5">total</th><td class="num">${esc(
          e.analysis.totals.stackTokens,
        )}</td></tr></tfoot>
      </table>`;
}

function renderTokenCostByFile(e: MapEntryResult): string {
  const perFile = e.analysis.totals.perFile;
  const keys = Object.keys(perFile).sort();
  if (keys.length === 0) return "      <p>none</p>";
  const rows = keys
    .map(
      (k) =>
        `        <tr><td class="src">${esc(k)}</td><td class="num">${esc(
          perFile[k],
        )}</td></tr>`,
    )
    .join("\n");
  return `      <table>
        <thead><tr><th>file</th><th class="num">tokens</th></tr></thead>
        <tbody>
${rows}
        </tbody>
      </table>`;
}

function renderBudget(e: MapEntryResult): string {
  const b = e.analysis.budget;
  const red = redundancy(e.analysis);
  return `      <dl class="kv">
        <dt>budget</dt><dd>${esc(b.total)}</dd>
        <dt>safety margin</dt><dd>${esc(Math.round(b.safetyMargin * 100))}% &rarr; effective ${esc(
          b.effective,
        )}</dd>
        <dt>stack total</dt><dd>${esc(b.stackTotal)}</dd>
        <dt>delta</dt><dd>${esc(signed(b.delta))} (${
          b.overBudget ? "OVER budget" : "under budget"
        })</dd>
        <dt>redundant tokens</dt><dd>${esc(red.tokens)} (${esc(red.pctOfStack)}% of stack)</dd>
      </dl>`;
}

function renderFinding(f: Finding): string {
  const locs = f.locations
    .map((l) => `          <li>${esc(l.file)}:${esc(l.lineStart)}-${esc(l.lineEnd)}</li>`)
    .join("\n");
  const parts: string[] = [];
  parts.push(`      <article class="finding sev-${esc(f.severity)}">`);
  parts.push(`        <h4>${esc(f.type)} &mdash; ${esc(f.severity)}</h4>`);
  parts.push(`        <p class="message">${esc(f.message)}</p>`);
  if (f.locations.length > 0) {
    parts.push(`        <ul class="locations">\n${locs}\n        </ul>`);
  }
  if (typeof f.tokens === "number") {
    parts.push(`        <p>token cost: ${esc(f.tokens)}</p>`);
  }
  if (f.detail && Object.keys(f.detail).length > 0) {
    const rows = Object.keys(f.detail)
      .sort()
      .map(
        (k) =>
          `          <dt>${esc(k)}</dt><dd>${esc(
            formatDetailValue((f.detail as Record<string, unknown>)[k]),
          )}</dd>`,
      )
      .join("\n");
    parts.push(`        <dl class="kv">\n${rows}\n        </dl>`);
  }
  parts.push("      </article>");
  return parts.join("\n");
}

function renderFindings(e: MapEntryResult): string {
  const { error, warn } = severityCounts(e.analysis.findings);
  const head = `      <p>${error} error, ${warn} warn</p>`;
  if (e.analysis.findings.length === 0) {
    return head + "\n      <p>none</p>";
  }
  return head + "\n" + e.analysis.findings.map(renderFinding).join("\n");
}

function renderList(items: string[], cls: string): string {
  if (items.length === 0) return "      <p>none</p>";
  const rows = items.map((n) => `        <li>${esc(n)}</li>`).join("\n");
  return `      <ul class="${cls}">\n${rows}\n      </ul>`;
}

function renderExtraFields(e: MapEntryResult): string {
  const bag = e as unknown as Record<string, unknown>;
  const keys = Object.keys(bag)
    .filter((k) => !KNOWN_ENTRY_KEYS.has(k))
    .sort();
  if (keys.length === 0) return "";
  const rows = keys
    .map(
      (k) =>
        `        <dt>${esc(k)}</dt><dd class="mono">${esc(JSON.stringify(bag[k]))}</dd>`,
    )
    .join("\n");
  return `      <h3>Other fields</h3>
      <dl class="kv">
${rows}
      </dl>`;
}

function renderEntrySection(
  e: MapEntryResult,
  index: number,
  notes: string[],
): string {
  const id = `entry-${index}`;
  return `    <section class="entry" id="${id}">
      <h2>${esc(e.entry)}</h2>
      <dl class="kv">
        <dt>mode</dt><dd>${esc(e.mode)}</dd>
        <dt>tokenizer</dt><dd>${esc(e.analysis.tokenizer)}</dd>
        <dt>stack tokens</dt><dd>${esc(e.analysis.totals.stackTokens)}</dd>
        <dt>result</dt><dd class="${e.pass ? "pass" : "fail"}">${e.pass ? "pass" : "fail"}</dd>
      </dl>

      <h3>Load order</h3>
${renderLoadOrder(e)}

      <h3>Token cost by file</h3>
${renderTokenCostByFile(e)}

      <h3>Budget</h3>
${renderBudget(e)}

      <h3>Findings</h3>
${renderFindings(e)}

      <h3>Notes</h3>
${renderList(notes, "notes")}

      <h3>Result</h3>
      <p class="${e.pass ? "pass" : "fail"}">${e.pass ? "pass" : "fail"}</p>
${e.reasons.length > 0 ? renderList(e.reasons, "reasons") : "      <p>no gate failures</p>"}
${renderExtraFields(e)}
    </section>`;
}

function renderSummaryTable(result: MapResult): string {
  const rows = result.entries
    .map((e, i) => {
      const { error, warn } = severityCounts(e.analysis.findings);
      return (
        "        <tr>" +
        `<td class="src"><a href="#entry-${i}">${esc(e.entry)}</a></td>` +
        `<td>${esc(e.mode)}</td>` +
        `<td class="num">${esc(e.analysis.totals.stackTokens)}</td>` +
        `<td class="num">${esc(signed(e.analysis.budget.delta))}</td>` +
        `<td class="num">${esc(error)}</td>` +
        `<td class="num">${esc(warn)}</td>` +
        `<td class="${e.pass ? "pass" : "fail"}">${e.pass ? "pass" : "FAIL"}</td>` +
        "</tr>"
      );
    })
    .join("\n");
  const totalTokens = result.entries.reduce(
    (n, e) => n + e.analysis.totals.stackTokens,
    0,
  );
  const red = mapRedundancy(result);
  return `      <table>
        <thead><tr><th>entry</th><th>mode</th><th class="num">tokens</th><th class="num">delta</th><th class="num">errors</th><th class="num">warnings</th><th>result</th></tr></thead>
        <tbody>
${rows}
        </tbody>
        <tfoot><tr><th colspan="2">repo rollup</th><td class="num">${esc(
          totalTokens,
        )}</td><td colspan="4"></td></tr></tfoot>
      </table>
      <p>${esc(totalTokens)} tokens across ${esc(result.entries.length)} entry ${
        result.entries.length === 1 ? "point" : "points"
      }.</p>
      <p>redundant tokens: ${esc(red.tokens)} (${esc(red.pctOfStack)}% of stack).</p>`;
}

/**
 * The gate verdict block for `conman check --map --html`: pass/fail up front, the
 * effective budget the gate applied, and every failing entry with its reasons.
 * Mirrors the trailing RESULT section of `check --map` text output, hoisted to
 * the top of the page so the verdict is the first thing read.
 */
function renderGateVerdict(result: MapResult): string {
  const b = result.entries[0]?.analysis.budget;
  const budgetRows = b
    ? `      <dt>budget</dt><dd>${esc(b.total)}</dd>
      <dt>safety margin</dt><dd>${esc(Math.round(b.safetyMargin * 100))}% &rarr; effective ${esc(
        b.effective,
      )}</dd>`
    : "      <dt>budget</dt><dd>(no entry points)</dd>";

  const failing = result.entries.filter((e) => !e.pass);
  let failBlock: string;
  if (failing.length === 0) {
    failBlock = "    <p>No entry point fails the gate.</p>";
  } else {
    const items = failing
      .map((e) => {
        const idx = result.entries.indexOf(e);
        const reasons = e.reasons
          .map((r) => `          <li>${esc(r)}</li>`)
          .join("\n");
        return `        <li><a href="#entry-${idx}">${esc(e.entry)}</a>
${reasons ? `        <ul class="reasons">\n${reasons}\n        </ul>` : "        <p>gate failure, no reason recorded</p>"}
        </li>`;
      })
      .join("\n");
    failBlock = `    <h3>Failing entry points (${failing.length})</h3>
    <ul class="reasons">
${items}
    </ul>`;
  }

  return `  <section id="verdict">
    <h2>Gate verdict</h2>
    <p class="${result.pass ? "pass" : "fail"}" style="font-size:1.3rem">${
      result.pass ? "PASS" : "FAIL"
    }</p>
    <dl class="kv">
${budgetRows}
      <dt>entry points checked</dt><dd>${esc(result.entries.length)}</dd>
    </dl>
${failBlock}
  </section>`;
}

export function renderMapHtml(
  result: MapResult,
  toolVersion: string,
  configSource: string | null,
  opts: { gate?: boolean } = {},
): string {
  const gate = opts.gate === true;
  const toc = result.entries
    .map((e, i) => `<a href="#entry-${i}">${esc(e.entry)}</a>`)
    .join("\n        ");

  const noteSummary = summarizeMapNotes(result);
  const entrySections = result.entries
    .map((e, i) =>
      renderEntrySection(e, i, noteSummary.perEntry.get(e.entry) ?? e.notes),
    )
    .join("\n\n");

  const pathScopedSection =
    noteSummary.collapsed.length === 0 && noteSummary.deadRules.length === 0
      ? ""
      : `  <section id="path-scoped-rules">
    <h2>Path-scoped rules</h2>
    <h3>Did not match every entry point</h3>
${renderList(noteSummary.collapsed, "notes")}
    <h3>Matched no entry point (dead scope)</h3>
${renderList(noteSummary.deadRules, "notes")}
  </section>

`;

  const title = gate ? "conman check --map report" : "conman map report";

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title>
<style>
${STYLE}
</style>
</head>
<body>
<main>
  <header>
    <h1>${title}</h1>
    <dl class="kv">
      <dt>tool</dt><dd>conman ${esc(toolVersion)}</dd>
      <dt>model</dt><dd>${esc(MODEL_VERSION)}</dd>
      <dt>config</dt><dd>${esc(configSource ?? "(built-in defaults)")}</dd>
      <dt>entry points discovered</dt><dd>${esc(result.entries.length)}</dd>
      <dt>result</dt><dd class="${result.pass ? "pass" : "fail"}">${
        result.pass ? "pass" : "fail"
      }</dd>
    </dl>
  </header>

${gate ? renderGateVerdict(result) + "\n" : ""}  <section id="summary">
    <h2>Summary</h2>
    <p class="toc mono">
        ${toc || "(no entry points)"}
    </p>
${renderSummaryTable(result)}
  </section>

${pathScopedSection}${entrySections}
</main>
</body>
</html>
`;
}
