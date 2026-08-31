# Project agent memory

This file is the project's committed home for project-intrinsic agent knowledge:
build, test, release, architecture, and sharp-edge notes that should travel with
the code.

## What conman is

Deterministic, offline CLI that resolves a repo's Claude Code context stack for an
entry point and reports load order, token cost, block duplication, and direct
value conflicts, plus a budget-gated CI check. Scope and non-goals: `VISION.md`.
No model in the analysis path. The only code that ever makes a network call is
`--tokenizer exact` (`src/tokenizer.ts`), gated on the flag plus
`ANTHROPIC_API_KEY`; the default `claude-local` path is fully offline. Keep it
that way — never add a network call on any other path, and never wire `exact`
into a golden or CI job. `scripts/measure-tokenizer.mjs` (not built, not
shipped) regenerates the local-vs-`count_tokens` drift table in README's "How
accurate is the token estimate?".

## Where things are

- `MODEL.md` — the resolution model (load order, `settings.json` keys, finding
  rules, default budget provenance, tokenizer caveat). Read it before changing
  `src/resolver.ts` or the defaults in `src/config.ts`. Its "Accurate as of"
  section pins the model to a named Claude Code release; `src/anchor.test.ts`
  fails when resolved output drifts from it, and MODEL.md's "Bumping the version
  anchor" section is the procedure to follow when it does. Its "Entry-point
  discovery" section covers how `conman map` (`src/map.ts`) turns a rule `paths`
  glob into an entry-point directory. Its "Other agents (best-effort)" section
  documents the `--agent codex|cursor|copilot` rulesets, which are NOT
  version-anchored and NOT guarded by `anchor.test.ts`. Its "User-level config
  (`--user`)" section covers the opt-in that folds `~/.claude/CLAUDE.md` and
  `~/.claude/settings.json` into the stack and marks the report
  machine-specific; it is off by default so default output stays reproducible.
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
  README's "What the research says". `cli.ts` is arg-parse and dispatch only. `agent.ts` is the `--agent` enum;
`resolver.ts`'s `resolveNonClaude` and `map.ts`'s agent-keyed discovery hold the
best-effort non-Claude rulesets, and the `agent === "claude"` path is guaranteed
byte-identical (early-return before any shared code). Most renderers are pure
  formatters over `Analysis` / `MapResult`; `report.ts` additionally evaluates
  the gate (see audit item 15). All of them must stay deterministic: no `Date`,
  no absolute paths, sort before emit.
  `mapReport.ts`'s `summarizeMapNotes` hoists the resolver's repeated
  "rule ... did not match entry <x>" notes out of every per-entry list into a
  single counted map-level list (`conman map --json` keys `pathScopedRuleNotes`
  and `deadPathScopedRules`; per-entry `notes` keeps only its unique lines), and
  `mapHtmlReport.ts` renders the same via a "Path-scoped rules" section.
- `test/fixtures/` — small hand-built synthetic mini-repos. `test/golden/` —
  expected CLI output. `test/run-golden-*.js` diff live output against golden (shared harness in
  `test/golden-lib.js`);
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

`test/corpus-sweep.js` (run via `npm run test:corpus` / `test:corpus:all`, not
`npm test`) runs `conman map` over every fetched fixture and diffs a compact
per-repo digest against `test/corpus-digest.json`. The baseline is Linux-only:
macOS's case-insensitive filesystem over-discovers entry points from lowercase
`claude.md` / `agents.md` files in `firstmate` and `ruflo`, so those records
won't match a local macOS run. Regenerate from the `corpus-digest` artifact of
the `full-sweep` CI job whenever findings logic changes, and update the "What
conman finds in the wild" numbers in `README.md` /
`data/conman-corpus-map-reports/report.md` in the same commit. CI: `corpus-fast`
job per PR (small subset), `.github/workflows/corpus.yml` on corpus-tooling
changes and weekly (all 11).

`scripts/survey.mjs` (standalone, not built, not CI, not the fixture corpus) is
a separate, heavier evidence path: it code-searches GitHub via `gh-axi`,
shallow-clones a deterministic sample of public repos one at a time, runs the
local `conman map` build over each, deletes the clone, and writes
`docs/survey-<YYYY-MM>.md` plus the README "Broader sample" block (between the
`<!-- survey:begin -->` / `<!-- survey:end -->` markers). Its header comment has
`--help`, the flags, and the captain's full ~100-repo run command. Keep it off
CI and out of `fixtures/`.

## Maintaining this file

Keep this file for knowledge useful to almost every future agent session in this project.
Do not repeat what the codebase already shows; point to the authoritative file or command instead.
Prefer rewriting or pruning existing entries over appending new ones.
When updating this file, preserve this bar for all agents and keep entries concise.
