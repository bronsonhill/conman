# conman

*A linter for the Claude Code context stack a repo loads before you type anything.*

Claude Code builds its startup context fresh every session. It walks the directory
tree for `CLAUDE.md` and `AGENTS.md`, inlines their `@`-imports, pulls in
`.claude/rules/`, and appends a one-line index of every skill. Nobody watches the
total. It grows a paragraph at a time, across months of pull requests, and one day
a root file says Node 20 while a service file two directories down says Node 22.
Both loaded, both in front of the model, and nothing reconciles them. The agent
gets a little worse and it's hard to say why.

`conman` reads that stack before a session starts. Point it at an entry point; it
resolves the full chain a session would load and reports what's in it, in what
order, at what token cost, and where blocks repeat verbatim or set the same key to
different values. It runs offline and emits the same bytes for the same input
every time. No model sits in the analysis path.

The name is the joke. Every file in the stack looks helpful. Some of them
contradict each other, some are dead weight duplicated from a parent, and the
session pays for all of it. conman is the audit.

The scope and the reasoning behind it are in [`VISION.md`](VISION.md). The
resolution model — load order, which `settings.json` keys matter, how findings are
defined, where the default numbers come from — is in [`MODEL.md`](MODEL.md).

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
`--no-repo-boundary`, `--repo-root <path>`, `--fix`, `--dry-run`, `--map`
(with `check`), and `--html <path>` (with `map`).

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
    "vehicle-fit": "warn"
  },
  "resolve": { "repoBoundary": true, "importDepthLimit": 5, "skillListingBudget": null },
  "ignore": ["**/node_modules/**"]
}
```

`conman check` fails when the stack is over `budget.total * (1 - safetyMargin)`
(with `gate.over-budget: "error"`) or when any finding's type maps to `error`.
`warn` is reported and never fails the gate.

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
