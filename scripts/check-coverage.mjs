#!/usr/bin/env node
// Per-file unit-test line-coverage gate for the modules the coverage push
// targets. Runs the compiled unit tests under node's built-in coverage and
// fails while any target module is below its threshold. Not wired into npm
// test; run manually or from an autonomous loop:
//   npm run build && node scripts/check-coverage.mjs
import { execFileSync } from "node:child_process";
import { readdirSync } from "node:fs";

// Target: >=90% line coverage per file. Basenames are unique across dist/.
const TARGETS = {
  "mapReport.js": 90,
  "vehicleFit.js": 90,
  "lintDuplication.js": 90,
  "reportUtil.js": 90,
  "trim.js": 90,
  "sarif.js": 90,
  "mapHtmlReport.js": 90,
};

const testFiles = [
  ...readdirSync("dist").filter((f) => f.endsWith(".test.js")).map((f) => `dist/${f}`),
  ...readdirSync("dist/findings").filter((f) => f.endsWith(".test.js")).map((f) => `dist/findings/${f}`),
].sort();

let out;
try {
  out = execFileSync(
    process.execPath,
    ["--test", "--experimental-test-coverage", ...testFiles],
    { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
  );
} catch (err) {
  process.stdout.write(err.stdout ?? "");
  process.stderr.write(err.stderr ?? "");
  console.error("check-coverage: unit tests failed; fix tests before checking coverage");
  process.exit(1);
}

const seen = new Map();
for (const line of out.split("\n")) {
  // Coverage table rows look like: "ℹ  mapReport.js | 39.66 | 77.27 | 71.43 | 64-65 ..."
  const m = line.match(/[#ℹ]\s+([A-Za-z0-9_.-]+\.js)\s+\|\s+([0-9.]+)\s+\|/);
  if (m && m[1] in TARGETS) seen.set(m[1], parseFloat(m[2]));
}

let failed = false;
for (const [file, threshold] of Object.entries(TARGETS)) {
  const pct = seen.get(file);
  if (pct === undefined) {
    console.error(`check-coverage: FAIL ${file}: not found in coverage report`);
    failed = true;
  } else if (pct < threshold) {
    console.error(`check-coverage: FAIL ${file}: ${pct}% lines < ${threshold}%`);
    failed = true;
  } else {
    console.log(`check-coverage: ok   ${file}: ${pct}% lines >= ${threshold}%`);
  }
}
process.exit(failed ? 1 : 0);
