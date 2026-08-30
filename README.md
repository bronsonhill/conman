# conman

**Don't be conned.** `conman` is short for context manager. The con is the
context stack itself: files that are each defensible on their own while, together,
they make the model worse and every session more expensive.

Claude Code assembles its startup context fresh every session. It walks the
directory tree for `CLAUDE.md` and `AGENTS.md`, inlines their `@`-imports, pulls in
`.claude/rules/`, and appends a one-line index of every skill. Every block in that
stack was added by someone trying to help the agent, and read on its own each one
looks reasonable.

Read the whole stack and the story changes. A root file says Node 20; a service
file two directories down says Node 22. Both load, both sit in front of the model,
nothing reconciles them. A setup paragraph gets copied into a child directory and
now the session pays for it twice. The skill index creeps up a line at a time.
None of it trips an alarm, because none of it looks wrong up close. The agent just
gets a little worse each month and it's hard to point at why.

That's the con. The stack reads like help and bills you like help, session after
session, while some of it is duplicated blocks, contradictory values, and weight
inherited from a parent directory that never applied here.

`conman` reads the stack before a session starts and calls it. Point it at an
entry point; it resolves the full chain a session would load and reports what's in
it, in what order, at what token cost, and where blocks repeat verbatim or set the
same key to two different values. It runs offline, uses no model in the analysis
path, and emits the same bytes for the same input every time. The job is to lint
your context stack, not to grow it.

The scope and the reasoning behind it are in [`VISION.md`](VISION.md). The
resolution model — load order, which `settings.json` keys matter, how findings are
defined, where the default numbers come from — is in [`MODEL.md`](MODEL.md).

## What the research says

Three recent studies have looked at whether `AGENTS.md`-style context files help
coding agents. The results on task accuracy are unsettled; the results on cost and
hygiene are not.

- **[Evaluating AGENTS.md](https://arxiv.org/abs/2602.11988)** (Gloaguen et al.,
  Feb 2026). Across established benchmarks and new repos with developer-written
  context files, providing a context file did not generally improve task success
  and raised inference cost by more than 20% on average. Agents follow the file
  literally and over-explore; any non-essential requirement in it makes tasks
  harder. The authors recommend keeping human-written context minimal.
