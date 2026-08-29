# Sibling duplication fixture

This directory ships a CLAUDE.md and an AGENTS.md that are byte-for-byte the
same file. Neither is an ancestor of the other and neither imports the other, so
the relationship is `same-stack`. conman should report one rolled-up whole-file
duplication finding, not one finding per shared paragraph.

## Build and test

Run `npm ci` then `npm test` before every push. Do not skip the lint step or the
type check. Keep each change scoped to a single package so the review stays small.

## House style

Two-space indent, named exports only, `const` over `let`, and never a bare
`var`. Prefer a short comment that explains why over a long one that restates
the code.
