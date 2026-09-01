// Golden tests for `conman <entry>` analysis output. See test/golden-lib.js.
import { registerGolden, MONO } from "./golden-lib.js";

registerGolden("golden/analyze", [
  { name: "analyze-monorepo", args: [`${MONO}/services/api`, "--repo-root", MONO] },
  { name: "analyze-monorepo-json", args: [`${MONO}/services/api`, "--repo-root", MONO, "--json"] },
  {
    name: "analyze-monorepo-sarif",
    args: [`${MONO}/services/api`, "--repo-root", MONO, "--format", "sarif"],
  },
  {
    name: "analyze-frontmatter-broken",
    args: [
      "test/fixtures/frontmatter-broken",
      "--repo-root",
      "test/fixtures/frontmatter-broken",
    ],
  },
  {
    name: "analyze-frontmatter-broken-json",
    args: [
      "test/fixtures/frontmatter-broken",
      "--repo-root",
      "test/fixtures/frontmatter-broken",
      "--json",
    ],
  },
  { name: "analyze-imports", args: ["test/fixtures/imports", "--repo-root", "test/fixtures/imports"] },
  {
    name: "analyze-single-file",
    args: ["test/fixtures/single-file/notes.md", "--repo-root", "test/fixtures/single-file"],
  },
  {
    name: "analyze-lint-dup",
    args: ["test/fixtures/lint-dup", "--repo-root", "test/fixtures/lint-dup"],
  },
  {
    name: "analyze-stale-init",
    args: ["test/fixtures/stale-init", "--repo-root", "test/fixtures/stale-init"],
  },
  {
    name: "analyze-max-skills",
    args: ["test/fixtures/max-skills", "--repo-root", "test/fixtures/max-skills"],
  },
  {
    name: "analyze-max-skills-over",
    args: [
      "test/fixtures/max-skills-over",
      "--repo-root",
      "test/fixtures/max-skills-over",
    ],
  },
  {
    name: "analyze-dead-ref",
    args: ["test/fixtures/dead-ref", "--repo-root", "test/fixtures/dead-ref"],
  },
  {
    name: "analyze-dead-ref-json",
    args: ["test/fixtures/dead-ref", "--repo-root", "test/fixtures/dead-ref", "--json"],
  },
  {
    // Issue #36: `@token` inside an inline code span (incl. spans that wrap
    // across lines) is not an @-import and must not be flagged. Expect a clean
    // report with zero findings.
    name: "analyze-inline-code-ref",
    args: ["test/fixtures/inline-code-ref", "--repo-root", "test/fixtures/inline-code-ref"],
  },
  {
    name: "analyze-per-file-budget",
    args: ["test/fixtures/per-file-budget", "--repo-root", "test/fixtures/per-file-budget"],
  },
  {
    name: "analyze-per-file-budget-json",
    args: [
      "test/fixtures/per-file-budget",
      "--repo-root",
      "test/fixtures/per-file-budget",
      "--json",
    ],
  },
  {
    name: "analyze-budget-cap-override",
    args: [
      "test/fixtures/budget-cap-override",
      "--repo-root",
      "test/fixtures/budget-cap-override",
    ],
  },
  {
    name: "analyze-skill-index-budget",
    args: ["test/fixtures/skill-index-budget", "--repo-root", "test/fixtures/skill-index-budget"],
  },
  {
    name: "analyze-skill-index-budget-sarif",
    args: [
      "test/fixtures/skill-index-budget",
      "--repo-root",
      "test/fixtures/skill-index-budget",
      "--format",
      "sarif",
    ],
  },
  {
    name: "analyze-codex",
    args: [
      "test/fixtures/agents-only",
      "--repo-root",
      "test/fixtures/agents-only",
      "--agent",
      "codex",
    ],
  },
  {
    name: "analyze-cursor",
    args: [
      "test/fixtures/cursor-rules",
      "--repo-root",
      "test/fixtures/cursor-rules",
      "--agent",
      "cursor",
    ],
  },
  {
    name: "analyze-cursor-json",
    args: [
      "test/fixtures/cursor-rules",
      "--repo-root",
      "test/fixtures/cursor-rules",
      "--agent",
      "cursor",
      "--json",
    ],
  },
  {
    name: "analyze-cursor-frontend",
    args: [
      "test/fixtures/cursor-rules/src/frontend",
      "--repo-root",
      "test/fixtures/cursor-rules",
      "--agent",
      "cursor",
    ],
  },
  {
    name: "analyze-copilot",
    args: [
      "test/fixtures/copilot",
      "--repo-root",
      "test/fixtures/copilot",
      "--agent",
      "copilot",
    ],
  },
  {
    // --user: ~/.claude/CLAUDE.md loads first, ~/.claude/settings.json merges
    // below the repo settings (its claudeMdExcludes drops skip/CLAUDE.md), and
    // the report is flagged machine-specific. --user-config-dir keeps this
    // deterministic by pointing at a fixture instead of the real home dir.
    name: "analyze-user-config",
    args: [
      "test/fixtures/user-config/repo/skip/deep",
      "--repo-root",
      "test/fixtures/user-config/repo",
      "--user-config-dir",
      "test/fixtures/user-config/home",
    ],
  },
  {
    name: "analyze-user-config-json",
    args: [
      "test/fixtures/user-config/repo/skip/deep",
      "--repo-root",
      "test/fixtures/user-config/repo",
      "--user-config-dir",
      "test/fixtures/user-config/home",
      "--json",
    ],
  },
  {
    // --user also folds in ~/.claude/skills and ~/.claude/rules: the user skills
    // merge name-sorted with the project skill under a stable "~/.claude/skills"
    // label (commit-style, rg-check, rg-helper), and a user rule loads always-on
    // as "~/.claude/rules/always-note.md". The path-scoped user rule does not
    // match the entry and only leaves a NOTE.
    name: "analyze-user-skills",
    args: [
      "test/fixtures/user-skills/repo",
      "--repo-root",
      "test/fixtures/user-skills/repo",
      "--user-config-dir",
      "test/fixtures/user-skills/home",
    ],
  },
  {
    name: "analyze-user-skills-json",
    args: [
      "test/fixtures/user-skills/repo",
      "--repo-root",
      "test/fixtures/user-skills/repo",
      "--user-config-dir",
      "test/fixtures/user-skills/home",
      "--json",
    ],
  },
]);
