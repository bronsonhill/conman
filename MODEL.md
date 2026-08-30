# The conman resolution model

conman reports on a *model* of how Claude Code assembles startup context. The
model is versioned (`modelVersion` in every report; `0.2` today) and is the thing
under test. It is not a claim of bug-for-bug parity with any Claude Code release.
When Claude Code changes how it loads context, the model version bumps and the
golden fixtures move with it.

This file records what the model assumes and where the default numbers come from.
If you are debugging a surprising report, start here.

## What resolves, and in what order

For one entry point (a directory, or a file), the resolved stack is built in this
order. Order matters because nothing overrides anything: the session accumulates
every block.

1. **Ancestor memory files.** Walk from the entry directory upward. At each
   directory, load `CLAUDE.md` if present. Root-most directory first,
   entry-closest last. With `resolve.repoBoundary: true` (default) the walk stops
   at the repo root (nearest `.git`); `--no-repo-boundary` continues to the
   filesystem root.
   - `~/.claude/CLAUDE.md` and other home-directory context are out of scope:
     conman analyzes a repository, not a machine.
   - **`AGENTS.md` is not loaded on its own.** Claude Code reads `CLAUDE.md`;
     `AGENTS.md` is the cross-tool file that Codex, Cursor and Aider read. A bare
     `AGENTS.md` costs a Claude Code session nothing, so conman leaves it out of
     the stack and records a NOTE. An `AGENTS.md` enters the stack only when:
     - `CLAUDE.md` `@`-imports it — then it is counted once, as an import block
       (see step 2), or
     - `CLAUDE.md` is a symlink to it (or it to `CLAUDE.md`) — one file on disk,
       counted once under the `CLAUDE.md` path.
   - Two *separate* byte-identical files — a hand-maintained `CLAUDE.md` and
     `AGENTS.md` that are not linked — are the normal multi-tool setup, not a
     double charge. conman loads the `CLAUDE.md`, ignores the `AGENTS.md` for
     cost, and raises the `unlinked-copy` finding (below) for the drift risk.

2. **`@`-imports**, inlined immediately after the file that imports them,
   depth-first, in the order the `@` references appear.
   - An `@`-reference is a token starting with `@` that is not inside a fenced
     code block and not inside inline backticks.
   - Paths resolve relative to the importing file's directory. `@~/...` (home
     directory) is skipped as out-of-repo.
   - Depth limit is `resolve.importDepthLimit`, default **5**, matching Claude
     Code's documented 5-hop import limit. The file at the limit still loads; its
     own imports do not.
   - Import cycles are broken: a file already on the current import stack is not
     re-imported. Both cases produce a NOTE in the report.
   - A file already pulled in as an `@`-import is not *also* loaded as a sibling
     memory file. This is the common `CLAUDE.md` → `@AGENTS.md` pointer: the
     import wins, `AGENTS.md` is not counted twice.

