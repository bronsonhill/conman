# The conman resolution model

conman reports on a *model* of how Claude Code assembles startup context. The
model is versioned (`modelVersion` in every report; `0.2` today) and is the thing
under test. It is not a claim of bug-for-bug parity with any Claude Code release.
When Claude Code changes how it loads context, the model version bumps and the
golden fixtures move with it.

This file records what the model assumes and where the default numbers come from.
If you are debugging a surprising report, start here.

## Accurate as of

**Claude Code v2.1.251, verified 2026-08-30.**

Every resolution rule below — ancestor `CLAUDE.md` walk order, the
`settings.json` keys conman honours, `@`-import inlining and the 5-hop depth
limit, `.claude/rules/` always-on vs `paths`-scoped, and the skill startup
index — was checked against that release's documented behaviour and its rule
parser. conman models this release; it does not track newer ones automatically.

`src/anchor.test.ts` pins the observable resolution output for this anchor. If
a newer Claude Code release changes any of these rules, that test fails with a
pointer back here. When it does, follow **Bumping the version anchor** at the
bottom of this file — do not just regenerate the golden.

## What resolves, and in what order

For one entry point (a directory, or a file), the resolved stack is built in this
order. Order matters because nothing overrides anything: the session accumulates
every block.

1. **Ancestor memory files.** Walk from the entry directory upward. At each
   directory, load `CLAUDE.md` if present. Root-most directory first,
   entry-closest last. With `resolve.repoBoundary: true` (default) the walk stops
   at the repo root (nearest `.git`); `--no-repo-boundary` continues to the
   filesystem root.
   - `~/.claude/CLAUDE.md` (Claude Code's "User" memory) is not read by default —
     conman's default output describes a repository, not a machine. Pass `--user`
     to fold it in; see "User-level config" below.
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
   - `@`-imports inside rule files are not followed.
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
repo root and deep-merges them, `settings.local.json` layered on top. The merge
matches Claude Code's `i5` customizer (`claude 2.1.251`): arrays are
**concatenated and de-duplicated**, plain objects merge key-by-key, and a scalar
in `settings.local.json` replaces the one in `settings.json`. So a
`claudeMdExcludes` entry in `settings.local.json` *adds to* the project list —
it does not replace it. (conman previously did a shallow `Object.assign`, which
let a local `claudeMdExcludes` drop every project-level exclude.) Precedence,
lowest first: `~/.claude/settings.json` (only with `--user`; see "User-level
config" below) < project `settings.json` < local `settings.local.json` < managed
policy. Managed policy is still not modelled.

It acts on:

- **`claudeMdExcludes`** — a list of globs. Any memory, imported, or
  `.claude/rules/` file whose repo-relative path matches is dropped from the
  stack, with a NOTE. Also accepted: `claudeMd.excludes`. Claude Code matches
  these against *absolute* paths with picomatch; conman matches repo-relative
  paths, so relative and `**/`-prefixed globs behave identically while a
  machine-specific absolute glob (the docs' `/home/user/...` example) never
  matches in conman.
- **`skillListingBudget`** — token budget for the skill startup index (see above).
  Also accepted: `skillsListingBudget`, `skills.listingBudget`.

These key names are conman's current interpretation. They will track Claude Code
as it formalizes the settings surface; a change here is a model-version change.

## User-level config (`--user`)

By default conman reads only the repository. `--user` (alias
`--include-user-config`) additionally resolves Claude Code's **User** memory and
user-level settings from this machine, so a `conman check` / `conman map` run at
a developer's desk matches how their own harness assembles context.

Modelled for `--agent claude` only — user-level files are Claude Code's own
memory model, and every other agent has its own home-directory files, which
conman does not read. `--user` with any other `--agent` is ignored, with a NOTE.

**What it reads**, from `$CLAUDE_CONFIG_DIR` if set, else `~/.claude`
(`--user-config-dir <path>` overrides both):

- **`<dir>/CLAUDE.md`** — loaded as the **root-most memory block**, ahead of the
  repo's own root `CLAUDE.md`. It is the most global instruction file (it applies
  to every repo on the machine), so it sits at the top of the stack. It is
  loaded as a single block: conman does **not** follow `@`-imports out of the
  user file (that would pull in more machine-local paths), and it is emitted
  under the stable label `~/.claude/CLAUDE.md` rather than a real path, so the
  load-order table stays portable. A NOTE reports any unfollowed `@`-imports.
- **`<dir>/settings.json`** — merged into the settings layer **below** every
  repo-root file: `~/.claude/settings.json` < project `settings.json` < local
  `settings.local.json`. Same deep-merge as the repo files, so a user-level
  `claudeMdExcludes` *adds to* the project list.

**Reproducibility caveat.** This breaks conman's default guarantee that the same
input produces the same bytes: the output now depends on whose machine it ran
on. conman marks it. The human report carries a `scope: machine-specific` line
under the header, the JSON report sets `"machineSpecific": true`, and both emit a
NOTE. `conman map` records the NOTE per affected entry point. Leave `--user` out
of CI and any shared/committed report; it is a desk-time convenience.

## Other agents (best-effort)

Everything above models Claude Code. The `--agent` flag switches to a different
resolution ruleset for another coding agent. These rulesets are **best-effort**:
they are a static parser's reading of each vendor's *documented* file-loading
behavior, the real tool may load more or less than this, and — unlike the Claude
Code model — they are **not anchored to a release** and `src/anchor.test.ts` does
not guard them. The pipeline downstream of resolution is unchanged: same coster,
same findings, same budget gate.

Common to every non-Claude agent:

- `CLAUDE.md` is not special-cased. The memory file is `AGENTS.md`, walked from
  the entry directory up to the repo root (or the filesystem root with
  `--no-repo-boundary`), root-most first.
- No `@`-import following, no `.claude/rules/`, no skill startup index, no
  `.claude/settings.json` keys.
- Single-file mode (an entry that is a file other than `AGENTS.md`) still works:
  that one file is costed, nothing else is resolved.

### `--agent codex`

Ancestor `AGENTS.md` files only. Nothing else. Codex also reads
`~/.codex/AGENTS.md`; conman does not read it (there is no non-Claude equivalent
of `--user`). Vendor behavior around `AGENTS.md` merge order and depth may differ
from this and is not tracked.

### `--agent copilot`

The repo-root `.github/copilot-instructions.md` first (it is repo-wide), then the
ancestor `AGENTS.md` walk. Both load as `memory` blocks. GitHub Copilot's
`.github/instructions/*.instructions.md` path-scoped files and `applyTo`
frontmatter are not modeled yet.

### `--agent cursor`

Ancestor `AGENTS.md` walk, then Cursor rules, in this order:

1. Legacy `.cursorrules` at the repo root, if present — one always-on block.
2. `.cursor/rules/*.mdc` from every `.cursor/` directory at or above the entry,
   path-sorted within each directory.

`.mdc` frontmatter maps onto conman's always-on vs path-scoped split:

- `alwaysApply: true` → **always-on** (`rule-always`).
- otherwise a non-empty `globs` (string or list) → **path-scoped**
  (`rule-scoped`), loaded only when one glob matches the entry path, matched by
  conman's own literal matcher (no brace expansion), exactly as `paths` is
  matched for Claude. A `globs` of just `**` counts as no scope.
- neither key → Cursor pulls the rule in *on agent request*, which a static
  resolver cannot predict. conman loads it always-on and adds a NOTE.

Always-on rules load before matched path-scoped rules, both path-sorted, mirroring
the Claude rule order. `.mdc` frontmatter is not linted by the `frontmatter`
finding — that check is Claude-specific.

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
- **Lint duplication** — an always-loaded context file (`memory` / `import` /
  rule) restates a rule that a linter or formatter config at the repo root
  already enforces mechanically. Configs read: `.prettierrc*` (JSON/YAML, and
  `package.json#prettier`), `.eslintrc*` (JSON/YAML, and
  `package.json#eslintConfig`), `biome.json(c)`, and `pyproject.toml`
  `[tool.ruff*]` / `[tool.black]` (`line-length`, `indent-width`, scanned
  without a full TOML parse). JS config files are skipped — reading them means
  running them. The matcher recognises a fixed set of keys (indent style/width,
  line width, `semi`, quote style, `no-console`, trailing comma) and a short
  list of conservative prose phrasings per key, matched on rule intent. One
  finding per (file, rule), at **warn** (`config.gate["lint-duplication"]`;
  `"off"` disables). Numbers must match: "100-column limit" only collides with a
  config that sets 100.
- **Stale boilerplate** — a sentence from Claude Code's `/init` template still
  sitting unmodified in a `memory` file. The match set is a small curated list
  of known `/init` sentences (currently the "This file provides guidance to
  Claude Code (claude.ai/code)…" header and two near-verbatim variants),
  compared with whitespace collapsed and case folded. One finding per file, at
  **warn** (`config.gate["stale-boilerplate"]`; `"off"` disables).
- **Dead reference** — a pointer in a depth-0 block (ancestor memory file or
  `.claude/rules` entry) that does not resolve on disk. Sub-cases:
  - `dead-import` (**error**) — an `@`-import whose target file is missing.
    Claude Code drops it from the resolved stack silently, so content the author
    expected never loads. Only path-shaped tokens (`@x/y`, `@x.md`) count; a
    bare `@handle` is treated as prose. An unresolved token shaped like an npm
    scoped package name in prose (`@superset-ui/core`, `@xyflow/react`: all
    lowercase, no dot anywhere, at least two segments, and the scope segment is
    not a real directory next to the file) is also treated as prose, not a dead
    import. Claude Code (v2.1.251) makes no such distinction — its parser
    accepts any candidate whose first character is `[a-zA-Z0-9._-]`, `./`,
    `~/`, or `/`, and silently skips a missing target — so the resolved stack
    is identical either way; the exemption is about author intent, not load
    behavior.
  - `dead-path` (**warn**) — a repo-relative path named inside backticks
    (`` `docs/architecture.md` ``) that does not exist. Flagged only when the
    path has a file extension, no globs or `..`, and its parent directory
    already exists and holds a real (non-dotfile) file — a reference into a
    tree that has not been created yet is not guessed at.
  - `dead-script` (**warn**) — `npm|pnpm|yarn run <name>` with no matching key
    in the repo-root `package.json` `scripts`. Skipped when there is no
    `package.json` or it has no `scripts`.

  `config.gate["dead-reference"]` is a **ceiling** like `gate.frontmatter`:
  `"warn"` caps the import case at warn, `"off"` disables the check. This is a
  read-only lint; `--fix` does not touch references.
- **Max skills** — the resolved startup skill index for an entry point lists
  more than `config.maxSkills` skills (default 8), counted *after* any
  skill-listing-budget truncation, i.e. the entries the agent actually sees.
  Complementary to `budget.skillIndex`, not a replacement: that caps the token
  weight of the listing, this caps the count, because selection accuracy
  degrades with the number of candidates independently of how terse each entry
  is. Bands: 9 to 15 skills **warn**, more than 15 **error**.
  `config.gate["max-skills"]` is a **ceiling** like `gate.frontmatter`:
  `"warn"` caps the >15 case at warn, `"off"` disables the check. The finding
  names the count and points at the skills root. The default 8 and hard cap 15
  are transferred from tool-selection research, not measured on skill indexes;
  see the `maxSkills` row in "Default budget numbers" for provenance and the
  version pin. `--fix` does not touch skills.

## Default budget numbers, and why

There is no published hard token limit for a `CLAUDE.md` or a context stack.
Anthropic's guidance is qualitative: keep it concise, keep it relevant. The
defaults below are conservative starting points meant to make a bloated stack
visible, not a standard. Override them per repo in `conman.json`.

| Key                    | Default | Reasoning |
|------------------------|---------|-----------|
| `budget.total`         | 12000   | A stack in the low thousands of tokens leaves the context window mostly for the session. 12k is a soft ceiling that a healthy small-to-mid repo stays well under. |
| `budget.perFile`       | 4000    | Roughly a third of the total: no single memory file should dominate the stack. |
| `budget.skillIndex`    | 2000    | **Cost line for the skill index.** The listing is pure overhead paid every session; it should stay small. |
| `maxSkills`            | 8       | **Performance line for the skill index**, complementary to `budget.skillIndex` — a count cap, not a token cap. A repo can sit under 2000 tokens (15 terse entries at ~80 tokens is ~1200) and still list enough skills that selection accuracy drops. The number is **transferred from tool / function-selection research** — arXiv 2605.24660 ("How Many Tools Should an LLM Agent See?", knee around 7 to 8) and Anthropic's "advanced tool use" post (retrieve rather than list past ~10 tools, keep 3 to 5 always loaded) — and is **not measured on Claude Code skill indexes**. `gate["max-skills"]` is a ceiling: 9 to 15 skills warn, more than 15 error. Pinned to the `MODEL_VERSION` / "Accurate as of" anchor for re-review as models change: the tool-selection penalty shrinks across model releases (Opus 4: 49% to 74% with retrieval; Opus 4.5: 79.5% to 88.1%), so this knee moves. |
| `safetyMargin`         | 0.1     | The local tokenizer is an estimate (see below). The gate compares against `total * (1 - margin)` so a stack near the line fails before the real count would. |
| `resolve.importDepthLimit` | 5   | Matches Claude Code's documented import hop limit. |

## The tokenizer is an estimate

Default costing uses `@anthropic-ai/tokenizer` (the `claude-local` path), which
bundles Anthropic's released Claude tokenizer and runs offline. It is not the
current frontier-model vocab, which Anthropic has not published. On English prose
and markdown its counts track the `count_tokens` API within a few percent. What
conman guarantees is determinism: the same text always costs the same number, and
budgets are set against this counter.

### The `exact` seam

`--tokenizer exact` swaps the local estimate for Anthropic's
`POST /v1/messages/count_tokens`. It is the only code path in conman that makes a
network call, and it is gated twice: the caller passes `--tokenizer exact` **and**
`ANTHROPIC_API_KEY` is set in the environment. Missing key with the flag is a
usage error (exit 2) naming the env var; the key is read from `ANTHROPIC_API_KEY`
only, never from a flag or a file. With the flag absent, conman never opens a
socket — `claude-local` stays fully offline and deterministic, which is why it,
not the API, is what budgets and the CI gate are measured against.

The request wraps each block as a one-message prompt, so `count_tokens` returns a
few tokens of turn-structure framing on top of the text. conman measures that
framing once from a short probe and subtracts it, so an `exact` count is
comparable to the local text-only count. Results are cached per block text (a
duplicated stack resolves to a handful of distinct blocks), so `conman map` over
a large repo makes tens of calls, not thousands. `exact` is never wired into a
golden or a CI job; CI has no key and stays offline.

`CONMAN_EXACT_MODEL` overrides the model whose vocab the count is taken against
(default `claude-opus-5`). `count_tokens` is model-specific.

Measured drift `(local - exact) / exact` over the pinned corpus: within a few
percent against the older-generation vocab (`claude-haiku-4-5`, ≤ 9% per stack),
but a systematic ~32% undercount against the Opus 4.7 / Sonnet 4.6 generation.
Full table and corpus SHAs: README "How accurate is the token estimate?".
Regenerate with `node scripts/measure-tokenizer.mjs`.

## Bumping the version anchor

`src/anchor.test.ts` fails when the resolved output for its pinned fixtures
drifts from what this file's **Accurate as of** release documents. A conman
maintainer sees that failure, re-verifies against the newer Claude Code release,
and bumps the anchor. The procedure:

1. **Re-verify each resolution rule** against the new release's docs and, where
   possible, its rule parser:
   - ancestor `CLAUDE.md` walk direction and the repo-boundary stop;
   - `@`-import handling: inline position, depth-first order, the hop limit
     (`resolve.importDepthLimit`), cycle breaking, `@~/...` skipped;
   - `.claude/rules/`: `paths` as the only scoping key, always-on vs
     path-scoped ordering, `**` and keyless treated as always-on, `globs` /
     `alwaysApply` ignored;
   - the skill startup index: one line per `SKILL.md`, sorted by name, budget
     truncation;
   - the `settings.json` keys conman acts on (`claudeMdExcludes`,
     `skillListingBudget`, and their aliases).
2. **If behaviour changed**, update `src/resolver.ts` / `src/config.ts` to
   match, then bump `modelVersion` and add a `## Model version history` entry.
3. **Update the anchor**: change the version and date in **Accurate as of**
   above, and the `ANCHOR` constant in `src/anchor.test.ts`.
4. **Regenerate the drift-test expectation and the goldens**: update the
   `EXPECTED` literal in `src/anchor.test.ts` to the new resolved output, then
   `npm run test:update-golden`. Review the diff — an unexplained change there
   is a bug, not a refresh.
5. `npm test` green, commit with the release you verified against named in the
   message.

If re-verification finds nothing changed, still bump the date in **Accurate as
of** and the `ANCHOR` constant so the anchor records the last time it was
checked.

## Model version history

- **0.3** — Two false-fail fixes.

  *`claudeMdExcludes` covers rules.* The setting now also drops matching
  `.claude/rules/` entries, not just memory and imported files. Claude Code
  applies it to rules files (its settings schema documents a
  `.claude/rules/**` exclude, and a changelog entry fixes exclusion of
  symlinked rules entries), so a repo that deliberately keeps its rules out of
  the base context and reaches them via agent `@`-imports was being charged
  tokens it never loads, and failed `conman check --map` on a stack Claude
  Code never assembles.

  *`dead-import` ignores npm package names in prose.*
  `@superset-ui/core` or `@xyflow/react` mid-sentence is parsed as an
  import by Claude Code and silently skipped when missing, exactly like a
  genuinely dead `@docs/setup.md` — but the author never meant it to load, so
  reporting it as a gate `error` was a false positive endemic to JS repos
  (for several large repos it was the only reason `conman check --map` failed).
  The exemption is shape-based and offline: all-lowercase, dot-free, two or
  more segments, and the scope segment is not an existing directory beside the
  importing file. Resolution is unchanged — the token is still attempted and
  dropped, and the report still carries the `unresolved @-import` NOTE.

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
