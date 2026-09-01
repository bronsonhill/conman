---
description: Nested rule file; Claude Code walks `.claude/rules/` recursively, so this scopes src/webview just like a top-level rule
paths:
  - src/webview/**
---

Webview code must not import from the main process.
