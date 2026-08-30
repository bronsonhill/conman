// Lint-duplication finding: a rule stated in an always-loaded context file that
// a linter or formatter config in the repo already enforces mechanically.
//
// Telling the agent "use 2-space indent" when `.prettierrc` sets `tabWidth: 2`
// spends context budget on a rule the tooling applies on save. This matcher is
// deliberately narrow: it recognises a handful of well-known config keys and a
// small set of conservative prose phrasings for each, matched on rule intent,
// not arbitrary wording. A missed collision is cheaper than a false one.
//
// Configs read: `.eslintrc*` (JSON/YAML only), `biome.json(c)`, `.prettierrc*`
// (JSON/YAML/`package.json#prettier`), and `pyproject.toml` `[tool.ruff]` /
// `[tool.black]` (`line-length`, `indent-width`). JS config files are skipped —
// they cannot be read without executing them.
//
// Severity: warn (`config.gate["lint-duplication"]`; "off" disables).

import { readFileSync } from "node:fs";
import { join } from "node:path";
import JSON5 from "json5";
import YAML from "yaml";
import type { Block, Finding } from "../types.js";
import type { Config } from "../config.js";
import { isFile } from "../repo.js";

const CONTEXT_KINDS = new Set<Block["kind"]>([
  "memory",
  "import",
  "rule-always",
  "rule-scoped",
]);

