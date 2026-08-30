# Sibling duplication fixture

This directory ships a CLAUDE.md and an AGENTS.md that are two separate files
with byte-for-byte the same content. Neither is a symlink and neither @-imports
the other. Claude Code loads CLAUDE.md and never opens AGENTS.md, so this is not
a token cost, but the two hand-maintained copies drift. conman should raise one
`unlinked-copy` finding at warn severity and no duplication finding.

## Build and test

Run `npm ci` then `npm test` before every push. Do not skip the lint step or the
type check. Keep each change scoped to a single package so the review stays small.

## House style

Two-space indent, named exports only, `const` over `let`, and never a bare
`var`. Prefer a short comment that explains why over a long one that restates
the code.
