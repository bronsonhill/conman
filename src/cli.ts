#!/usr/bin/env node
// conman CLI. Commands:
//   conman <entrypoint>          analyze one entry point (a dir, or a file for scoped checks)
//   conman map [root]            discover and analyze every entry point in the repo
//   conman check [<entrypoint>]  analyze + gate; non-zero exit over budget or on gated findings
//   conman explain [<id>]        describe a finding type (explanation, research, fix)
//
// Flags: --json  --format <human|json|sarif>  --config <path>  --budget <n>  --tokenizer <name>
//        --no-repo-boundary  --fix  --dry-run  --trim  --map (check only)
//        --html <path> (map, or check --map)
//
// Exit codes: 0 ok / gate pass, 1 gate fail, 2 usage or runtime error.

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig, type Config } from "./config.js";
import { AGENTS, isAgent, type Agent } from "./agent.js";
import { findRepoRoot, isDir, isFile, relPosix } from "./repo.js";
import { analyzeEntry } from "./analyze.js";
import { renderHuman, renderJson, type RenderContext } from "./report.js";
import { runMap, discoverEntryPoints } from "./map.js";
import type { FileChange } from "./fix.js";
import { renderMapHuman, renderMapJson } from "./mapReport.js";
import { renderMapHtml } from "./mapHtmlReport.js";
import { computeFixes, applyFixes } from "./fix.js";
import { computeTrim, renderTrimHuman, renderTrimJson } from "./trim.js";
import { unifiedDiff } from "./diff.js";
import { evaluateGate } from "./gate.js";
import { renderSarif } from "./sarif.js";
import { renderExplain, renderExplainList } from "./explain.js";

const HERE = dirname(fileURLToPath(import.meta.url));

function toolVersion(): string {
  try {
    const pkg = JSON.parse(readFileSync(resolve(HERE, "../package.json"), "utf8"));
    return typeof pkg.version === "string" ? pkg.version : "0.0.0";
  } catch {
    return "0.0.0";
  }
}

interface Args {
  command: "analyze" | "map" | "check" | "explain";
  target: string | null;
  json: boolean;
  sarif: boolean;
  configPath?: string;
  budget?: number;
  tokenizer: string;
  agent: Agent;
  repoBoundary: boolean;
  fix: boolean;
  dryRun: boolean;
  trim: boolean;
  map: boolean;
  html?: string;
  repoRoot?: string;
}

function applyFormat(a: Args, value: string | undefined): void {
  switch (value) {
    case "human":
      a.json = false;
      a.sarif = false;
      break;
    case "json":
      a.json = true;
      a.sarif = false;
      break;
    case "sarif":
      a.json = false;
      a.sarif = true;
      break;
    default:
      process.stderr.write(
        `conman: --format expects human | json | sarif, got ${value ?? "(nothing)"}\n`,
      );
      process.exit(2);
  }
}

function applyAgent(a: Args, value: string | undefined): void {
  if (value && isAgent(value)) {
    a.agent = value;
    return;
  }
  process.stderr.write(
    `conman: --agent expects ${AGENTS.join(" | ")}, got ${value ?? "(nothing)"}\n`,
  );
  process.exit(2);
}

function parseArgs(argv: string[]): Args | { help: true } | { version: true } {
  const a: Args = {
    command: "analyze",
    target: null,
    json: false,
    sarif: false,
    tokenizer: "claude-local",
    agent: "claude",
    repoBoundary: true,
    fix: false,
    dryRun: false,
    trim: false,
    map: false,
  };
  const positional: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const t = argv[i]!;
    switch (t) {
      case "-h":
      case "--help":
        return { help: true };
      case "-v":
      case "--version":
        return { version: true };
      case "--json":
        a.json = true;
        break;
      case "--format":
        applyFormat(a, argv[++i]);
        break;
      case "--fix":
        a.fix = true;
        break;
      case "--dry-run":
        a.dryRun = true;
        break;
      case "--trim":
        a.trim = true;
        break;
      case "--map":
        a.map = true;
        break;
      case "--no-repo-boundary":
        a.repoBoundary = false;
        break;
      case "--config":
        a.configPath = argv[++i];
        break;
      case "--html":
        a.html = argv[++i];
        break;
      case "--repo-root":
        a.repoRoot = argv[++i];
        break;
      case "--budget":
        a.budget = Number(argv[++i]);
        break;
      case "--tokenizer":
        a.tokenizer = argv[++i] ?? "claude-local";
        break;
      case "--agent":
        applyAgent(a, argv[++i]);
        break;
      default:
        if (t.startsWith("--format=")) applyFormat(a, t.slice("--format=".length));
        else if (t.startsWith("--budget=")) a.budget = Number(t.slice("--budget=".length));
        else if (t.startsWith("--config=")) a.configPath = t.slice("--config=".length);
        else if (t.startsWith("--html=")) a.html = t.slice("--html=".length);
        else if (t.startsWith("--repo-root=")) a.repoRoot = t.slice("--repo-root=".length);
        else if (t.startsWith("--tokenizer=")) a.tokenizer = t.slice("--tokenizer=".length);
        else if (t.startsWith("--agent=")) applyAgent(a, t.slice("--agent=".length));
        else if (t.startsWith("-")) {
          process.stderr.write(`conman: unknown flag ${t}\n`);
          process.exit(2);
        } else positional.push(t);
    }
  }

  if (
    positional[0] === "map" ||
    positional[0] === "check" ||
    positional[0] === "explain"
  ) {
    a.command = positional[0];
    a.target = positional[1] ?? null;
  } else {
    a.command = "analyze";
    a.target = positional[0] ?? null;
  }
  return a;
}

