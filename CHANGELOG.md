# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project aims to
follow semantic versioning.

## Unreleased

### Added

- `dead-reference` now checks markdown link targets. A link like
  `[architecture](docs/architecture.md)` in a depth-0 memory file or rule whose
  target is missing raises a `dead-link` sub-finding at **warn**, under the same
  conservative guards as `dead-path` (extension required, no globs, no `..`,
  parent directory exists and holds a real file). URLs and pure `#anchor` links
  are skipped. Backticked-path handling is unchanged. `MODEL_VERSION` → 0.8.

- `--agent <claude|codex|cursor|copilot>` selects the resolution ruleset. The
  default `claude` behaviour is unchanged. `codex` and `copilot` resolve an
  `AGENTS.md`-only stack (`copilot` also reads `.github/copilot-instructions.md`);
  `cursor` resolves `.cursorrules` and `.cursor/rules/*.mdc` alongside `AGENTS.md`,
  mapping `.mdc` `alwaysApply` / `globs` onto always-on vs path-scoped. Non-claude
  rulesets are best-effort and not version-anchored; see `MODEL.md`.
- `--tokenizer exact` is now implemented: an opt-in path that counts tokens via
  Anthropic's `count_tokens` API. It is the only code path that makes a network
  call, gated on the flag plus `ANTHROPIC_API_KEY` (missing key is a usage error
  naming the env var). The default `claude-local` path stays fully offline and
  deterministic; `exact` is never used by a golden or CI job.
- README "How accurate is the token estimate?" — a measured drift table
  (`local` vs `count_tokens`) over the pinned corpus, plus
  `scripts/measure-tokenizer.mjs` to regenerate it.
- `--user` now also folds in `~/.claude/skills/` and `~/.claude/rules/`, not just
  `~/.claude/CLAUDE.md` and `~/.claude/settings.json`. User skills merge
  name-sorted into the same startup index as the repo's and count toward
  `maxSkills` / `max-skills` and `budget.skillIndex` / `skill-index-budget`; user
  rules join the repo's `.claude/rules/` root-most. Entries found under the user
  dir carry stable `~/.claude/skills` / `~/.claude/rules/<file>` labels so the
  report shape stays reproducible. See `MODEL.md`, "User-level config".

### Changed

- README restructured to follow the conventions of widely-used CLI tool READMEs
  (ripgrep, uv, ruff, bat, fd): one-line pitch and badges above the fold, a
  scannable feature list, then Quick Start / Install / How It Works / findings /
  research / configuration / commands / CI. No factual claim changed; the
  empirical-honesty content (Probe-and-Refine, "conservative starting points,
  not a standard", no model in the analysis path) is intact and near the top.
- `budget.total` default is now backed by measurement, not assertion. It stays
  at 12,000: the resolved-stack size distribution across the pinned corpus (123
  entry points) and the 2026-08 survey sample is bimodal, with healthy repos
  under ~7k tokens per entry point, overgrown stacks at 18k and up, and nothing
  between — so any ceiling in 8k–18k splits the samples the same way and 12,000
  is the round midpoint. MODEL.md's `budget.total` row and a new "Where
  `budget.total` = 12,000 comes from" section carry the provenance.
  `modelVersion` `0.6` -> `0.7` re-pins the default for review the way the 0.4
  caps are pinned; no resolution or gate behaviour changes, goldens re-pinned
  for the version string only.

### Fixed

- `paths` glob brace lists are now expanded. A rule scoped with
  `src/**/*.{ts,tsx}` or `src/{main,renderer}/**` matched literally, so it never
  applied and dropped silently from the resolved stack — a false negative in
  conman's core job. The matcher now expands `{a,b}` the way Claude Code (via
  minimatch) does: one group to its alternatives, several groups to the
  cartesian product, nested groups recursively. `conman map`'s
  glob-to-directory discovery expands the same way, so `src/{main,renderer}/**`
  yields two entry-point directories, not one literal `src`. `modelVersion`
  `0.5` -> `0.6`; goldens re-pinned.
- `value-conflict` no longer fires on a definitional line (`` `Key`: value ``,
  `**Key:** value`, `- Key: value`) that sits inside an inline code span or a
  fenced block. A `CLAUDE.md` that shows a changelog trailer or a config snippet
  verbatim was being scored a cross-file conflict on example text nothing loads
  as a rule. Ordinary `` `Key`: value `` prose still counts. `modelVersion`
  `0.4` -> `0.5`; goldens re-pinned.
- `scripts/survey.mjs` and `docs/survey-2026-08.md` no longer tell the reader to
  `git checkout fm/conman-survey-100` — that branch is gone and the script is on
  `main`; the reproduction steps are now `git pull` / build / run.

## 0.1.0 — 2026-08-30

First published release.

conman is a deterministic, offline CLI that resolves a repository's Claude Code
context stack for an entry point and reports what a session would load: file
load order, per-block token cost, block duplication, and direct value conflicts.
It runs no model and makes no network calls in the analysis path, and it emits
the same bytes for the same input every time.

### Commands

- `conman <entry>` — resolve and lint the stack for an entry point.
- `conman map` — map every entry point in the repo, with per-entry token totals
  and budget status; `--html` renders it as a standalone page.
- `conman check` — budget-gated CI check; `--map` runs it across every entry
  point. Exits non-zero when a gate fails.
- `conman <entry> --fix` — mechanical dedupe of byte-identical parent/child
  blocks, skill frontmatter key sorting, whitespace normalization. Never touches
  prose or meaning; idempotent.
- `conman <entry> --trim` — delete-only Tier-1 trim advice over the whole-file
  duplication findings.
- `conman diff` — compare resolved stacks.

### Finding types

- **duplication** — blocks that repeat verbatim across the resolved stack, with
  the token cost of each redundant copy.
- **value-conflict** — the same `settings.json` key set to two different values
  by different files in the chain.
- **vehicle-fit** — content carried by the wrong vehicle (skill-shaped text in a
  context file, and similar).
- **frontmatter** — malformed rule or skill YAML frontmatter.
- **unlinked-copy** — a near-duplicate block that is not a byte-identical child
  of its parent.

### Configuration

- `conman.json` at the repo root sets the token budget and per-check gate
  severities. Default budget provenance is documented in `MODEL.md`.