const FENCE = /^(\s*)(`{3,}|~{3,})/;

/** A single mechanically-enforced rule and the prose that restates it. */
interface EnforcedRule {
  /** Stable sub-case id, e.g. "indent-spaces". */
  id: string;
  /** Repo-relative config file it comes from. */
  config: string;
  /** The config key/section it is read from. */
  key: string;
  /** Human phrasing for the finding message. */
  label: string;
  /** Conservative patterns; a match on a prose line is a collision. */
  patterns: RegExp[];
}

function parseLoose(text: string): unknown {
  try {
    return JSON5.parse(text);
  } catch {
    /* not JSON/JSON5 */
  }
  try {
    return YAML.parse(text);
  } catch {
    /* not YAML either */
  }
  return undefined;
}

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** ESLint rule value: `"error"`, `2`, or `["error", opts...]`. Returns opts[0]. */
function ruleOpt(v: unknown): unknown {
  return Array.isArray(v) ? v[1] : undefined;
}
function ruleOn(v: unknown): boolean {
  const level = Array.isArray(v) ? v[0] : v;
  return level === "error" || level === "warn" || level === 2 || level === 1;
}

function indentSpacesRule(config: string, key: string, n: number): EnforcedRule {
  return {
    id: "indent-spaces",
    config,
    key,
    label: `${n}-space indentation`,
    patterns: [
      new RegExp(`\\b${n}[ -]spaces?\\b[^.\\n]{0,30}\\bindent`, "i"),
      new RegExp(`\\bindent\\w*\\b[^.\\n]{0,30}\\b${n}[ -]spaces?`, "i"),
      new RegExp(`\\buse\\s+${n}\\s+spaces?\\b`, "i"),
    ],
  };
}
function indentTabsRule(config: string, key: string): EnforcedRule {
  return {
    id: "indent-tabs",
    config,
    key,
    label: "tab indentation",
    patterns: [
      /\bindent\w*\b[^.\n]{0,20}\bwith tabs\b/i,
      /\buse tabs\b[^.\n]{0,20}\bindent/i,
      /\btabs,? not spaces\b/i,
    ],
  };
}
function lineLengthRule(config: string, key: string, n: number): EnforcedRule {
  return {
    id: "line-length",
    config,
    key,
    label: `a ${n}-column line limit`,
    patterns: [
      new RegExp(`\\bline\\s+(?:length|width)\\b[^.\\n]{0,20}\\b${n}\\b`, "i"),
      new RegExp(`\\b${n}[- ](?:char|character|column)s?\\b[^.\\n]{0,20}\\blines?\\b`, "i"),
      new RegExp(`\\blines?\\b[^.\\n]{0,25}\\b(?:under|to|at|max\\w*)\\b[^.\\n]{0,10}\\b${n}\\b`, "i"),
      new RegExp(`\\bwrap\\b[^.\\n]{0,20}\\b${n}\\b`, "i"),
    ],
  };
}
function semiRule(config: string, key: string, require: boolean): EnforcedRule {
  return require
    ? {
        id: "semi-require",
        config,
        key,
        label: "required semicolons",
        patterns: [/\balways use semicolons?\b/i, /\brequire semicolons?\b/i],
      }
    : {
        id: "semi-omit",
        config,
        key,
        label: "no semicolons",
        patterns: [
          /\bno semicolons?\b/i,
          /\bomit semicolons?\b/i,
          /\bsemicolon-free\b/i,
          /\bdon'?t use semicolons?\b/i,
          /\bwithout semicolons?\b/i,
        ],
      };
}
function quoteRule(config: string, key: string, style: "single" | "double"): EnforcedRule {
  return {
    id: `quotes-${style}`,
    config,
    key,
    label: `${style} quotes`,
    patterns: [
      new RegExp(`\\b(?:use|prefer)\\b[^.\\n]{0,20}\\b${style} quotes?\\b`, "i"),
      new RegExp(`\\b${style} quotes?\\b[^.\\n]{0,15}\\bnot\\b`, "i"),
    ],
  };
}
function noConsoleRule(config: string, key: string): EnforcedRule {
  return {
    id: "no-console",
    config,
    key,
    label: "no console statements",
    patterns: [
      /\bno console\.\w+\b/i,
      /\b(?:don'?t use|avoid|remove)\b[^.\n]{0,15}\bconsole\.\w+/i,
      /\bno console logging\b/i,
    ],
  };
}
function trailingCommaRule(config: string, key: string): EnforcedRule {
  return {
    id: "trailing-comma",
    config,
    key,
    label: "trailing commas",
    patterns: [/\b(?:use|add|always)\b[^.\n]{0,20}\btrailing commas?\b/i],
  };
}

function fromPrettier(obj: unknown, config: string): EnforcedRule[] {
  if (!isObj(obj)) return [];
  const out: EnforcedRule[] = [];
  if (obj["useTabs"] === true) out.push(indentTabsRule(config, "useTabs"));
  else if (typeof obj["tabWidth"] === "number")
    out.push(indentSpacesRule(config, "tabWidth", obj["tabWidth"] as number));
  if (typeof obj["printWidth"] === "number")
    out.push(lineLengthRule(config, "printWidth", obj["printWidth"] as number));
  if (obj["semi"] === false) out.push(semiRule(config, "semi", false));
  if (obj["semi"] === true) out.push(semiRule(config, "semi", true));
  if (obj["singleQuote"] === true) out.push(quoteRule(config, "singleQuote", "single"));
  if (
    typeof obj["trailingComma"] === "string" &&
    obj["trailingComma"] !== "none"
  )
    out.push(trailingCommaRule(config, "trailingComma"));
  return out;
}

function fromEslint(obj: unknown, config: string): EnforcedRule[] {
  if (!isObj(obj) || !isObj(obj["rules"])) return [];
  const rules = obj["rules"];
  const out: EnforcedRule[] = [];
  const indent = rules["indent"];
  const iv = ruleOpt(indent);
  if (typeof iv === "number") out.push(indentSpacesRule(config, "rules.indent", iv));
  else if (iv === "tab") out.push(indentTabsRule(config, "rules.indent"));
  const q = ruleOpt(rules["quotes"]);
  if (q === "single") out.push(quoteRule(config, "rules.quotes", "single"));
  if (q === "double") out.push(quoteRule(config, "rules.quotes", "double"));
  const s = ruleOpt(rules["semi"]);
  if (s === "never") out.push(semiRule(config, "rules.semi", false));
  if (s === "always") out.push(semiRule(config, "rules.semi", true));
  const ml = ruleOpt(rules["max-len"]);
  const mlN =
    typeof ml === "number" ? ml : isObj(ml) && typeof ml["code"] === "number" ? ml["code"] : undefined;
  if (typeof mlN === "number") out.push(lineLengthRule(config, "rules.max-len", mlN));
  if (rules["no-console"] !== undefined && ruleOn(rules["no-console"]))
    out.push(noConsoleRule(config, "rules.no-console"));
  return out;
}

function fromBiome(obj: unknown, config: string): EnforcedRule[] {
  if (!isObj(obj)) return [];
  const out: EnforcedRule[] = [];
  const fmt = isObj(obj["formatter"]) ? obj["formatter"] : {};
  if (fmt["indentStyle"] === "tab") out.push(indentTabsRule(config, "formatter.indentStyle"));
  else if (fmt["indentStyle"] === "space")
    out.push(
      indentSpacesRule(
        config,
        "formatter.indentWidth",
        typeof fmt["indentWidth"] === "number" ? (fmt["indentWidth"] as number) : 2,
      ),
    );
  if (typeof fmt["lineWidth"] === "number")
    out.push(lineLengthRule(config, "formatter.lineWidth", fmt["lineWidth"] as number));
  const js = isObj(obj["javascript"]) && isObj(obj["javascript"]["formatter"])
    ? (obj["javascript"]["formatter"] as Record<string, unknown>)
    : {};
  if (js["quoteStyle"] === "single")
    out.push(quoteRule(config, "javascript.formatter.quoteStyle", "single"));
  if (js["quoteStyle"] === "double")
    out.push(quoteRule(config, "javascript.formatter.quoteStyle", "double"));
  const susp =
    isObj(obj["linter"]) &&
    isObj(obj["linter"]["rules"]) &&
    isObj((obj["linter"]["rules"] as Record<string, unknown>)["suspicious"])
      ? ((obj["linter"]["rules"] as Record<string, unknown>)["suspicious"] as Record<string, unknown>)
      : {};
  const nc = susp["noConsoleLog"] ?? susp["noConsole"];
  if (nc === "error" || nc === "warn" || nc === true)
    out.push(noConsoleRule(config, "linter.rules.suspicious.noConsole"));
  return out;
}

/** Conservative TOML scan: only `line-length` / `indent-width` under a
 *  `[tool.ruff*]` or `[tool.black]` table. No full TOML parse. */
function fromPyproject(text: string, config: string): EnforcedRule[] {
  const out: EnforcedRule[] = [];
  let section = "";
  for (const raw of text.split("\n")) {
    const line = raw.replace(/#.*$/, "").trim();
    const sec = line.match(/^\[+([^\]]+)\]+$/);
    if (sec) {
      section = sec[1]!.trim();
      continue;
    }
    const isRuff = /^tool\.ruff(\.|$)/.test(section);
    const isBlack = section === "tool.black";
    if (!isRuff && !isBlack) continue;
    const tool = isRuff ? "[tool.ruff]" : "[tool.black]";
    const ll = line.match(/^line-length\s*=\s*(\d+)/);
    if (ll) out.push(lineLengthRule(config, `${tool} line-length`, Number(ll[1])));
    const iw = line.match(/^indent-width\s*=\s*(\d+)/);
    if (iw) out.push(indentSpacesRule(config, `${tool} indent-width`, Number(iw[1])));
  }
  return out;
}

/** Read every recognised config at the repo root into a de-duped rule set. */
function collectEnforcedRules(repoRoot: string): EnforcedRule[] {
  const seen = new Map<string, EnforcedRule>();
  const add = (rules: EnforcedRule[]) => {
    for (const r of rules) if (!seen.has(r.id)) seen.set(r.id, r);
  };
  const read = (name: string): string | undefined => {
    const p = join(repoRoot, name);
    return isFile(p) ? readFileSync(p, "utf8") : undefined;
  };

  for (const name of [".prettierrc", ".prettierrc.json", ".prettierrc.json5", ".prettierrc.yaml", ".prettierrc.yml"]) {
    const t = read(name);
    if (t !== undefined) add(fromPrettier(parseLoose(t), name));
  }
  for (const name of [".eslintrc", ".eslintrc.json", ".eslintrc.yaml", ".eslintrc.yml"]) {
    const t = read(name);
    if (t !== undefined) add(fromEslint(parseLoose(t), name));
  }
  for (const name of ["biome.json", "biome.jsonc"]) {
    const t = read(name);
    if (t !== undefined) add(fromBiome(parseLoose(t), name));
  }
  const pkg = read("package.json");
  if (pkg !== undefined) {
    const obj = parseLoose(pkg);
    if (isObj(obj)) {
      if (isObj(obj["prettier"])) add(fromPrettier(obj["prettier"], "package.json#prettier"));
      if (isObj(obj["eslintConfig"])) add(fromEslint(obj["eslintConfig"], "package.json#eslintConfig"));
    }
  }
  const py = read("pyproject.toml");
  if (py !== undefined) add(fromPyproject(py, "pyproject.toml"));

  return [...seen.values()];
}

/** 0-based indices of lines inside a fenced code block. */
function fencedLines(lines: string[]): Set<number> {
  const set = new Set<number>();
  let open = false;
  let marker = "";
  lines.forEach((line, i) => {
    const m = line.match(FENCE);
    if (open) {
      set.add(i);
      if (m && m[2]!.startsWith(marker)) open = false;
    } else if (m) {
      set.add(i);
      open = true;
      marker = m[2]![0]!.repeat(3);
    }
  });
  return set;
}

export function findLintDuplication(
  blocks: Block[],
  config: Config,
  repoRoot: string,
): Finding[] {
  const severity = config.gate["lint-duplication"];
  if (severity === "off" || !repoRoot) return [];

  const enforced = collectEnforcedRules(repoRoot);
  if (enforced.length === 0) return [];

  const findings: Finding[] = [];
  // One finding per (context file, enforced rule): first colliding line wins.
  const emitted = new Set<string>();

  for (const b of blocks) {
    if (!CONTEXT_KINDS.has(b.kind)) continue;
    const lines = b.text.split("\n");
    const fenced = fencedLines(lines);
    lines.forEach((line, i) => {
      if (fenced.has(i)) return;
      for (const rule of enforced) {
        const key = `${b.source} ${rule.id}`;
        if (emitted.has(key)) continue;
        if (!rule.patterns.some((re) => re.test(line))) continue;
        emitted.add(key);
        const ln = b.lineStart + i;
        findings.push({
          type: "lint-duplication",
          severity,
          message: `${rule.label} is already enforced by ${rule.config} (${rule.key}); repeating it in an always-loaded context file spends budget on a rule the tooling applies automatically`,
          locations: [{ file: b.source, lineStart: ln, lineEnd: ln }],
          detail: { rule: rule.id, config: rule.config, key: rule.key },
        });
      }
    });
  }

  findings.sort(
    (a, b) =>
      (a.locations[0]!.file < b.locations[0]!.file ? -1 : a.locations[0]!.file > b.locations[0]!.file ? 1 : 0) ||
      a.locations[0]!.lineStart - b.locations[0]!.lineStart ||
      (String(a.detail!["rule"]) < String(b.detail!["rule"]) ? -1 : 1),
  );
  return findings;
}
