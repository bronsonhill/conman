// survey-lib.mjs — pure helpers for scripts/survey.mjs: the qualify-stage
// predicates (docs/suite-criteria.md criteria 1-3) and per-repo aggregation
// (criterion 4). No network, no filesystem, no Date.now(): callers pass `now`
// and a token counter, so the tests run on hand-built inputs.

export const THRESHOLDS = Object.freeze({
  minStars: 50,
  maxAgeDays: 183, // ~6 months since the last push
  minRootTokens: 500,
  minSourceShare: 0.3,
  maxAgentShare: 0.4,
  minSourceFiles: 10,
  // Borderline margins: a pick inside these bands is flagged for the captain.
  borderline: { rootTokens: 750, stars: 75, ageDays: 150, sourceShare: 0.4, agentShare: 0.3 },
});

// ---------------------------------------------------------------------------
// path classification

const SOURCE_EXT = new Set(
  ("ts tsx js jsx mjs cjs py go rs java kt kts scala rb php c h cc cpp cxx hpp cs swift m mm dart lua sh bash zsh " +
    "ex exs erl hs clj cljs ml fs vue svelte sql zig nim r jl pl pm ps1 gd").split(" "),
);
const DOC_EXT = new Set("md mdx rst txt adoc".split(" "));
// Not counted at all: binary assets, lockfiles, generated bundles.
const IGNORED_EXT = new Set(
  ("png jpg jpeg gif webp ico svg bmp pdf mp3 mp4 mov wav ogg woff woff2 ttf otf eot zip gz tar tgz jar wasm " +
    "lock sum map snap").split(" "),
);
const VENDOR_SEGMENTS = new Set(["node_modules", "vendor", "third_party", "dist", "build", ".git", "__pycache__"]);
// Directories whose contents are agent material rather than the project itself.
const AGENT_DIRS = new Set(["skills", "prompts", "agents", "commands", ".claude", ".cursor", ".agents"]);

/** @returns {"source"|"doc"|"other"|"ignored"} */
export function fileKind(path) {
  const segs = path.split("/");
  if (segs.some((s) => VENDOR_SEGMENTS.has(s))) return "ignored";
  const base = segs[segs.length - 1];
  if (/\.min\.(js|css)$/.test(base)) return "ignored";
  const dot = base.lastIndexOf(".");
  const ext = dot > 0 ? base.slice(dot + 1).toLowerCase() : "";
  if (IGNORED_EXT.has(ext)) return "ignored";
  if (SOURCE_EXT.has(ext)) return "source";
  if (DOC_EXT.has(ext)) return "doc";
  return "other";
}

/** Project-vs-collection numbers for criterion 1. Every figure is reported, not just the verdict. */
export function projectStats(paths) {
  let source = 0, doc = 0, other = 0, agent = 0;
  for (const p of paths) {
    const k = fileKind(p);
    if (k === "ignored") continue;
    if (k === "source") source++;
    else if (k === "doc") doc++;
    else other++;
    if (p.split("/").slice(0, -1).some((s) => AGENT_DIRS.has(s))) agent++;
  }
  const total = source + doc + other;
  return {
    sourceFiles: source,
    docFiles: doc,
    otherFiles: other,
    totalFiles: total,
    sourceShare: total ? +(source / total).toFixed(3) : 0,
    agentShare: total ? +(agent / total).toFixed(3) : 0,
  };
}

const NAME_HINT = /(^|[-_.])(awesome|template|templates|starter|boilerplate|skeleton|cookiecutter)([-_.]|$)|(^|[-_.])(skills?|prompts?|prompt-library|dotfiles)$/i;
const TOPIC_HINT = /^(awesome|awesome-list|template|templates|starter|starter-template|boilerplate|cookiecutter|prompts?|skills|claude-skills|dotfiles)$/i;

/** Name/topic hint for criterion 1. Returns the matched hint or null. */
export function collectionHint(name, topics = []) {
  const repoName = name.split("/").pop();
  const m = repoName.match(NAME_HINT);
  if (m) return `name:${m[0].replace(/^[-_.]|[-_.]$/g, "").toLowerCase()}`;
  const t = topics.find((x) => TOPIC_HINT.test(x));
  return t ? `topic:${t}` : null;
}

