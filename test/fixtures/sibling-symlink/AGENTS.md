# Sibling symlink fixture

This directory ships one file under two names: `AGENTS.md` is the real file and
`CLAUDE.md` is a symlink to it. This is the recommended multi-tool layout, so
conman must load the content exactly once and raise no finding.

## Build and test

Run `npm ci` then `npm test` before every push. Do not skip the lint step or the
type check. Keep each change scoped to a single package so the review stays small.

## House style

Two-space indent, named exports only, `const` over `let`, and never a bare
`var`. Prefer a short comment that explains why over a long one that restates
the code.
