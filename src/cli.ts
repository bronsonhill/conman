#!/usr/bin/env node
// conman CLI. Commands:
//   conman <entrypoint>          analyze one entry point (a dir, or a file for scoped checks)
//   conman map [root]            discover and analyze every entry point in the repo
//   conman check [<entrypoint>]  analyze + gate; non-zero exit over budget or on gated findings
//
// Flags: --json  --config <path>  --budget <n>  --tokenizer <name>
//        --no-repo-boundary  --fix  --dry-run  --map (check only)
//
// Exit codes: 0 ok / gate pass, 1 gate fail, 2 usage or runtime error.

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig, type Config } from "./config.js";
import { findRepoRoot, isDir, isFile } from "./repo.js";
import { analyzeEntry } from "./analyze.js";
import { renderHuman, renderJson, type RenderContext } from "./report.js";
import { runMap } from "./map.js";
import { renderMapHuman, renderMapJson } from "./mapReport.js";
import { computeFixes, applyFixes } from "./fix.js";
import { unifiedDiff } from "./diff.js";
import { evaluateGate } from "./gate.js";

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
  command: "analyze" | "map" | "check";
  target: string | null;
  json: boolean;
  configPath?: string;
  budget?: number;
  tokenizer: string;
  repoBoundary: boolean;
  fix: boolean;
  dryRun: boolean;
  map: boolean;
  repoRoot?: string;
}

function parseArgs(argv: string[]): Args | { help: true } | { version: true } {
  const a: Args = {
    command: "analyze",
    target: null,
    json: false,
    tokenizer: "claude-local",
    repoBoundary: true,
    fix: false,
    dryRun: false,
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
      case "--fix":
        a.fix = true;
        break;
      case "--dry-run":
        a.dryRun = true;
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
      case "--repo-root":
        a.repoRoot = argv[++i];
        break;
      case "--budget":
        a.budget = Number(argv[++i]);
        break;
      case "--tokenizer":
        a.tokenizer = argv[++i] ?? "claude-local";
        break;
      default:
        if (t.startsWith("--budget=")) a.budget = Number(t.slice("--budget=".length));
        else if (t.startsWith("--config=")) a.configPath = t.slice("--config=".length);
        else if (t.startsWith("--repo-root=")) a.repoRoot = t.slice("--repo-root=".length);
        else if (t.startsWith("--tokenizer=")) a.tokenizer = t.slice("--tokenizer=".length);
        else if (t.startsWith("-")) {
          process.stderr.write(`conman: unknown flag ${t}\n`);
          process.exit(2);
        } else positional.push(t);
    }
  }

  if (positional[0] === "map" || positional[0] === "check") {
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
  conman map [root] [flags]        analyze every discovered entry point
  conman check [<entrypoint>]      analyze + gate on budget / findings

FLAGS
  --json                 machine-readable output
  --config <path>        config file (default: search up for conman.json)
  --budget <n>           override the total-token budget
  --tokenizer <name>     claude-local (default) | exact (unimplemented seam)
  --no-repo-boundary     walk ancestors above the repo root
  --repo-root <path>     treat <path> as the repo root (default: nearest .git)
  --fix                  apply mechanical fixes (dedupe, sort skill keys, whitespace)
  --dry-run              with --fix: print a diff, write nothing
  --map                  (check only) gate across all discovered entry points

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

  if (args.command === "map" || (args.command === "check" && args.map)) {
    const root = args.target ? resolve(cwd, args.target) : repoRoot;
    const result = runMap(root, config, args.tokenizer);
    process.stdout.write(
      args.json
        ? renderMapJson(result, tv, configSource)
        : renderMapHuman(result, tv, configSource),
    );
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
  });

  if (args.fix) {
    const fixes = computeFixes(repoRoot, analysis);
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
  process.stdout.write(args.json ? renderJson(ctx) : renderHuman(ctx));

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
