// Token costing.
//
// Default is `claude-local`: Anthropic's released Claude tokenizer, bundled by
// @anthropic-ai/tokenizer, run entirely offline. It is not the current
// frontier-model vocab (Anthropic has not published that), so treat its output
// as an estimate: on prose and markdown it tracks the API's count_tokens within
// roughly a few percent. What matters here is determinism -- the same text
// always costs the same -- and budgets are set against this counter, not the API.
//
// `exact` is a seam only. No network code ships in the MVP.

import anthropicTokenizer from "@anthropic-ai/tokenizer";

export interface Tokenizer {
  readonly name: string;
  countTokens(text: string): number;
}

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

class RemoteTokenizer implements Tokenizer {
  readonly name = "exact";
  countTokens(_text: string): number {
    throw new Error(
      "exact-mode token counting is not implemented in the MVP; it is a documented seam only",
    );
  }
}

export function getTokenizer(name = "claude-local"): Tokenizer {
  switch (name) {
    case "claude-local":
      return new LocalClaudeTokenizer();
    case "exact":
      return new RemoteTokenizer();
    default:
      throw new Error(
        `unknown tokenizer "${name}"; supported: claude-local (default), exact (seam, unimplemented)`,
      );
  }
}
