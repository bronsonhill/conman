// YAML frontmatter parsing. A document has frontmatter when its first line is
// exactly `---` and a later line is exactly `---`. Everything between is YAML.

import YAML from "yaml";

export interface Frontmatter {
  /** Parsed YAML mapping, or {} when there is no frontmatter / it is not a map. */
  data: Record<string, unknown>;
  /** True when a frontmatter fence was present and parsed. */
  present: boolean;
  /** 1-indexed line where the frontmatter block starts (the opening `---`). */
  startLine: number;
  /** 1-indexed line of the closing `---`. 0 when absent. */
  endLine: number;
  /** The raw text between the fences, without the fences. */
  rawYaml: string;
  /** The document body after the closing fence. */
  body: string;
  /** 1-indexed line where the body begins in the original document. */
  bodyStartLine: number;
  /** The first line was exactly `---`, i.e. an opening fence is present. */
  opened: boolean;
  /** An opening `---` was present but no closing `---` line was found. */
  unterminated: boolean;
  /**
   * Set when `YAML.parse` threw on the fenced text: the first line of the
   * parser's message. Undefined when the YAML parsed (or there was none).
   */
  parseError?: string;
}

export function parseFrontmatter(text: string): Frontmatter {
  const lines = text.split("\n");
  const empty: Frontmatter = {
    data: {},
    present: false,
    startLine: 0,
    endLine: 0,
    rawYaml: "",
    body: text,
    bodyStartLine: 1,
    opened: false,
    unterminated: false,
  };
  if (lines[0] !== "---") return empty;
  let close = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i] === "---") {
      close = i;
      break;
    }
  }
  if (close === -1) return { ...empty, opened: true, unterminated: true };
  const rawYaml = lines.slice(1, close).join("\n");
  let data: Record<string, unknown> = {};
  let parseError: string | undefined;
  try {
    const parsed = YAML.parse(rawYaml);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      data = parsed as Record<string, unknown>;
    }
  } catch (err) {
    data = {};
    parseError = String((err as Error)?.message ?? err)
      .split("\n")[0]!
      .replace(/ at line \d+, column \d+:?\s*$/, "")
      .trim();
  }
  return {
    data,
    present: true,
    startLine: 1,
    endLine: close + 1,
    rawYaml,
    body: lines.slice(close + 1).join("\n"),
    bodyStartLine: close + 2,
    opened: true,
    unterminated: false,
    ...(parseError ? { parseError } : {}),
  };
}
