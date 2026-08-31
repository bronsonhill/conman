// conman budget calibration -- deterministic size-sweep harness.
//
// Puts an empirical number behind conman's budget.total default. A fixed
// retrieval task the model normally aces is run behind a synthetic context
// stack whose size is swept over a list of token counts, at two qualities
// (clean / messy). The stack size where the score starts to fall is the
// candidate defensible budget.total.
//
// This is a manual research tool: not built, not shipped, not in CI, not in the
// fixture corpus. The only network path is the real model provider, which reads
// ANTHROPIC_API_KEY from the environment. Everything else is offline and
// deterministic given --seed.
//
//   node eval/budget-calibration/run-sweep.mjs --help
//
// See eval/budget-calibration/README.md for every flag and docs/budget-calibration.md
// for the full-run command.

import { mkdirSync, writeFileSync } from "node:fs";
import { resolve, join } from "node:path";
import { countTokens } from "@anthropic-ai/tokenizer";
import { buildTask, composePrompt, scoreResponse } from "./lib/task.mjs";
import { buildStack } from "./lib/stack.mjs";
import { complete, costUSD, PRICE_TABLE } from "./lib/model.mjs";
import { aggregate, findKnee, renderSummary } from "./lib/render.mjs";

const HERE = resolve(new URL(".", import.meta.url).pathname);

const DEFAULTS = {
  model: "claude-opus-5",
  n: 20,
  sizes: "0,2000,4000,8000,12000,20000,40000",
  qualities: "clean,messy",
  needles: 8,
  distractors: 40,
  seed: 1729,
  effort: "", // unset -> output_config omitted; e.g. "low" | "high"
  thinking: false, // adaptive thinking on/off
  "max-tokens": 512,
  concurrency: 4,
  "size-tolerance": 0.02,
  "knee-drop": 0.05,
  mock: false,
  "dry-run": false,
  out: "", // default derived from model/n/seed
};

function parseArgs(argv) {
  const opts = { ...DEFAULTS };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--help" || a === "-h") return { help: true };
    if (!a.startsWith("--")) throw new Error(`unexpected arg: ${a}`);
    const key = a.slice(2);
    if (!(key in DEFAULTS)) throw new Error(`unknown flag: ${a}`);
    if (typeof DEFAULTS[key] === "boolean") {
      opts[key] = true;
      continue;
    }
    const val = argv[++i];
    if (val === undefined) throw new Error(`flag ${a} needs a value`);
    opts[key] = typeof DEFAULTS[key] === "number" ? Number(val) : val;
  }
  return { opts };
}

function help() {
  const rows = Object.entries(DEFAULTS).map(
    ([k, v]) => `  --${k.padEnd(16)} ${String(v === "" ? "(unset)" : v)}`,
  );
  process.stdout.write(
    [
      "conman budget calibration -- size-sweep harness",
      "",
      "Usage: node eval/budget-calibration/run-sweep.mjs [flags]",
      "",
      "Flags (name / default):",
      ...rows,
      "",
      "  --model            model id passed to the Messages API",
      "  --n                trials per (size, quality) cell",
      "  --sizes            comma-separated stack sizes in tokens; 0 = no stack",
      "  --qualities        subset of: clean,messy",
      "  --needles          target codes planted in the haystack per trial",
      "  --distractors      same-shaped decoy facts per trial",
      "  --seed             top-level seed; every cell derives its own stream",
      "  --effort           output_config.effort (low|medium|high|xhigh|max); unset = omit",
      "  --thinking         enable adaptive thinking (off by default)",
      "  --max-tokens       response cap",
      "  --concurrency      parallel in-flight API calls",
      "  --size-tolerance   fractional slack when sizing the stack",
      "  --knee-drop        score drop from running best that marks the knee",
      "  --mock             deterministic offline provider; makes no API calls",
      "  --dry-run          build every prompt, print token sizes + projected cost, no calls",
      "  --out              results directory (default: results/<model>-n<N>-seed<seed>)",
      "",
      "Outputs <out>/results.json and <out>/summary.txt, and prints the summary.",
      "",
    ].join("\n") + "\n",
  );
}

async function pool(items, concurrency, worker) {
  const results = new Array(items.length);
  let next = 0;
  async function run() {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      results[i] = await worker(items[i], i);
    }
  }
  await Promise.all(
    Array.from({ length: Math.max(1, concurrency) }, run),
  );
  return results;
}

