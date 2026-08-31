// What a directory's AGENTS.md means for a Claude Code stack: Claude Code reads
// CLAUDE.md and never opens a bare AGENTS.md, so this never adds a block. It
// only records a note, plus an `unlinkedAgentsCopy` when the AGENTS.md is a
// separate byte-identical twin of the sibling CLAUDE.md.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { isFile, relPosix } from "../repo.js";
import {
  countLines,
  normalizeForCompare,
  realOrSelf,
  type ImportCtx,
} from "./imports.js";

/**
 * A directory that ships a CLAUDE.md and an AGENTS.md as two separate,
 * byte-identical files — not a symlink, not an `@`-import. Claude Code loads the
 * CLAUDE.md and never opens the AGENTS.md, so this is not a cost, but the two
 * copies drift. Fuel for the `unlinked-copy` finding.
 */
export interface UnlinkedAgentsCopy {
  claudeMd: string;
  agentsMd: string;
  /** Line count of the shared content, for the finding's locations. */
  lines: number;
}

/**
 * Decide what a directory's AGENTS.md means for the resolved stack, given that
 * it was not already pulled in as an `@`-import. Never adds a block — a bare
 * AGENTS.md is not stack cost — but records a note, and an `unlinkedAgentsCopy`
 * when it is a separate byte-identical twin of the sibling CLAUDE.md.
 */
export function classifyAgentsMd(
  dir: string,
  agentsAbs: string,
  agentsRel: string,
  repoRoot: string,
  ctx: ImportCtx,
  out: UnlinkedAgentsCopy[],
): void {
  // Same underlying file as something already loaded — the common
  // `CLAUDE.md -> AGENTS.md` symlink, or the reverse. Counted once already.
  const real = realOrSelf(agentsAbs);
  const loadedAs = ctx.seenReal.get(real);
  if (loadedAs) {
    ctx.notes.push(
      `${agentsRel} is the same file as ${loadedAs} (symlink); Claude Code loads it once, as ${loadedAs}`,
    );
    return;
  }

  const claudeAbs = join(dir, "CLAUDE.md");
  const claudeRel = relPosix(repoRoot, claudeAbs);

  if (!isFile(claudeAbs)) {
    ctx.notes.push(
      `${agentsRel} present but not loaded: Claude Code reads CLAUDE.md, and this directory has none, so no project instructions load here`,
    );
    return;
  }
  if (!ctx.seen.has(claudeRel)) {
    // CLAUDE.md exists but was excluded or otherwise not loaded; nothing to
    // compare the AGENTS.md against.
    ctx.notes.push(
      `${agentsRel} present but not loaded by Claude Code (it reads ${claudeRel})`,
    );
    return;
  }

  const agentsText = readFileSync(agentsAbs, "utf8");
  const claudeText = readFileSync(claudeAbs, "utf8");
  if (normalizeForCompare(agentsText) === normalizeForCompare(claudeText)) {
    ctx.notes.push(
      `${agentsRel} present but not loaded: Claude Code reads ${claudeRel}, not AGENTS.md, and the two are byte-identical here`,
    );
    out.push({
      claudeMd: claudeRel,
      agentsMd: agentsRel,
      lines: Math.max(1, countLines(claudeText)),
    });
  } else {
    ctx.notes.push(
      `${agentsRel} present but not loaded by Claude Code (it reads ${claudeRel}); the two files differ`,
    );
  }
}
