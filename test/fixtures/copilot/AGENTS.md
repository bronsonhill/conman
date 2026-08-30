# Copilot fixture

This repo carries a `.github/copilot-instructions.md` and an `AGENTS.md`. Under
`--agent copilot` conman resolves both, copilot-instructions first.

## Conventions

Run `npm ci` then `npm test` before every push. Keep each change scoped to a
single package so the review stays small.
