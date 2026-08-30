// Claude Code context-stack constants shared by the resolver and the entry-point
// mapper. Both stages must read the same frontmatter key and the same memory
// file names, so they live here rather than being copied and kept in step.

/** The memory file names Claude Code loads from a directory, in load order. */
export const MEMORY_NAMES = ["CLAUDE.md", "AGENTS.md"];

/**
 * The one `.claude/rules/` frontmatter key Claude Code reads to path-scope a
 * rule. Confirmed against the docs and Claude Code's own parser; see MODEL.md.
 * `globs` / `alwaysApply` are Cursor `.mdc` keys and are not honored.
 */
export const RULE_SCOPE_KEY = "paths";

/** Normalize a frontmatter scalar or list into a trimmed string array. */
export function toStringArray(v: unknown): string[] {
  if (typeof v === "string") return v.trim() ? [v.trim()] : [];
  if (Array.isArray(v)) {
    return v.filter((x) => typeof x === "string").map((x) => (x as string).trim());
  }
  return [];
}
