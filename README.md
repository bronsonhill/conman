<p align="center">Don't be conned.</p>
<h1 align="center">conman</h1>

<p align="center">
  <a href="https://www.npmjs.com/package/@bronsonhill/conman"
    ><img
      alt="npm"
      src="https://img.shields.io/npm/v/%40bronsonhill%2Fconman?style=flat-square"
  /></a>
  <a href="https://github.com/bronsonhill/conman/actions/workflows/ci.yml"
    ><img
      alt="CI"
      src="https://img.shields.io/github/actions/workflow/status/bronsonhill/conman/ci.yml?style=flat-square&label=ci"
  /></a>
  <a href="LICENSE"
    ><img
      alt="License"
      src="https://img.shields.io/badge/license-MIT-blue?style=flat-square"
  /></a>
  <a
    href="https://img.shields.io/badge/platform-macOS%20%7C%20Linux-blue?style=flat-square"
    ><img
      alt="Platform"
      src="https://img.shields.io/badge/platform-macOS%20%7C%20Linux-blue?style=flat-square"
  /></a>
</p>

Lint the context stack before a Claude Code session loads it.

`conman` is short for context manager. Claude Code assembles its startup context
fresh every session: it walks the directory tree for `CLAUDE.md` and `AGENTS.md`,
inlines their `@`-imports, pulls in `.claude/rules/`, and appends a one-line index
of every skill. Every block in that stack was added by someone trying to help the
agent, and read on its own each one looks reasonable. Read the whole stack and
the story changes — a root file says Node 20, a service file two directories down
says Node 22, both load and nothing reconciles them; a setup paragraph copied
into a child directory bills the session twice; the skill index creeps up a line
at a time.

That is the con. `conman` reads the stack before the session starts and calls it.
Point it at an entry point; it resolves the full chain a session would load and
reports what is in it, in what order, at what token cost, and where blocks repeat
verbatim or bind the same key to two different values. It runs offline, uses no
model in the analysis path, and emits the same bytes for the same input every
time. The job is to lint your context stack, not to grow it.

Scope and the reasoning behind it: [`VISION.md`](VISION.md). The resolution model
— load order, which `settings.json` keys matter, how findings are defined, where
the default numbers come from — is in [`MODEL.md`](MODEL.md).

- **Resolves the real stack** - ancestor `CLAUDE.md` / `AGENTS.md`, `@`-imports to
  the depth limit, `.claude/rules/` (always-on and path-scoped), the skill startup
  index, and the `settings.json` keys that change resolution — concatenated in
  load order, because nothing overrides anything.
- **Costs every block** - per-block and per-file token counts from a bundled
  offline tokenizer, totalled against a budget you set.
- **Names duplication and value conflicts** - byte-identical blocks that load
  twice, and a key bound to two different values across the stack, each with a
  `file:line` and a token cost.
- **Gates CI** - `conman check` exits non-zero when the stack is over budget or a
  gated finding fires; the pass/fail condition is legible from `conman.json`.
- **Maps a whole repo** - `conman map` runs the same analysis over every entry
  point it discovers, including directories a path-scoped rule points at that
  carry no memory file of their own.
- **Fixes only what is mechanical** - dedupe byte-identical parent/child blocks,
  sort skill frontmatter keys, normalize whitespace. It never rewrites prose and
  never resolves a value conflict for you.
- **Deterministic** - no `Date`, no `Math.random`, no network, no model in the
  analysis path. `--tokenizer exact` is the one opt-in exception.
- **Other agents, best-effort** - `--agent codex|cursor|copilot` resolves each
  vendor's documented file loading; not version-anchored, everything downstream
  runs unchanged.

## Quick Start

```sh
# resolve and lint the context stack for one entry point
npx @bronsonhill/conman path/to/dir
```

```sh
# map every entry point in the repo, with each one's budget status
npx @bronsonhill/conman map
```

```sh
# analyze, then exit non-zero over budget or on a gated finding
npx @bronsonhill/conman check --map
```

Point it at a directory, or at a `CLAUDE.md` / `AGENTS.md` for scoped checks. A
single-entry run prints the load order with per-block token counts, the total
against the budget, then the findings. No config file is required to start; every
`conman.json` key has a built-in default.

