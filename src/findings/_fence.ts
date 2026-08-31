// Shared helper: which 0-based line indices sit inside a fenced code block.
//
// One home for fenced-code-block scanning. `resolver`, `fix`, `segments`, and
// `deadReference` each used to carry their own copy of this regex and loop; a
// drift between them would let one stage treat a line as code that another
// treats as prose. Closing-fence parity (``` vs ~~~, indented fences, info
// strings, a longer closing run) is pinned by `_fence.test.ts`.

/** Opening/closing fence: optional indent, then a run of >= 3 backticks or tildes. */
export const FENCE = /^(\s*)(`{3,}|~{3,})/;

export function fencedLineSet(lines: string[]): Set<number> {
  const set = new Set<number>();
  let inFence = false;
  let marker = "";
  lines.forEach((line, i) => {
    const m = line.match(FENCE);
    if (inFence) {
      set.add(i);
      if (m && m[2]!.startsWith(marker)) inFence = false;
    } else if (m) {
      set.add(i);
      inFence = true;
      marker = m[2]![0]!.repeat(3);
    }
  });
  return set;
}

/** Same scan as `fencedLineSet`, as a per-line boolean array. */
export function fencedFlags(lines: string[]): boolean[] {
  const set = fencedLineSet(lines);
  return lines.map((_, i) => set.has(i));
}
