// Golden tests for `conman check`, `--fix`, `--trim`, and `explain`.
// See test/golden-lib.js.
import { registerGolden, MONO } from "./golden-lib.js";

registerGolden("golden/check-fix", [
  { name: "explain-list", args: ["explain"] },
  { name: "explain-duplication", args: ["explain", "duplication"] },
  { name: "explain-per-file-budget", args: ["explain", "per-file-budget"] },
  { name: "explain-skill-index-budget", args: ["explain", "skill-index-budget"] },
  { name: "check-monorepo", args: ["check", `${MONO}/services/api`, "--repo-root", MONO] },
  { name: "check-clean", args: ["check", "test/fixtures/clean", "--repo-root", "test/fixtures/clean"] },
  {
    name: "fix-dryrun-monorepo",
    args: [`${MONO}/services/api`, "--repo-root", MONO, "--fix", "--dry-run"],
  },
  {
    name: "trim-dup",
    args: [
      "test/fixtures/trim-dup/pkg",
      "--repo-root",
      "test/fixtures/trim-dup",
      "--trim",
    ],
  },
  {
    name: "trim-dup-json",
    args: [
      "test/fixtures/trim-dup/pkg",
      "--repo-root",
      "test/fixtures/trim-dup",
      "--trim",
      "--json",
    ],
  },
  {
    name: "trim-monorepo-noop",
    args: [`${MONO}/services/api`, "--repo-root", MONO, "--trim"],
  },
]);
