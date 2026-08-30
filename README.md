# conman

## Quickstart

```sh
npx @bronsonhill/conman <path>          # resolve and lint the context stack for an entry point
npx @bronsonhill/conman map <path>      # map every entry point in the repo and its budget status
```

Point it at a directory (or a `CLAUDE.md`/`AGENTS.md`). It prints the exact
stack a Claude Code session would load from there — load order, token cost,
duplicated blocks, and keys set to conflicting values — and exits non-zero when a
budget-gated check fails. Offline, no model, same bytes for the same input.

Full docs below; the resolution model is in [`MODEL.md`](MODEL.md).

---

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
  with no guidance file on SWE-bench Verified, 33.0% resolved versus 25.5%. The
  static knowledge base the pruning started from already scored 28.3%, so +2.8
  points come from having a static file at all and the remaining +4.7 from
  pruning it against outcome probes. That pruning is a model-in-the-loop process,
  which `VISION.md` rules out of conman's path; the paper supports "pruned beats
  static", not "mechanical dedupe beats static".

conman targets the settled part: duplication, self-contradiction, and per-session
token cost you can measure and budget before a session starts. Whether a leaner
stack also improves task outcomes is a question for a future eval, not a claim
conman makes.

## What conman finds in the wild

`conman map` was run over a pinned corpus of 11 public repos with real Claude
Code adoption (`fixtures/manifest.toml`), each at a fixed SHA, with built-in
defaults (12,000-token budget, 0.10 safety margin, so a 10,800-token gate line).
That is 123 entry points. Numbers below are exact counts from `conman 0.1.0`,
resolution model `0.2`, generated on Linux by the `full-sweep` CI job; the full
breakdown with per-repo figures and SHAs is in
[`data/conman-corpus-map-reports/report.md`](data/conman-corpus-map-reports/report.md),
and CI diffs them against `test/corpus-digest.json` on every change.

| measure | corpus result |
|---------|---------------|
| redundant tokens (byte-identical blocks loaded twice) | **1,688 of 1,712,585 — 0.10%**, all in `ruflo` (`d33ef4b`); zero in the other ten repos |
| entry points with a direct value conflict | **2 of 123 — 1.63%**, both in `ruflo`'s `v3/` subtree |
| median resolved stack | **5,472 tokens**, but lopsided: `posthog` (52 entry points) and `ruflo` (6) resolve to 15k–40k each and are 58 of the 123; the rest sit under 6k |
| entry points over the effective budget | **61 of 123 — 49.59%**: `posthog` (52, `41570ae`), `ruflo` (6), `ack-nestjs-boilerplate` (2, `ab70ad2`), `firstmate` (1, `4207214`) |

