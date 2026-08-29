# Project agent memory

This file is the project's committed home for project-intrinsic agent knowledge: build, test, release, architecture, and sharp-edge notes that should travel with the code.

- Add durable project-specific notes here as they are discovered through real work.

## Test fixtures

`fixtures/` holds the pinned corpus of real public repos used to test conman's
resolved-stack analysis. Edit `fixtures/manifest.toml` to add or re-pin a repo,
run `scripts/fetch-fixtures.sh` to clone them into `fixtures/repos/`
(gitignored). See `fixtures/README.md` for the workflow and the
behavior-coverage table. No third-party code is vendored; clones are
local-only, pinned by SHA, not redistributed.

## Maintaining this file

Keep this file for knowledge useful to almost every future agent session in this project.
Do not repeat what the codebase already shows; point to the authoritative file or command instead.
Prefer rewriting or pruning existing entries over appending new ones.
When updating this file, preserve this bar for all agents and keep entries concise.
