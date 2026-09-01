// SARIF 2.1.0 renderer for conman findings, so they surface in the GitHub
// code-scanning UI. Deterministic like every other renderer: results sorted,
// no timestamps, repo-relative URIs only.

import type { Analysis, Finding, Severity } from "./types.js";
import type { MapResult } from "./map.js";
import { FINDING_IDS, FINDING_INFO } from "./explain.js";

const INFORMATION_URI = "https://github.com/bronsonhill/conman";

function sarifLevel(sev: Severity): "error" | "warning" | "none" {
  if (sev === "error") return "error";
  if (sev === "warn") return "warning";
  return "none";
}

/** First sentence of the explanation, for the rule's short description. */
function firstSentence(text: string): string {
  const m = text.match(/^(.*?[.!?])(\s|$)/s);
  return (m?.[1] ?? text).replace(/\s+/g, " ").trim();
}

function resultForFinding(f: Finding) {
  return {
    ruleId: f.type,
    level: sarifLevel(f.severity),
    message: { text: f.message },
    locations: f.locations.map((loc) => ({
      physicalLocation: {
        artifactLocation: { uri: loc.file },
        region: { startLine: loc.lineStart, endLine: loc.lineEnd },
      },
    })),
  };
}

type SarifResult = ReturnType<typeof resultForFinding>;

function sortResults(results: SarifResult[]): SarifResult[] {
  return results.slice().sort(
    (a, b) =>
      (a.ruleId < b.ruleId ? -1 : a.ruleId > b.ruleId ? 1 : 0) ||
      cmpLoc(a, b) ||
      (a.message.text < b.message.text ? -1 : a.message.text > b.message.text ? 1 : 0),
  );
}

function sarifDoc(results: SarifResult[], toolVersion: string) {
  const rules = FINDING_IDS.map((id) => ({
    id,
    name: id,
    shortDescription: { text: firstSentence(FINDING_INFO[id].explanation) },
    fullDescription: { text: FINDING_INFO[id].explanation.replace(/\s+/g, " ").trim() },
    helpUri: `${INFORMATION_URI}#findings`,
    help: {
      text: `${FINDING_INFO[id].explanation}\n\nRemediation: ${FINDING_INFO[id].remediation}`,
    },
  }));

  return {
    $schema: "https://json.schemastore.org/sarif-2.1.0.json",
    version: "2.1.0",
    runs: [
      {
        tool: {
          driver: {
            name: "conman",
            informationUri: INFORMATION_URI,
            version: toolVersion,
            rules,
          },
        },
        results,
      },
    ],
  };
}

export function renderSarif(analysis: Analysis, toolVersion: string): string {
  const results = sortResults(analysis.findings.map(resultForFinding));
  return JSON.stringify(sarifDoc(results, toolVersion), null, 2) + "\n";
}

/**
 * Aggregated SARIF for `conman map` / `conman check --map`: one document over
 * every discovered entry point. A finding that repeats across entry points —
 * typically an ancestor CLAUDE.md block resolved into several leaf stacks —
 * collapses to a single result. The collapse key is the full result shape
 * (ruleId + level + message + physical locations); since every location is
 * already repo-relative, two entry points that hit the same block produce
 * byte-identical results and dedupe cleanly. No per-entry attribution is kept:
 * SARIF locations are physical, and the physical location is the actionable
 * fact.
 */
export function renderSarifMap(result: MapResult, toolVersion: string): string {
  const seen = new Set<string>();
  const results: SarifResult[] = [];
  for (const e of result.entries) {
    for (const f of e.analysis.findings) {
      const r = resultForFinding(f);
      const key = JSON.stringify(r);
      if (seen.has(key)) continue;
      seen.add(key);
      results.push(r);
    }
  }
  return JSON.stringify(sarifDoc(sortResults(results), toolVersion), null, 2) + "\n";
}

function cmpLoc(a: ReturnType<typeof resultForFinding>, b: ReturnType<typeof resultForFinding>): number {
  const la = a.locations[0]?.physicalLocation;
  const lb = b.locations[0]?.physicalLocation;
  const fa = la?.artifactLocation.uri ?? "";
  const fb = lb?.artifactLocation.uri ?? "";
  if (fa !== fb) return fa < fb ? -1 : 1;
  return (la?.region.startLine ?? 0) - (lb?.region.startLine ?? 0);
}
