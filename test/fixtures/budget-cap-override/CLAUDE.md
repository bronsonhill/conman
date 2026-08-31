# Per-file budget fixture

This single memory file is deliberately larger than the `budget.perFile` cap
set in this fixture's conman.json, so the resolver's per-file-budget finding
fires at warn severity. Nothing here is real guidance; it is filler chosen to
push the token count for this one file past the configured limit without
tripping any other finding.

The resolved stack has no override semantics. Every block that resolves is
loaded into the session and paid for on every request, whatever the task. A
memory file this size sets the floor for the base context of every session in
the repository, which is the pattern the per-file cap is meant to make visible
in a report.

Splitting the file, moving the task-specific parts into a skill reached on
demand, or scoping a section to the paths that need it with a rule entry all
bring the always-loaded cost back down. This fixture keeps the file whole so
the finding has something to report. The prose runs on a little longer here
only to clear the small cap this fixture configures, and no further.
