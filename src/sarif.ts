// SARIF 2.1.0 renderer for conman findings, so they surface in the GitHub
// code-scanning UI. Deterministic like every other renderer: results sorted,
// no timestamps, repo-relative URIs only.

import type { Analysis, Finding, Severity } from "./types.js";
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

export function renderSarif(analysis: Analysis, toolVersion: string): string {
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

  const results = analysis.findings
    .map(resultForFinding)
    .sort(
      (a, b) =>
        (a.ruleId < b.ruleId ? -1 : a.ruleId > b.ruleId ? 1 : 0) ||
        cmpLoc(a, b),
    );

  const doc = {
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
  return JSON.stringify(doc, null, 2) + "\n";
}

function cmpLoc(a: ReturnType<typeof resultForFinding>, b: ReturnType<typeof resultForFinding>): number {
  const la = a.locations[0]?.physicalLocation;
  const lb = b.locations[0]?.physicalLocation;
  const fa = la?.artifactLocation.uri ?? "";
  const fb = lb?.artifactLocation.uri ?? "";
  if (fa !== fb) return fa < fb ? -1 : 1;
  return (la?.region.startLine ?? 0) - (lb?.region.startLine ?? 0);
}
