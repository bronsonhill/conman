# Curated suite: inclusion criteria

The curated suite (`docs/survey-suite.txt`) is a list of about 50 public repos
that stand for the typical serious Claude Code adopter. It replaces two sets
that had no written inclusion rule: the 11 pinned fixtures (hand-picked for
behaviour coverage; `posthog` alone is 81% of their tokens) and the hash-sampled
survey (which let near-empty stacks and skill-collection dumps in).

A repo is in the suite when it passes all four criteria. `scripts/survey.mjs
--qualify` applies 1 to 3 using the GitHub API only (no clones); the predicates
are in `scripts/survey-lib.mjs` and tested in `scripts/survey-lib.test.mjs`.
Thresholds live in `THRESHOLDS` there.

## 1. It is a project

Mostly source code under development. Rejected, in this order, with the reason
recorded in `docs/survey-suite-rejections.txt`:

| test | rejects when |
|------|--------------|
| repo metadata | `fork`, `archived`, or `is_template` is true |
| name / topic hint | repo name has a `awesome`, `template`, `starter`, `boilerplate`, `skeleton`, `cookiecutter` word, or ends in `skill(s)` / `prompt(s)`; or a topic is `awesome`, `awesome-list`, `template`, `starter`, `boilerplate`, `prompts`, `skills` and similar |
| source files | fewer than 10 source files |
| source share | source files are under 30% of counted files |
| agent-dir share | more than 40% of counted files sit under a `skills/`, `prompts/`, `agents/`, `commands/`, `.claude/`, `.cursor/` or `.agents/` directory |

Counted files come from the recursive git tree. Source is a fixed extension list
(`ts py go rs java rb c cpp cs swift sh ...`); markdown is `md mdx rst txt adoc`;
everything else is "other". Binary assets, lockfiles, minified bundles and
vendored directories (`node_modules`, `vendor`, `dist`, `build`) are left out of
the denominator. The qualify stage prints all three numbers per repo so a
verdict can be checked by hand.

## 2. Layered harness context

A root memory file that loads, at least about 500 tokens, plus one structural
feature.

- **Loads**: `CLAUDE.md` or `.claude/CLAUDE.md` at the repo root. A bare
  `AGENTS.md` does not count, because Claude Code does not read it (MODEL.md).
  A `CLAUDE.md` that is a symlink to `AGENTS.md` loads the target; depth-1
  `@`-imports that exist in the tree add to the total.
- **Floor**: 500 tokens with the local `claude-local` tokenizer, summed over the
  root file and its depth-1 imports. Only these blobs are fetched.
- **Structural feature** (any one):
  - a nested `CLAUDE.md` (any directory below the root);
  - `.claude/rules/**/*.md` at any depth;
  - `.claude/skills/<name>/SKILL.md` at any depth;
  - an `@`-import from the root memory file to another file in the repo (the
    `CLAUDE.md` to `@AGENTS.md` pointer is one file in two places, so it does not count);
  - a `.claude/settings.json` key that changes resolution: `claudeMdExcludes`,
    `claudeMd.excludes`, `skillListingBudget`, `skillsListingBudget`,
    `skills.listingBudget`.

There is no ceiling on stack size and no floor beyond 500 tokens. The suite
measures how large and how redundant real stacks are, so selecting on size would
pre-decide the answer. The threshold is on structure only.

## 3. Alive and adopted

`pushed_at` within the last 183 days, and at least 50 stars. `pushed_at` is
GitHub's repo-level last push, which can come from a non-default branch; it is
the cheapest signal that needs no extra call.

## 4. No single repo dominates

Not a filter: a reporting rule. Survey output states, next to the pooled
numbers, per-repo figures where each repo counts once: the median of per-repo
median entry-point stacks, the repo-level rates (any redundancy, any value
conflict, any over-budget entry point), the repo-weighted over-budget entry
point rate, and the largest repo's share of all entry points. Headline claims
use the per-repo figures.

## Borderline picks

A repo that passes every threshold but sits near one is kept and flagged with
`# borderline:` in the suite file: root memory under 750 tokens, under 75 stars,
last push over 150 days ago, source share under 40%, agent-dir share over 30%,
or an `@`-import or settings key as the only feature. The captain rules on these.

## Size

Target 50. If more than 50 qualify, the first 50 by stable
`sha256(seed + repo)` order are kept. If fewer qualify, the suite is shorter;
thresholds are not loosened to reach the target.
