# Calibrating `budget.total`

`budget.total` (default 12000) has no published basis — see MODEL.md, "Default
budget numbers, and why". This is the procedure to replace that guess with a
measured knee.

The harness lives at `eval/budget-calibration/` (see its README for design and
every flag). It is a manual research tool: not built, not shipped, not in CI.
**Split of labour:** the harness is built and validated on the branch; the full
expensive sweep is run locally by the captain from a checkout of that branch.

## Before the run

```sh
git checkout fm/conman-budget-calibration
npm ci            # tokenizer is already a dependency; nothing new to install
export ANTHROPIC_API_KEY=sk-ant-...

# Sanity: pipeline works offline, no key needed (~3s)
node eval/budget-calibration/run-sweep.mjs --mock --n 2 --sizes 0,4000,12000 --qualities clean

# Projection: token sizes per cell + call count + rough cost (~15s, no calls)
node eval/budget-calibration/run-sweep.mjs --dry-run --n 100
```

## The full run — primary command

Run from the repo root:

```sh
node eval/budget-calibration/run-sweep.mjs \
  --model claude-opus-5 \
  --n 100 \
  --sizes 0,2000,4000,6000,8000,10000,12000,16000,20000,28000,40000 \
  --qualities clean,messy \
  --needles 8 \
  --distractors 40 \
  --seed 1729 \
  --max-tokens 512 \
  --concurrency 6 \
  --out eval/budget-calibration/results/opus5-full
```

- **Working directory:** repo root (`eval/budget-calibration/run-sweep.mjs` is
  the path).
- **Grid:** 11 sizes × 2 qualities × 100 = **2200 calls**. The extra sizes at
  6k/10k/16k/28k tighten the resolution around where the current default (12k)
  sits.
- **Cost:** measured average prompt is ~13k tokens across the default grid (a bit
  higher with the wider grid, ~14k); output with no thinking / no effort is
  ~40–90 tokens/call. At Opus 5 rates ($5 in / $25 out per MTok):
  `2200 × 14000 × 5/1e6` ≈ **$154 input** + `2200 × 90 × 25/1e6` ≈ $5 output →
  **~$160, expect $130–200** (prompt sizing varies ±2%, output length varies by
  model mood). Run `--dry-run` with the same flags for the exact projection.
- **Wall clock:** 2200 calls at `--concurrency 6` ≈ 367 sequential slots; each
  retrieval call is ~3–8 s → **~25–50 min**. Raise `--concurrency` if your rate
  limit allows; the harness retries 429/5xx with fixed backoff.
- **Results land in** `eval/budget-calibration/results/opus5-full/`:
  `results.json` (full per-trial records + per-cell aggregates + `meta`) and
  `summary.txt` (table + ASCII curve + knee). The summary is also printed to
  stdout.

## High-confidence variant (optional, ~$300)

If the Opus 5 knee is noisy or you want the most capable model's behaviour:

```sh
node eval/budget-calibration/run-sweep.mjs \
  --model claude-fable-5 \
  --n 150 \
  --sizes 0,2000,4000,6000,8000,10000,12000,16000,20000,28000,40000 \
  --qualities clean,messy \
  --concurrency 4 \
  --out eval/budget-calibration/results/fable5-full
```

3300 calls. Fable 5 is $10/$50 per MTok and thinks on every turn, so both cost
and latency climb: **~$280–340**, **~2–4 h** wall clock. Only worth it if the
cheaper run leaves the knee ambiguous.

## Reading the result

`summary.txt` ends with:

```
knee (first size dropping >= knee-drop below the running best)
  clean   <size>
  messy   <size>
```

The `clean` knee is the headline number: the stack size at which a task the
model otherwise aces starts to degrade. The `messy` knee shows how much a
duplicated / self-contradicting stack pulls that in. A defensible `budget.total`
is at or below the `clean` knee, with the gap to the `messy` knee as the margin
argument.

If either knee reads `none in swept range`, the task never degraded across 40k —
widen `--sizes`, raise `--needles`, or shrink `--distractors` to harden it, and
re-run.

## Follow-up (separate PR, not this one)

Once the numbers are in: pick `budget.total`, change the default in
`src/config.ts`, update the MODEL.md "Default budget numbers" row and its
provenance paragraph to cite this sweep (model, N, seed, date, knee), refresh any
golden output that shifts, and note it in `CHANGELOG.md`. That change is
out of scope for the harness PR.