const HELP = `conman ${toolVersion()} - deterministic linter for a repo's Claude Code context stack

USAGE
  conman <entrypoint> [flags]      analyze one entry point
  conman map [root] [flags]        analyze every entry point (memory files + path-scoped rule targets)
  conman check [<entrypoint>]      analyze + gate on budget / findings
  conman explain [<finding-id>]    describe a finding type, its research, its fix

FLAGS
  --json                 machine-readable output (alias for --format json)
  --format <fmt>         human (default) | json | sarif; sarif is SARIF 2.1.0
                         for GitHub code scanning (single entry point only)
  --config <path>        config file (default: search up for conman.json)
  --budget <n>           override the total-token budget
  --tokenizer <name>     claude-local (default) | exact (unimplemented seam)
  --agent <name>         claude (default) | codex | cursor | copilot; selects the
                         resolution ruleset. Non-claude rulesets are best-effort
                         (see MODEL.md)
  --no-repo-boundary     walk ancestors above the repo root
  --repo-root <path>     treat <path> as the repo root (default: nearest .git)
  --fix                  apply mechanical fixes (dedupe, sort skill keys, whitespace);
                         with map, fixes every discovered entry point. A leaf
                         entry point warns before rewriting ancestor files.
  --dry-run              with --fix: print a diff, write nothing
  --trim                 (analyze only) list provably-redundant whole files and a
                         git-apply-able diff that deletes them; writes nothing
  --map                  (check only) gate across all discovered entry points
  --html <path>          (map, or check --map) write a self-contained HTML report
                         to <path>; with check --map the page leads with the gate
                         verdict, effective budget, and failing entry points

EXIT CODES
  0  ok / gate pass    1  gate fail    2  usage or runtime error
`;

function applyOverrides(config: Config, args: Args): Config {
  const c: Config = {
    ...config,
    budget: { ...config.budget },
    gate: { ...config.gate },
    resolve: { ...config.resolve },
    ignore: [...config.ignore],
  };
  if (typeof args.budget === "number" && Number.isFinite(args.budget)) {
    c.budget.total = args.budget;
  }
  if (!args.repoBoundary) c.resolve.repoBoundary = false;
  return c;
}

/**
 * Files a `--fix` run would rewrite that sit outside the entry point the user
 * named. `targetRel` is the entry-point directory relative to the repo root
 * ("." for the root itself). A leaf entry inherits and overrides its ancestors,
 * so `conman sub/ --fix` can legitimately rewrite the repo-root CLAUDE.md; this
 * lists those files so the write is not a surprise.
 */
function outOfPathFiles(targetRel: string, files: string[]): string[] {
  if (targetRel === "." || targetRel === "") return [];
  const prefix = `${targetRel}/`;
  return files.filter((f) => f !== targetRel && !f.startsWith(prefix)).sort();
}

function warnOutOfPath(targetRel: string, changes: FileChange[]): void {
  const outside = outOfPathFiles(
    targetRel,
    changes.map((c) => c.file),
  );
  if (outside.length === 0) return;
  process.stdout.write(
    `warning: ${targetRel}/ inherits from ancestor context files; --fix will also modify:\n`,
  );
  for (const f of outside) process.stdout.write(`  ${f}\n`);
}

/**
 * `conman map --fix`: apply mechanical fixes across every discovered entry
 * point, not just one. Without this the map branch returns before the analyze
 * branch's fix block, so `map --fix` writes nothing.
 */
function runMapFix(root: string, config: Config, args: Args): void {
  const repoRoot = root;
  const points = discoverEntryPoints(repoRoot, config, args.agent);
  const merged = new Map<string, FileChange>();
  const notes = new Set<string>();
  for (const p of points) {
    const { analysis } = analyzeEntry(p.abs, {
      repoRoot,
      config,
      tokenizerName: args.tokenizer,
      agent: args.agent,
    });
    const fixes = computeFixes(repoRoot, analysis);
    for (const n of fixes.notes) notes.add(n);
    if (!args.dryRun) applyFixes(repoRoot, fixes);
    for (const c of fixes.changes) {
      if (!merged.has(c.file)) merged.set(c.file, c);
    }
  }
  const changes = [...merged.values()].sort((a, b) => (a.file < b.file ? -1 : 1));
  const label = args.dryRun ? "map --fix --dry-run" : "map --fix";
  if (changes.length === 0) {
    process.stdout.write(`conman ${label}: no mechanical fixes to apply\n`);
  } else if (args.dryRun) {
    for (const c of changes) {
      process.stdout.write(`# ${c.file}: ${c.operations.join(", ")}\n`);
      process.stdout.write(unifiedDiff(c.before, c.after, c.file));
    }
  } else {
    for (const c of changes) {
      process.stdout.write(`fixed ${c.file}: ${c.operations.join(", ")}\n`);
    }
  }
  for (const n of [...notes].sort()) {
    process.stdout.write(`${args.dryRun ? "# note" : "note"}: ${n}\n`);
  }
}

