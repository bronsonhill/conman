// Shared data shapes for the conman analysis pipeline.
//
// Everything here is plain data. The pipeline is: resolver -> blocks, coster ->
// per-block token counts, findings engine -> findings, report renderer -> text.

/** conman analysis-model version; bump when resolution semantics change. */
export const MODEL_VERSION = "0.8";

export type BlockKind =
  | "memory" // an ancestor CLAUDE.md / AGENTS.md
  | "import" // an @-imported file, inlined at its import site
  | "rule-always" // a .claude/rules entry with no path scope
  | "rule-scoped" // a .claude/rules entry whose glob matched the entry path
  | "skill-index"; // the skill startup listing

export interface Block {
  /** Stable identifier, assigned in load order: "b1", "b2", ... */
  id: string;
  kind: BlockKind;
  /** Repo-relative POSIX path of the source file. */
  source: string;
  /** 1-indexed inclusive line span within `source`. */
  lineStart: number;
  lineEnd: number;
  /** Raw text of this block, used verbatim for token costing. */
  text: string;
  /** @-import depth: 0 for a file read directly, 1 for its imports, etc. */
  depth: number;
  /**
   * For imports: "CLAUDE.md:12" — the file:line the @-reference sits on.
   * Undefined for non-imports.
   */
  via?: string;
  /** Token count, filled in by the coster. */
  tokens: number;
}

/** A sub-region of a block's text, used for duplication and conflict detection. */
export interface Segment {
  source: string;
  lineStart: number;
  lineEnd: number;
  /** Trimmed text of the segment. */
  text: string;
  /** True when the segment is a single markdown heading line and nothing else. */
  headingOnly: boolean;
  /** True when the segment is a fenced code block. */
  fenced: boolean;
  tokens: number;
}

export type FindingType =
  | "duplication"
  | "unlinked-copy"
  | "value-conflict"
  | "vehicle-fit"
  | "frontmatter"
  | "lint-duplication"
  | "stale-boilerplate"
  | "dead-reference"
  | "max-skills"
  | "per-file-budget"
  | "skill-index-budget";
export type Severity = "error" | "warn" | "off";

export interface Location {
  /** Repo-relative POSIX path. */
  file: string;
  lineStart: number;
  lineEnd: number;
}

export interface Finding {
  type: FindingType;
  severity: Severity;
  /** One-line human summary. */
  message: string;
  /** Locations this finding points at, in report order. At least one. */
  locations: Location[];
  /** Token cost attributed to the finding, when meaningful. */
  tokens?: number;
  /** Extra structured detail for the JSON report. */
  detail?: Record<string, unknown>;
}

export interface Totals {
  /** Sum of all block token counts. */
  stackTokens: number;
  /** Per-file token subtotals, keyed by repo-relative path, sorted by key. */
  perFile: Record<string, number>;
  skillIndexTokens: number;
}

export interface BudgetReport {
  total: number;
  safetyMargin: number;
  /** total * (1 - safetyMargin), rounded. The line the gate compares against. */
  effective: number;
  stackTotal: number;
  /** stackTotal - effective. Positive means over budget. */
  delta: number;
  overBudget: boolean;
}

export interface Analysis {
  /** conman analysis-model version; bump when resolution semantics change. */
  modelVersion: string;
  /** Repo-relative POSIX path of the entry point. */
  entry: string;
  tokenizer: string;
  blocks: Block[];
  totals: Totals;
  budget: BudgetReport;
  findings: Finding[];
  /**
   * Budget / findings gate verdict. Computed once in `analyzeEntry` so every
   * renderer reads the same result instead of re-running `evaluateGate`.
   */
  gate: GateResult;
}

export interface GateResult {
  pass: boolean;
  /** Human-readable reasons the gate failed. Empty when it passed. */
  reasons: string[];
  /** Process exit code: 0 pass, 1 fail. */
  exitCode: number;
}