- **[Configuration Smells in AGENTS.md Files](https://arxiv.org/abs/2606.15828)**
  (dos Santos et al., June 2026). A scan of 100 popular repos found widespread
  removable content: lint rules the linter already enforces (62% of files),
  general context bloat (42%), skill-shaped content (35%), plus contradictory
  instructions, stale `/init` boilerplate, and dead references.
- **[Probe-and-Refine Tuning of Repository
  Guidance](https://arxiv.org/abs/2606.20512)** (Shepard & Albrecht, June 2026).
  A guidance file iteratively pruned against synthetic bug-fix probes beat running
  with no guidance file on SWE-bench Verified, 33.0% resolved versus 25.5%.

conman targets the settled part: duplication, self-contradiction, and per-session
token cost you can measure and budget before a session starts. Whether a leaner
stack also improves task outcomes is a question for a future eval, not a claim
conman makes.

## Install

```
npm install
npm run build
```

`dist/cli.js` is the entry point. `npm link` or an `npx` invocation both work.

## Use

```
conman <entrypoint>          analyze one entry point (a directory, or a file for scoped checks)
conman map [root]            analyze every entry point discovered in the repo
conman check [<entrypoint>]  analyze, then exit non-zero over budget or on a gated finding
```

Flags: `--json`, `--config <path>`, `--budget <n>`, `--tokenizer <name>`,
`--no-repo-boundary`, `--repo-root <path>`, `--fix`, `--dry-run`, `--trim`,
`--map` (with `check`), and `--html <path>` (with `map`).

A single-entry run prints the load order with per-block token counts, the total
against the budget, then the findings. Every finding names a `file:line`, a token
cost, or both — advice without one of those attached does not ship.

```
$ conman check services/api
...
FINDINGS  (2 error, 0 warn)
  error  duplication
         CLAUDE.md:7-8
         services/api/CLAUDE.md:7-8
         identical 27-token block "Run `npm ci` then `npm test`..." appears in 2 files (27 redundant tokens)
  error  value-conflict
         CLAUDE.md:3-3
         services/api/CLAUDE.md:3-3
         key "node version" is set to different values across the stack: "20" vs "22"

RESULT  fail
```

## `conman map`

`conman map` runs the same analysis across every entry point in the repo and rolls
the results into one table, so adopting conman into an existing monorepo is a
single pass rather than a directory-by-directory hunt.

An entry point is any directory that holds a `CLAUDE.md` or `AGENTS.md` (the repo
root always counts), plus any directory a `.claude/rules/` file path-scopes to
through its `paths` glob — the directory `src/renderer/**` points at, even when it
carries no memory file of its own. Repos that scope every rule with `paths` have
directories that load a distinct context stack and were never obvious as entry
points; `map` finds them and lists them under the table. Keyless and `**`-scoped
rules add nothing, and only directories that exist on disk are picked up.
`MODEL.md` has the glob-to-directory rule.

## HTML report

`conman map --html <path>` writes the map results to one self-contained HTML file
instead of printing them: the discovered entry points, each entry's load order and
per-block token cost, the per-file subtotals, block duplication, and value
conflicts. The file inlines its own CSS and pulls in no scripts, fonts, or network
resources, so it opens straight from disk. Output is byte-identical for the same
repo state — no timestamps, no absolute paths — so it commits and diffs like any
other checked-in artifact.

```
conman map --html report.html
```

## `--fix`

`--fix` applies mechanical, meaning-free changes only: it deletes a block a child
file repeats byte-for-byte from a parent, sorts skill frontmatter keys, and
normalizes whitespace. It never rewrites prose and never touches a value conflict —
resolving one of those is a judgment call, and that call is yours. `--fix
--dry-run` prints the diff and writes nothing. The operation is idempotent.

`conman map --fix` runs the same mechanical fixes across every entry point `map`
discovers, so a repo with dozens of entry points is fixed in one pass rather than
one directory at a time. Running `--fix` on a leaf entry point can rewrite context
files above it — a leaf inherits and overrides its ancestors — so conman prints a
warning naming those out-of-path files before it writes.

## `--trim`

`conman <entrypoint> --trim` reports the whole files that are safe to delete
outright: every file the duplication finding proved is a byte-for-byte copy of
another file in the same resolved stack. It keeps exactly one copy of each — when
a `CLAUDE.md` and an `AGENTS.md` are identical the `CLAUDE.md` is kept, otherwise
the ancestor-directory copy wins — and prints the deletions cheapest-first with a
unified diff:

```
$ conman services/api --trim
RANKED DELETIONS  (lowest value first)
     157 tok  pkg/CLAUDE.md    16 lines  keep CLAUDE.md  [parent-child]
  recoverable: 157 tokens across 1 file

DIFF  (apply with: git apply)
diff --git a/pkg/CLAUDE.md b/pkg/CLAUDE.md
...
```

conman writes nothing. Pipe the diff to `git apply` yourself if you agree with
it. The output is a pure function of the tree — deterministic between runs, and
empty once the redundant copies are gone. `--trim` only removes provably
redundant whole files; trimming non-redundant content down to a budget is not
built.

## Config

`conman.json` at the repo root, searched upward from the entry point. Every key is
optional; an omitted key takes the built-in default (see `MODEL.md` for where each
default comes from).

```jsonc
{
  "budget": { "total": 12000, "perFile": 4000, "skillIndex": 2000 },
  "safetyMargin": 0.1,
  "gate": {
    "over-budget": "error",
    "duplication": "error",
    "value-conflict": "error",
    "vehicle-fit": "warn",
    "frontmatter": "error"
  },
  "resolve": { "repoBoundary": true, "importDepthLimit": 5, "skillListingBudget": null },
  "ignore": ["**/node_modules/**"]
}
```

`conman check` fails when the stack is over `budget.total * (1 - safetyMargin)`
(with `gate.over-budget: "error"`) or when any finding's type maps to `error`.
`warn` is reported and never fails the gate.

`gate.frontmatter` is a ceiling rather than a single severity: the frontmatter
finding assigns `error` or `warn` per sub-case (a `.claude/rules` entry whose
`paths` scope is unparseable or the wrong type is an `error` — the rule then
silently loads always-on or never matches; a skill missing `description`, a
bare-string `paths`, and other still-resolving cases are `warn`). `"error"` lets
both through, `"warn"` caps every sub-case at warn, `"off"` disables it.
`MODEL.md` lists the sub-cases.

## CI

`.github/workflows/ci.yml` builds, runs the tests, then runs `conman check --map`
against this repo. Point the same step at your own repo and context growth fails
the build on the PR that introduced it, instead of being discovered months later.

## Deliberately out of scope for the MVP

No LLM anywhere in the analysis path. No semantic contradiction detection beyond
byte-identical duplication and direct value conflicts. No `.cursor/rules` or
Copilot instruction files — keeping those in sync is another tool's job. No
runtime monitoring; `/context` already shows a live session's usage. The `exact`
tokenizer mode is a documented seam with no implementation. Vehicle-fit advice
stays coarse and structural until a later opt-in LLM layer.

## Tests

```
npm test
```

Unit tests sit next to the code (`src/*.test.ts`). Golden-output tests
(`test/run-golden.js`) run the built CLI against synthetic fixtures under
`test/fixtures/` and diff against `test/golden/`; `npm run test:update-golden`
regenerates them. A pinned corpus of real public repos lives under `fixtures/`
(see `fixtures/README.md`) and is fetched on demand; nothing in the test suite
depends on it.
