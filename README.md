# conman

`conman` measures and budgets a repository's Claude Code context before a session
starts. Give it an entry point; it resolves the full context stack that a session
would assemble and reports what loads, in what order, at what token cost, and
where the loaded instructions duplicate or plainly contradict each other. It runs
offline, uses no model, and produces the same output for the same input every
time.

The scope and the reasoning behind it are in [`VISION.md`](VISION.md). The
resolution model — load order, which `settings.json` keys matter, how findings
are defined, where the default numbers come from — is in [`MODEL.md`](MODEL.md).

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
`--no-repo-boundary`, `--repo-root <path>`, `--fix`, `--dry-run`, and `--map`
(with `check`).

A run prints the load order with per-block token counts, the total against the
budget, and any findings. Every finding names a `file:line`, a token cost, or
both.

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

## `--fix`

`--fix` applies mechanical, semantics-free changes only: it deletes a block a
child file repeats byte-for-byte from a parent, sorts skill frontmatter keys, and
normalizes whitespace. It never rewrites prose and never touches a value
conflict. `--fix --dry-run` prints the diff and writes nothing.

## Config

`conman.json` at the repo root, searched upward from the entry point. Every key is
optional; omitted keys take the built-in default (see `MODEL.md` for provenance).

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
`warn` never fails the gate.

## CI

`.github/workflows/ci.yml` builds, runs the tests, and then runs
`conman check --map` against this repo. Point the same step at your own repo to
gate context growth on every PR.

## Deliberately out of scope for the MVP

No LLM anywhere in the analysis path. No semantic contradiction detection beyond
byte-identical duplication and direct value conflicts. No `.cursor/rules` or
Copilot instruction files. No runtime monitoring. The `exact` tokenizer mode is a
documented seam with no implementation. Vehicle-fit advice stays coarse and
structural until a later opt-in LLM layer.

## Tests

```
npm test
```

Unit tests sit next to the code (`src/*.test.ts`). Golden-output tests
(`test/run-golden.js`) run the built CLI against synthetic fixtures under
`test/fixtures/` and diff against `test/golden/`; `npm run test:update-golden`
regenerates them. A real-repo corpus is a separate task and nothing here depends
on it.
