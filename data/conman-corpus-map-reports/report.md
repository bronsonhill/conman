# What `conman map` finds across the pinned corpus

`conman 0.1.0`, resolution model `0.2`. Run with built-in defaults (no
`conman.json`): budget total 12,000 tokens, safety margin 0.10, so the gate line
is an effective 10,800 tokens per entry point.

Source: `conman map --json` over every repo in `fixtures/manifest.toml`, each at
its pinned SHA. The machine-readable roll-up is `test/corpus-digest.json` (the CI
regression baseline); regenerate it with `npm run test:corpus:update` and update
the numbers below in the same commit.

## Corpus

| repo | pinned SHA | entry points | resolved tokens | redundant tokens | over budget | value-conflict entry points | findings by type |
|------|-----------|-------------:|----------------:|-----------------:|------------:|----------------------------:|------------------|
| llm | `a463c6318f65a48ae185733a0655dca7bb00c3e1` | 1 | 0 | 0 | 0 | 0 | — |
| firstmate | `420721401c4080d1a4f6982b0ef6769e2a749b23` | 2 | 37,401 | 0 | 2 | 0 | vehicle-fit 11 |
| motrix | `78610342d63ce8446acf4505158aaebdc91a9c09` | 38 | 92,356 | 0 | 0 | 0 | — |
| ack-nestjs-boilerplate | `ab70ad273db04566f1c03d9f797fba9f1e100738` | 2 | 49,600 | 0 | 2 | 0 | dead-reference 2, frontmatter 4, vehicle-fit 33 |
| cockroach | `8812064a015d2faf99d3fc7e15880f94042954b0` | 9 | 28,442 | 0 | 0 | 0 | frontmatter 9, stale-boilerplate 9 |
| humanlayer | `99abe673498cf8bdcd5f989aebe9406a27185b3b` | 9 | 13,080 | 0 | 0 | 0 | stale-boilerplate 9 |
| posthog | `41570ae96afb3b0fd74d2873d68037553aaaec8d` | 52 | 1,352,459 | 0 | 52 | 0 | dead-reference 5, vehicle-fit 394 |
| ruflo | `d33ef4bf8ab27a8f9ef08352c9c293b53312a861` | 10 | 242,653 | 3,376 | 10 | 4 | dead-reference 34, duplication 60, stale-boilerplate 1, value-conflict 20, vehicle-fit 14 |
| lila | `9b49f37fe9d953c85dae12bbc159a0bf721a9fca` | 1 | 1,814 | 0 | 0 | 0 | — |
| inbox-zero | `780453c5d351a0b59b6ca2d7b60f6a58d213078b` | 2 | 5,566 | 0 | 0 | 0 | vehicle-fit 6 |
| vercel-ai | `1c6854096fbe9aa55ae59cfa2bdee03d55e95c8e` | 2 | 7,918 | 0 | 0 | 0 | — |

## The four headline numbers

Every entry point discovered by `conman map` counts as one observation. 11
repos, 128 entry points.

- **Redundant tokens: 3,376 of 1,831,289, or 0.18%.** Byte-identical blocks that
  load more than once in the same resolved stack. All 3,376 are in ruflo, split
  across 60 duplication findings; the other ten repos have zero. Byte-identical
  duplication is rare in the wild — it shows up where one overgrown stack copies
  the same block into several nested `CLAUDE.md` files, not as a broad tax.

- **Value-conflict rate: 4 of 128 entry points, or 3.13%.** An entry point where
  the resolved stack sets one key to two different values (20 findings across
  the 4). Every one is in ruflo's `v3/` subtree. No other repo in the corpus has
  a direct value conflict at any entry point.

- **Median resolved stack: 19,676 tokens.** The distribution is bimodal, not
  centred here: 61 entry points resolve to under 5,000 tokens, 66 to over
  12,000, and exactly one lands between. The large half is posthog (52 entry
  points), ruflo (10), firstmate (2), and ack-nestjs-boilerplate (2). The median
  sits in the gap because posthog contributes 41% of all observations.

- **Over the effective budget: 66 of 128 entry points, or 51.56%.** Measured
  against the 10,800-token default gate line. The 66 are the same
  posthog/ruflo/firstmate/ack set. Nothing in motrix, cockroach, humanlayer,
  llm, lila, inbox-zero, or vercel-ai crosses it.

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
- **humanlayer** — 9 entry points across a moderate monorepo — is clean: no
  duplication, no conflicts, no entry over budget.

## Skew and how the corpus is weighted

posthog and motrix together supply 90 of the 128 entry points. posthog alone
drives the entire over-budget count above its own repo size, and ruflo is the
sole source of every duplication and value-conflict finding. `inbox-zero` and
`vercel-ai` were pinned into the corpus as mid-size counterweights — real
adopters whose resolved stacks sit at ~5.6k and ~7.9k tokens with no findings —
but two small repos do not offset a 52-entry-point monorepo. Read the per-repo
table, not just the aggregate: the corpus shows that overgrowth is real and
concentrated, not that it is the median experience.

## Other findings

The four headline numbers cover redundancy, value conflicts, stack size, and
budget. The corpus raises 611 findings in total; the rest break down as:

- **`vehicle-fit`** (458) — `warn`-level structural advice (skill-shaped content
  in a memory file, and similar), no gate effect. The most common finding by far.
- **`duplication`** (60) and **`value-conflict`** (20) — all in `ruflo`; these
  feed the redundancy and conflict headline numbers.
- **`dead-reference`** (41) — a memory file points at a path that does not exist.
  `ruflo` 34, `posthog` 5, `ack-nestjs-boilerplate` 2.
- **`stale-boilerplate`** (19) — leftover `/init` scaffolding. `cockroach` 9,
  `humanlayer` 9, `ruflo` 1.
- **`frontmatter`** (13) — malformed rule/skill YAML. `cockroach` 9,
  `ack-nestjs-boilerplate` 4.