```
$ conman check services/api
...
FINDINGS  (2 error, 0 warn)
  error  duplication
         CLAUDE.md:7-8
         services/api/CLAUDE.md:7-8
         identical 27-token block "Run `npm ci` then `npm test`. Do not skip the lint step.…" appears in 2 files (27 redundant tokens, relation: parent-child)
  error  value-conflict
         CLAUDE.md:3-3
         services/api/CLAUDE.md:3-3
         key "node version" is set to different values across the stack: "20" vs "22"

RESULT  fail
```

Every finding names a `file:line`, a token cost, or both. Advice without one of
those attached does not ship.

## Install

**npx** — no install, always the published version:

```sh
npx @bronsonhill/conman <path>
```

**npm** — global CLI:

```sh
npm install -g @bronsonhill/conman
```

**From source**:

```sh
git clone https://github.com/bronsonhill/conman.git
cd conman
npm install
npm run build
npm link
```

`dist/cli.js` is the entry point.

## How It Works

None of that drift trips an alarm, because none of it looks wrong up close. The
agent just gets a little worse each month and it is hard to point at why. The
stack reads like help and bills you like help, session after session, while some
of it is duplicated blocks, contradictory values, and weight inherited from a
parent directory that never applied here.

For one entry point, `conman` builds the resolved stack in load order — order and
accumulation are the real behavior, and no file overrides another:

1. **Ancestor memory files** — `CLAUDE.md` from the entry directory up to the repo
   root (or the filesystem root with `--no-repo-boundary`), root-most first. A
   bare `AGENTS.md` is the cross-tool file; Claude Code does not load it on its
   own, so `conman` leaves it out of the stack and records a note.
2. **`@`-imports** — inlined right after the file that imports them, depth-first,
   up to `resolve.importDepthLimit` (default 5, Claude Code's documented hop
   limit). Cycles are broken.
3. **`.claude/rules/` entries** — every `*.md` under a `.claude/rules/` directory
   at or above the entry. `paths` frontmatter makes a rule path-scoped; a rule
   with no `paths` (or `paths: **`) is always-loaded. Always-loaded first, then
   matched path-scoped rules.
4. **The skill startup index** — one `- <name>: <description>` line per
   `SKILL.md`, sorted by name, optionally truncated by a skill-listing budget.

`MODEL.md` has the exact rules, the `settings.json` keys `conman` honours
(`claudeMdExcludes`, `skillListingBudget`), and the version anchor —
`src/anchor.test.ts` fails when resolved output drifts from the named Claude Code
release the model is pinned to.

### How accurate is the token estimate?

Default costing (`--tokenizer claude-local`) uses `@anthropic-ai/tokenizer`,
which runs offline and is what budgets and the CI gate are measured against.
`--tokenizer exact` swaps in Anthropic's `count_tokens` API (opt-in; needs
`ANTHROPIC_API_KEY`, the only thing in `conman` that makes a network call).
Running both over the pinned corpus (`fixtures/manifest.toml` — 9 public repos,
123 resolved stacks, 468 distinct blocks) gives the drift `(local - exact) /
exact`:

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

## What conman reports

Every finding carries a `file:line`, a token cost, or both, and a severity that
`conman.json` can remap. `error` fails `conman check`; `warn` is reported and
never fails the gate.

| finding | severity | what it catches |
|---|---|---|
| `duplication` | error | a segment whose trimmed bytes are identical in two or more files of the resolved stack; whole-file duplicates roll up into one finding with a `redundant tokens: N (M% of stack)` line |
| `value-conflict` | error | a definitional line (`` `Key`: value ``, `**Key:** value`) binding the same normalized key to two different short values in two files |
| `unlinked-copy` | warn | a directory with a `CLAUDE.md` and an `AGENTS.md` as two separate byte-identical files — not a token cost, but they drift |
| `vehicle-fit` | warn | coarse and structural only: a prose segment over 350 tokens in always-loaded memory or a rule, keyed off size and shape, never meaning |
| `frontmatter` | error (ceiling) | malformed / missing / wrong-type YAML on a `.claude/rules` entry or a `SKILL.md` — the files whose frontmatter changes what resolves |
| `lint-duplication` | warn | a context file restating a rule a repo-root linter/formatter config already enforces (`.prettierrc`, `.eslintrc*`, `biome.json`, `pyproject.toml` `[tool.ruff]` / `[tool.black]`) — "use 2-space indent" next to a `.prettierrc` with `tabWidth: 2`. Narrow: known keys, conservative phrasings, numbers must match |
| `stale-boilerplate` | warn | a stock `/init` sentence still unmodified in a memory file (the "This file provides guidance to Claude Code…" header and close variants) |
| `dead-reference` | error (ceiling) | a pointer that does not resolve on disk: a missing `@`-import (`error` — Claude Code drops it silently), or a backticked path or `npm run <script>` name with nothing behind it (`warn`) |
| `max-skills` | warn / error | the resolved skill index lists more than `maxSkills` entries (default 8); 9–15 `warn`, over 15 `error` |

