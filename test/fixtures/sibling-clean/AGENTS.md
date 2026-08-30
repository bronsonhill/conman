# Sibling clean fixture

This file records the deployment runbook: how a tagged commit becomes a release
on the three production regions, and who to page when a rollout stalls partway
through. None of that overlaps with the build notes in CLAUDE.md.

## Release

Tag the commit, wait for the pipeline to go green, then promote the artifact
region by region with a ten-minute soak between each. Roll back the whole set if
error rates climb in any single region.
