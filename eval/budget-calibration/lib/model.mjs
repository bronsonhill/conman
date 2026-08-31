// Model providers for the sweep.
//
//   real  -- POST /v1/messages with a fetch wrapper and bounded retry. The only
//            network path in this harness. Reads ANTHROPIC_API_KEY from the
//            environment (never a flag, never a file), matching conman's own
//            `--tokenizer exact` seam.
//   mock  -- fully deterministic. Returns the expected codes, flipping some to
//            wrong with a probability that grows with stack size and messiness,
//            derived from a hash of the cell key (no runtime randomness). Use it
//            to validate the pipeline, the aggregation, and the curve/knee logic
//            offline and for $0.

import { countTokens } from "@anthropic-ai/tokenizer";
import { xmur3 } from "./prng.mjs";
import { SYSTEM_PROMPT } from "./task.mjs";

const ENDPOINT = "https://api.anthropic.com/v1/messages";
const API_VERSION = "2023-06-01";

/** $/MTok [input, output]. Unknown model -> cost reported as null. */
export const PRICE_TABLE = {
  "claude-opus-5": [5, 25],
  "claude-opus-4-8": [5, 25],
  "claude-opus-4-7": [5, 25],
  "claude-fable-5": [10, 50],
  "claude-sonnet-5": [2, 10],
  "claude-sonnet-4-6": [3, 15],
  "claude-haiku-4-5": [1, 5],
};

export function costUSD(model, usage) {
  const p = PRICE_TABLE[model];
  if (!p || !usage) return null;
  const inTok = usage.input_tokens ?? 0;
  const outTok = usage.output_tokens ?? 0;
  return (inTok * p[0] + outTok * p[1]) / 1_000_000;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * One completion. Returns { text, usage: {input_tokens, output_tokens}, latencyMs }.
 * Throws on non-retryable errors and after the retry budget is spent.
 */
export async function complete({
  provider,
  model,
  system = SYSTEM_PROMPT,
  user,
  maxTokens,
  effort = "",
  thinking = false,
  mockContext = null,
  retries = 5,
}) {
  if (provider === "mock") {
    return mockComplete({ user, mockContext });
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new Error(
      "real provider needs ANTHROPIC_API_KEY in the environment " +
        "(read from the env only, never a flag or file). " +
        "Use --mock for an offline pipeline check.",
    );
  }

  const body = {
    model,
    max_tokens: maxTokens,
    system,
    messages: [{ role: "user", content: user }],
  };
  if (thinking) body.thinking = { type: "adaptive" };
  if (effort) body.output_config = { effort };

  let attempt = 0;
  for (;;) {
    const started = Date.now();
    let res;
    try {
      res = await fetch(ENDPOINT, {
        method: "POST",
        headers: {
          "x-api-key": apiKey,
          "anthropic-version": API_VERSION,
          "content-type": "application/json",
        },
        body: JSON.stringify(body),
      });
    } catch (err) {
      if (attempt++ >= retries) throw err;
      await sleep(backoff(attempt));
      continue;
    }

    if (res.ok) {
      const json = await res.json();
      const text = (json.content || [])
        .filter((b) => b.type === "text")
        .map((b) => b.text)
        .join("");
      return { text, usage: json.usage || {}, latencyMs: Date.now() - started };
    }

    const retryable = res.status === 429 || res.status >= 500;
    const detail = await res.text().catch(() => "");
    if (!retryable || attempt++ >= retries) {
      throw new Error(`messages API ${res.status}: ${detail.slice(0, 400)}`);
    }
    const ra = Number(res.headers.get("retry-after"));
    await sleep(Number.isFinite(ra) && ra > 0 ? ra * 1000 : backoff(attempt));
  }
}

function backoff(attempt) {
  // Fixed schedule, no jitter -- keeps the run reproducible in shape.
  return Math.min(30_000, 1000 * 2 ** (attempt - 1));
}

/**
 * Deterministic stand-in. `mockContext` carries { expected, key, sizeTokens,
 * quality }. Probability a given code is returned wrong ramps from ~0 below 8k
 * to ~0.55 at 40k, plus a messy-stack penalty -- enough to put a visible knee
 * near 8k-12k so the curve and knee-finder can be exercised without spend.
 */
function mockComplete({ user, mockContext }) {
  if (!mockContext) {
    return Promise.resolve({
      text: "",
      usage: { input_tokens: countTokens(user), output_tokens: 0 },
      latencyMs: 0,
    });
  }
  const { expected, key, sizeTokens, quality } = mockContext;
  const size = sizeTokens || 0;
  const ramp = size <= 8000 ? size / 8000 * 0.08 : 0.08 + ((size - 8000) / 32000) * 0.47;
  const pWrong = Math.min(0.7, ramp + (quality === "messy" ? 0.14 : 0));

  const lines = expected.map((code, i) => {
    const h = xmur3(`mock:${key}:${i}`) / 4294967296;
    if (h < pWrong) {
      // Deterministic wrong answer: rotate the digits.
      return code.slice(1) + code[0];
    }
    return code;
  });

  const text = lines.join("\n");
  return Promise.resolve({
    text,
    usage: {
      input_tokens: countTokens(user) + 16,
      output_tokens: countTokens(text) + 4,
    },
    latencyMs: 0,
  });
}
