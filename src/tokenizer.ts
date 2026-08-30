// Token costing.
//
// Default is `claude-local`: Anthropic's released Claude tokenizer, bundled by
// @anthropic-ai/tokenizer, run entirely offline. It is not the current
// frontier-model vocab (Anthropic has not published that), so treat its output
// as an estimate: on prose and markdown it tracks the API's count_tokens within
// roughly a few percent. What matters here is determinism -- the same text
// always costs the same -- and budgets are set against this counter, not the API.
//
// `exact` is the opt-in seam: it calls Anthropic's `POST /v1/messages/count_tokens`
// and is the ONLY code path in conman that ever touches the network. It is
// gated twice -- the caller must pass `--tokenizer exact` AND the environment
// must carry ANTHROPIC_API_KEY. Nothing else can reach the remote path. See
// MODEL.md "The tokenizer is an estimate".

import { execFileSync } from "node:child_process";
import anthropicTokenizer from "@anthropic-ai/tokenizer";

export interface Tokenizer {
  readonly name: string;
  countTokens(text: string): number;
}

/** Env var that must hold the API key for `--tokenizer exact`. Never a flag, never a file. */
export const EXACT_API_KEY_ENV = "ANTHROPIC_API_KEY";

/** Model whose vocab the exact count is taken against. Override for testing/pinning. */
const EXACT_MODEL = process.env.CONMAN_EXACT_MODEL || "claude-opus-5";

const EXACT_ENDPOINT = "https://api.anthropic.com/v1/messages/count_tokens";

class LocalClaudeTokenizer implements Tokenizer {
  readonly name = "claude-local";
  private cache = new Map<string, number>();

  countTokens(text: string): number {
    if (text.length === 0) return 0;
    const hit = this.cache.get(text);
    if (hit !== undefined) return hit;
    const n = anthropicTokenizer.countTokens(text);
    this.cache.set(text, n);
    return n;
  }
}

/**
 * Exact token counts from Anthropic's `count_tokens` API.
 *
 * The Tokenizer contract is synchronous, so the HTTP call is made synchronously
 * with `curl` via `execFileSync`. One request per distinct block; byte-identical
 * blocks (common in a duplicated context stack) are served from the cache, so a
 * `map` run over a large repo makes tens of calls, not thousands.
 *
 * `count_tokens` wraps the text in a one-message prompt, so its raw count
 * includes a fixed framing overhead (the `Human:` turn structure). That
 * overhead is measured once from a short probe and subtracted, leaving a number
 * directly comparable to the local tokenizer's text-only count.
 */
class RemoteTokenizer implements Tokenizer {
  readonly name = "exact";
  private cache = new Map<string, number>();
  private apiKey: string;
  private overhead: number | null = null;

  constructor(apiKey: string) {
    this.apiKey = apiKey;
  }

  private rawCount(text: string): number {
    const body = JSON.stringify({
      model: EXACT_MODEL,
      messages: [{ role: "user", content: text }],
    });
    let out: string;
    try {
      out = execFileSync(
        "curl",
        [
          "-sS",
          "--fail-with-body",
          "-X",
          "POST",
          EXACT_ENDPOINT,
          "-H",
          `x-api-key: ${this.apiKey}`,
          "-H",
          "anthropic-version: 2023-06-01",
          "-H",
          "content-type: application/json",
          "--data-binary",
          "@-",
        ],
        { input: body, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 },
      );
    } catch (err) {
      const e = err as { stdout?: string; stderr?: string; message?: string };
      const detail = (e.stdout || e.stderr || e.message || "").toString().trim();
      throw new Error(`exact tokenizer: count_tokens request failed: ${detail}`);
    }
    let parsed: { input_tokens?: number };
    try {
      parsed = JSON.parse(out);
    } catch {
      throw new Error(`exact tokenizer: unparseable count_tokens response: ${out.slice(0, 200)}`);
    }
    if (typeof parsed.input_tokens !== "number") {
      throw new Error(`exact tokenizer: count_tokens response had no input_tokens: ${out.slice(0, 200)}`);
    }
    return parsed.input_tokens;
  }

  private framingOverhead(): number {
    if (this.overhead === null) {
      const probe = "conman probe";
      this.overhead = this.rawCount(probe) - anthropicTokenizer.countTokens(probe);
      if (this.overhead < 0) this.overhead = 0;
    }
    return this.overhead;
  }

  countTokens(text: string): number {
    if (text.length === 0) return 0;
    const hit = this.cache.get(text);
    if (hit !== undefined) return hit;
    const n = Math.max(0, this.rawCount(text) - this.framingOverhead());
    this.cache.set(text, n);
    return n;
  }
}

export function getTokenizer(name = "claude-local"): Tokenizer {
  switch (name) {
    case "claude-local":
      return new LocalClaudeTokenizer();
    case "exact": {
      const apiKey = process.env[EXACT_API_KEY_ENV];
      if (!apiKey) {
        throw new Error(
          `--tokenizer exact needs ${EXACT_API_KEY_ENV} in the environment; ` +
            `it is the only path that makes a network call and the key is read from ` +
            `${EXACT_API_KEY_ENV} only, never a flag or a file`,
        );
      }
      return new RemoteTokenizer(apiKey);
    }
    default:
      throw new Error(
        `unknown tokenizer "${name}"; supported: claude-local (default, offline), exact (opt-in, calls count_tokens)`,
      );
  }
}
