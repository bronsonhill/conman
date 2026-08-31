import { test } from "node:test";
import assert from "node:assert/strict";
import { analyzeEntry } from "../analyze.js";
import { DEFAULT_CONFIG } from "../config.js";
import { fixture } from "../testutil.js";

test("monorepo/services/api: value-conflict on `node version` with both values and locations", () => {
  const root = fixture("monorepo");
  const { analysis } = analyzeEntry(fixture("monorepo", "services", "api"), {
    repoRoot: root,
    config: DEFAULT_CONFIG,
  });

  const conflict = analysis.findings.find((f) => f.type === "value-conflict");
  assert.ok(conflict, "expected a value-conflict finding");
  assert.equal(conflict!.detail?.["key"], "node version");
  assert.deepEqual(conflict!.detail?.["values"], ["20", "22"]);
  assert.equal(conflict!.locations.length, 2);
});