The corpus is skewed by two repos: `posthog` and `motrix` (`7861034`) supply 90
of the 123 entry points, and `ruflo` is the only source of any duplication or
value-conflict finding. The boring results are real and left in: `llm`
(`a463c63`) resolves to a zero-token stack (a bare `AGENTS.md` is not loaded at
model 0.2); `lila` (`9b49f37`), 16.7k files, collapses to one root entry point at
1,814 tokens with no findings; `motrix` raises zero findings across all 38 of its
entry points. Overgrowth in the wild is real and concentrated, not the median.

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
conman explain [<id>]        describe a finding type: explanation, research, remediation
```

Flags: `--json`, `--format <human|json|sarif>`, `--config <path>`, `--budget <n>`,
`--tokenizer <name>`, `--agent <claude|codex|cursor|copilot>`,
`--no-repo-boundary`, `--repo-root <path>`, `--fix`, `--dry-run`, `--trim`,
`--map` (with `check`), and `--html <path>` (with `map` or `check --map`).

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

### How accurate is the token estimate?

Default costing (`--tokenizer claude-local`) uses `@anthropic-ai/tokenizer`,
which runs offline and is what budgets and the CI gate are measured against.
`--tokenizer exact` swaps in Anthropic's `count_tokens` API (opt-in; needs
`ANTHROPIC_API_KEY`, the only thing in conman that makes a network call). Running
both over the pinned corpus (`fixtures/manifest.toml` — 9 public repos, 123
resolved stacks, 468 distinct blocks) gives the drift `(local - exact) / exact`:

| `count_tokens` model | per stack (mean / median / p90 / max) | per block (mean / min / max) |
|---|---|---|
| `claude-haiku-4-5` | −4.2% / −4.3% / −3.1% / −8.6% | −4.3% / −14.2% / +4.1% |
| `claude-opus-5` | −32.1% / −32.5% / −31.0% / −35.5% | −31.9% / −43.3% / −22.3% |

The bundled tokenizer closely matches Claude's older-generation vocab — through
Sonnet 4.5 / Haiku 4.5 it is within a few percent, and never off by more than
~9% on a whole stack. The Opus 4.7 / Sonnet 4.6 generation shipped a denser
tokenizer, and against that the local estimate runs a consistent ~32% low (the
spread is tight: −29% to −35% per stack). That gap is systematic, not
content-dependent, so it does not change which stacks look heavy relative to
each other — but a stack the local counter puts at 12k tokens is closer to 17k
for a current Claude Code model. Set the budget with that headroom in mind, or
run `--tokenizer exact` when the absolute number matters. `CONMAN_EXACT_MODEL`
picks the model the exact count is taken against (default `claude-opus-5`).

Numbers from corpus SHAs: llm `a463c63`, firstmate `4207214`, motrix `7861034`,
ack-nestjs-boilerplate `ab70ad2`, cockroach `8812064`, humanlayer `99abe67`,
posthog `41570ae`, ruflo `d33ef4b`, lila `9b49f37`. Regenerate with
`node scripts/measure-tokenizer.mjs` (needs the key and network).

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

`conman check --map --html <path>` writes a gate-focused variant of the same
page: it leads with the pass/fail verdict, the effective budget the gate
applied, and every failing entry point with its reasons (over budget,
duplication error, value-conflict error), then the same per-entry detail. The
process exit code still follows the gate (0 pass, 1 fail). Plain `map --html`
stays the inventory view with no verdict framing.

## SARIF output

`conman <entrypoint> --format sarif` emits the findings as a SARIF 2.1.0
document. Upload it with `github/codeql-action/upload-sarif` and the findings
land in the repository's Security → Code scanning tab, one alert per finding,
annotated on the context file and line it originates from. Each finding type is
registered as a SARIF rule with a short description; `error` findings map to
SARIF `error`, `warn` to `warning`. The document carries no timestamps and only
repo-relative URIs, so it is deterministic for a given tree. Only single-entry
runs support it; `map` does not.

```
conman check src/renderer --format sarif > conman.sarif
```

## `conman explain`

`conman explain <finding-id>` prints the one-paragraph explanation for a finding
type, the research citations behind that class of problem, and how to fix it.
`conman explain` with no argument lists the ids (`duplication`, `unlinked-copy`,
`value-conflict`, `vehicle-fit`, `frontmatter`). The same reference text feeds
the SARIF rule descriptions.

```
$ conman explain value-conflict
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

## Other agents (best-effort)

`--agent` switches the resolution ruleset. `claude` is the default and the only
one anchored to a named Claude Code release. The other three model each vendor's
documented file-loading on a best-effort basis — no version anchor, no drift
test — and everything downstream (token costing, findings, the budget gate) runs
unchanged on whatever stack comes out.

| `--agent` | resolves |
|---|---|
| `claude` (default) | `CLAUDE.md` / `AGENTS.md` ancestors, `@`-imports, `.claude/rules/`, skill index, `settings.json` keys |
| `codex` | ancestor `AGENTS.md` only |
| `copilot` | `.github/copilot-instructions.md`, then ancestor `AGENTS.md` |
| `cursor` | ancestor `AGENTS.md`, then `.cursorrules` and `.cursor/rules/*.mdc` (`.mdc` `alwaysApply` / `globs` mapped onto always-on vs path-scoped; a rule with neither is loaded always-on with a note) |

