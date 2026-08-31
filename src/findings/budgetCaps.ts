// Budget-cap findings: the two per-part token caps in `budget`.
//
//   - per-file-budget: a single resolved memory file (its summed block
//     contribution) costs more than `budget.perFile`. One oversized file
//     dominates every session's base context; splitting it or scoping part of
//     it to a rule keeps the always-loaded stack legible.
//   - skill-index-budget: the startup skill listing costs more than
//     `budget.skillIndex`. Pure per-session overhead, distinct from the
//     `max-skills` count cap.
//
// Both are `warn` by default (`config.gate`), so they surface everywhere other
// findings do without failing `conman check`. A repo can raise either to
// `error` in conman.json. The defaults are pinned to MODEL_VERSION; see
// MODEL.md "Default budget numbers".

import type { Block, Finding, Severity, Totals } from "../types.js";
import type { Config } from "../config.js";

export function findBudgetCaps(
  totals: Totals,
  blocks: Block[],
  config: Config,
): Finding[] {
  const out: Finding[] = [];
  const skillIndexSource = blocks.find((b) => b.kind === "skill-index")?.source;

  const perFileCeiling = config.gate["per-file-budget"];
  if (perFileCeiling !== "off") {
    const cap = config.budget.perFile;
    const severity: Severity = perFileCeiling === "error" ? "error" : "warn";
    // Sorted by key already (coster.computeTotals), so findings come out stable.
    for (const [file, tokens] of Object.entries(totals.perFile)) {
      if (file === skillIndexSource) continue; // covered by skill-index-budget
      if (tokens <= cap) continue;
      out.push({
        type: "per-file-budget",
        severity,
        message:
          `${file} contributes ${tokens} tokens to the resolved stack, over ` +
          `the ${cap}-token per-file budget`,
        locations: [{ file, lineStart: 1, lineEnd: 1 }],
        tokens,
        detail: { file, tokens, cap },
      });
    }
  }

  const skillCeiling = config.gate["skill-index-budget"];
  if (skillCeiling !== "off" && skillIndexSource) {
    const cap = config.budget.skillIndex;
    const tokens = totals.skillIndexTokens;
    if (tokens > cap) {
      const severity: Severity = skillCeiling === "error" ? "error" : "warn";
      out.push({
        type: "skill-index-budget",
        severity,
        message:
          `the startup skill index costs ${tokens} tokens, over the ` +
          `${cap}-token skill-index budget; it is paid on every request`,
        locations: [{ file: skillIndexSource, lineStart: 1, lineEnd: 1 }],
        tokens,
        detail: { tokens, cap },
      });
    }
  }

  return out;
}
