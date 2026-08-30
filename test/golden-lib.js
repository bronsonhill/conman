// Shared harness for the golden-output tests. Each test/run-golden-*.js file
// imports registerGolden and hands it a slice of the case list; `node --test`
// then runs those files in parallel, and the cases within one file run as
// concurrent subtests.
//
//   node --test test/run-golden-*.js                    # check
//   UPDATE_GOLDEN=1 node --test test/run-golden-*.js     # regenerate goldens
//
// The tool version in the first output line is normalized so a version bump does
// not churn every golden.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileP = promisify(execFile);
import { readFileSync, writeFileSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const CLI = join(ROOT, "dist", "cli.js");
const GOLDEN_DIR = join(ROOT, "test", "golden");
const UPDATE = process.env["UPDATE_GOLDEN"] === "1";

export const MONO = "test/fixtures/monorepo";

function normalize(s) {
  return s
    .replace(/conman \d+\.\d+\.\d+/g, "conman VERSION")
    .replace(/"version": "\d+\.\d+\.\d+"/g, '"version": "VERSION"');
}

async function run(args) {
  try {
    const { stdout } = await execFileP(process.execPath, [CLI, ...args], {
      cwd: ROOT,
      encoding: "utf8",
      maxBuffer: 32 * 1024 * 1024,
    });
    return { code: 0, stdout };
  } catch (err) {
    return { code: err.code ?? 1, stdout: (err.stdout ?? "").toString() };
  }
}

/**
 * @param {string} group  describe-block label, unique per file
 * @param {{name:string, args:string[], html?:boolean}[]} cases
 */
export function registerGolden(group, cases) {
  if (!existsSync(GOLDEN_DIR)) mkdirSync(GOLDEN_DIR, { recursive: true });

  describe(group, { concurrency: true }, () => {
    for (const c of cases) {
      it(c.name, async () => {
        let code;
        let payload;
        if (c.html) {
          // `--html` writes a file, not stdout. Run it, read the file back, and
          // diff that against the golden. Two runs into two paths also proves
          // the output is byte-identical for identical input.
          const out1 = join(tmpdir(), `conman-golden-${c.name}-1.html`);
          const out2 = join(tmpdir(), `conman-golden-${c.name}-2.html`);
          try {
            await run([...c.args, "--html", out1]);
            await run([...c.args, "--html", out2]);
            const html1 = readFileSync(out1, "utf8");
            const html2 = readFileSync(out2, "utf8");
            assert.equal(html1, html2, `${c.name}: HTML output differs between two runs`);
            code = 0;
            payload = html1;
          } finally {
            rmSync(out1, { force: true });
            rmSync(out2, { force: true });
          }
        } else {
          const r = await run(c.args);
          code = r.code;
          payload = r.stdout;
        }
        const actual = `# exit: ${code}\n` + normalize(payload);
        const goldenPath = join(GOLDEN_DIR, `${c.name}.txt`);

        if (UPDATE || !existsSync(goldenPath)) {
          writeFileSync(goldenPath, actual, "utf8");
          if (UPDATE) return;
        }
        const expected = readFileSync(goldenPath, "utf8");
        assert.equal(actual, expected, `golden mismatch for ${c.name} (UPDATE_GOLDEN=1 to refresh)`);
      });
    }
  });
}