No non-claude agent follows `@`-imports, reads `.claude/`, or reads
`settings.json`. See `MODEL.md`, "Other agents (best-effort)", for the exact
rules and their limits.

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
    "frontmatter": "error",
    "lint-duplication": "warn",
    "stale-boilerplate": "warn",
    "dead-reference": "error"
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

Three more finding types trim context that pays no rent:

- **lint-duplication** (`warn`) — a context file restates a rule a linter or
  formatter config in the repo already enforces (`.prettierrc`, `.eslintrc*`,
  `biome.json`, `pyproject.toml` `[tool.ruff]` / `[tool.black]`). "Use 2-space
  indent" next to a `.prettierrc` with `tabWidth: 2` is budget the tooling makes
  redundant. The matcher is narrow: known keys, conservative phrasings.
- **stale-boilerplate** (`warn`) — a stock sentence Claude Code's `/init` writes
  into a fresh `CLAUDE.md`, still there unmodified (the "This file provides
  guidance to Claude Code…" header and close variants).
- **dead-reference** — a pointer that does not resolve on disk: a missing
  `@`-import (`error`, since Claude Code drops it from the stack with no
  warning), or a prose path or `npm run <script>` name with nothing behind it
  (`warn`). `gate.dead-reference` is a ceiling like `gate.frontmatter`.

## CI

`.github/workflows/ci.yml` builds, runs the tests, then runs `conman check --map`
against this repo. Point the same step at your own repo and context growth fails
the build on the PR that introduced it, instead of being discovered months later.

### pre-commit

conman ships a [pre-commit](https://pre-commit.com) hook. Add two entries to your
`.pre-commit-config.yaml`:

```yaml
- repo: https://github.com/bronsonhill/conman
  rev: v0.1.0
  hooks:
    - id: conman
```

The hook runs `conman check --map` over the whole repo whenever a `CLAUDE.md`,
`AGENTS.md`, `.claude/` file, or `conman.json` is staged, and blocks the commit
when an entry point is over budget or trips a gated finding.

## Deliberately out of scope for the MVP

No LLM anywhere in the analysis path. No semantic contradiction detection beyond
byte-identical duplication and direct value conflicts. Non-Claude agent rulesets
(`--agent codex|cursor|copilot`) are best-effort and not version-anchored;
keeping instruction files in sync across tools is still another tool's job. No
runtime monitoring; `/context` already shows a live session's usage. The
analysis path is offline by default and stays that way; `--tokenizer exact` is
the one opt-in exception (see "How accurate is the token estimate?"). Vehicle-fit
advice stays coarse and structural until a later opt-in LLM layer.

## Tests

```
npm test
```

Unit tests sit next to the code (`src/*.test.ts`). Golden-output tests
(`test/run-golden.js`) run the built CLI against synthetic fixtures under
`test/fixtures/` and diff against `test/golden/`; `npm run test:update-golden`
regenerates them. `npm test` needs no network.

A pinned corpus of real public repos lives under `fixtures/` (see
`fixtures/README.md`) and is fetched on demand. The corpus regression sweep
(`test/corpus-sweep.js`) runs `conman map` over every fetched fixture, asserts it
resolves crash-free, and diffs a compact digest against `test/corpus-digest.json`
so the "What conman finds in the wild" numbers stay honest as findings evolve. It
is not in `npm test`:

```
npm run test:corpus         # fetch the 5-repo fast subset, sweep it (~20s)
npm run test:corpus:all     # fetch every fixture, sweep all 11 (~60s)
npm run test:corpus:update  # regenerate the digest baseline
```

The baseline is generated on Linux by CI. On a case-insensitive dev filesystem
(macOS) the `firstmate` and `ruflo` records will not match, because lowercase
`claude.md` / `agents.md` files in those fixtures get discovered as extra entry
points — expected, and why the numbers come from the CI `corpus-digest` artifact.
CI runs the fast subset on every PR and the full sweep weekly and whenever the
corpus tooling changes (see `.github/workflows/`).
