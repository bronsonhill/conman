---
description: Electron main-process rules; scopes src/main with no memory file there
paths:
  - src/main/**
---

Never block the main process on synchronous IPC.
