# Budget calibration harness

A deterministic size-sweep that puts an empirical number behind conman's
`budget.total` default. It is a **manual research tool**: not built, not shipped,
not run in CI, not part of the fixture corpus. Nothing under `src/` imports it.

## What it does

1. **Fixed downstream task** the model normally aces: multi-needle retrieval
   ("lost in the middle"). Each trial plants `--needles` `access code` facts in a
   small haystack of `--distractors` same-shaped decoy facts, then asks for every
   code, one per line, digits only. Scoring is a regex extract plus a
   position-wise exact match — no LLM judge, no agent loop. Score per trial is
   the fraction of codes returned exactly right.

2. **Synthetic context stack** prepended ahead of the task, sized to a target
   token count (measured with the bundled offline `@anthropic-ai/tokenizer`, the
   same counter conman's default path uses). Two qualities:
   - `clean` — unique, coherent instruction paragraphs, no contradictions.
   - `messy` — the clean stack plus verbatim duplicated paragraphs (~35% by
     token weight) and up to four directly contradictory directive pairs
     (`Always respond in strict JSON` vs `Never respond in JSON`, tabs vs
     spaces, `make all` vs `npm run build`, …). Models a real stack grown by
     accretion. Sized to the **same** target token count as `clean` for the
     cell, so structure is the only variable.

3. **Sweep** the stack size over `--sizes` (default `0,2000,4000,8000,12000,
   20000,40000`) at each quality, `--n` trials per cell, every trial seeded from
   `--seed`.

4. **Output** (`<out>/results.json` + `<out>/summary.txt`, summary also printed):
   a per-cell table (score ± sd, mean input/output tokens, cost), an ASCII
   score-vs-size curve per quality, and the **knee** — the first swept size whose
   mean score falls `--knee-drop` or more below the running best. The knee is the
   candidate defensible `budget.total`.

## Determinism

Same `--seed` and flags → same `summary.txt` bytes and same `results.json`
(except `meta.generatedAt` and `meta.argv`). No `Date` in scored output, no
`Math.random`, fixed retry backoff. The only network path is the `real` model
provider.

## Providers

| Provider | How | Cost |
|---|---|---|
| `real` (default) | `POST /v1/messages` via a `fetch` wrapper with bounded retry. Reads `ANTHROPIC_API_KEY` from the environment only — never a flag, never a file, matching conman's own `--tokenizer exact` seam. | model rates |
| `mock` (`--mock`) | Fully deterministic. Returns the expected codes, flipping some to wrong with a probability that ramps with stack size and messiness, derived from a hash of the cell key (no runtime randomness). Puts a visible knee near 8k–12k so the aggregation and curve/knee logic can be exercised offline. | $0 |

## Flags

Run `node eval/budget-calibration/run-sweep.mjs --help` for the list with live
defaults. Every knob is a flag; defaults are recorded in `DEFAULTS` at the top of
`run-sweep.mjs` and echoed into `results.json` `meta`.

| Flag | Default | Meaning |
|---|---|---|
| `--model` | `claude-opus-5` | model id sent to the Messages API |
| `--n` | `20` | trials per (size, quality) cell |
| `--sizes` | `0,2000,4000,8000,12000,20000,40000` | stack sizes in tokens; `0` = no stack |
| `--qualities` | `clean,messy` | subset of `clean,messy` |
| `--needles` | `8` | target codes planted per trial |
| `--distractors` | `40` | same-shaped decoy facts per trial |
| `--seed` | `1729` | top-level seed; each cell derives its own stream |
| `--effort` | *(unset)* | `output_config.effort` (`low`…`max`); unset omits `output_config`. Not supported on Haiku — leave unset there. |
| `--thinking` | `false` | enable adaptive thinking |
| `--max-tokens` | `512` | response cap |
| `--concurrency` | `4` | parallel in-flight API calls |
| `--size-tolerance` | `0.02` | fractional slack when sizing the stack |
| `--knee-drop` | `0.05` | score drop from running best that marks the knee |
| `--mock` | `false` | use the deterministic offline provider |
| `--dry-run` | `false` | build every prompt, print token sizes + projected call count and cost, make no API calls |
| `--out` | *(derived)* | results directory; default `results/<model>-n<N>-seed<seed>` |

## Quick checks

```sh
# Offline pipeline smoke (no key, ~3s):
node eval/budget-calibration/run-sweep.mjs --mock --n 2 --sizes 0,4000,12000 --qualities clean

# Cost/size projection before a real run (no key, ~15s for the full grid):
node eval/budget-calibration/run-sweep.mjs --dry-run --n 20
```

## Full run

See `docs/budget-calibration.md` for the exact command, cost/time estimate, and
where results land.

## Files

```
run-sweep.mjs      CLI: arg parse, spec build, concurrency pool, output
lib/prng.mjs       mulberry32 + xmur3 string-seeded PRNG
lib/task.mjs       needle-in-haystack generation + regex/exact-match scoring
lib/stack.mjs      synthetic clean / messy context stack, token-sized
lib/model.mjs      real (fetch) + mock providers, price table, cost
lib/render.mjs     aggregation, ASCII curve, knee finder, summary text
results/           run outputs (gitignored)
```
