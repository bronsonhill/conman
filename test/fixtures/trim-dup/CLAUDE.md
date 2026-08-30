# Trim fixture

This repo ships a root CLAUDE.md and a package CLAUDE.md that are byte-for-byte
identical. The package copy is provably redundant: conman's trim mode should
rank it for deletion and keep the root copy.

## Build and test

Run `npm ci` then `npm test` before every push. Do not skip the lint step or the
type check. Keep each change scoped to one package so the review stays small.

## House style

Two-space indent, named exports only, `const` over `let`, and never a bare
`var`. Prefer a short comment that explains why over a long one that restates
the code.