function main(): void {
  const parsed = parseArgs(process.argv.slice(2));
  if ("help" in parsed) {
    process.stdout.write(HELP);
    return;
  }
  if ("version" in parsed) {
    process.stdout.write(toolVersion() + "\n");
    return;
  }
  const args = parsed;

  if (args.tokenizer === "exact") {
    process.stderr.write(
      "conman: exact-mode token counting is a documented seam, not implemented in the MVP\n",
    );
    process.exit(2);
  }

  if (args.command === "explain") {
    if (!args.target) {
      process.stdout.write(renderExplainList(toolVersion()));
      return;
    }
    const text = renderExplain(args.target, toolVersion());
    if (text === null) {
      process.stderr.write(
        `conman: no such finding type: ${args.target}\n` +
          `run \`conman explain\` with no argument to list them\n`,
      );
      process.exit(2);
    }
    process.stdout.write(text);
    return;
  }

  const cwd = process.cwd();
  const rawTarget = args.target ? resolve(cwd, args.target) : cwd;
  const repoRoot = args.repoRoot
    ? resolve(cwd, args.repoRoot)
    : findRepoRoot(isDir(rawTarget) ? rawTarget : dirname(rawTarget));

  const startDir = isDir(rawTarget) ? rawTarget : dirname(rawTarget);
  const { config: baseConfig, source: configSource } = loadConfig(
    startDir,
    repoRoot,
    args.configPath,
  );
  const config = applyOverrides(baseConfig, args);
  const tv = toolVersion();

  if (args.sarif && (args.command === "map" || args.map)) {
    process.stderr.write("conman: --format sarif is not supported with map\n");
    process.exit(2);
  }

  if (args.command === "map" || (args.command === "check" && args.map)) {
    const root = args.target ? resolve(cwd, args.target) : repoRoot;
    if (args.fix) {
      runMapFix(root, config, args);
      return;
    }
    const result = runMap(root, config, args.tokenizer, args.agent);
    if (args.html) {
      const dest = resolve(cwd, args.html);
      writeFileSync(
        dest,
        renderMapHtml(result, tv, configSource, { gate: args.command === "check" }),
      );
      process.stdout.write(`wrote ${args.html}\n`);
    } else {
      process.stdout.write(
        args.json
          ? renderMapJson(result, tv, configSource)
          : renderMapHuman(result, tv, configSource),
      );
    }
    process.exit(args.command === "check" ? (result.pass ? 0 : 1) : 0);
  }

  if (!isDir(rawTarget) && !isFile(rawTarget)) {
    process.stderr.write(`conman: entry point not found: ${args.target}\n`);
    process.exit(2);
  }

  const { analysis, notes, mode } = analyzeEntry(rawTarget, {
    repoRoot,
    config,
    tokenizerName: args.tokenizer,
    agent: args.agent,
  });

  if (args.trim) {
    const trim = computeTrim(repoRoot, analysis);
    process.stdout.write(
      args.json
        ? renderTrimJson(trim, analysis.entry, tv)
        : renderTrimHuman(trim, analysis.entry, tv),
    );
    return;
  }

  if (args.fix) {
    const fixes = computeFixes(repoRoot, analysis);
    warnOutOfPath(relPosix(repoRoot, startDir), fixes.changes);
    if (args.dryRun) {
      if (fixes.changes.length === 0) {
        process.stdout.write("conman --fix --dry-run: no mechanical fixes to apply\n");
      } else {
        for (const c of fixes.changes) {
          process.stdout.write(`# ${c.file}: ${c.operations.join(", ")}\n`);
          process.stdout.write(unifiedDiff(c.before, c.after, c.file));
        }
      }
      for (const n of fixes.notes) process.stdout.write(`# note: ${n}\n`);
      return;
    }
    applyFixes(repoRoot, fixes);
    if (fixes.changes.length === 0) {
      process.stdout.write("conman --fix: no mechanical fixes to apply\n");
    } else {
      for (const c of fixes.changes) {
        process.stdout.write(`fixed ${c.file}: ${c.operations.join(", ")}\n`);
      }
    }
    for (const n of fixes.notes) process.stdout.write(`note: ${n}\n`);
    return;
  }

  const ctx: RenderContext = {
    analysis,
    config,
    configSource,
    notes,
    mode,
    toolVersion: tv,
  };
  process.stdout.write(
    args.sarif
      ? renderSarif(analysis, tv)
      : args.json
        ? renderJson(ctx)
        : renderHuman(ctx),
  );

  if (args.command === "check") {
    const gate = evaluateGate(analysis, config);
    process.exit(gate.exitCode);
  }
}

try {
  main();
} catch (err) {
  process.stderr.write(`conman: ${(err as Error).message}\n`);
  process.exit(2);
}