async function main() {
  const { help: wantHelp, opts } = parseArgs(process.argv.slice(2));
  if (wantHelp) return help();

  const sizes = opts.sizes
    .split(",")
    .map((s) => Number(s.trim()))
    .filter((n) => Number.isFinite(n))
    .sort((a, b) => a - b);
  const qualities = opts.qualities.split(",").map((s) => s.trim()).filter(Boolean);
  const provider = opts.mock ? "mock" : "real";

  // Build every trial spec up front (deterministic).
  const specs = [];
  for (const size of sizes) {
    for (const quality of qualities) {
      for (let trial = 0; trial < opts.n; trial++) {
        const key = `${opts.seed}:${size}:${quality}:${trial}`;
        const task = buildTask({
          key,
          needles: opts.needles,
          distractors: opts.distractors,
        });
        const stack =
          size > 0
            ? buildStack({
                key,
                targetTokens: size,
                quality,
                tolerance: opts["size-tolerance"],
              })
            : { text: "", tokens: 0, paragraphs: 0, duplicateRatio: 0, conflictPairs: 0 };
        const user = composePrompt({ task, stack: stack.text });
        specs.push({ size, quality, trial, key, task, stack, user });
      }
    }
  }

  if (opts["dry-run"]) {
    return dryRun(opts, sizes, qualities, specs);
  }

  process.stderr.write(
    `running ${specs.length} calls (${sizes.length} sizes x ${qualities.length} qualities x ${opts.n}) ` +
      `via ${provider} provider, concurrency ${opts.concurrency}\n`,
  );

  let done = 0;
  const records = await pool(specs, opts.concurrency, async (spec) => {
    const res = await complete({
      provider,
      model: opts.model,
      user: spec.user,
      maxTokens: opts["max-tokens"],
      effort: opts.effort,
      thinking: opts.thinking,
      mockContext: {
        expected: spec.task.expected,
        key: spec.key,
        sizeTokens: spec.stack.tokens,
        quality: spec.quality,
      },
    });
    const { score, got } = scoreResponse(res.text, spec.task.expected);
    done++;
    if (done % 10 === 0 || done === specs.length) {
      process.stderr.write(`  ${done}/${specs.length}\n`);
    }
    return {
      size: spec.size,
      quality: spec.quality,
      trial: spec.trial,
      key: spec.key,
      stackTokens: spec.stack.tokens,
      duplicateRatio: spec.stack.duplicateRatio,
      conflictPairs: spec.stack.conflictPairs,
      score,
      expected: spec.task.expected,
      got,
      usage: res.usage,
      costUSD: costUSD(opts.model, res.usage),
      latencyMs: res.latencyMs,
    };
  });

  // Group into cells.
  const cellMap = new Map();
  for (const r of records) {
    const k = `${r.size}::${r.quality}`;
    if (!cellMap.has(k)) cellMap.set(k, { size: r.size, quality: r.quality, trials: [] });
    cellMap.get(k).trials.push(r);
  }
  const cells = aggregate(
    [...cellMap.values()].sort(
      (a, b) => a.size - b.size || a.quality.localeCompare(b.quality),
    ),
  );

  const byQuality = {};
  for (const q of qualities) {
    byQuality[q] = cells
      .filter((c) => c.quality === q)
      .map((c) => ({ size: c.size, meanScore: c.agg.meanScore }));
  }
  const knee = findKnee(sizes, byQuality, opts["knee-drop"]);

  const meta = {
    provider,
    model: opts.model,
    n: opts.n,
    seed: opts.seed,
    needles: opts.needles,
    distractors: opts.distractors,
    effort: opts.effort,
    thinking: opts.thinking,
    maxTokens: opts["max-tokens"],
    sizes,
    qualities,
    knee,
    priceTable: PRICE_TABLE,
    generatedAt: new Date().toISOString(),
    argv: process.argv.slice(2),
  };

  const summary = renderSummary({ meta, cells, sizes, qualities, knee });

  const outDir = resolve(
    opts.out
      ? opts.out
      : join(HERE, "results", `${opts.model}-n${opts.n}-seed${opts.seed}${provider === "mock" ? "-mock" : ""}`),
  );
  mkdirSync(outDir, { recursive: true });
  writeFileSync(
    join(outDir, "results.json"),
    JSON.stringify({ meta, cells }, null, 2) + "\n",
  );
  writeFileSync(join(outDir, "summary.txt"), summary + "\n");

  process.stdout.write("\n" + summary + "\n");
  process.stderr.write(`\nwrote ${join(outDir, "results.json")}\n`);
  process.stderr.write(`wrote ${join(outDir, "summary.txt")}\n`);
}

function dryRun(opts, sizes, qualities, specs) {
  const price = PRICE_TABLE[opts.model];
  const L = [];
  L.push("DRY RUN -- no API calls");
  L.push(`model ${opts.model}  n ${opts.n}  seed ${opts.seed}`);
  L.push("");
  L.push(
    ["size".padStart(7), "quality".padEnd(7), "stack_tok".padStart(10), "prompt_tok".padStart(11)].join("  "),
  );
  L.push("-".repeat(40));
  const seen = new Set();
  let promptTokTotal = 0;
  for (const s of specs) {
    const pt = countTokens(s.user);
    promptTokTotal += pt;
    const k = `${s.size}::${s.quality}`;
    if (seen.has(k)) continue;
    seen.add(k);
    L.push(
      [
        String(s.size).padStart(7),
        s.quality.padEnd(7),
        String(s.stack.tokens).padStart(10),
        String(pt).padStart(11),
      ].join("  "),
    );
  }
  L.push("");
  const calls = specs.length;
  const avgIn = Math.round(promptTokTotal / calls);
  const estOut = opts.needles * 8; // ~one short line per needle
  L.push(`calls              ${calls}`);
  L.push(`avg prompt tokens  ${avgIn}`);
  L.push(`est output tokens  ${estOut} / call`);
  if (price) {
    const est =
      (calls * avgIn * price[0] + calls * estOut * price[1]) / 1_000_000;
    L.push(`est cost (${opts.model})  ~$${est.toFixed(2)}  [${price[0]}/${price[1]} per MTok]`);
  } else {
    L.push(`est cost           unknown model, not in price table`);
  }
  process.stdout.write(L.join("\n") + "\n");
}

main().catch((err) => {
  process.stderr.write(`\nERROR: ${err.stack || err.message}\n`);
  process.exitCode = 1;
});
