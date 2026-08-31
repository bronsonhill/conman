// Synthetic context stack generator.
//
// Produces a block of text that reads like a repo's CLAUDE.md / AGENTS.md /
// rules stack, sized to a target token count (measured with the bundled
// offline @anthropic-ai/tokenizer, the same counter conman's default path
// uses). Two qualities:
//
//   clean  -- unique, coherent instruction paragraphs, no contradictions.
//   messy  -- the clean stack plus verbatim duplicated paragraphs and a set of
//             directly contradictory directive pairs, to model a real stack
//             that has grown by accretion across many hands.
//
// Both qualities are sized to the SAME target token count for a given cell, so
// the only thing that varies between them is structure.

import { countTokens as rawCountTokens } from "@anthropic-ai/tokenizer";
import { rngFromKey, randInt, pick, shuffle } from "./prng.mjs";

// The paragraph vocabulary is small, so the same paragraph text recurs across
// trials and sizes. Memoize to keep stack generation cheap when the sweep
// builds hundreds of stacks.
const _tokCache = new Map();
function countTokens(text) {
  let n = _tokCache.get(text);
  if (n === undefined) {
    n = rawCountTokens(text);
    _tokCache.set(text, n);
  }
  return n;
}

const MODULES = [
  "resolver", "coster", "reporter", "gate", "planner", "indexer", "scheduler",
  "collector", "emitter", "walker", "matcher", "loader", "differ", "packer",
];
const COMMANDS = [
  "npm run build", "npm test", "npm run lint", "make check", "npm run bench",
  "scripts/verify.sh", "npm run typecheck", "make golden",
];
const DIRS = [
  "src/", "lib/", "test/fixtures/", "dist/", "internal/", "cmd/", "pkg/", "tools/",
];
const NUMS = [200, 512, 1000, 1500, 2048, 3000, 4096, 8000];

const PARA_TEMPLATES = [
  (r) =>
    `The ${pick(r, MODULES)} module owns one stage of the pipeline. It takes the ` +
    `output of the previous stage and hands a plain value to the next. Keep it ` +
    `free of I/O so the unit tests stay fast.`,
  (r) =>
    `Run \`${pick(r, COMMANDS)}\` before every commit. CI runs the same command ` +
    `on a clean checkout, so a green local run should mean a green pipeline.`,
  (r) =>
    `Files under \`${pick(r, DIRS)}\` are generated. Do not edit them by hand; ` +
    `change the generator and re-run \`${pick(r, COMMANDS)}\` instead.`,
  (r) =>
    `Keep any single source file under ${pick(r, NUMS)} lines. When it grows past ` +
    `that, split it along the seam that has the fewest cross-references.`,
  (r) =>
    `Error messages name the offending file and the rule that fired. They never ` +
    `include absolute paths or timestamps, because the golden tests compare bytes.`,
  (r) =>
    `The ${pick(r, MODULES)} stage must be deterministic: same input, same bytes ` +
    `out. Sort every directory listing and every array before you emit it.`,
  (r) =>
    `Prefer a small pure function over a class. If a helper needs more than ` +
    `${pick(r, NUMS)} bytes of state, that is a sign the stage is doing two jobs.`,
  (r) =>
    `When you add a fixture under \`${pick(r, DIRS)}\`, add the matching golden ` +
    `file in the same commit and note it in the changelog.`,
  (r) =>
    `Network calls are banned on every path except the explicitly gated one. A ` +
    `review that adds \`fetch\` anywhere else should be rejected on sight.`,
  (r) =>
    `The ${pick(r, MODULES)} module logs at most one line per run at info level. ` +
    `Everything else is debug and off by default.`,
  (r) =>
    `Config is read once at startup into a frozen object. Nothing downstream ` +
    `mutates it; pass overrides explicitly if a stage needs different values.`,
  (r) =>
    `Treat \`${pick(r, DIRS)}\` as the public surface. Anything outside it can ` +
    `change shape between releases without a changelog entry.`,
];

