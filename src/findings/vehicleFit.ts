// Vehicle-fit finding: coarse, structural advice about whether a chunk of text
// belongs in always-loaded memory at all. Keyed only off segment token size and
// shape (prose vs fenced code). No judgement about meaning.
//
// This is deliberately unsharpened. A later opt-in LLM layer is where "this
// section is reference material a session rarely needs" becomes a real call.
// Until then conman only says "this is large and always loaded; consider a
// path-scoped rule or a skill".

import type { Block, Finding, Location } from "../types.js";
import type { Config } from "../config.js";
import type { Tokenizer } from "../tokenizer.js";
import { splitSegments } from "../segments.js";

const LARGE_SEGMENT_TOKENS = 350;
const LARGE_ALWAYS_RULE_TOKENS = 800;

function vehicleName(kind: Block["kind"]): string {
  switch (kind) {
    case "memory":
    case "import":
      return "always-loaded memory";
    case "rule-always":
      return "an always-loaded rule";
    case "rule-scoped":
      return "a path-scoped rule";
    default:
      return "the stack";
  }
}

export function findVehicleFit(
  blocks: Block[],
  config: Config,
  tok: Tokenizer,
): Finding[] {
  const severity = config.gate["vehicle-fit"];
  if (severity === "off") return [];

  const findings: Finding[] = [];

  for (const b of blocks) {
    if (b.kind === "skill-index") continue;

    if (b.kind === "rule-always" && b.tokens > LARGE_ALWAYS_RULE_TOKENS) {
      findings.push({
        type: "vehicle-fit",
        severity,
        message: `${b.tokens}-token always-loaded rule; adding a \`globs\` scope would keep it out of unrelated sessions`,
        locations: [{ file: b.source, lineStart: b.lineStart, lineEnd: b.lineEnd }],
        tokens: b.tokens,
        detail: { shape: "rule-always", coarse: true },
      });
    }

    for (const seg of splitSegments(b.source, b.text, b.lineStart, tok)) {
      if (seg.fenced || seg.headingOnly) continue;
      if (seg.tokens <= LARGE_SEGMENT_TOKENS) continue;
      const loc: Location = {
        file: seg.source,
        lineStart: seg.lineStart,
        lineEnd: seg.lineEnd,
      };
      findings.push({
        type: "vehicle-fit",
        severity,
        message: `${seg.tokens}-token prose section in ${vehicleName(b.kind)}; if it is reference material, a skill or path-scoped rule keeps it out of every session's base context`,
        locations: [loc],
        tokens: seg.tokens,
        detail: { shape: "prose-segment", coarse: true },
      });
    }
  }

  findings.sort(
    (a, b) =>
      (b.tokens ?? 0) - (a.tokens ?? 0) ||
      (a.locations[0]!.file < b.locations[0]!.file ? -1 : 1),
  );
  return findings;
}