// ---------------------------------------------------------------------------
// criteria 1 + 3 on repo metadata

/**
 * meta: { fork, archived, is_template, stargazers_count, pushed_at, topics, full_name }.
 * Returns a rejection code or null. Order is fixed so counts are reproducible.
 */
export function checkMeta(meta, now, t = THRESHOLDS) {
  if (meta.fork) return "fork";
  if (meta.archived) return "archived";
  if (meta.is_template) return "template-flag";
  const hint = collectionHint(meta.full_name, meta.topics || []);
  if (hint) return `collection-hint (${hint})`;
  if ((meta.stargazers_count ?? 0) < t.minStars) return `stars<${t.minStars}`;
  const age = ageDays(meta.pushed_at, now);
  if (age === null || age > t.maxAgeDays) return `stale (>${t.maxAgeDays}d since push)`;
  return null;
}

export function ageDays(iso, now) {
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? Math.floor((now - ms) / 86_400_000) : null;
}

/** Criterion 1, file-mix half. */
export function checkProject(stats, t = THRESHOLDS) {
  if (stats.sourceFiles < t.minSourceFiles) return `collection (only ${stats.sourceFiles} source files)`;
  if (stats.sourceShare < t.minSourceShare) return `collection (source share ${pct(stats.sourceShare)} < ${pct(t.minSourceShare)})`;
  if (stats.agentShare > t.maxAgentShare) return `collection (agent-dir share ${pct(stats.agentShare)} > ${pct(t.maxAgentShare)})`;
  return null;
}

const pct = (x) => `${Math.round(x * 100)}%`;

// ---------------------------------------------------------------------------
// criterion 2: harness structure