`frontmatter`, `dead-reference`, and `max-skills` are ceilings, not single
severities: `"error"` lets both levels through, `"warn"` caps every sub-case at
warn, `"off"` disables the check. `MODEL.md` lists the sub-cases and their
per-case severity.

`conman explain <finding-id>` prints the one-paragraph explanation for a finding
type, the research behind that class of problem, and how to fix it. `conman
explain` with no argument lists the ids. The same reference text feeds the SARIF
rule descriptions.

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

On skill-index length specifically, no one has published a measurement for
Claude Code skill indexes, but the adjacent tool/function-selection work is
consistent: **[How Many Tools Should an LLM Agent
See?](https://arxiv.org/abs/2605.24660)** (Prakash et al., 2026) puts the knee
around 7 to 8 candidates, and Anthropic's **[advanced tool
use](https://www.anthropic.com/engineering/advanced-tool-use)** post recommends
retrieving rather than listing tools past ~10 and keeping only 3 to 5 always
loaded. conman's `maxSkills` check (default 8, hard cap 15) borrows those
numbers; see MODEL.md for the caveat and the version pin.

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

<!-- survey:begin -->

### Broader sample (small-sample validation run)

A wider, non-deterministic sweep lives in [`docs/survey-2026-08.md`](docs/survey-2026-08.md). The run below is a
**small-sample validation** of `scripts/survey.mjs` (9 repos mapped of
10 sampled), not the full survey — treat the pinned-corpus table above as the
load-bearing numbers until the ~100-repo run lands.

| measure | sample result |
|---------|---------------|
| redundant tokens (% of resolved stack, per repo) | **median 0%, mean 0.01%** |
| repos with a direct value conflict (error severity) | **1 of 9 — 11.1%** |
| median resolved stack | **17,803 tokens** |
| repos with an over-budget entry point | **5 of 9 — 55.6%** |

<!-- survey:end -->

## Configuration

`conman.json` at the repo root, searched upward from the entry point. Every key is
optional; an omitted key takes the built-in default. There is no published hard
token limit for a context stack — Anthropic's guidance is qualitative — so the
defaults below are conservative starting points meant to make a bloated stack
visible, **not a standard**. Override them per repo. `MODEL.md` records where each
number comes from, including the `maxSkills` default of 8, which is transferred
from tool-selection research and not measured on Claude Code skill indexes.

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

## Commands and flags

```
conman <entrypoint>          analyze one entry point (a directory, or a file for scoped checks)
conman map [root]            analyze every entry point discovered in the repo
conman check [<entrypoint>]  analyze, then exit non-zero over budget or on a gated finding
conman explain [<id>]        describe a finding type: explanation, research, remediation
```

Flags: `--json`, `--format <human|json|sarif>`, `--config <path>`, `--budget <n>`,
`--tokenizer <name>`, `--agent <claude|codex|cursor|copilot>`,
`--no-repo-boundary`, `--repo-root <path>`, `--fix`, `--dry-run`, `--trim`,
`--map` (with `check`), `--html <path>` (with `map` or `check --map`), and
`--user` (with `--user-config-dir <path>`).

### `conman map`

Runs the same analysis across every entry point in the repo and rolls the results
into one table, so adopting `conman` into an existing monorepo is a single pass
rather than a directory-by-directory hunt.

An entry point is any directory that holds a `CLAUDE.md` or `AGENTS.md` (the repo
root always counts), plus any directory a `.claude/rules/` file path-scopes to
through its `paths` glob — the directory `src/renderer/**` points at, even when it
carries no memory file of its own. Repos that scope every rule with `paths` have
directories that load a distinct context stack and were never obvious as entry
points; `map` finds them and lists them under the table. Keyless and `**`-scoped
rules add nothing, and only directories that exist on disk are picked up.
`MODEL.md` has the glob-to-directory rule.

### HTML report

`conman map --html <path>` writes the map results to one self-contained HTML file
instead of printing them: the discovered entry points, each entry's load order and
per-block token cost, the per-file subtotals, block duplication, and value
conflicts. The file inlines its own CSS and pulls in no scripts, fonts, or network
resources, so it opens straight from disk. Output is byte-identical for the same
repo state — no timestamps, no absolute paths — so it commits and diffs like any
other checked-in artifact.

```sh
conman map --html report.html
```

`conman check --map --html <path>` writes a gate-focused variant of the same
page: it leads with the pass/fail verdict, the effective budget the gate
applied, and every failing entry point with its reasons (over budget,
duplication error, value-conflict error), then the same per-entry detail. The
process exit code still follows the gate (0 pass, 1 fail). Plain `map --html`
stays the inventory view with no verdict framing.

### SARIF output

`conman <entrypoint> --format sarif` emits the findings as a SARIF 2.1.0
document. Upload it with `github/codeql-action/upload-sarif` and the findings
land in the repository's Security → Code scanning tab, one alert per finding,
annotated on the context file and line it originates from. Each finding type is
registered as a SARIF rule with a short description; `error` findings map to
SARIF `error`, `warn` to `warning`. The document carries no timestamps and only
repo-relative URIs, so it is deterministic for a given tree. Only single-entry
runs support it; `map` does not.

```sh
conman check src/renderer --format sarif > conman.sarif
```

### `--fix`

`--fix` applies mechanical, meaning-free changes only: it deletes a block a child
file repeats byte-for-byte from a parent, sorts skill frontmatter keys, and
normalizes whitespace. It never rewrites prose and never touches a value conflict —
resolving one of those is a judgment call, and that call is yours. `--fix
--dry-run` prints the diff and writes nothing. The operation is idempotent.

`conman map --fix` runs the same mechanical fixes across every entry point `map`
discovers, so a repo with dozens of entry points is fixed in one pass rather than
one directory at a time. Running `--fix` on a leaf entry point can rewrite context
files above it — a leaf inherits and overrides its ancestors — so `conman` prints a
warning naming those out-of-path files before it writes.

### `--trim`

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

`conman` writes nothing. Pipe the diff to `git apply` yourself if you agree with
it. The output is a pure function of the tree — deterministic between runs, and
empty once the redundant copies are gone. `--trim` only removes provably
redundant whole files; trimming non-redundant content down to a budget is not
built.

### `--user`

`--user` (alias `--include-user-config`) also resolves this machine's user-level
Claude config: `~/.claude/CLAUDE.md` as the root-most memory block and
`~/.claude/settings.json` merged below the repo settings, so a run at your desk
matches how your own Claude Code harness assembles context. It honours
`$CLAUDE_CONFIG_DIR`, applies to `--agent claude` only, and is off by default —
when on, the report reads machine-local files and will not reproduce on another
machine, so `conman` marks it `machine-specific` and it does not belong in CI. See
MODEL.md, "User-level config".

### Other agents (best-effort)

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

## Continuous integration

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

## Development

```sh
npm test
```

Unit tests sit next to the code (`src/*.test.ts`). Golden-output tests
(`test/run-golden-*.js`) run the built CLI against synthetic fixtures under
`test/fixtures/` and diff against `test/golden/`; `npm run test:update-golden`
regenerates them. `npm test` needs no network.

A pinned corpus of real public repos lives under `fixtures/` (see
`fixtures/README.md`) and is fetched on demand. The corpus regression sweep
(`test/corpus-sweep.js`) runs `conman map` over every fetched fixture, asserts it
resolves crash-free, and diffs a compact digest against `test/corpus-digest.json`
so the "What conman finds in the wild" numbers stay honest as findings evolve. It
is not in `npm test`:

```sh
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

Contributor-facing workflow — the determinism contract, goldens, the `--fix`
rule, adding a fixture — is in [`CONTRIBUTING.md`](CONTRIBUTING.md).
