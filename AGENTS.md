# Project agent memory

This file is the project's committed home for project-intrinsic agent knowledge:
build, test, release, architecture, and sharp-edge notes that should travel with
the code.

## What conman is

Deterministic, offline CLI that resolves a repo's Claude Code context stack for an
entry point and reports load order, token cost, block duplication, and direct
value conflicts, plus a budget-gated CI check. Scope and non-goals: `VISION.md`.
No model or network in the analysis path.

## Where things are

- `MODEL.md` — the resolution model (load order, `settings.json` keys, finding
  rules, default budget provenance, tokenizer caveat). Read it before changing
  `src/resolver.ts` or the defaults in `src/config.ts`. Its "Accurate as of"
  section pins the model to a named Claude Code release; `src/anchor.test.ts`
  fails when resolved output drifts from it, and MODEL.md's "Bumping the version
  anchor" section is the procedure to follow when it does. Its "Entry-point
  discovery" section covers how `conman map` (`src/map.ts`) turns a rule `paths`
  glob into an entry-point directory.
- `src/` — one module per stage: `resolver` → `coster` → `findings/` → `report`
  / `mapReport` / `mapHtmlReport` (`conman map --html`, plus a gate-focused
  variant for `conman check --map --html`), with `gate`, `map`,
  `fix`, `diff`, `config`, `tokenizer` around them. `trim` (`conman <entry>
  --trim`, delete-only Tier-1 advice over the whole-file duplication findings)
  reuses `parentFile` / `preferredKeeper` from `fix.ts` to pick which copy of a
  byte-identical cluster to keep. `sarif` renders findings as SARIF 2.1.0
  (`conman <entry> --format sarif`, single entry only); `explain` holds the
  static per-finding-type reference table (`conman explain [<id>]`) that also
  supplies the SARIF rule descriptions — keep its citations in sync with
  README's "What the research says". `cli.ts` is arg-parse and dispatch only. Every renderer is a pure formatter over `Analysis` / `MapResult`
  and must stay deterministic: no `Date`, no absolute paths, sort before emit.
- `test/fixtures/` — small hand-built synthetic mini-repos. `test/golden/` —
  expected CLI output. `test/run-golden.js` diffs live output against golden;
  `npm run test:update-golden` regenerates.

## Build and test

- `npm run build` — clean `tsc` to `dist/` (`rootDir: src`, so `bin` is
  `dist/cli.js`).
- `npm test` — `scripts/build-if-stale.sh` (skips `tsc` when `dist/` is newer
  than every build input), then `node --test` over compiled unit tests and the
  golden runner. CI runs `npm run build` first, so CI always gets a full compile.
- Contributor-facing workflow (determinism contract, goldens, `--fix` rule,
  adding a fixture): `CONTRIBUTING.md`.

## Release

- Published to npm as `@bronsonhill/conman` (the bare `conman` name is taken by
  an unrelated hapi plugin). `publishConfig.access` is `public`; `prepublishOnly`
  runs the build. `files` ships `dist/` minus `*.test.js`/`testutil.js`, plus
  `README.md`, `MODEL.md`, `LICENSE`. Bump `version` here and in `CHANGELOG.md`,
  then `npm publish` and tag `vX.Y.Z`.

## House rules

- Determinism is the contract: same input → same bytes out. No `Date`, no
  `Math.random`, sort every directory listing and every findings array, emit
  POSIX paths.
- `--fix` is mechanical only (dedupe byte-identical parent/child blocks, sort
  skill frontmatter keys, normalize whitespace). It must never touch prose or
  meaning, and must be idempotent.
- conman is held to its own checks: `conman.json` at the repo root, and CI runs
  `conman check --map` against this repo. Keep this file and any other context
  files under the budget in `conman.json`.

## Test fixtures

`fixtures/` holds the pinned corpus of real public repos used to test conman's
resolved-stack analysis. Edit `fixtures/manifest.toml` to add or re-pin a repo,
run `scripts/fetch-fixtures.sh` to clone them into `fixtures/repos/`
(gitignored). See `fixtures/README.md` for the workflow and the
behavior-coverage table. No third-party code is vendored; clones are
local-only, pinned by SHA, not redistributed. This corpus is separate from the
small hand-built fixtures under `test/fixtures/`, which the unit and golden tests
depend on.

## Maintaining this file

Keep this file for knowledge useful to almost every future agent session in this project.
Do not repeat what the codebase already shows; point to the authoritative file or command instead.
Prefer rewriting or pruning existing entries over appending new ones.
When updating this file, preserve this bar for all agents and keep entries concise.
