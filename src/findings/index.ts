import type { Block, Finding, Totals } from "../types.js";
import type { Config } from "../config.js";
import type { Tokenizer } from "../tokenizer.js";
import type { UnlinkedAgentsCopy, FrontmatterSubject } from "../resolver/index.js";
import { findDuplication } from "./duplication.js";
import { findFrontmatterIssues } from "./frontmatter.js";
import { findUnlinkedCopies } from "./unlinkedCopy.js";
import { findValueConflicts } from "./valueConflict.js";
import { findVehicleFit } from "./vehicleFit.js";
import { findLintDuplication } from "./lintDuplication.js";
import { findStaleBoilerplate } from "./staleBoilerplate.js";
import { findDeadReferences } from "./deadReference.js";
import { findMaxSkills } from "./maxSkills.js";
import { findBudgetCaps } from "./budgetCaps.js";

const TYPE_ORDER: Record<Finding["type"], number> = {
  duplication: 0,
  "unlinked-copy": 1,
  "value-conflict": 2,
  "vehicle-fit": 3,
  frontmatter: 4,
  "lint-duplication": 5,
  "stale-boilerplate": 6,
  "dead-reference": 7,
  "max-skills": 8,
  "per-file-budget": 9,
  "skill-index-budget": 10,
};
const SEV_ORDER: Record<string, number> = { error: 0, warn: 1, off: 2 };

export function runFindings(
  blocks: Block[],
  config: Config,
  tok: Tokenizer,
  unlinkedAgentsCopies: UnlinkedAgentsCopy[] = [],
  frontmatterSubjects: FrontmatterSubject[] = [],
  repoRoot = "",
  skillCount = 0,
  totals: Totals = { stackTokens: 0, perFile: {}, skillIndexTokens: 0 },
): Finding[] {
  const skillIndexSource = blocks.find((b) => b.kind === "skill-index")?.source;
  const all = [
    ...findDuplication(blocks, config, tok),
    ...findUnlinkedCopies(unlinkedAgentsCopies, config),
    ...findValueConflicts(blocks, config, tok),
    ...findVehicleFit(blocks, config, tok),
    ...findFrontmatterIssues(frontmatterSubjects, config),
    ...findLintDuplication(blocks, config, repoRoot),
    ...findStaleBoilerplate(blocks, config),
    ...findDeadReferences(blocks, config, repoRoot),
    ...findMaxSkills(skillCount, skillIndexSource, config),
    ...findBudgetCaps(totals, blocks, config),
  ];
  all.sort(
    (a, b) =>
      SEV_ORDER[a.severity]! - SEV_ORDER[b.severity]! ||
      TYPE_ORDER[a.type] - TYPE_ORDER[b.type] ||
      (b.tokens ?? 0) - (a.tokens ?? 0) ||
      (a.locations[0]!.file < b.locations[0]!.file ? -1 : 1),
  );
  return all;
}
