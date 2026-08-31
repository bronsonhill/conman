// The fixed downstream task: multi-needle retrieval ("lost in the middle").
//
// A small haystack of same-shaped facts holds K target "access code" facts
// among distractors. The model is asked for all K codes, one per line, digits
// only. Score = fraction of codes returned exactly right, at the right position.
// No LLM judge, no agent loop -- a regex pulls the digit run from each line and
// compares position-wise to the expected list.
//
// The haystack is small and constant across the sweep. The independent variable
// is the synthetic context stack prepended ahead of it (see stack.mjs). At
// stack size 0 a capable model scores ~1.0; the sweep looks for the stack size
// where the score starts to fall.

import { rngFromKey, randInt, pick, shuffle } from "./prng.mjs";

const ZONE_WORDS = [
  "Zone", "Sector", "Bay", "Wing", "Deck", "Vault", "Grid", "Node", "Dock", "Cell",
];
const LETTERS = "ABCDEFGHJKLMNPRSTUVWXYZ".split(""); // no I/O/Q, easier to read
const NAMES = [
  "Alvarez", "Boone", "Cho", "Devi", "Ekwueme", "Farmer", "Grigson",
  "Haddad", "Iverson", "Jha", "Kowalski", "Lindqvist", "Mbeki", "Novak",
];
const TIMES = [
  "02:00", "03:30", "05:15", "07:45", "11:00", "13:20", "16:40", "19:05", "22:30",
];
const SYSTEMS = [
  "coolant loop", "air handler", "pump array", "relay bank", "sensor mesh",
  "backup generator", "filtration unit", "comms uplink",
];

function zoneLabel(rng) {
  const word = pick(rng, ZONE_WORDS);
  const letter = pick(rng, LETTERS);
  const num = randInt(rng, 1, 9);
  return `${word} ${letter}${num}`;
}

function sixDigits(rng) {
  let s = "";
  for (let i = 0; i < 6; i++) s += randInt(rng, 0, 9);
  return s;
}

/**
 * Build one trial: a haystack string, the list of questions, and the expected
 * codes. `key` fully determines the content.
 */
export function buildTask({ key, needles, distractors }) {
  const rng = rngFromKey(`task:${key}`);

  // Unique zone labels for this trial.
  const zones = new Set();
  while (zones.size < needles + distractors) zones.add(zoneLabel(rng));
  const zoneList = shuffle(rng, [...zones]);

  const targetZones = zoneList.slice(0, needles);
  const distractorZones = zoneList.slice(needles);

  const expected = targetZones.map(() => sixDigits(rng));

  const needleFacts = targetZones.map(
    (z, i) => `The access code for ${z} is ${expected[i]}.`,
  );

  // Distractors share the surface form so the model cannot key on "code".
  const distractorFacts = distractorZones.map((z) => {
    const kind = randInt(rng, 0, 3);
    if (kind === 0) return `The maintenance window for ${z} is ${pick(rng, TIMES)}.`;
    if (kind === 1) return `The supervisor of ${z} is ${pick(rng, NAMES)}.`;
    if (kind === 2)
      return `The ${pick(rng, SYSTEMS)} in ${z} was serviced at ${pick(rng, TIMES)}.`;
    return `The access log for ${z} shows ${randInt(rng, 2, 40)} entries today.`;
  });

  const lines = shuffle(rng, [...needleFacts, ...distractorFacts]);
  const haystack = lines.join("\n");

  const questions = targetZones.map(
    (z, i) => `${i + 1}. What is the access code for ${z}?`,
  );

  return { haystack, questions, expected, targetZones };
}

/** Compose the user message for a trial from its task and a context stack. */
export function composePrompt({ task, stack }) {
  const parts = [];
  if (stack) {
    parts.push(stack.trimEnd());
    parts.push("");
    parts.push("=".repeat(60));
    parts.push("");
  }
  parts.push(
    "Facility reference sheet. Each line is an independent fact.",
    "",
    task.haystack,
    "",
    "Answer these questions using only the reference sheet above.",
    "Reply with one line per question, in order. Each line must contain",
    "ONLY the six-digit code, no numbering, no words.",
    "",
    ...task.questions,
  );
  return parts.join("\n");
}

export const SYSTEM_PROMPT =
  "You are a precise retrieval assistant. Answer only from the text provided.";

/** Pull the digit run out of a model line; "" if none. */
function extractCode(line) {
  const m = line.replace(/^\s*\d+[.):]\s*/, "").match(/\d[\d\s-]{4,}\d/);
  if (!m) return "";
  return m[0].replace(/[\s-]/g, "");
}

/**
 * Score a model response against expected codes. Returns
 * { score, got } where score is in [0, 1] and got is the parsed code list.
 */
export function scoreResponse(text, expected) {
  const rawLines = text
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
  const got = rawLines.map(extractCode).filter((c) => c.length > 0);

  let hits = 0;
  for (let i = 0; i < expected.length; i++) {
    if (got[i] === expected[i]) hits++;
  }
  return { score: expected.length ? hits / expected.length : 0, got };
}
