// Max-skills finding: how many skills one entry point's startup index lists.
//
// This is a *performance* signal, not a cost one. `budget.skillIndex` already
// caps the token weight of the listing; a repo can sit well under that cap and
// still list enough skills that selection accuracy degrades — 15 terse entries
// at ~80 tokens each is ~1200 tokens, under the 2000 default, but in the range
// where the tool-selection literature shows measurable wrong-pick rates. The two
// findings are independent on purpose: cost vs selection load.
//
// Bands (see MODEL.md "Default budget numbers"):
//   - <= config.maxSkills (default 8): no finding.
//   - config.maxSkills+1 .. 15: warn.
//   - > 15: error.
// `config.gate["max-skills"]` is a ceiling like `gate.frontmatter`: "warn" caps
// the >15 case at warn, "off" disables the check.
//
// The default 8 and the hard cap 15 are transferred from tool / function
// selection research (arXiv 2605.24660; Anthropic "advanced tool use"), not
// measured on Claude Code skill indexes, and are pinned to MODEL_VERSION for
// re-review as models change.

import type { Finding, Severity } from "../types.js";
import type { Config } from "../config.js";

/** Fixed upper band edge: above this a flat list is the wrong architecture. */
const HARD_CAP = 15;

export function findMaxSkills(
  skillCount: number,
  skillIndexSource: string | undefined,
  config: Config,
): Finding[] {
  const ceiling = config.gate["max-skills"];
  if (ceiling === "off") return [];

  const warnAbove = config.maxSkills;
  if (skillCount <= warnAbove) return [];

  const raw: Severity = skillCount > HARD_CAP ? "error" : "warn";
  const severity: Severity = ceiling === "warn" && raw === "error" ? "warn" : raw;

  const file = skillIndexSource ?? ".claude/skills";
  const band =
    skillCount > HARD_CAP
      ? `over the hard cap of ${HARD_CAP}`
      : `over the recommended ${warnAbove}`;

  return [
    {
      type: "max-skills",
      severity,
      message:
        `the startup skill index lists ${skillCount} skills (${band}); ` +
        `every unselected skill is a distractor at pick time, and selection ` +
        `accuracy drops measurably in this range`,
      locations: [{ file, lineStart: 1, lineEnd: Math.max(1, skillCount) }],
      tokens: undefined,
      detail: { count: skillCount, warnAbove, hardCap: HARD_CAP },
    },
  ];
}
