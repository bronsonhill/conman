> Pre-build checkpoint. See VISION.md / MODEL.md for current behaviour.

# conman MVP — stack + architecture proposal

Checkpoint before building. Awaiting captain sign-off.

## Language: TypeScript on Node

Node wins on one decisive point: the only usable **local** Claude tokenizer ships
as an npm package. `@anthropic-ai/tokenizer` bundles Anthropic's released Claude
BPE (`tokenizer.json`, byte-level, MIT) and runs with no network. Python's
`anthropic` SDK dropped local counting; `count_tokens` is now an API call. Go and
Rust have no Claude vocab at all — only GPT proxies via ported tiktoken.

Secondary reasons:

- **Distribution.** `npx conman` for the desk; a pinned JS GitHub Action or a
  three-line `setup-node` + `npx` step for CI. Node is already on every hosted
  runner.
- **Static parsing.** Mature, dependency-light libs for the three formats we
  touch: markdown paragraphs/headings (hand-split), YAML frontmatter (`yaml`,
  pure, no transitive deps), and `settings.json` (`JSON.parse`, with `json5` as a
  tolerant fallback).
- Node 24 and npm 11 are already on this machine.

Cost: CI needs a Node runtime (ubiquitous, not a real cost) and we don't get a
single static binary. Acceptable for a linter that runs via `npx` or an Action.

Build: plain `tsc` to `dist/`, `bin` entry `conman` → `node dist/cli.js`. Test
runner: built-in `node --test` (zero deps). Runtime deps kept to `@anthropic-ai/tokenizer`,
`yaml`, `json5`.

## Tokenizer approach

- **Default (`claude-local`).** `@anthropic-ai/tokenizer`. Fully offline,
  deterministic.
- **"Close enough to Claude's counting."** It is Anthropic's released tokenizer,
  not the current frontier-model vocab (which Anthropic has not published). On
  English prose and markdown it lands within roughly ±5–10% of the API's
  `count_tokens`. For budgeting that is fine: budgets are set against conman's own
  counter, the report header names the tokenizer and its version, and a
  configurable `safetyMargin` adds headroom to the budget delta. Determinism is
  the property we actually need — same stack, same number, every run.
- **Seam for exact mode (not built).** A `Tokenizer` interface with one method,
  `countTokens(text: string): number`. Default impl `LocalClaudeTokenizer`. A
  `RemoteTokenizer` stub exists and throws `not implemented in MVP`. `--exact` is
  parsed and rejected with that message. No HTTP code lands in the tree.

## Module breakdown

| Module | Responsibility |
|---|---|
| `resolver/` | Entry point → ordered list of **blocks**. Walks ancestor `CLAUDE.md`/`AGENTS.md` from entry dir upward; inlines `@`-imports depth-first to the depth limit (default 5), with cycle guard; collects `.claude/rules/` always-loaded and path-scoped (frontmatter glob matched against the entry path); builds the skill startup index from `.claude/skills/*/SKILL.md` name+description; applies `settings.json` keys that change resolution (`claudeMdExcludes`, skill-listing budget). Each block: `{sourceFile, lineSpan, rawText, kind, phase}`. Ordering assumptions written down in `MODEL.md`. |
| `coster/` | Wraps the tokenizer. `costBlock(block) → tokens`, stack total, budget delta with safety margin. |
| `findings/` | **Duplication:** split memory files into segments on heading and blank-line boundaries, hash each, flag a segment whose byte-identical hash appears in both an ancestor and a descendant file. Emits both `file:line`s + the segment's token cost. **Value conflict:** (a) same dotted key in frontmatter/`settings.json` set to two different scalars at two resolved locations; (b) a strict markdown pattern — `` `KEY`: v ``, `KEY = v`, `**KEY**: v` — where one KEY token gets two different values. Deliberately conservative to avoid false positives. Every finding carries `file:line`, token cost, or both. |
| `report/` | Human-readable (default) and `--json`. Human: header, load-order table (block, `file:line`, kind, tokens), total + budget delta, findings by severity. JSON: stable sorted-key schema for CI and tooling. |
| `gate/` | Reads config, compares total vs budget, checks gated finding categories, sets exit code. 0 pass, 1 over budget / gated finding, 2 usage error. |
| `map/` | Discovers entry points (any dir with a `CLAUDE.md` or `AGENTS.md`, plus repo root), runs the single-entry analysis for each, aggregates: per-entry totals + a repo rollup. `--json` emits an array. |
| `fix/` | Mechanical, semantics-free only. Dedupe byte-identical parent/child segments by deleting the segment from the **child** and repairing surrounding blank lines; sort skill frontmatter keys alphabetically; normalize whitespace (strip trailing, collapse 3+ blank lines to 1, single trailing newline). Never touches prose characters. Idempotent. `--fix` writes in place; `--fix --dry-run` prints a unified diff. |
| `cli/` | Arg parsing, command dispatch, exit codes. |