/** Strip fenced blocks and inline code, then collect `@path` tokens (mirrors src/resolver/imports.ts). */
export function findAtImports(text) {
  const out = [];
  let fenced = false;
  for (const line of text.split("\n")) {
    if (/^\s*(```|~~~)/.test(line)) { fenced = !fenced; continue; }
    if (fenced) continue;
    const masked = line.replace(/`[^`]*`/g, "");
    for (const m of masked.matchAll(/(?:^|\s)@([^\s`]+)/g)) {
      if (!m[1].startsWith("~")) out.push(m[1]);
    }
  }
  return out;
}

const normPath = (p) => {
  const out = [];
  for (const s of p.split("/")) {
    if (s === "" || s === ".") continue;
    if (s === "..") { if (!out.length) return null; out.pop(); } else out.push(s);
  }
  return out.join("/");
};
const dirOf = (p) => (p.includes("/") ? p.slice(0, p.lastIndexOf("/")) : "");
const resolveFrom = (file, ref) => normPath(ref.startsWith("/") ? ref.slice(1) : (dirOf(file) ? dirOf(file) + "/" : "") + ref);

/**
 * The root memory file Claude Code loads: CLAUDE.md or .claude/CLAUDE.md.
 * A bare AGENTS.md does not load (MODEL.md), so it never counts on its own.
 * entries: [{path, mode}] from the git tree. Returns {path, symlink} or null.
 */
export function rootMemoryEntry(entries) {
  for (const p of ["CLAUDE.md", ".claude/CLAUDE.md"]) {
    const e = entries.find((x) => x.path === p);
    if (e) return { path: p, symlink: e.mode === "120000" };
  }
  return null;
}

/**
 * Decide the root stack from fetched text. `read(path)` returns blob text or null.
 * Follows one symlink hop and depth-1 @-imports that exist in the tree (max 5 fetched).
 * Returns {tokens, files, imports} where imports are tree-resident @-import targets.
 */
export function rootStack(entry, treePaths, read, countTokens) {
  const have = new Set(treePaths);
  let path = entry.path;
  let text = read(path);
  if (text === null) return { tokens: 0, files: [], imports: [] };
  if (entry.symlink) {
    const target = resolveFrom(path, text.trim());
    if (!target || !have.has(target)) return { tokens: 0, files: [], imports: [] };
    path = target;
    text = read(path);
    if (text === null) return { tokens: 0, files: [], imports: [] };
  }
  const files = [path];
  let tokens = countTokens(text);
  const imports = [];
  for (const ref of findAtImports(text)) {
    for (const cand of [ref, ref.replace(/[.,;:)]+$/, "")]) {
      const target = resolveFrom(path, cand);
      if (target && have.has(target) && !imports.includes(target)) { imports.push(target); break; }
    }
  }
  for (const target of imports.slice(0, 5)) {
    const t = read(target);
    if (t === null) continue;
    files.push(target);
    tokens += countTokens(t);
  }
  return { tokens, files, imports };
}

const RULE_RE = /(^|\/)\.claude\/rules\/.+\.md$/;
const SKILL_RE = /(^|\/)\.claude\/skills\/[^/]+\/SKILL\.md$/;
const SETTINGS_KEYS = ["claudeMdExcludes", "claudeMd.excludes", "skillListingBudget", "skillsListingBudget", "skills.listingBudget"];

/** True if a settings.json text sets a key that changes resolution (MODEL.md). */
export function settingsChangesResolution(text) {
  let j;
  try { j = JSON.parse(text); } catch { return false; }
  const get = (path) => path.split(".").reduce((o, k) => (o && typeof o === "object" ? o[k] : undefined), j);
  return SETTINGS_KEYS.some((k) => (k in j ? j[k] : get(k)) !== undefined);
}

/**
 * Structural features, as {name: count}. `memoryPath` is the root memory file;
 * `imports` its tree-resident @-import targets. A root-level AGENTS.md pointer
 * does not count: CLAUDE.md -> @AGENTS.md is one file in two places, not layering.
 */
export function structuralFeatures(treePaths, { memoryPath, imports = [], settingsText = null }) {
  const f = {};
  const nested = treePaths.filter(
    (p) => /(^|\/)CLAUDE\.md$/.test(p) && p !== "CLAUDE.md" && p !== ".claude/CLAUDE.md" && !p.split("/").some((s) => VENDOR_SEGMENTS.has(s)),
  ).length;
  if (nested) f["nested-claude-md"] = nested;
  const rules = treePaths.filter((p) => RULE_RE.test(p)).length;
  if (rules) f["rules"] = rules;
  const skills = treePaths.filter((p) => SKILL_RE.test(p)).length;
  if (skills) f["skills"] = skills;
  const imp = imports.filter((p) => p !== "AGENTS.md" && p !== memoryPath).length;
  if (imp) f["@-imports"] = imp;
  if (settingsText && settingsChangesResolution(settingsText)) f["settings-keys"] = 1;
  return f;
}

/** Flags that make an included repo a close call; the captain rules on these. */
export function borderlineFlags({ rootTokens, stars, ageDays: age, stats, features }, t = THRESHOLDS) {
  const b = t.borderline;
  const flags = [];
  if (rootTokens < b.rootTokens) flags.push(`root memory ${rootTokens} tok, near the ${t.minRootTokens} floor`);
  if (stars < b.stars) flags.push(`${stars} stars, near the ${t.minStars} floor`);
  if (age > b.ageDays) flags.push(`last push ${age}d ago, near the ${t.maxAgeDays}d cutoff`);
  if (stats.sourceShare < b.sourceShare) flags.push(`source share ${pct(stats.sourceShare)}, near the ${pct(t.minSourceShare)} floor`);
  if (stats.agentShare > b.agentShare) flags.push(`agent-dir share ${pct(stats.agentShare)}, near the ${pct(t.maxAgentShare)} ceiling`);
  const only = Object.keys(features);
  if (only.length === 1 && (only[0] === "@-imports" || only[0] === "settings-keys")) flags.push(`only structural feature is ${only[0]}`);
  return flags;
}

// ---------------------------------------------------------------------------
// suite file

/** One suite line: `owner/repo # included: ... [# borderline: ...]`. */
export function suiteLine(r) {
  const feats = Object.entries(r.features).map(([k, v]) => (v > 1 ? `${k} x${v}` : k)).join(", ");
  let line = `${r.repo} # features: ${feats}; root ${r.rootTokens} tok; ${r.stars} stars; source ${pct(r.stats.sourceShare)}`;
  if (r.borderline.length) line += ` # borderline: ${r.borderline.join("; ")}`;
  return line;
}

/** Parse a suite/candidate file: owner/repo per line, '#' comments ignored. */
export function parseRepoList(text) {
  const repos = text
    .split("\n")
    .map((s) => s.replace(/#.*/, "").trim())
    .filter((s) => /^[\w.-]+\/[\w.-]+$/.test(s));
  return [...new Set(repos)].sort();
}

/** Bucket rejection reasons by code (text before the first " (" or "<"), for the counts table. */
export function rejectionCounts(rejections) {
  const counts = new Map();
  for (const { reason } of rejections) {
    const code = reason.replace(/\s*[(<].*$/, "").trim() || reason;
    counts.set(code, (counts.get(code) || 0) + 1);
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1));
}

// ---------------------------------------------------------------------------
// aggregation (criterion 4)

export const median = (xs) => {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
export const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);

/** Per-repo summary of a `conman map --json` result. */
export function summariseRepo(name, map) {
  const eps = map.entryPoints || [];
  let stackTokens = 0, redundantTokens = 0, overBudgetEps = 0, valueConflictEps = 0;
  const stackSizes = [];
  for (const e of eps) {
    stackTokens += e.stackTokens || 0;
    redundantTokens += e.redundant?.tokens || 0;
    stackSizes.push(e.stackTokens || 0);
    if (e.budget?.overBudget) overBudgetEps++;
    if ((e.findings || []).some((f) => f.type === "value-conflict" && f.severity === "error")) valueConflictEps++;
  }
  return {
    repo: name,
    entryPoints: eps.length,
    stackTokens,
    redundantTokens,
    redundantPct: stackTokens ? +((redundantTokens / stackTokens) * 100).toFixed(2) : 0,
    overBudgetEntryPoints: overBudgetEps,
    valueConflictEntryPoints: valueConflictEps,
    medianStackTokens: median(stackSizes),
    stackSizes,
  };
}

/**
 * Pooled figures (every entry point weighs the same, so a repo with 50 entry
 * points outweighs one with 2) and per-repo figures (every repo weighs the same).
 */
export function aggregate(repoSummaries) {
  const mapped = repoSummaries.filter((r) => r.entryPoints > 0);
  const n = mapped.length;
  const rate = (k, d) => (d ? +((k / d) * 100).toFixed(1) : 0);
  const vcRepos = mapped.filter((r) => r.valueConflictEntryPoints > 0).length;
  const overBudgetRepos = mapped.filter((r) => r.overBudgetEntryPoints > 0).length;
  const redundantRepos = mapped.filter((r) => r.redundantTokens > 0).length;
  const totalEps = mapped.reduce((a, r) => a + r.entryPoints, 0);
  const overBudgetEps = mapped.reduce((a, r) => a + r.overBudgetEntryPoints, 0);
  const redundantPcts = mapped.map((r) => r.redundantPct);
  const repoMedians = mapped.map((r) => r.medianStackTokens);
  const repoOverFractions = mapped.map((r) => r.overBudgetEntryPoints / r.entryPoints);
  const biggest = mapped.reduce((m, r) => Math.max(m, r.entryPoints), 0);
  return {
    reposMapped: n,
    entryPoints: totalEps,
    redundantTokenPctMedian: +median(redundantPcts).toFixed(2),
    redundantTokenPctMean: +mean(redundantPcts).toFixed(2),
    valueConflictRepoRatePct: rate(vcRepos, n),
    valueConflictRepos: vcRepos,
    redundantRepos,
    redundantRepoRatePct: rate(redundantRepos, n),
    // pooled across every entry point
    medianResolvedStackTokens: median(mapped.flatMap((r) => r.stackSizes)),
    overBudgetEntryPointRatePct: rate(overBudgetEps, totalEps),
    overBudgetEntryPoints: overBudgetEps,
    // per repo
    medianOfRepoMedianStackTokens: median(repoMedians),
    overBudgetRepoRatePct: rate(overBudgetRepos, n),
    overBudgetRepos,
    repoWeightedOverBudgetEntryPointPct: +(mean(repoOverFractions) * 100).toFixed(1),
    largestRepoEntryPointSharePct: rate(biggest, totalEps),
  };
}
