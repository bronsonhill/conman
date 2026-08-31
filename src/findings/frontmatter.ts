// Frontmatter finding: the YAML frontmatter on a context file the resolver
// reads keys from is malformed, missing a required key, or the wrong type.
//
// Scope is exactly the files whose frontmatter changes what resolves:
//   - `.claude/rules/*.md`      — the `paths` scope key
//   - `.claude/skills/*/SKILL.md` — `name` and `description`
// CLAUDE.md / AGENTS.md are not checked: the resolver reads no keys from their
// frontmatter, only `@`-imports from the body.
//
// Severity, per sub-case:
//   error — a path-scoped rule whose scope cannot be read: unparseable YAML or
//           an unterminated fence when the raw text carries `paths:` / `globs:`,
//           or a `paths` value that is neither a string nor a list of strings.
//           Claude Code then silently loads the rule always-on (unscoped) or
//           never matches it — invisible breakage, which is conman's whole job.
//   warn  — softer cases that still resolve: `paths` given as a bare string,
//           a rule that scopes on `globs` (which Claude Code ignores), a skill
//           missing `name` / `description`, and cosmetic YAML damage on files
//           with no scoping intent.
//
// `config.gate.frontmatter` is a ceiling: "warn" caps every sub-case at warn,
// "off" disables the check.

import type { Finding, Location, Severity } from "../types.js";
import type { Config } from "../config.js";
import type { FrontmatterSubject } from "../resolver/index.js";
import { parseFrontmatter } from "../frontmatter.js";

/** Matches a `paths:` or `globs:` key at the start of a line — scoping intent. */
const SCOPE_KEY_RE = /^[ \t]*(paths|globs)[ \t]*:/m;

function isStringList(v: unknown): boolean {
  return Array.isArray(v) && v.every((x) => typeof x === "string");
}

function typeName(v: unknown): string {
  if (v === null) return "null";
  if (Array.isArray(v)) return "a list";
  return `a ${typeof v}`;
}

export function findFrontmatterIssues(
  subjects: FrontmatterSubject[],
  config: Config,
): Finding[] {
  const ceiling = config.gate["frontmatter"];
  if (ceiling === "off") return [];
  const cap = (s: Severity): Severity =>
    ceiling === "warn" && s === "error" ? "warn" : s;

  const findings: Finding[] = [];
  const ordered = [...subjects].sort((a, b) =>
    a.file < b.file ? -1 : a.file > b.file ? 1 : 0,
  );
  for (const subj of ordered) {
    findings.push(...checkSubject(subj, cap));
  }
  findings.sort((a, b) => {
    const sev = { error: 0, warn: 1, off: 2 };
    return (
      sev[a.severity] - sev[b.severity] ||
      (a.locations[0]!.file < b.locations[0]!.file ? -1 : 1)
    );
  });
  return findings;
}

function checkSubject(
  subj: FrontmatterSubject,
  cap: (s: Severity) => Severity,
): Finding[] {
  const fm = parseFrontmatter(subj.text);
  const at = (lineStart: number, lineEnd: number): Location[] => [
    { file: subj.file, lineStart, lineEnd },
  ];
  const mk = (
    severity: Severity,
    locations: Location[],
    message: string,
    subcase: string,
  ): Finding => ({
    type: "frontmatter",
    severity: cap(severity),
    message,
    locations,
    detail: { role: subj.role, subcase },
  });

  const out: Finding[] = [];
  const scopeIntent = (s: string) => subj.role === "rule" && SCOPE_KEY_RE.test(s);

  if (fm.opened && fm.unterminated) {
    out.push(
      mk(
        scopeIntent(subj.text) ? "error" : "warn",
        at(1, 1),
        subj.role === "rule"
          ? "frontmatter opens with `---` but has no closing `---`; the block is read as prose and any `paths` scope is ignored, so the rule loads always-on"
          : "frontmatter opens with `---` but has no closing `---`; `name` and `description` are not read",
        "unterminated-fence",
      ),
    );
    return out;
  }

  if (!fm.opened) {
    if (subj.role === "skill") {
      out.push(
        mk(
          "warn",
          at(1, 1),
          "SKILL.md has no YAML frontmatter; `name` and `description` are missing",
          "missing-frontmatter",
        ),
      );
    }
    return out;
  }

  if (fm.parseError !== undefined) {
    const intent = scopeIntent(fm.rawYaml);
    out.push(
      mk(
        intent ? "error" : "warn",
        at(fm.startLine, fm.endLine),
        `frontmatter YAML does not parse (${fm.parseError})` +
          (intent
            ? "; the `paths` scope cannot be read, so this path-scoped rule silently loads always-on"
            : subj.role === "skill"
              ? "; `name` and `description` cannot be read"
              : ""),
        "unparseable-yaml",
      ),
    );
    return out;
  }

  if (subj.role === "rule") {
    const paths = fm.data["paths"];
    const globs = fm.data["globs"];
    if (paths !== undefined && !isStringList(paths)) {
      if (typeof paths === "string") {
        out.push(
          mk(
            "warn",
            at(fm.startLine, fm.endLine),
            "`paths` is a bare string, not a YAML list; conman reads it as a single glob, but the documented form is a list and some parsers drop a scalar",
            "scope-scalar-string",
          ),
        );
      } else {
        out.push(
          mk(
            "error",
            at(fm.startLine, fm.endLine),
            `\`paths\` is ${typeName(paths)}, not a string or a list of strings; the scope yields no globs, so this rule meant to be path-scoped loads always-on instead`,
            "scope-wrong-type",
          ),
        );
      }
    } else if (paths === undefined && globs !== undefined) {
      out.push(
        mk(
          "warn",
          at(fm.startLine, fm.endLine),
          "frontmatter sets `globs` but not `paths`; Claude Code path-scopes rules only on `paths`, so this rule loads always-on",
          "scope-key-absent",
        ),
      );
    }
    return out;
  }

  // skill
  const name = fm.data["name"];
  if (typeof name !== "string" || name.trim() === "") {
    out.push(
      mk(
        "warn",
        at(fm.startLine, fm.endLine),
        "skill frontmatter has no usable `name`; the startup listing falls back to the skill directory name",
        "skill-missing-name",
      ),
    );
  }
  const description = fm.data["description"];
  if (typeof description !== "string" || description.trim() === "") {
    out.push(
      mk(
        "warn",
        at(fm.startLine, fm.endLine),
        "skill frontmatter has no usable `description`; the startup listing shows this skill with an empty description",
        "skill-missing-description",
      ),
    );
  }
  return out;
}