3. **`.claude/rules/` entries.** Every `*.md` under a `.claude/rules/` directory
   at or above the entry directory (within the repo).
   - Frontmatter `paths` (a string or list of globs) makes a rule
     **path-scoped**: it loads only when one of its globs matches the entry
     path. A rule with no `paths` — or a `paths` of just `**` — is
     **always-loaded**. `paths` is the only scoping key Claude Code reads:
     confirmed by the [memory docs][cc-rules] ("Rules can be scoped to specific
     files using YAML frontmatter with the `paths` field [...] Rules without a
     `paths` field are loaded unconditionally") and by Claude Code's own rule
     parser (v2.1.251), which reads `frontmatter.paths` and nothing else.
     `globs` and `alwaysApply` are Cursor `.mdc` keys; a rule that carries
     `globs` but no `paths` loads always-on, with a NOTE.
   - Always-loaded rules load first (path-sorted), then path-scoped rules that
     matched (path-sorted). Rules load after all memory files.
   - `@`-imports inside rule files are not followed in `0.1`.
   - conman's glob matcher (`src/repo.ts`) does not do brace expansion, so a
     `paths` pattern like `src/**/*.{ts,tsx}` matches literally rather than as
     the two patterns Claude Code expands it to.

[cc-rules]: https://code.claude.com/docs/en/memory#path-specific-rules

4. **The skill startup index.** One line per skill found under a `.claude/skills/`
   directory at or above the entry: `- <name>: <description>`, taken from each
   `SKILL.md` frontmatter, sorted by skill name.
   - A skill-listing budget (tokens) truncates the list from the end and adds a
     `- (N more skills not listed...)` marker. The budget is
     `resolve.skillListingBudget` if set, else the `skillListingBudget` key from
     `.claude/settings.json`, else no limit.

## Entry-point discovery (`conman map`)

`conman map` resolves and gates every entry point it can find in the repo. A
directory is an entry point when either:

- it holds a `CLAUDE.md` or an `AGENTS.md` (the repo root always counts), or
- a `.claude/rules/` file path-scopes to it through `paths` — the directory a
  glob such as `src/renderer/**` points at, even when that directory carries no
  memory file of its own. This is the shape `conman map` on Motrix used to
  miss: every one of Motrix's rules scopes with `paths`, so `src/main` and
  `src/renderer` were entry points that discovery never reported.

**Glob to directory.** Take the longest leading run of path segments that carry
no glob metacharacter — `*`, `?`, `[`, `]`, `{`, `}`, `,`. `src/renderer/**`
gives `src/renderer`; `src/**` gives `src`; `app/api/**` gives `app/api`; a
wildcard anywhere in the path (`src/*/main`) cuts the run at that segment. If
the run names a file rather than a directory (`docs/CONTRIBUTING.md`), trailing
segments are dropped until an existing directory is left. A glob whose leading
run is empty — a bare `**`, or any pattern that starts with a wildcard — or that
reduces to the repo root is skipped, so a keyless or `**`-scoped rule adds no
entry point. Only directories that exist on disk are added; conman never invents
a path. Brace lists are not expanded (`src/{main,renderer}/**` stops at the `{`
and yields `src`), matching the resolver's own literal treatment of `paths`
globs.

Note the interaction with rule matching: a `paths` of `src/**` scopes everything
*under* `src`, not `src` itself, so the rule that made `src` an entry point does
not necessarily load into `src`'s own resolved stack. Discovery still surfaces
the directory so it is analyzed and gated.

The `map` JSON report tags each entry point with a `discovery` array — some of
`root`, `memory-file`, `rule-path` — recording why it was picked up. The human
report lists, under the table, any entry point found only through a path-scoped
rule.

## `settings.json` keys that change resolution

conman reads `.claude/settings.json` and `.claude/settings.local.json` at the
repo root and merges them (local wins). It acts on:

- **`claudeMdExcludes`** — a list of globs. Any memory or imported file whose
  repo-relative path matches is dropped from the stack, with a NOTE. Also
  accepted: `claudeMd.excludes`.
- **`skillListingBudget`** — token budget for the skill startup index (see above).
  Also accepted: `skillsListingBudget`, `skills.listingBudget`.

These key names are conman's current interpretation. They will track Claude Code
as it formalizes the settings surface; a change here is a model-version change.

## Findings

- **Duplication** — a segment (a heading-delimited or blank-line-delimited run of
  text, or a whole fenced code block) whose trimmed bytes are identical in two or
  more files of the *resolved stack*, whatever the relationship between those
  files. Segments under 8 tokens and heading-only segments are ignored. Each
  finding carries every `file:line` and the redundant token count, and records
  the file relationship in `detail.relation`:
  - `parent-child` — one file's directory is an ancestor of the other's
  - `import` — one file `@`-imports the other, directly or through a chain
  - `same-stack` — neither; two files of the stack that merely share text (two
    rules, a rule and a memory file, a memory file and a `@`-import sibling)

  Only content that a Claude Code session actually loads is in scope: a bare
  `AGENTS.md` is not part of the stack (see step 1), so a `CLAUDE.md` and an
  unlinked `AGENTS.md` twin never produce a duplication finding — the
  `unlinked-copy` finding covers that case instead.

  When every qualifying segment of one file also appears in another (a whole-file
  duplicate), the pair — or the whole cluster of mutually-duplicated files — is
  reported as one finding with `detail.wholeFileDuplicate: true`, not one finding
  per shared segment. The report leads with a `redundant tokens: N (M% of stack)`
  line summing what removing the duplicate copies would recover.

  `--fix` still only dedupes `parent-child`, per-segment findings: removing a
  `same-stack` or whole-file duplicate safely means deleting a file or writing a
  pointer, which is a change of substance conman does not make. When a
  `parent-child` block is shared by files with no ancestor relationship (a
  `CLAUDE.md`/`AGENTS.md` pair in one directory), the keeper is deterministic:
  `CLAUDE.md` wins over `AGENTS.md`, then lexical order. See `preferredKeeper` in
  `src/fix.ts`.
- **Unlinked copy** — a directory holds a `CLAUDE.md` and an `AGENTS.md` as two
  separate byte-identical files: not a symlink, not an `@`-import. Claude Code
  loads only the `CLAUDE.md`, so this is not a token cost, but the two
  hand-maintained copies drift. One finding per pair, at **warn** (a
  maintainability smell, not a gate failure). The message carries the remedy:
  link them with a symlink, or make `CLAUDE.md` a one-line `@AGENTS.md` import.
- **Value conflict** — a definitional markdown line (`` `Key`: value ``,
  `**Key:** value`, or `- Key: value` with an uppercase key) where the same
  normalized key is bound to two different short values in two different files of
  the stack. Deliberately strict: a missed conflict is cheaper than a false one.
  Structured keys (frontmatter, settings.json) are not cross-compared because
  each file's values are legitimately its own.
- **Vehicle fit** — coarse and structural only. A non-code prose segment over
  350 tokens in always-loaded memory or a rule, or an always-loaded rule over
  800 tokens. Keyed off size and shape, never meaning. Left unsharpened until a
  later opt-in LLM layer.
- **Frontmatter** — the YAML frontmatter on a file the resolver reads keys from
  is malformed, missing a required key, or the wrong type. Scope is exactly the
  files whose frontmatter changes what resolves: a `.claude/rules` entry (its
  `paths` scope key) and a skill `SKILL.md` (`name` / `description`). `CLAUDE.md`
  / `AGENTS.md` are out of scope — the resolver reads no keys from their
  frontmatter, only `@`-imports from the body. Sub-cases and severity:
  - **error** — a path-scoped rule whose scope cannot be read, so Claude Code
    silently loads it always-on (unscoped) or never matches it: `paths` is
    neither a string nor a list of strings (`scope-wrong-type`); the frontmatter
    YAML throws a parse error and the raw text carries a `paths:` / `globs:` key
    (`unparseable-yaml`); or the opening `---` has no closing `---` and the raw
    text carries a scope key (`unterminated-fence`).
  - **warn** — softer cases that still resolve: `paths` given as a bare string
    rather than a list (`scope-scalar-string`); a rule that scopes on `globs`
    with no `paths`, which Claude Code ignores (`scope-key-absent`); a skill
    missing a usable `name` (`skill-missing-name`) or `description`
    (`skill-missing-description`); a skill with no frontmatter at all
    (`missing-frontmatter`); and unparseable YAML or an unterminated fence on a
    file with no scoping stakes.

  `config.gate.frontmatter` is a **ceiling**, not a single severity: `"error"`
  (the default) lets both levels through, `"warn"` caps every sub-case at warn,
  `"off"` disables the check. The rule / skill files are carried out of
  resolution as `ResolveResult.frontmatterSubjects`; the check re-parses their
  raw text so it also covers a path-scoped rule that did not match the entry.
  `--fix` does not touch frontmatter validity — a malformed scope key is a
  change of meaning to repair.

## Default budget numbers, and why

There is no published hard token limit for a `CLAUDE.md` or a context stack.
Anthropic's guidance is qualitative: keep it concise, keep it relevant. The
defaults below are conservative starting points meant to make a bloated stack
visible, not a standard. Override them per repo in `conman.json`.

| Key                    | Default | Reasoning |
|------------------------|---------|-----------|
| `budget.total`         | 12000   | A stack in the low thousands of tokens leaves the context window mostly for the session. 12k is a soft ceiling that a healthy small-to-mid repo stays well under. |
| `budget.perFile`       | 4000    | Roughly a third of the total: no single memory file should dominate the stack. |
| `budget.skillIndex`    | 2000    | The skill listing is pure overhead paid every session; it should stay small. |
| `safetyMargin`         | 0.1     | The local tokenizer is an estimate (see below). The gate compares against `total * (1 - margin)` so a stack near the line fails before the real count would. |
| `resolve.importDepthLimit` | 5   | Matches Claude Code's documented import hop limit. |

## The tokenizer is an estimate

Default costing uses `@anthropic-ai/tokenizer`, which bundles Anthropic's
released Claude tokenizer and runs offline. It is not the current
frontier-model vocab, which Anthropic has not published. On English prose and
markdown its counts track the `count_tokens` API within a few percent. What conman
guarantees is determinism: the same text always costs the same number, and
budgets are set against this counter. `--tokenizer exact` is a documented seam
for a future token-counting API call; it is not implemented and ships no network
code.

## Model version history

- **0.2** — Two changes to how repeated context is scored.

  *Whole-stack duplication.* Duplication fires across the whole resolved stack,
  not just parent/child file pairs. Any byte-identical segment (≥ 8 tokens)
  repeated between two files a Claude Code session loads is a finding;
  `detail.relation` records whether the files are `parent-child`, `import`, or
  `same-stack`. Whole-file duplicates roll up into one finding per cluster. The
  report leads with a `redundant tokens: N (M% of stack)` line, and the map
  JSON/HTML reports carry the same figure per entry point. Duplication severity
  is unchanged (`error`): a genuine repeat that loads twice — an ancestor and a
  child `CLAUDE.md` sharing a block, a `CLAUDE.md` and its own `@`-import — now
  fails a repo that passed under 0.1.

  *`AGENTS.md` is not Claude stack cost.* Claude Code reads `CLAUDE.md`, not a
  bare `AGENTS.md`. The resolver now leaves a standalone `AGENTS.md` out of the
  stack; it counts only when `CLAUDE.md` `@`-imports it or the two are one file
  via symlink. A directory with a separate byte-identical `CLAUDE.md`/`AGENTS.md`
  pair — the common multi-tool layout — is no longer a duplication `error`; it
  raises the new **`unlinked-copy`** finding at `warn` instead. On a corpus like
  PostHog, where every `CLAUDE.md` is a symlink to its `AGENTS.md`, this removes
  a large block of false `error` findings and roughly halves the measured stack.

  `--fix` behaviour is unchanged: it still only dedupes `parent-child`,
  per-segment duplication findings, and never touches `unlinked-copy`,
  `same-stack`, or whole-file findings.
- **0.1** — Initial model: ancestor memory walk, `@`-imports, `.claude/rules/`,
  skill startup index, `settings.json` resolution keys. Duplication limited to
  parent/child file pairs.
