# MODEL.md claim → code → test traceability

One row per resolution rule that MODEL.md's **Bumping the version anchor**
re-verify checklist asks a maintainer to re-check, plus four claims the
[model/process review](../data/conman-model-process-review/report.md) (R3)
flagged as likely unguarded. The point of the table is the **guarding test**
column: a cell marked *documented, not asserted* is a claim that only prose
backs today.

Code references are `file:function`. Tests are `file` plus the test name.
`anchor` = `src/anchor.test.ts` (snapshots observable resolved output for the
pinned Claude Code release; guards the whole Claude path at once).
`resolver` = `src/resolver.test.ts`.

## Ancestor memory walk

| claim (MODEL.md) | resolver code | guarding test |
| --- | --- | --- |
| Walk entry dir upward, root-most first, entry-closest last | `resolver/index.ts:resolveStack` (the `ancestorDirs` loop), `resolver/index.ts:ancestorDirs` | `resolver` "monorepo: ancestor chain, import, rules, skill index, exclude"; `anchor` "monorepo services/api" |
| `resolve.repoBoundary: true` stops the walk at the nearest `.git` | `resolver/index.ts:ancestorDirs` | `anchor` "monorepo services/api" (walk stops at fixture root); `resolver` "--user off: default run is reproducible" (walk stops at `USER_REPO`) — no direct `--no-repo-boundary` case; *repoBoundary=false path documented, not asserted* |
| `CLAUDE.local.md` loads right after that dir's `CLAUDE.md`, imports followed | `resolver/index.ts:resolveStack` (`LOCAL_MEMORY_NAMES` branch); `claudeContext.ts:LOCAL_MEMORY_NAMES` | `anchor` "claude-local root" (block order `CLAUDE.md` then `CLAUDE.local.md`) |
| A stack with `CLAUDE.local.md` is flagged machine-specific | `resolver/index.ts:resolveStack` (`machineSpecific = true` in that branch) | `resolver` "CLAUDE.local.md flags the whole stack machine-specific" (direct `machineSpecific` assertion, added with this table); `anchor` "claude-local root" (NOTE text) |
| `~/.claude/CLAUDE.md` is not read by default | `resolver/index.ts:resolveStack` (`userBlocks` only when `userConfigDir !== undefined`) | `resolver` "--user off: default run is reproducible, no ~/.claude, skip/CLAUDE.md loads" |
| Bare `AGENTS.md` is not loaded; recorded as a NOTE / `unlinked-copy` | `resolver/agentsMd.ts:classifyAgentsMd` | `resolver` "a bare AGENTS.md beside a byte-identical CLAUDE.md is not loaded, but is recorded as a copy"; "a bare AGENTS.md with no CLAUDE.md contributes no memory block" |
| `AGENTS.md` enters the stack via `@`-import (counted once) or symlink to `CLAUDE.md` | `resolver/agentsMd.ts:classifyAgentsMd`; `resolver/imports.ts:resolveFileBlocks` (`seenReal`) | `resolver` "a file pulled in via @-import is not loaded again as a sibling"; "a CLAUDE.md -> AGENTS.md symlink loads the content once and is not a copy" |

## `@`-imports

| claim (MODEL.md) | resolver code | guarding test |
| --- | --- | --- |
| Inlined immediately after the importing file, depth-first, in reference order | `resolver/imports.ts:resolveFileBlocks`, `resolver/imports.ts:findImports` | `anchor` "imports root" (block order); `resolver` "monorepo: ancestor chain…" (import sits between the two memory blocks) |
| `@`-reference detection skips fenced code blocks and inline backticks | `resolver/imports.ts:findImports` (`fencedLineSet`, `maskInlineCode`) | `src/fence.test.ts`, `src/segments.test.ts` |
| Paths resolve relative to the importing file's directory | `resolver/imports.ts:resolveFileBlocks` (`resolve(fileAbs)` against `dirname`) | `anchor` "imports root" (`chain-b.md via chain-a.md:1` etc. resolve per-dir) |
| `@~/...` is skipped as out-of-repo (silently, no block) | `resolver/imports.ts:findImports` (`raw.startsWith("~")` → `continue`) | `resolver` "@~/... home-dir imports are skipped as out-of-repo" (direct `findImports` assertion, added with this table) |
| Depth limit `resolve.importDepthLimit` (default 5); file at the limit loads, its imports do not | `resolver/imports.ts:resolveFileBlocks` (`depth >= ctx.depthLimit`) | `resolver` "import depth limit stops the chain and leaves a note"; `anchor` "imports root" (NOTE + `chain-e` loads, `chain-f` does not) |
| Import cycles broken: a file already on the stack is not re-imported; NOTE | `resolver/imports.ts:resolveFileBlocks` (`visited.has(norm)`) | `resolver` "import cycle is broken with a note"; `anchor` "imports root" |
| A file already pulled in as an `@`-import is not also loaded as a sibling memory file | `resolver/index.ts:resolveStack` (`ctx.seen.has(rel)` check) | `resolver` "a file pulled in via @-import is not loaded again as a sibling" |

