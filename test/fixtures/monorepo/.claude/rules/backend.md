---
description: Backend service rules
paths:
  - services/**
---

Backend services must not import from `web/`.
Log through the shared logger, never `console`.
