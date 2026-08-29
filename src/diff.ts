// Minimal line-level diff for `--fix --dry-run`. LCS via dynamic programming;
// context files are small, so a single whole-file hunk is the readable choice
// and is trivially correct. Output mimics `diff -u` closely enough to read and
// to pin in a golden test.

function diffOps(a: string[], b: string[]): { tag: " " | "-" | "+"; line: string }[] {
  const m = a.length;
  const n = b.length;
  const dp: number[][] = Array.from({ length: m + 1 }, () =>
    new Array<number>(n + 1).fill(0),
  );
  for (let i = m - 1; i >= 0; i--) {
    for (let j = n - 1; j >= 0; j--) {
      dp[i]![j] =
        a[i] === b[j]
          ? dp[i + 1]![j + 1]! + 1
          : Math.max(dp[i + 1]![j]!, dp[i]![j + 1]!);
    }
  }
  const ops: { tag: " " | "-" | "+"; line: string }[] = [];
  let i = 0;
  let j = 0;
  while (i < m && j < n) {
    if (a[i] === b[j]) {
      ops.push({ tag: " ", line: a[i]! });
      i++;
      j++;
    } else if (dp[i + 1]![j]! >= dp[i]![j + 1]!) {
      ops.push({ tag: "-", line: a[i]! });
      i++;
    } else {
      ops.push({ tag: "+", line: b[j]! });
      j++;
    }
  }
  while (i < m) ops.push({ tag: "-", line: a[i++]! });
  while (j < n) ops.push({ tag: "+", line: b[j++]! });
  return ops;
}

export function unifiedDiff(oldText: string, newText: string, path: string): string {
  if (oldText === newText) return "";
  const a = oldText.split("\n");
  const b = newText.split("\n");
  const ops = diffOps(a, b);
  const lines = [`--- a/${path}`, `+++ b/${path}`, `@@ -1,${a.length} +1,${b.length} @@`];
  for (const o of ops) lines.push(o.tag + o.line);
  return lines.join("\n") + "\n";
}