## `.claude/rules/`

| claim (MODEL.md) | resolver code | guarding test |
| --- | --- | --- |
| Every `*.md` under a `.claude/rules/` at or above the entry, discovered recursively | `resolver/rules.ts:findClaudeDirs`, `resolver/rules.ts:findRuleFiles`, `resolver/rules.ts:collectRuleBlocks` | `resolver` "a rule in a `.claude/rules/` subdirectory is discovered and path-scoped"; `anchor` "rule-scope-keys src/renderer" (`frontend/react.md`) |
| Files ordered by full `/`-joined path relative to `rules/` | `resolver/rules.ts:findRuleFiles` (sorted listings), `resolver/rules.ts:collectRuleBlocks` | `anchor` "rule-scope-keys *" (block + notes order) |
| Frontmatter `paths` (string or list of globs) makes a rule path-scoped | `resolver/rules.ts:collectRuleBlocks` | `resolver` "`paths` frontmatter makes a rule path-scoped, and it matches a matching entry"; "Motrix regression: a `paths`-scoped rule is path-scoped, not always-on" |
| No `paths`, or `paths` of just `**`, or a keyless rule → always-loaded | `resolver/rules.ts:collectRuleBlocks` | `resolver` "a rule with no scoping key stays always-on"; "a `paths` of just `**` scopes to everything, so the rule loads always-on"; `anchor` "rule-scope-keys app/api" (`keyless.md`, `scope-everything.md`) |
| `globs` / `alwaysApply` (Cursor `.mdc` keys) ignored; `globs`-without-`paths` loads always-on with a NOTE | `resolver/rules.ts:collectRuleBlocks` | `resolver` "a rule scoped with the Cursor `globs` key loads always-on, with a NOTE"; `anchor` "rule-scope-keys *" (`legacy-globs.md` NOTE) |
| Always-loaded rules first (path-sorted), then matched path-scoped (path-sorted); rules after all memory | `resolver/rules.ts:collectRuleBlocks`; `resolver/index.ts:resolveStack` (`[...memoryBlocks, ...always, ...scoped]`) | `anchor` "rule-scope-keys src/renderer" (full block order) |
| `@`-imports inside rule files are not followed | `resolver/rules.ts:collectRuleBlocks` (reads file text, no `resolveFileBlocks`) | *documented, not asserted* — no fixture has an `@`-import inside a rule file |
| `{a,b}` brace lists expand like minimatch (cartesian for multiple groups) | `src/repo.ts` (`matchesAnyGlob` / brace expansion) | `src/repo.test.ts`; `anchor` "rule-scope-keys src/main" (`brace-scoped.md` on `src/{main,renderer}`) |

## Skill startup index

| claim (MODEL.md) | resolver code | guarding test |
| --- | --- | --- |
| One `- <name>: <description>` line per `SKILL.md` at or above the entry, sorted by skill name | `resolver/skills.ts:buildSkillIndex` | `resolver` "monorepo: ancestor chain…" (skill-index block present); `anchor` "monorepo services/api" |
| Skill-listing budget truncates from the end and adds an `(N more…)` marker | `resolver/skills.ts:buildSkillIndex` | `anchor` "monorepo services/api" (NOTE "skill startup index truncated: 1 of 3 skills omitted") |
| Budget source: `resolve.skillListingBudget`, else `settings.json` `skillListingBudget`, else no limit | `resolver/index.ts:resolveStack` (`config.resolve.skillListingBudget ?? settings.skillListingBudget ?? null`) | `anchor` "monorepo services/api" (settings-supplied budget of 45); `src/findings/maxSkills.test.ts` |

## `settings.json` keys

| claim (MODEL.md) | resolver code | guarding test |
| --- | --- | --- |
| `.claude/settings.json` + `.claude/settings.local.json` deep-merged (arrays concat+dedupe, objects key-by-key, scalars replace), local on top | `resolver/settings.ts:mergeSettingsValue`, `resolver/settings.ts:loadSettings` | `resolver` "settings.local.json claudeMdExcludes adds to, not replaces, settings.json"; "loadSettings deep-merges ~/.claude/settings.json below the repo files" |
| `claudeMdExcludes` (alias `claudeMd.excludes`) — matching memory/import/rule files dropped with a NOTE, repo-relative match | `resolver/settings.ts:loadSettings` (`pickStringArray` + `deepGet`); `resolver/index.ts:resolveStack` (`matchesAnyGlob(rel, excludes)`); `resolver/rules.ts:collectRuleBlocks` | `anchor` "monorepo services/api" (two `excluded by settings claudeMdExcludes` notes, one a rule file); `resolver` "monorepo: ancestor chain…" |
| `skillListingBudget` aliases `skillsListingBudget`, `skills.listingBudget` | `resolver/settings.ts:loadSettings` (`pickNumber` + `deepGet`) | *alias resolution documented, not asserted* — only the canonical key is exercised by `anchor`; add a `loadSettings` alias case to close this |
| Precedence: `~/.claude/settings.json` < project < local < managed policy | `resolver/settings.ts:loadSettings` | `resolver` "loadSettings deep-merges ~/.claude/settings.json below the repo files" (user < project); local-on-top covered above |
| **Managed policy is still not modelled** | not implemented — no code reads a managed-settings path | *documented, not asserted* — negative claim; nothing to assert until conman models it. Left as a known gap. |

