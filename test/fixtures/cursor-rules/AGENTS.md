# Cursor-rules fixture

This repo is set up for Cursor. It has an `AGENTS.md`, a legacy `.cursorrules`,
and three `.cursor/rules/*.mdc` files: one always-on, one glob-scoped, one that
Cursor pulls in only on request.

## Build and test

Run `npm ci` then `npm test` before every push. Keep each change scoped to a
single package so the review stays small.
