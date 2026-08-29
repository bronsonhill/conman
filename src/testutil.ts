// Test-only helpers. Not part of the public surface.

import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** Repo root, from a compiled test at dist/<x>.test.js. */
export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export function fixture(...parts: string[]): string {
  return resolve(REPO_ROOT, "test", "fixtures", ...parts);
}