const CONFLICT_PAIRS = [
  ["Always respond in strict JSON with no prose.", "Never respond in JSON. Use plain prose only."],
  ["Use British spelling throughout (colour, behaviour).", "Use American spelling throughout (color, behavior)."],
  ["The canonical build command is `make all`.", "The canonical build command is `npm run build`, never `make`."],
  ["Indent with tabs. Spaces are a lint error.", "Indent with two spaces. Tabs are a lint error."],
  ["Always include a summary section at the top of a report.", "Never add a summary section; start straight with the findings."],
  ["Prefer long, descriptive identifier names.", "Prefer short identifiers; long names are a code smell here."],
  ["Commit messages must be a single line, under 50 characters.", "Commit messages must have a body paragraph explaining the why."],
];

const FILE_HEADERS = ["CLAUDE.md", "AGENTS.md", ".claude/rules/style.md", ".claude/rules/pipeline.md"];

function makeParagraph(rng, idx) {
  const tmpl = PARA_TEMPLATES[idx % PARA_TEMPLATES.length];
  return tmpl(rng);
}

/**
 * Generate a context stack.
 *
 * @param {object} o
 * @param {string} o.key      deterministic content key
 * @param {number} o.targetTokens  desired size; 0 -> empty stack
 * @param {"clean"|"messy"} o.quality
 * @param {number} o.tolerance  fractional slack around targetTokens (e.g. 0.02)
 * @returns {{text: string, tokens: number, quality: string, paragraphs: number,
 *           duplicateRatio: number, conflictPairs: number}}
 */
export function buildStack({ key, targetTokens, quality, tolerance = 0.02 }) {
  if (!targetTokens || targetTokens <= 0) {
    return {
      text: "",
      tokens: 0,
      quality,
      paragraphs: 0,
      duplicateRatio: 0,
      conflictPairs: 0,
    };
  }

  const rng = rngFromKey(`stack:${quality}:${key}:${targetTokens}`);
  const hi = Math.round(targetTokens * (1 + tolerance));

  // For the messy quality, reserve part of the budget for duplicates and
  // conflict pairs so the final size still lands on target.
  const dupShare = quality === "messy" ? 0.35 : 0;
  const uniqueTarget = Math.round(targetTokens * (1 - dupShare));

  // 1. Grow unique paragraphs to the unique-share target (token cost tracked
  //    incrementally; no full-text re-tokenize).
  const unique = [];
  const cost = new Map(); // paragraph text -> token cost incl. separator
  let acc = 0;
  let idx = 0;
  while (acc < uniqueTarget) {
    const p = makeParagraph(rng, idx++);
    const c = countTokens(p) + 2;
    unique.push(p);
    cost.set(p, c);
    acc += c;
  }

  // 2. Assemble the body.
  let body = unique.slice();
  let total = acc;
  let conflictPairs = 0;
  let duplicated = 0;

  if (quality === "messy") {
    // Verbatim duplicates at random positions until near target.
    while (total < targetTokens && body.length < unique.length * 4) {
      const src = pick(rng, unique);
      body.splice(randInt(rng, 0, body.length), 0, src);
      total += cost.get(src);
      duplicated++;
    }
    // Scatter directly contradictory directive pairs.
    const pairs = shuffle(rng, CONFLICT_PAIRS).slice(
      0,
      Math.min(4, CONFLICT_PAIRS.length),
    );
    for (const [a, b] of pairs) {
      body.splice(randInt(rng, 0, body.length), 0, a);
      body.splice(randInt(rng, 0, body.length), 0, b);
      total += countTokens(a) + countTokens(b) + 4;
      conflictPairs++;
    }
  }

  // 3. Final trim so the token total sits within [target, hi].
  const kept = [];
  let running = 0;
  for (const p of body) {
    const c = cost.get(p) ?? countTokens(p) + 2;
    if (running + c > hi && running >= targetTokens) break;
    kept.push(p);
    running += c;
    if (running >= targetTokens) break;
  }

  // 4. Wrap in a few fake file sections so it reads like a real stack.
  const perFile = Math.max(1, Math.ceil(kept.length / FILE_HEADERS.length));
  const chunks = [];
  for (let i = 0; i < kept.length; i += perFile) {
    const header = FILE_HEADERS[Math.floor(i / perFile) % FILE_HEADERS.length];
    chunks.push(
      `----- ${header} -----\n\n` + kept.slice(i, i + perFile).join("\n\n"),
    );
  }
  const text = chunks.join("\n\n");

  return {
    text,
    tokens: countTokens(text),
    quality,
    paragraphs: kept.length,
    duplicateRatio: kept.length ? duplicated / kept.length : 0,
    conflictPairs,
  };
}
