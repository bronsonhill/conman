# What `conman map` finds across the pinned corpus

`conman 0.1.0`, resolution model `0.2`. Run with built-in defaults (no
`conman.json`): budget total 12,000 tokens, safety margin 0.10, so the gate line
is an effective 10,800 tokens per entry point.

Source: `conman map --json` over every repo in `fixtures/manifest.toml`, each at
its pinned SHA. The machine-readable roll-up is `test/corpus-digest.json` (the CI
regression baseline). It is generated on Linux by the `full-sweep` job in
`.github/workflows/corpus.yml` — a case-insensitive dev machine (macOS)
over-discovers entry points from lowercase `claude.md` / `agents.md` files in a
few fixtures, so the numbers below come from that job, not a local run. Update
them from the job's `corpus-digest` artifact in the same commit that changes
findings logic.

## Corpus

| repo | pinned SHA | entry points | resolved tokens | redundant tokens | over budget | value-conflict entry points | findings by type |
|------|-----------|-------------:|----------------:|-----------------:|------------:|----------------------------:|------------------|
| llm | `a463c6318f65a48ae185733a0655dca7bb00c3e1` | 1 | 0 | 0 | 0 | 0 | — |
| firstmate | `420721401c4080d1a4f6982b0ef6769e2a749b23` | 1 | 18,299 | 0 | 1 | 0 | vehicle-fit 5 |
| motrix | `78610342d63ce8446acf4505158aaebdc91a9c09` | 38 | 92,356 | 0 | 0 | 0 | — |
| ack-nestjs-boilerplate | `ab70ad273db04566f1c03d9f797fba9f1e100738` | 2 | 49,600 | 0 | 2 | 0 | dead-reference 2, frontmatter 4, vehicle-fit 33 |
| cockroach | `8812064a015d2faf99d3fc7e15880f94042954b0` | 9 | 28,442 | 0 | 0 | 0 | frontmatter 9, stale-boilerplate 9 |
| humanlayer | `99abe673498cf8bdcd5f989aebe9406a27185b3b` | 9 | 13,080 | 0 | 0 | 0 | stale-boilerplate 9 |
| posthog | `41570ae96afb3b0fd74d2873d68037553aaaec8d` | 52 | 1,352,459 | 0 | 52 | 0 | dead-reference 5, vehicle-fit 394 |
| ruflo | `d33ef4bf8ab27a8f9ef08352c9c293b53312a861` | 6 | 143,051 | 1,688 | 6 | 2 | dead-reference 20, duplication 30, stale-boilerplate 1, value-conflict 10, vehicle-fit 8 |
| lila | `9b49f37fe9d953c85dae12bbc159a0bf721a9fca` | 1 | 1,814 | 0 | 0 | 0 | — |
| inbox-zero | `780453c5d351a0b59b6ca2d7b60f6a58d213078b` | 2 | 5,566 | 0 | 0 | 0 | vehicle-fit 6 |
| vercel-ai | `1c6854096fbe9aa55ae59cfa2bdee03d55e95c8e` | 2 | 7,918 | 0 | 0 | 0 | — |

## The four headline numbers

Every entry point discovered by `conman map` counts as one observation. 11
repos, 123 entry points.

- **Redundant tokens: 1,688 of 1,712,585, or 0.10%.** Byte-identical blocks that
  load more than once in the same resolved stack. All 1,688 are in ruflo, across
  30 duplication findings; the other ten repos have zero. Byte-identical
  duplication is rare in the wild — it shows up where one overgrown stack copies
  the same block into nested `CLAUDE.md` files, not as a broad tax.

- **Value-conflict rate: 2 of 123 entry points, or 1.63%.** An entry point where
  the resolved stack sets one key to two different values (10 findings across the
  2). Both are in ruflo's `v3/` subtree. No other repo in the corpus has a direct
  value conflict at any entry point.

- **Median resolved stack: 5,472 tokens.** Below the 10,800-token gate line, but
  the distribution is lopsided: posthog (52 entry points) and ruflo (6) resolve
  to 15k–40k tokens each and supply 58 of the 123 observations; almost everything
  else sits under 6k.

- **Over the effective budget: 61 of 123 entry points, or 49.59%.** Measured
  against the 10,800-token default gate line. The 61 are posthog (52), ruflo (6),
  ack-nestjs-boilerplate (2), and firstmate (1). Nothing in motrix, cockroach,
  humanlayer, llm, lila, inbox-zero, or vercel-ai crosses it.

## The boring results are the point

- **llm** resolves to a zero-file, zero-token stack. Its one `AGENTS.md` has no
  sibling `CLAUDE.md`, and at model 0.2 a bare `AGENTS.md` is discovered but not
  loaded. Nothing to report, and conman reports nothing.
- **lila** — ~16.7k files, 85 SBT modules, 42 UI packages — collapses to a
  single entry point at the root, 1,814 tokens, no findings. Scale in the tree
  does not mean scale in the context stack.
- **motrix** has 38 entry points (13 path-scoped `.claude/rules/` files pointing
  at real directories) and raises zero findings across all of them, every one
  under budget.
- **humanlayer** — 9 entry points across a moderate monorepo — has no
  duplication, no conflicts, and no entry over budget; its only findings are 9
  `stale-boilerplate` warnings.

## Skew and how the corpus is weighted

posthog and motrix together supply 90 of the 123 entry points. posthog alone
drives the entire over-budget count above its own repo size, and ruflo is the
sole source of every duplication and value-conflict finding. `inbox-zero` and
`vercel-ai` were pinned into the corpus as mid-size counterweights — real
adopters whose resolved stacks sit at ~5.6k and ~7.9k tokens with no findings —
but two small repos do not offset a 52-entry-point monorepo. Read the per-repo
table, not just the aggregate: the corpus shows that overgrowth is real and
concentrated, not that it is the median experience.

## Other findings

The four headline numbers cover redundancy, value conflicts, stack size, and
budget. The corpus raises 545 findings in total; the rest break down as:

- **`vehicle-fit`** (446) — `warn`-level structural advice (skill-shaped content
  in a memory file, and similar), no gate effect. The most common finding by far,
  and mostly posthog's 394.
- **`duplication`** (30) and **`value-conflict`** (10) — all in `ruflo`; these
  feed the redundancy and conflict headline numbers.
- **`dead-reference`** (27) — a memory file points at a path that does not exist.
  `ruflo` 20, `posthog` 5, `ack-nestjs-boilerplate` 2.
- **`stale-boilerplate`** (19) — leftover `/init` scaffolding. `cockroach` 9,
  `humanlayer` 9, `ruflo` 1.
- **`frontmatter`** (13) — malformed rule/skill YAML. `cockroach` 9,
  `ack-nestjs-boilerplate` 4.
