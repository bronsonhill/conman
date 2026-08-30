# Vision

`conman` exists so that a repository's Claude Code context can be measured and budgeted before a session starts, instead of growing unchecked until it bloats, contradicts itself, and costs more every session.
It serves the developer or team that maintains that context, and it turns a checkout plus an entry point into a report of what loads, in what order, at what token cost, and where the loaded instructions duplicate or plainly contradict each other.
It owns exactly one thing: the resolved context stack for an entry point.

## The resolved stack is the unit of analysis

conman analyzes what an entry point actually loads, not files in isolation.
It resolves the full chain a session would assemble: ancestor `CLAUDE.md` and `AGENTS.md` from the entry directory up to the filesystem root, `@`-imports up to their depth limit, `.claude/rules/` both always-loaded and path-scoped, the skill startup index, and the `settings.json` keys that change resolution such as `claudeMdExcludes` and the skill-listing budget.
It reports the concatenated result in load order, because order and accumulation are the real behavior and no file overrides another.

Which files count, and in what order, depends on the agent.
Claude Code is the default and the best-supported target: its rules are anchored to a named release and tested against drift.
The `--agent` flag selects a different resolution ruleset for Codex, Cursor, or Copilot, each of which reads a different set of instruction files.
Those rulesets are **best-effort**: conman models the vendor's documented behavior as closely as a static parser can, marks the model best-effort in `MODEL.md`, and does not version-anchor it the way the Claude Code model is anchored.
Everything downstream of resolution is the same regardless of agent: the same token costing, the same duplication and value-conflict and dead-reference findings, the same budget gate.
It analyzes one entry point per run, and `conman map` runs that same analysis across every entry point it discovers in a repo, so a team can adopt conman into an existing monorepo in a single pass.

## Deterministic, local, reproducible

conman is a linter, not an agent.
It uses static parsing and a local tokenizer, runs offline, and produces the same output for the same input every time.
It never needs network access or credentials, in CI or anywhere else; an optional exact mode may call a token-counting API, but that mode is never the default and never required.
No model sits in the analysis path for the MVP.
Vehicle-fit advice - whether a block belongs in always-loaded memory, a path-scoped rule, or a skill - stays coarse and structural in the MVP, keyed off block size and shape rather than meaning, and is deliberately left unsharpened until a later opt-in LLM layer.

## It measures and gates, and its only edits are mechanical

conman reports cost, conflict, and vehicle mismatch, and it can fail a check against a budget.
On request it applies mechanical, semantics-free fixes: dedupe blocks that are byte-identical between a parent and child file, sort skill frontmatter keys, normalize whitespace.
It does not write, rewrite, generate, or migrate prose, and it never edits meaning.
The developer owns every change of substance, because unsupervised edits to agent-authored context are the problem conman was built to expose.

## Findings carry numbers and locations

Every finding names a token cost, a `file:line`, or both.
Budgets are explicit values the user sets, and conman ships sensible defaults, drawn from published guidance, that a project can override.
"This stack is 3,000 tokens over budget", "this block is duplicated between a parent and child file", and "this child file sets a value its ancestor already set differently, at these two lines" are the shape of the output.
Deeper semantic contradiction detection is out of scope until the LLM layer; the MVP catches duplication and direct value conflicts only.
Advice without a number or a location attached does not ship.

## Built for the workflow that already exists

conman runs as a CLI at the desk, as a report for a review, and as a check on a pull request.
It reads a git checkout and fits the branch-and-PR loop rather than asking teams to adopt a new process.
The CI check is deterministic and its pass or fail condition is legible from the config.
Editor and plugin integrations may follow, built on this core, but the CLI, the report, and the CI check are the whole of the MVP, and anything wider waits until the tool has proved useful.

## Scope

conman's primary target is the Claude Code context stack: `CLAUDE.md` / `AGENTS.md`, `.claude/rules/`, and skills.
It also resolves the instruction stacks of Codex, Cursor, and Copilot on a best-effort basis behind `--agent`, so a repo built for one of those tools can still be measured, budgeted, and gated; keeping instruction files in sync across tools remains another tool's job.
It is not a runtime context monitor; `/context` already shows a live session's usage.
It can check a single file on its own as a convenience, running the same checks scoped down, but it is not a file-quality grader competing with existing `CLAUDE.md` linters; its real unit is the resolved stack.
It is not an agent, and the MVP adds no model to the analysis path.
Its own context files are held to the same budgets and checks it applies to others.

A change aligns when it makes the resolved stack more accurately modeled, its cost more visible, its duplication and value conflicts easier to find, or its budget easier to enforce in CI, without adding a model to the analysis path or a required network call.
A change should be resisted when it has conman rewrite or generate prose, when it trades reproducible output for a model's judgment in the default path, when it turns a best-effort agent ruleset into a maintenance burden that rivals the Claude Code model, when it extends to runtime monitoring, or when it grades a file without reference to the stack that file lives in.
