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
    name: "analyze-dead-ref",
    args: ["test/fixtures/dead-ref", "--repo-root", "test/fixtures/dead-ref"],
  },
  {
    name: "analyze-dead-ref-json",
    args: ["test/fixtures/dead-ref", "--repo-root", "test/fixtures/dead-ref", "--json"],
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
]);
