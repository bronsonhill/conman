// Static reference copy for every finding type: a one-paragraph explanation, the
// research citations already carried in README.md / MODEL.md for that class of
// problem, and the remediation. `conman explain <id>` renders one entry;
// `conman explain` with no argument lists the ids. The same table feeds the
// SARIF `rules` descriptions (see `sarif.ts`), so keep the text plain and
// self-contained.

import type { FindingType } from "./types.js";

export interface FindingInfo {
  /** Short human title. */
  title: string;
  /** One paragraph, no line breaks. */
  explanation: string;
  /** Research citations, verbatim from README.md "What the research says". */
  citations: string[];
  /** What to do about it. One or two sentences. */
  remediation: string;
}

export const FINDING_INFO: Record<FindingType, FindingInfo> = {
  duplication: {
    title: "Duplicated block",
    explanation:
      "A run of text (a heading- or blank-line-delimited segment, or a whole fenced code block) whose trimmed bytes are identical in two or more files of the resolved stack. Every copy past the first is loaded into the same session context, so it is paid for on every request with no added information. When every qualifying segment of one file also appears in another, the whole file is flagged as one duplicate rather than segment by segment.",
    citations: [
      "Configuration Smells in AGENTS.md Files (dos Santos et al., June 2026), https://arxiv.org/abs/2606.15828 — a scan of 100 popular repos found lint rules the linter already enforces in 62% of files and general context bloat in 42%.",
      "Evaluating AGENTS.md (Gloaguen et al., Feb 2026), https://arxiv.org/abs/2602.11988 — providing a context file raised inference cost by more than 20% on average; the authors recommend keeping human-written context minimal.",
    ],
    remediation:
      "Keep one copy at the broadest scope that needs it and delete the rest, or replace a child copy with an `@`-import of the parent. `conman --fix` removes byte-identical parent/child blocks mechanically; whole-file and same-stack duplicates it leaves for you, since removing them means deleting a file or writing a pointer.",
  },
  "unlinked-copy": {
    title: "Unlinked CLAUDE.md / AGENTS.md copy",
    explanation:
      "A directory holds a CLAUDE.md and an AGENTS.md that are separate byte-identical files, not a symlink and not an `@`-import. Claude Code loads only the CLAUDE.md, so this costs no extra tokens, but the two hand-maintained copies drift apart over time and a reader cannot tell which one is authoritative.",
    citations: [
      "Configuration Smells in AGENTS.md Files (dos Santos et al., June 2026), https://arxiv.org/abs/2606.15828 — dead references and stale boilerplate are among the removable-content smells catalogued across the corpus.",
    ],
    remediation:
      "Link the two files with a symlink, or make CLAUDE.md a one-line `@AGENTS.md` import so a single file is the source of truth.",
  },
  "value-conflict": {
    title: "Direct value conflict",
    explanation:
      "A definitional markdown line (`` `Key`: value ``, `**Key:** value`, or `- Key: value` with an uppercase key) binds the same normalized key to two different short values in two different files of the stack. The agent sees both and has no rule for which wins, so behaviour depends on load order and attention rather than intent.",
    citations: [
      "Configuration Smells in AGENTS.md Files (dos Santos et al., June 2026), https://arxiv.org/abs/2606.15828 — contradictory instructions across a repo's context files are one of the catalogued smells.",
      "Evaluating AGENTS.md (Gloaguen et al., Feb 2026), https://arxiv.org/abs/2602.11988 — agents follow the context file literally, so a contradiction in it makes tasks harder rather than being silently ignored.",
    ],
    remediation:
      "Decide the real value, set it once at the broadest scope that applies, and remove the other binding. If both are genuinely correct in their own scope, make the scope explicit in the surrounding text so the narrower one clearly overrides.",
  },
  "vehicle-fit": {
    title: "Oversized always-loaded block",
    explanation:
      "A non-code prose segment over 350 tokens sits in always-loaded memory or a rule, or an always-loaded rule runs over 800 tokens. This check is structural only — it keys off size and shape, never meaning — and flags content large enough that it probably belongs in a skill, a linked doc, or a path-scoped rule rather than in every session's base context.",
    citations: [
      "Evaluating AGENTS.md (Gloaguen et al., Feb 2026), https://arxiv.org/abs/2602.11988 — any non-essential requirement in the context file makes tasks harder and increases over-exploration; keep human-written context minimal.",
      "Probe-and-Refine Tuning of Repository Guidance (Shepard & Albrecht, June 2026), https://arxiv.org/abs/2606.20512 — a guidance file iteratively pruned against synthetic probes beat the unpruned baseline on SWE-bench Verified, 33.0% versus 25.5%.",
    ],
    remediation:
      "Move the bulk into a skill or a separate document referenced on demand, or scope it to the paths that need it with a `.claude/rules` entry. Leave only the part every session needs in always-loaded memory. This advice is structural; conman does not judge the content itself.",
  },
  frontmatter: {
    title: "Malformed rule / skill frontmatter",
    explanation:
      "The YAML frontmatter on a file the resolver reads keys from is malformed, missing a required key, or the wrong type. Scope is exactly the files whose frontmatter changes what resolves: a `.claude/rules` entry (its `paths` scope key) and a skill SKILL.md (`name` / `description`). An unreadable `paths` scope silently makes a rule load always-on or never match; a skill missing `name` or `description` weakens or breaks its startup listing.",
    citations: [
      "Path-specific rules, Claude Code memory docs, https://code.claude.com/docs/en/memory#path-specific-rules — rules use YAML frontmatter with a `paths` field; the resolver models the v2.1.251 parser, which reads `frontmatter.paths` and nothing else.",
      "Configuration Smells in AGENTS.md Files (dos Santos et al., June 2026), https://arxiv.org/abs/2606.15828 — stale `/init` boilerplate and dead references are catalogued smells; broken frontmatter is the machine-checkable end of that spectrum.",
    ],
    remediation:
      "Fix the YAML: give `paths` a list of strings, close the `---` fence, and give each skill a usable `name` and `description`. `conman --fix` does not repair frontmatter validity, since a malformed scope key is a change of meaning.",
  },
  "lint-duplication": {
    title: "Lint rule the tooling already enforces",
    explanation:
      "An always-loaded context file restates a rule that a linter or formatter config in the repo already enforces mechanically — telling the agent \"use 2-space indent\" next to a `.prettierrc` with `tabWidth: 2`. The config runs on save or in CI regardless, so the sentence is context the tooling makes redundant, paid for on every request. conman reads `.prettierrc*`, `.eslintrc*` (JSON/YAML), `biome.json`, and `pyproject.toml` `[tool.ruff]` / `[tool.black]`, and matches a fixed set of keys against conservative prose phrasings.",
    citations: [
      "Configuration Smells in AGENTS.md Files (dos Santos et al., June 2026), https://arxiv.org/abs/2606.15828 — a scan of 100 popular repos found lint rules the linter already enforces in 62% of files and general context bloat in 42%.",
      "Evaluating AGENTS.md (Gloaguen et al., Feb 2026), https://arxiv.org/abs/2602.11988 — any non-essential requirement in the context file makes tasks harder and raised inference cost by more than 20% on average.",
    ],
    remediation:
      "Delete the sentence and let the linter or formatter config carry the rule. If the rule is not actually configured, add it to the config rather than to the context file.",
  },
  "stale-boilerplate": {
    title: "Unmodified /init boilerplate",
    explanation:
      "A stock sentence that Claude Code's `/init` writes into a fresh CLAUDE.md is still sitting there unmodified — most often the \"This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository\" header. It says nothing project-specific, so it is pure filler in every session's base context. conman matches a small curated set of known `/init` sentences near-verbatim.",
    citations: [
      "Configuration Smells in AGENTS.md Files (dos Santos et al., June 2026), https://arxiv.org/abs/2606.15828 — stale `/init` boilerplate is one of the removable-content smells catalogued across the corpus, alongside general context bloat in 42% of files.",
    ],
    remediation:
      "Replace the template sentence with guidance specific to this repository, or delete it outright.",
  },
  "dead-reference": {
    title: "Reference that does not resolve",
    explanation:
      "A pointer in a context file that does not resolve on disk: an `@`-import whose target file is missing, a repo-relative path named in prose that does not exist, or an `npm run <script>` name with no matching entry in package.json. A missing `@`-import is the worst case — Claude Code drops it from the resolved stack with no error, so content the author expected silently never loads. conman checks these on ancestor memory files and `.claude/rules` entries.",
    citations: [
      "Configuration Smells in AGENTS.md Files (dos Santos et al., June 2026), https://arxiv.org/abs/2606.15828 — dead references are one of the catalogued smells across the 100-repo corpus.",
    ],
    remediation:
      "Fix or remove the reference: correct the `@`-import path, update the prose path, or rename the script to match package.json. A dead `@`-import is a gate error because the drop is silent; a dead prose path or script is a warning.",
  },
};

