// Which agent's resolution rules to apply.
//
// `claude` is the default and the only version-anchored model (see MODEL.md's
// "Accurate as of"). The other three are best-effort: conman models the
// vendor's documented file-loading behavior with a static parser and does not
// anchor it to a release. Their rules live in MODEL.md under "Other agents
// (best-effort)".

import { ANCHOR } from "./anchor.js";

export type Agent = "claude" | "codex" | "cursor" | "copilot";

export const AGENTS: readonly Agent[] = ["claude", "codex", "cursor", "copilot"];

export function isAgent(s: string): s is Agent {
  return (AGENTS as readonly string[]).includes(s);
}

// How rigorously each agent's resolution model is pinned. `claude` is verified
// against a named Claude Code release; the others are a static best-effort model
// of documented behavior with no release anchor and no anchor.test.ts guard.
export type AgentVerification =
  | { anchored: true; release: string; verified: string }
  | { anchored: false };

export const AGENT_VERIFICATION: Record<Agent, AgentVerification> = {
  claude: { anchored: true, release: ANCHOR.version, verified: ANCHOR.verified },
  codex: { anchored: false },
  cursor: { anchored: false },
  copilot: { anchored: false },
};

/**
 * Report-header fragment naming how current the anchored model is, e.g.
 * `(Claude Code anchor v2.1.251, verified 2026-09-01)` for claude, or
 * `(best-effort, un-anchored - see MODEL.md)` for the other agents. Prints the
 * verified date, never a computed age — the reader judges staleness.
 */
export function modelFreshness(agent: Agent): string {
  const v = AGENT_VERIFICATION[agent];
  return v.anchored
    ? `(Claude Code anchor ${v.release}, verified ${v.verified})`
    : "(best-effort, un-anchored - see MODEL.md)";
}