## `--user` (user-level config)

| claim (MODEL.md) | resolver code | guarding test |
| --- | --- | --- |
| `--user` resolves `~/.claude` memory, settings, skills, rules; run is marked **machine-specific** | `resolver/index.ts:resolveStack` (`userConfigDir` branch, `machineSpecific = userConfigDir !== undefined`) | `resolver` "--user on: ~/.claude/CLAUDE.md loads first and settings.json merges below the repo" (direct `machineSpecific === true`); "--user with a config dir that has no CLAUDE.md still merges settings" |
| `~/.claude/CLAUDE.md` loads as the root-most block, under a stable label, `@`-imports not followed | `resolver/index.ts:resolveStack` (`userBlocks`, `USER_MEMORY_LABEL`) | `resolver` "--user on: ~/.claude/CLAUDE.md loads first…" (block order + label) |
| `~/.claude` skills / rules fold into the same index and rule split, stable labels | `resolver/index.ts:resolveStack` (`claudeDirs` prepends `userConfigDir`); `resolver/skills.ts:buildSkillIndex`; `resolver/rules.ts:collectRuleBlocks` | `resolver` "--user on: ~/.claude/skills merges name-sorted…"; "--user on: ~/.claude/rules load with a stable label…" |
| `--user` with any non-claude `--agent` is ignored, with a NOTE | `resolver/index.ts:resolveStack` (early `agent !== "claude"` branch) | `resolver` "--user is ignored for non-claude agents, with a note" |
| `--user` off → user skills/rules contribute nothing, run reproducible | `resolver/index.ts:resolveStack` | `resolver` "--user off: user skills and rules contribute nothing"; "--user off: default run is reproducible…" |

## Other agents (`--agent codex|copilot|cursor`)

The whole non-Claude surface is **best-effort and not version-anchored**:
`src/anchor.test.ts` does not touch it. It has direct unit tests in
`src/resolver.test.ts`, but no drift guard — a Claude Code release bump
re-verifies nothing here, and neither does a vendor doc change.

| claim (MODEL.md) | resolver code | guarding test |
| --- | --- | --- |
| Non-Claude: memory file is `AGENTS.md`, walked entry→root; no `@`-imports, no rules, no skills, no `settings.json` | `resolver/index.ts:resolveNonClaude` | `resolver` "non-claude agents do not read settings.json or follow @-imports"; "single-file mode: no ancestor walk, no rules" |
| `--agent codex`: ancestor `AGENTS.md` only; `~/.codex/AGENTS.md` not read | `resolver/index.ts:resolveNonClaude` (`agent === "codex"`) | `resolver` "--agent codex: ancestor AGENTS.md only, no CLAUDE.md, no rules, no skills" |
| `--agent copilot`: `.github/copilot-instructions.md`, then `AGENTS.md` walk, then `.github/instructions/**/*.instructions.md`; `applyTo` → always-on vs path-scoped split | `resolver/rules.ts:collectCopilotInstructions`, `resolver/rules.ts:findInstructionFiles` | `resolver` "--agent copilot: copilot-instructions, AGENTS.md, then always-on instructions"; "--agent copilot: a matching applyTo makes an instructions file path-scoped" |
| `--agent cursor`: `AGENTS.md` walk, `.cursorrules`, then `.cursor/rules/*.mdc`; `alwaysApply` / `globs` / neither → always-on / path-scoped / always-on+NOTE | `resolver/rules.ts:collectCursorRules` | `resolver` "--agent cursor: AGENTS.md, .cursorrules, then .mdc rules by frontmatter"; "--agent cursor: a matching glob makes an .mdc rule path-scoped" |
| These rulesets are best-effort and **not guarded by `anchor.test.ts`** | n/a | *by design, not asserted* — no drift test exists or is wanted for the non-Claude paths |

## Open gaps (empty / soft cells above)

- **Managed policy not modelled** — no code, no test. Known gap; nothing to
  assert until conman reads a managed-settings path.
- **`skillListingBudget` aliases** — only the canonical key is exercised.
  Cheap to close with a `loadSettings` alias unit test; left for a follow-up to
  avoid scope creep here.
- **`@`-imports inside rule files not followed** — needs a fixture with an
  `@`-ref inside a `.claude/rules/*.md` file. Not present; low risk.
- **`--no-repo-boundary`** — the walk-to-filesystem-root path has no direct
  case; the default `repoBoundary: true` stop is well covered.
- **Non-Claude agents un-anchored** — intentional. Unit-tested, not
  drift-guarded.
