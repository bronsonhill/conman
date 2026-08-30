// Trim mode (Tier 1): delete-only, lowest-value-first advice for a resolved
// stack. It removes nothing itself. It reports the whole-file duplicates the
// duplication finding already proved redundant, keeps exactly one copy of each,
// and emits a unified diff the developer applies with `git apply`.
//
// Scope is deliberately narrow: only clusters the duplication engine flagged as
// `wholeFileDuplicate`. No budget target, no judgement about non-redundant
// content — that is Tier 2, and it is not built here. Because the input is the
// duplication findings and the keeper is chosen deterministically
// (parentFile / preferredKeeper in src/fix.ts: ancestor copy first, else
// CLAUDE.md over AGENTS.md, else lexical), the output is a pure function of the
// tree: run it twice and
// the diff is byte-identical, run it on an already-trimmed tree and there are no
// deletions.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Analysis } from "./types.js";
import { isFile } from "./repo.js";
import { parentFile } from "./fix.js";

export interface TrimDeletion {
  /** Repo-relative POSIX path of the file to delete in full. */
  file: string;
  /** The cluster member whose copy is retained. */
  keeper: string;
  /** Tokens the resolved stack stops paying once `file` is gone. */
  tokens: number;
  /** Line count of the deleted file. */
  lines: number;
  /** How `file` and `keeper` are related, from the duplication finding. */
  relation: string;
}

export interface TrimResult {
  deletions: TrimDeletion[];
  /** Unified diff over all deletions, or "" when there is nothing to trim. */
  diff: string;
  /** Total tokens recovered if every deletion is applied. */
  tokens: number;
}

/** A `git apply`-able hunk that removes every line of `text`. */
function fileDeletionDiff(pathPosix: string, text: string): string {
  const raw = text.split("\n");
  const endsWithNewline = raw.length > 0 && raw[raw.length - 1] === "";
  const body = endsWithNewline ? raw.slice(0, -1) : raw;
  const out: string[] = [
    `diff --git a/${pathPosix} b/${pathPosix}`,
    "deleted file mode 100644",
    `--- a/${pathPosix}`,
    "+++ /dev/null",
    `@@ -1,${body.length} +0,0 @@`,
  ];
  for (const line of body) out.push("-" + line);
  if (!endsWithNewline) out.push("\\ No newline at end of file");
  return out.join("\n") + "\n";
}

export function computeTrim(repoRoot: string, analysis: Analysis): TrimResult {
  const deletions: TrimDeletion[] = [];
  const diffs: string[] = [];

  for (const f of analysis.findings) {
    if (f.type !== "duplication") continue;
    if (!f.detail || f.detail["wholeFileDuplicate"] !== true) continue;
    const files = ((f.detail["files"] as string[] | undefined) ?? []).slice();
    if (files.length < 2) continue;
    const relation = String(f.detail["relation"] ?? "same-stack");
    const keeper = parentFile(files);

    for (const file of files) {
      if (file === keeper) continue;
      const abs = join(repoRoot, file);
      if (!isFile(abs)) continue; // already trimmed, or a synthetic block source
      const text = readFileSync(abs, "utf8");
      if (text === "") continue;
      const lineCount = text.endsWith("\n")
        ? text.split("\n").length - 1
        : text.split("\n").length;
      deletions.push({
        file,
        keeper,
        tokens: analysis.totals.perFile[file] ?? 0,
        lines: lineCount,
        relation,
      });
    }
  }

  // Lowest-value-first: the cheapest redundant file leads the ranked list, so a
  // developer skimming the top sees the safest, least consequential deletions
  // first. Every entry here is provably redundant, so the order is presentation
  // only; ties break on path to keep the output stable. The diff and the token
  // total are order-independent.
  deletions.sort((a, b) => a.tokens - b.tokens || (a.file < b.file ? -1 : 1));

  for (const d of deletions) {
    diffs.push(fileDeletionDiff(d.file, readFileSync(join(repoRoot, d.file), "utf8")));
  }

  return {
    deletions,
    diff: diffs.join(""),
    tokens: deletions.reduce((n, d) => n + d.tokens, 0),
  };
}

const BANNER = "trim (tier 1: delete provably-redundant whole files)";

export function renderTrimHuman(
  result: TrimResult,
  entry: string,
  toolVersion: string,
): string {
  const out: string[] = [];
  out.push(`conman ${toolVersion}  ${BANNER}`);
  out.push(`entry: ${entry || "."}`);
  out.push("");

  if (result.deletions.length === 0) {
    out.push("no provably-redundant whole-file duplicates - nothing to trim");
    return out.join("\n") + "\n";
  }

  const fileW = Math.max(4, ...result.deletions.map((d) => d.file.length));
  out.push("RANKED DELETIONS  (lowest value first)");
  for (const d of result.deletions) {
    out.push(
      `  ${String(d.tokens).padStart(6)} tok  ${d.file.padEnd(fileW)}  ${String(
        d.lines,
      ).padStart(4)} lines  keep ${d.keeper}  [${d.relation}]`,
    );
  }
  out.push(
    `  recoverable: ${result.tokens} tokens across ${result.deletions.length} file${
      result.deletions.length === 1 ? "" : "s"
    }`,
  );
  out.push("");
  out.push("DIFF  (apply with: git apply)");
  out.push(result.diff.replace(/\n$/, ""));
  return out.join("\n") + "\n";
}

export function renderTrimJson(
  result: TrimResult,
  entry: string,
  toolVersion: string,
): string {
  const payload = {
    tool: "conman",
    toolVersion,
    mode: "trim",
    tier: 1,
    entry,
    recoverableTokens: result.tokens,
    deletions: result.deletions.map((d) => ({
      file: d.file,
      keeper: d.keeper,
      relation: d.relation,
      tokens: d.tokens,
      lines: d.lines,
    })),
    diff: result.diff,
  };
  return JSON.stringify(payload, null, 2) + "\n";
}