Vehicle-fit advice: coarse and structural only — keyed off segment token size and
shape (is it a fenced block, a list, a heading section). Emits `warn`-level notes
like "480-token prose section in always-loaded memory; candidate for a skill or a
path-scoped rule." Marked in output as deliberately unsharpened pending the
opt-in LLM layer.

## CLI surface

```
conman <entrypoint>          analyze one entry point (a directory, or a file for scoped-down checks)
  --json                     machine-readable output
  --config <path>            config file (default: search upward for conman.json)
  --budget <n>               override total-token budget
  --tokenizer <name>         default and only MVP value: claude-local
  --no-repo-boundary         walk ancestors above repo root to filesystem root
  --fix                      apply mechanical fixes
  --dry-run                  with --fix: print unified diff, write nothing

conman map [root]            discover + analyze every entry point in the repo
  --json  --config  --budget

conman check [<entrypoint>]  analyze + gate; non-zero exit over budget or on gated findings
  --map                      gate across all discovered entry points
  --json  --config

conman --version | --help
```

A file argument that is itself a `CLAUDE.md`/`AGENTS.md` walks from its directory;
any other file runs the scoped single-file convenience checks with no ancestor
walk.

## Config file: `conman.json` at repo root

JSON, not TOML — no extra parser, same idiom as `.claude/settings.json`. Absent →
built-in defaults. Searched upward from the entry point.

```jsonc
{
  "budget": {
    "total": 12000,        // whole resolved stack, tokens
    "perFile": 4000,       // optional soft cap per memory file
    "skillIndex": 2000     // skill startup listing
  },
  "safetyMargin": 0.1,     // report budget delta with 10% headroom
  "gate": {
    "overBudget": "error", // error | warn | off
    "duplication": "error",
    "valueConflict": "error",
    "vehicleFit": "warn"
  },
  "resolve": {
    "repoBoundary": true,
    "importDepthLimit": 5,
    "skillListingBudget": null  // falls back to settings.json if set there
  },
  "ignore": ["**/node_modules/**"]
}
```

Defaults are conservative starting points, not law: no official hard token number
exists, and Anthropic's public guidance is qualitative ("keep `CLAUDE.md`
concise"). `MODEL.md` records the provenance of each default and every resolution
ordering assumption. Projects override per repo.

## Explicitly deferred

LLM layer; semantic contradiction detection beyond byte-identical duplication and
direct value conflict; non-Claude tools (`.cursor/rules`, Copilot instruction
files); runtime context monitoring; exact-mode token API (interface seam only, no
network code). Vehicle-fit stays size/shape heuristics until a later opt-in LLM
layer.

## Test strategy

- **Unit**, colocated (`src/**/*.test.ts`), run with `node --test`. No test-runner dep.
- **Golden-output.** `test/fixtures/<case>/` synthetic mini-repos; `test/golden/<case>.{txt,json}`
  expected reports. A runner diffs live output against golden; `UPDATE_GOLDEN=1`
  regenerates. Cases: single memory file; ancestor chain; `@`-imports including
  depth-limit cutoff and cycle; always-loaded + path-scoped rules; skill index
  with skill-listing-budget truncation; `claudeMdExcludes`; byte-identical
  parent/child duplication; frontmatter value conflict; markdown `KEY: value`
  conflict; over/under budget; `conman map` with two-plus entry points; `--fix`
  before/after pairs.
- **Determinism.** Run twice, assert identical bytes.
- No dependency on the `conman-fixtures` real-repo corpus (separate task).
- **conman on conman.** Ship `conman.json` in this repo and a CI step running
  `conman check --map` against conman's own context files, alongside `node --test`.

## CI

GitHub Actions: `setup-node` → `npm ci` → `npm run build` → `npm test` →
`node dist/cli.js check --map`. Job fails on any non-zero exit.