export const FINDING_IDS = Object.keys(FINDING_INFO).sort() as FindingType[];

function isFindingType(s: string): s is FindingType {
  return Object.prototype.hasOwnProperty.call(FINDING_INFO, s);
}

/** `conman explain` with no argument: list the ids and titles. */
export function renderExplainList(toolVersion: string): string {
  const out: string[] = [];
  out.push(`conman ${toolVersion} - finding types`);
  out.push("");
  const w = Math.max(...FINDING_IDS.map((id) => id.length));
  for (const id of FINDING_IDS) {
    out.push(`  ${id.padEnd(w)}  ${FINDING_INFO[id].title}`);
  }
  out.push("");
  out.push("Run `conman explain <id>` for the full entry.");
  return out.join("\n") + "\n";
}

/**
 * `conman explain <id>`. Returns null when `id` is not a known finding type, so
 * the caller can print an error and exit 2.
 */
export function renderExplain(id: string, toolVersion: string): string | null {
  if (!isFindingType(id)) return null;
  const info = FINDING_INFO[id];
  const out: string[] = [];
  out.push(`conman ${toolVersion} - explain ${id}`);
  out.push("");
  out.push(info.title.toUpperCase());
  out.push("");
  out.push(wrap(info.explanation));
  out.push("");
  out.push("RESEARCH");
  for (const c of info.citations) out.push(wrap(c, "  - ", "    "));
  out.push("");
  out.push("REMEDIATION");
  out.push(wrap(info.remediation, "  ", "  "));
  return out.join("\n") + "\n";
}

/** Deterministic 80-column word wrap. No locale, no trailing whitespace. */
function wrap(text: string, first = "", rest = ""): string {
  const width = 80;
  const words = text.split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let line = first;
  let indent = first;
  for (const word of words) {
    const candidate = line === indent ? line + word : line + " " + word;
    if (candidate.length > width && line !== indent) {
      lines.push(line);
      indent = rest;
      line = rest + word;
    } else {
      line = candidate;
    }
  }
  if (line.trim().length > 0) lines.push(line);
  return lines.join("\n");
}
