# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project aims to
follow semantic versioning.

## Unreleased

### Added

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
