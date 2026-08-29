// Budget / findings gate. `conman check` runs an analysis and then this.
//
// Fail conditions, all read straight from config so the pass/fail rule is legible
// without running the tool:
//   - stack over the effective budget, when gate.over-budget = error
//   - any finding whose type maps to a gate severity of error
// warn-level items never fail the gate.

import type { Analysis, GateResult } from "./types.js";
import type { Config } from "./config.js";

export function evaluateGate(analysis: Analysis, config: Config): GateResult {
  const reasons: string[] = [];

  if (config.gate["over-budget"] === "error" && analysis.budget.overBudget) {
    reasons.push(
      `stack is ${analysis.budget.delta} tokens over the effective budget (${analysis.budget.stackTotal} > ${analysis.budget.effective})`,
    );
  }

  const gatedByType = new Map<string, number>();
  for (const f of analysis.findings) {
    if (f.severity === "error") {
      gatedByType.set(f.type, (gatedByType.get(f.type) ?? 0) + 1);
    }
  }
  for (const [type, count] of [...gatedByType].sort()) {
    reasons.push(`${count} ${type} finding${count === 1 ? "" : "s"} at error severity`);
  }

  const pass = reasons.length === 0;
  return { pass, reasons, exitCode: pass ? 0 : 1 };
}
