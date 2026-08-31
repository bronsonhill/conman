// Unlinked-copy finding: a directory ships a CLAUDE.md and an AGENTS.md as two
// separate, byte-identical files — not a symlink, not an `@`-import.
//
// This is NOT a duplication cost. Claude Code reads CLAUDE.md and never opens a
// bare AGENTS.md, so the copy adds nothing to a Claude Code session (the
// resolver already leaves it out of the stack). Other tools — Codex, Cursor,
// Aider — read AGENTS.md. Two hand-maintained copies drift. The fix is to link
// them: a symlink, or a one-line `@AGENTS.md` import in CLAUDE.md.
//
// Warn, not error: it is a maintainability smell, not a token bill, so it must
// not fail the gate on its own.

import type { Finding, Location } from "../types.js";
import type { Config } from "../config.js";
import type { UnlinkedAgentsCopy } from "../resolver/index.js";

const MESSAGE =
  "CLAUDE.md and AGENTS.md are separate byte-identical copies. Claude Code " +
  "reads only CLAUDE.md; other tools read AGENTS.md. Unlinked copies drift. " +
  "Fix: replace one with a symlink (ln -s CLAUDE.md AGENTS.md), or make " +
  "CLAUDE.md a one-line `@AGENTS.md` import.";

export function findUnlinkedCopies(
  copies: UnlinkedAgentsCopy[],
  config: Config,
): Finding[] {
  const severity = config.gate["unlinked-copy"];
  if (severity === "off") return [];

  return copies
    .slice()
    .sort((a, b) =>
      a.claudeMd < b.claudeMd ? -1 : a.claudeMd > b.claudeMd ? 1 : 0,
    )
    .map((c) => {
      const locations: Location[] = [
        { file: c.claudeMd, lineStart: 1, lineEnd: c.lines },
        { file: c.agentsMd, lineStart: 1, lineEnd: c.lines },
      ];
      return {
        type: "unlinked-copy" as const,
        severity,
        message: MESSAGE,
        locations,
        detail: { claudeMd: c.claudeMd, agentsMd: c.agentsMd },
      };
    });
}
