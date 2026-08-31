// The skill startup index: one `- name: description` line per `SKILL.md` found
// under `.claude/skills`, name-sorted, truncated to the skill-listing budget.
//
// With `--user`, `~/.claude/skills` is walked as well (it is passed in as the
// root-most entry of `claudeDirs`); skills found under it are labelled with the
// stable `~/.claude/skills` path rather than a machine-specific relative one, so
// the report stays reproducible in shape.

import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { Block } from "../types.js";
import { isDir, isFile, relPosix } from "../repo.js";
import { parseFrontmatter } from "../frontmatter.js";
import { USER_SKILLS_LABEL } from "./settings.js";
import type { ImportCtx } from "./imports.js";

export function buildSkillIndex(
  claudeDirs: string[],
  budgetTokens: number | null,
  ctx: ImportCtx,
  userConfigDir?: string,
): { block: Omit<Block, "id" | "tokens">; skillCount: number } | null {
  const skills: { name: string; description: string; dirRel: string }[] = [];
  let skillsRootRel = ".claude/skills";
  let sawUserSkills = false;
  for (const cdir of claudeDirs) {
    const isUserDir = userConfigDir !== undefined && cdir === userConfigDir;
    const sdir = join(cdir, "skills");
    if (!isDir(sdir)) continue;
    const rootRel = isUserDir ? USER_SKILLS_LABEL : relPosix(ctx.repoRoot, sdir);
    // A user-level skills root, once seen, owns the block label: the index is
    // one merged list and `~/.claude/skills` is the stable, machine-independent
    // name for its most global source.
    if (isUserDir) sawUserSkills = true;
    if (!sawUserSkills || isUserDir) skillsRootRel = rootRel;
    const subs = readdirSync(sdir).sort();
    for (const sub of subs) {
      const skillMd = join(sdir, sub, "SKILL.md");
      if (!isFile(skillMd)) continue;
      const skillText = readFileSync(skillMd, "utf8");
      ctx.frontmatterSubjects.push({
        file: isUserDir
          ? `${USER_SKILLS_LABEL}/${sub}/SKILL.md`
          : relPosix(ctx.repoRoot, skillMd),
        role: "skill",
        text: skillText,
      });
      const fm = parseFrontmatter(skillText);
      const name =
        typeof fm.data["name"] === "string" ? (fm.data["name"] as string) : sub;
      const description =
        typeof fm.data["description"] === "string"
          ? (fm.data["description"] as string).replace(/\s+/g, " ").trim()
          : "";
      const dirRel = isUserDir
        ? `${USER_SKILLS_LABEL}/${sub}`
        : relPosix(ctx.repoRoot, join(sdir, sub));
      skills.push({ name, description, dirRel });
    }
  }
  if (skills.length === 0) return null;
  skills.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));

  const lineFor = (s: { name: string; description: string }) =>
    `- ${s.name}: ${s.description}`;

  let kept = skills;
  let truncatedNote = "";
  if (budgetTokens !== null) {
    kept = [];
    let running = 0;
    for (const s of skills) {
      const cost = ctx.tok.countTokens(lineFor(s) + "\n");
      if (running + cost > budgetTokens) break;
      running += cost;
      kept.push(s);
    }
    if (kept.length < skills.length) {
      const omitted = skills.length - kept.length;
      truncatedNote = `\n- (${omitted} more skill${omitted === 1 ? "" : "s"} not listed; skill-listing budget ${budgetTokens} tokens exceeded)`;
      ctx.notes.push(
        `skill startup index truncated: ${omitted} of ${skills.length} skills omitted under skill-listing budget ${budgetTokens}`,
      );
    }
  }

  const text = kept.map(lineFor).join("\n") + truncatedNote + "\n";
  return {
    block: {
      kind: "skill-index",
      source: skillsRootRel,
      lineStart: 1,
      lineEnd: Math.max(1, kept.length),
      text,
      depth: 0,
    },
    // The count that drives the max-skills finding is what the agent actually
    // sees at startup: entries kept after any skill-listing-budget truncation.
    skillCount: kept.length,
  };
}
