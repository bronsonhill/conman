# Contributing to conman

Thanks for taking a look. conman is a small, deterministic CLI with a narrow
scope (`VISION.md`) and a written-down resolution model (`MODEL.md`). Read those
two before proposing anything that changes what the tool analyzes or reports.

## Build and test

```sh
npm install
npm run build     # clean tsc to dist/ (bin is dist/cli.js)
npm test          # build if stale, then node --test over unit + golden tests
```

`npm test` skips `tsc` when `dist/` is newer than every build input; see
`scripts/build-if-stale.sh`. Force a full compile with `npm run build`. CI always
runs a clean `npm run build` before the tests.

Run the CLI from source with `npm run conman -- <args>` or `node dist/cli.js
<args>`.

## The determinism contract

Same input, same bytes out. This is the whole point of the tool, and it is
enforced by the golden tests. Concretely, in any code that reaches output:

- No `Date`, no `Math.random`, no clock- or environment-dependent values.
- Sort every directory listing and every findings array before you emit it.
- Emit POSIX paths (forward slashes), never absolute paths.
- Renderers (`report`, `mapReport`, `mapHtmlReport`, …) are pure formatters over
  `Analysis` / `MapResult`. Keep them that way.

## Goldens

`test/golden/` holds expected CLI output; `test/run-golden.js` runs the built CLI
against the synthetic fixtures in `test/fixtures/` and diffs stdout plus exit
code.

If a change legitimately shifts output:

```sh
npm run test:update-golden
git diff test/golden/
```

Read the diff line by line. The regenerated goldens are the review artifact — a
churned golden you did not look at is how a determinism bug ships. Only commit
the ones that changed for the reason you expect.

## `--fix` is mechanical only

`conman --fix` (and `map --fix`, `--trim`) may only make changes that do not
touch prose or meaning: dedupe byte-identical parent/child blocks, sort skill
frontmatter keys, normalize whitespace. It must be idempotent — running it twice
changes nothing the second time. Anything that requires judgment about what the
text says does not belong in `--fix`.

## Adding a fixture repo

The pinned corpus of real public repos lives in `fixtures/`. To add one:

1. Pick a public repo with genuine Claude Code adoption that covers a gap in the
   coverage table in `fixtures/README.md`.
2. Get a SHA to pin: `git ls-remote https://github.com/OWNER/REPO.git refs/heads/BRANCH`.
3. Add a `[[fixture]]` block to `fixtures/manifest.toml` with every field filled
   in. In `notes`, name the specific conman behavior the stack exercises.
4. `scripts/fetch-fixtures.sh NAME` and confirm the clone lands at the pinned
   SHA.

No third-party code is vendored; clones are local-only and gitignored. Record the
repo's license in the manifest and keep it to terms that allow local cloning for
testing. Full workflow: `fixtures/README.md`.

## conman checks itself

`conman.json` sits at the repo root and CI runs `conman check --map` against this
repo. Keep `AGENTS.md`, `CLAUDE.md`, and any other context files under the budget
in `conman.json`.

## Releasing

`@bronsonhill/conman` publishes to npm through npm trusted publishing (OIDC) —
no token, no `npm login`. The `.github/workflows/release.yml` workflow does it:

1. Bump `version` in `package.json` (and the matching `CHANGELOG.md` entry).
2. Commit, then tag: `git tag vX.Y.Z`.
3. `git push origin vX.Y.Z`. The pushed `v*` tag triggers `release.yml`, which
   builds and runs `npm publish --access public` with an OIDC token.

`workflow_dispatch` is also wired if you need to re-run a publish by hand.

**One-time prerequisite (maintainer):** the npm side needs a trusted publisher
configured on npmjs.com for the `@bronsonhill/conman` package — GitHub repo
`bronsonhill/conman`, workflow `release.yml`. Until that's set, `npm publish`
in the workflow fails with an auth error.

## Pull requests

- One logical change per PR. Keep the diff scoped.
- `npm test` green, goldens regenerated and reviewed if output moved.
- Match the surrounding code and prose style. `AGENTS.md` has the house rules.
