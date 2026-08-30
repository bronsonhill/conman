# Fixture corpus

Real public repositories, pinned at a commit, used to test conman against
context stacks people actually ship. conman analyzes the *resolved context
stack* for an entry point (see `VISION.md`): the ancestor `CLAUDE.md` /
`AGENTS.md` chain, `@`-imports, `.claude/rules/` (always-loaded and
path-scoped), the skill startup index, and the `settings.json` keys that change
resolution. Each fixture here was picked because its stack exercises a specific
part of that.

This directory is **tooling only**. No third-party code is vendored. The repos
are cloned on demand into `fixtures/repos/` (gitignored) and are never
committed or redistributed.

## What's here

| file | purpose |
|------|---------|
| `manifest.toml`     | one `[[fixture]]` per repo: name, URL, pinned SHA, branch, license, entry points, and which conman behaviors it exercises |
| `../scripts/fetch-fixtures.sh` | clones each entry at its pinned SHA into `fixtures/repos/<name>` |
| `repos/`            | fetched clones (gitignored, not committed) |

## Refreshing

```sh
scripts/fetch-fixtures.sh            # all fixtures
scripts/fetch-fixtures.sh posthog    # one or more by name
```

The script is idempotent:

- repo absent -> fetch the pinned SHA, check it out detached
- repo already at the pinned SHA -> skip
- repo present but on another commit -> fetch the SHA, `git reset --hard`, `git clean -fdx`

It fetches shallowly by SHA where the server allows it and widens the fetch only
as a fallback. No submodules are initialised. If you are offline it says so and
leaves any existing clones alone; it exits non-zero if any fixture failed.

## Adding a repo

1. Pick a public repo with genuine Claude Code adoption: a real `.claude/`
   directory and/or a non-trivial `CLAUDE.md` or `AGENTS.md`. Prefer one that
   covers a gap in the current set (see the coverage list below) over another
   example of something already represented.
2. Get the SHA to pin:
   ```sh
   git ls-remote https://github.com/OWNER/REPO.git refs/heads/BRANCH
   ```
3. Add a `[[fixture]]` block to `manifest.toml`. Fill every field. In `notes`,
   name the specific conman behavior(s) the stack exercises — deep nesting,
   several entry points, byte-identical parent/child duplication, a direct
   value conflict, populated `.claude/rules/`, a large skills directory,
   `settings.json` resolution keys, an overgrown stack.
4. Run `scripts/fetch-fixtures.sh NAME` and confirm the clone lands at the
   pinned SHA.

To move a pin forward, bump `sha` (and `branch` if it moved), re-check `notes`
against the new tree, and re-run the fetch.

## Coverage

| behavior | fixtures |
|----------|----------|
| small single-file stack            | `llm`, `lila`, `vercel-ai` |
| `@`-import-only `CLAUDE.md`         | `firstmate` (one oversized block), `inbox-zero` (small `AGENTS.md`) |
| bare `AGENTS.md`, discovered but not loaded | `llm` (root), `vercel-ai` (`packages/ai`) |
| deep ancestor `CLAUDE.md` chain     | `cockroach`, `posthog`, `ruflo` |
| monorepo, several entry points      | `humanlayer`, `posthog`, `motrix`, `inbox-zero` |
| path-scoped `.claude/rules/`        | `motrix`, `ack-nestjs-boilerplate`, `cockroach`, `posthog` |
| large / nested skills directory     | `ruflo`, `cockroach`, `firstmate`, `inbox-zero` |
| `settings.json` resolution keys     | `ack-nestjs-boilerplate` (`claudeMdExcludes`), `ruflo` (`skillListingBudgetFraction`) |
| hooks-only `settings.json` (no resolution keys) | `firstmate`, `posthog`, `vercel-ai` |
| symlinked `CLAUDE.md` -> `AGENTS.md` (counted once, no finding) | `posthog` (~40 dirs), `lila` (root) |
| whole-stack / parent-child block dup | `ruflo` (30 findings), (hand-built `test/fixtures/monorepo`) |
| direct value conflict               | `ruflo` (`v3/` subtree, 2 entry points) |
| plainly overgrown stack             | `ruflo`, `posthog` |
| mid-size adopter, under budget, no findings (skew counterweight) | `inbox-zero`, `vercel-ai`, `humanlayer` |
| scale: large tree, many `conman map` entry points | `lila` (~16.7k files, 765 dirs, 85 SBT modules + 42 UI packages) |

## Licensing

Every repo is cloned at a pinned SHA for local testing only. We do not
redistribute them; `fixtures/repos/` is gitignored and nothing from it is
committed here. Licenses of the pinned repos, recorded in `manifest.toml`:
Apache-2.0 (`llm`, `humanlayer`, `vercel-ai`), MIT (`firstmate`, `motrix`,
`ack-nestjs-boilerplate`, `ruflo`), MIT Expat with a proprietary `ee/` subtree
that is not an entry point (`posthog`), AGPL-3.0 (`lila`, `inbox-zero`), and the
source-available CockroachDB Software License (`cockroach`). All permit local
cloning for testing; AGPL obligations attach to distributing or network-serving
modified versions, which this corpus does not do. If you add a repo, record its
license and keep it to terms that allow local cloning for testing.
