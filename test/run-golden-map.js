// Golden tests for `conman map` output. See test/golden-lib.js.
import { registerGolden, MONO } from "./golden-lib.js";

registerGolden("golden/map", [
  { name: "map-monorepo", args: ["map", MONO, "--repo-root", MONO] },
  { name: "map-monorepo-json", args: ["map", MONO, "--repo-root", MONO, "--json"] },
  { name: "map-monorepo-html", args: ["map", MONO, "--repo-root", MONO], html: true },
  {
    name: "check-map-monorepo-html",
    args: ["check", MONO, "--map", "--repo-root", MONO],
    html: true,
  },
  {
    name: "map-rule-entry",
    args: ["map", "test/fixtures/rule-entry", "--repo-root", "test/fixtures/rule-entry"],
  },
  {
    name: "map-rule-entry-json",
    args: ["map", "test/fixtures/rule-entry", "--repo-root", "test/fixtures/rule-entry", "--json"],
  },
  {
    name: "map-frontmatter-broken",
    args: [
      "map",
      "test/fixtures/frontmatter-broken",
      "--repo-root",
      "test/fixtures/frontmatter-broken",
    ],
  },
  {
    name: "map-fix-dryrun-monorepo",
    args: ["map", MONO, "--repo-root", MONO, "--fix", "--dry-run"],
  },
  {
    name: "map-cursor",
    args: [
      "map",
      "test/fixtures/cursor-rules",
      "--repo-root",
      "test/fixtures/cursor-rules",
      "--agent",
      "cursor",
    ],
  },
  {
    name: "map-copilot",
    args: [
      "map",
      "test/fixtures/copilot",
      "--repo-root",
      "test/fixtures/copilot",
      "--agent",
      "copilot",
    ],
  },
]);
