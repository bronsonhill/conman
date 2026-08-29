---
description: Backend service rules
globs:
  - services/**
---

Backend services must not import from `web/`.
Log through the shared logger, never `console`.
