# Agents-only fixture

This directory has an AGENTS.md and no CLAUDE.md. Codex, Cursor and Aider read
this file; Claude Code does not. conman models a Claude Code session, so the
resolved stack for this entry point carries no memory block at all — the file is
noted, not counted.

## Build and test

Run `npm ci` then `npm test` before every push. Do not skip the lint step or the
type check. Keep each change scoped to a single package so the review stays small.
