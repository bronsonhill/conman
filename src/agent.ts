// Which agent's resolution rules to apply.
//
// `claude` is the default and the only version-anchored model (see MODEL.md's
// "Accurate as of"). The other three are best-effort: conman models the
// vendor's documented file-loading behavior with a static parser and does not
// anchor it to a release. Their rules live in MODEL.md under "Other agents
// (best-effort)".

export type Agent = "claude" | "codex" | "cursor" | "copilot";

export const AGENTS: readonly Agent[] = ["claude", "codex", "cursor", "copilot"];

export function isAgent(s: string): s is Agent {
  return (AGENTS as readonly string[]).includes(s);
}
