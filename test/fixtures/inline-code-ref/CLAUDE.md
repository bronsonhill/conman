# Inline-code-ref fixture

Regression guard for issue #36. Every `@token` below sits inside an inline code
span, so none is an `@`-import and none should be flagged as a dead reference.

- FerretDB changelog shape — `### New Features 🎉`, `### Other Changes
  🤖`; entries end `... by @xet7. Thanks to xet7.`
- A span that wraps across lines: `run @scripts/build.sh
  --watch` stays code from open to close.
- A double-backtick span holds a stray backtick: ``@a/b ` @c/d`` is all code.
- The entry point is `src/index.ts`.
