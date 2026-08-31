import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findLintDuplication } from "./lintDuplication.js";
import { DEFAULT_CONFIG } from "../config.js";
import type { Block, BlockKind } from "../types.js";

function block(over: Partial<Block> & { kind: BlockKind; source: string; text: string }): Block {
  return {
    id: "b1",
    depth: 0,
    lineStart: 1,
    lineEnd: 10,
    tokens: 0,
    ...over,
  };
}

/** Make a throwaway repo root with the given files, run the finder, clean up. */
function withRepo(files: Record<string, string>, blocks: Block[], config = DEFAULT_CONFIG) {
  const root = mkdtempSync(join(tmpdir(), "conman-lintdup-"));
  try {
    for (const [name, body] of Object.entries(files)) writeFileSync(join(root, name), body);
    return findLintDuplication(blocks, config, root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

const memory = (text: string, source = "CLAUDE.md") => block({ kind: "memory", source, text });

test("lint-dup unit: severity off short-circuits", () => {
  const config = {
    ...DEFAULT_CONFIG,
    gate: { ...DEFAULT_CONFIG.gate, "lint-duplication": "off" as const },
  };
  const out = withRepo(
    { ".prettierrc": JSON.stringify({ tabWidth: 2 }) },
    [memory("Use 2 spaces for indentation everywhere.")],
    config,
  );
  assert.deepEqual(out, []);
});

test("lint-dup unit: empty repoRoot short-circuits", () => {
  const out = findLintDuplication([memory("Use 2 spaces for indentation.")], DEFAULT_CONFIG, "");
  assert.deepEqual(out, []);
});

test("lint-dup unit: no recognised config yields nothing", () => {
  const out = withRepo({ "README.md": "hi" }, [memory("Use 2 spaces for indentation.")]);
  assert.deepEqual(out, []);
});

test("lint-dup unit: prettier keys each collide once", () => {
  const out = withRepo(
    {
      ".prettierrc": JSON.stringify({
        tabWidth: 2,
        printWidth: 80,
        semi: false,
        singleQuote: true,
        trailingComma: "all",
      }),
    },
    [
      memory(
        [
          "Indent with 2 spaces.",
          "Keep every line under 80 characters.",
          "Use no semicolons in this codebase.",
          "Prefer single quotes, not double.",
          "Always add trailing commas to multiline literals.",
        ].join("\n"),
      ),
    ],
  );
  assert.deepEqual(
    out.map((f) => f.detail?.["rule"]).sort(),
    ["indent-spaces", "line-length", "quotes-single", "semi-omit", "trailing-comma"],
  );
  assert.ok(out.every((f) => f.severity === "warn"));
  assert.ok(out.every((f) => f.detail?.["config"] === ".prettierrc"));
  assert.ok(out.every((f) => f.type === "lint-duplication"));
});

test("lint-dup unit: prettier useTabs and semi:true branches", () => {
  const out = withRepo(
    { ".prettierrc.json": JSON.stringify({ useTabs: true, semi: true }) },
    [memory("Indent with tabs, always.\nAlways use semicolons.")],
  );
  assert.deepEqual(
    out.map((f) => f.detail?.["rule"]).sort(),
    ["indent-tabs", "semi-require"],
  );
});

test("lint-dup unit: YAML prettier config parses", () => {
  const out = withRepo(
    { ".prettierrc.yaml": "tabWidth: 4\n" },
    [memory("Use 4 spaces for indentation.")],
  );
  assert.deepEqual(out.map((f) => f.detail?.["rule"]), ["indent-spaces"]);
  assert.equal(out[0]!.detail?.["config"], ".prettierrc.yaml");
});

test("lint-dup unit: eslint rules map to enforced rules", () => {
  const out = withRepo(
    {
      ".eslintrc.json": JSON.stringify({
        rules: {
          indent: ["error", 2],
          quotes: ["error", "double"],
          semi: ["error", "always"],
          "max-len": ["error", { code: 100 }],
          "no-console": "error",
        },
      }),
    },
    [
      memory(
        [
          "Indent with 2 spaces.",
          "Use double quotes, not single.",
          "Always use semicolons.",
          "Keep line length under 100.",
          "Don't use console.log in committed code.",
        ].join("\n"),
      ),
    ],
  );
  assert.deepEqual(
    out.map((f) => f.detail?.["rule"]).sort(),
    ["indent-spaces", "line-length", "no-console", "quotes-double", "semi-require"],
  );
});

test("lint-dup unit: eslint indent 'tab' option", () => {
  const out = withRepo(
    { ".eslintrc.json": JSON.stringify({ rules: { indent: ["error", "tab"] } }) },
    [memory("Indent with tabs across the repo.")],
  );
  assert.deepEqual(out.map((f) => f.detail?.["rule"]), ["indent-tabs"]);
});

test("lint-dup unit: biome formatter + linter keys", () => {
  const out = withRepo(
    {
      "biome.json": JSON.stringify({
        formatter: { indentStyle: "space", indentWidth: 2, lineWidth: 90 },
        javascript: { formatter: { quoteStyle: "single" } },
        linter: { rules: { suspicious: { noConsoleLog: "error" } } },
      }),
    },
    [
      memory(
        [
          "Indent with 2 spaces.",
          "Wrap at 90.",
          "Prefer single quotes, not double.",
          "Avoid console.log statements.",
        ].join("\n"),
      ),
    ],
  );
  assert.deepEqual(
    out.map((f) => f.detail?.["rule"]).sort(),
    ["indent-spaces", "line-length", "no-console", "quotes-single"],
  );
});

test("lint-dup unit: biome tab indent style", () => {
  const out = withRepo(
    { "biome.jsonc": JSON.stringify({ formatter: { indentStyle: "tab" } }) },
    [memory("Indent with tabs everywhere.")],
  );
  assert.deepEqual(out.map((f) => f.detail?.["rule"]), ["indent-tabs"]);
});

test("lint-dup unit: package.json prettier and eslintConfig", () => {
  const out = withRepo(
    {
      "package.json": JSON.stringify({
        prettier: { tabWidth: 2 },
        eslintConfig: { rules: { semi: ["error", "never"] } },
      }),
    },
    [memory("Use 2 spaces for indentation.\nUse no semicolons.")],
  );
  assert.deepEqual(
    out.map((f) => f.detail?.["rule"]).sort(),
    ["indent-spaces", "semi-omit"],
  );
  assert.equal(
    out.find((f) => f.detail?.["rule"] === "indent-spaces")!.detail?.["config"],
    "package.json#prettier",
  );
});

test("lint-dup unit: pyproject ruff and black tables", () => {
  const out = withRepo(
    {
      "pyproject.toml": [
        "[tool.ruff]",
        "line-length = 88",
        "",
        "[tool.black]",
        "# black only sets indent-width here",
        "indent-width = 4",
      ].join("\n"),
    },
    [memory("Keep every line under 88 characters.\nUse 4 spaces for indentation.")],
  );
  assert.deepEqual(
    out.map((f) => f.detail?.["rule"]).sort(),
    ["indent-spaces", "line-length"],
  );
  assert.equal(
    out.find((f) => f.detail?.["rule"] === "line-length")!.detail?.["key"],
    "[tool.ruff] line-length",
  );
});

test("lint-dup unit: prose inside a fenced block is ignored", () => {
  const out = withRepo(
    { ".prettierrc": JSON.stringify({ tabWidth: 2 }) },
    [memory("```\nUse 2 spaces for indentation.\n```\nNo collision here.")],
  );
  assert.deepEqual(out, []);
});

test("lint-dup unit: non-context block kinds are skipped", () => {
  const out = withRepo(
    { ".prettierrc": JSON.stringify({ tabWidth: 2 }) },
    [block({ kind: "skill-index", source: "<skills>", text: "Use 2 spaces for indentation." })],
  );
  assert.deepEqual(out, []);
});

test("lint-dup unit: one finding per (file, rule); first colliding line wins", () => {
  const out = withRepo(
    { ".prettierrc": JSON.stringify({ tabWidth: 2 }) },
    [
      memory(
        "intro line\nUse 2 spaces for indentation.\nUse 2 spaces for indentation again.",
        "CLAUDE.md",
      ),
    ],
  );
  assert.equal(out.length, 1);
  assert.equal(out[0]!.locations[0]!.lineStart, 2);
  assert.equal(out[0]!.locations[0]!.lineEnd, 2);
});

test("lint-dup unit: findings sort by file then line then rule", () => {
  const out = withRepo(
    { ".prettierrc": JSON.stringify({ tabWidth: 2, printWidth: 80 }) },
    [
      block({
        kind: "rule-always",
        source: "z.md",
        text: "Use 2 spaces for indentation.",
        lineStart: 5,
      }),
      block({
        kind: "memory",
        source: "a.md",
        text: "Use 2 spaces for indentation.\nKeep lines under 80 characters.",
        lineStart: 1,
      }),
    ],
  );
  assert.deepEqual(
    out.map((f) => [f.locations[0]!.file, f.locations[0]!.lineStart, f.detail?.["rule"]]),
    [
      ["a.md", 1, "indent-spaces"],
      ["a.md", 2, "line-length"],
      ["z.md", 5, "indent-spaces"],
    ],
  );
});

test("lint-dup unit: recognised config but prose that does not restate it", () => {
  const out = withRepo(
    { ".prettierrc": JSON.stringify({ tabWidth: 2, printWidth: 80 }) },
    [memory("Write clear commit messages and keep functions small.")],
  );
  assert.deepEqual(out, []);
});
