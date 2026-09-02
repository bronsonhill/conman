// The Claude Code release conman's resolution model is verified against.
//
// Single source of truth for the anchor version and verification date. Three
// places must agree with this constant:
//   - MODEL.md's "Accurate as of" section (prose)
//   - src/anchor.test.ts, which imports ANCHOR from here and snapshots resolver
//     output against it
//   - the report header line, via src/agent.ts's AGENT_VERIFICATION
// Bumping one without the others is a bug — see "Bumping the version anchor" in
// MODEL.md.
export const ANCHOR = { version: "v2.1.251", verified: "2026-09-01" } as const;
