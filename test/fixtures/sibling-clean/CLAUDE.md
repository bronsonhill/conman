# Sibling clean fixture

A CLAUDE.md and an AGENTS.md live side by side here, but they say different
things. They share a heading word and nothing else of length, so conman should
report no duplication finding for this stack.

## Build

The build is a single `make release` that writes a static binary into `bin/`.
Nothing else runs at build time and there are no code-generation steps to keep
in sync.
