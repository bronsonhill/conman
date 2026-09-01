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

/**
 * Per-line copy of `lines` with every CommonMark inline code span, backtick
 * delimiters included, blanked to spaces (length preserved so column offsets
 * still line up). Backtick runs are matched by length: an opener of N backticks
 * closes only on the next run of exactly N. A span may wrap across lines. An
 * opener with no matching closer is literal text and stays untouched. Lines
 * inside a fenced code block are passed through verbatim and never open or
 * close a span; callers that already skip fenced lines can hand the set in.
 *
 * One home for inline-code-span scanning, next to `fencedLineSet`. `resolver`'s
 * `findImports` and `deadReference`'s dead-import/-script/-path stages each used
 * to carry a `` `[^`]*` `` regex that could not see a span crossing a line
 * break; `_fence.test.ts` pins the shared behaviour, including the wekan
 * `CLAUDE.md:516` case from issue #36.
 */
export function maskInlineCode(lines: string[], fenced?: Set<number>): string[] {
  const fencedSet = fenced ?? fencedLineSet(lines);
  const scanIdx: number[] = [];
  for (let i = 0; i < lines.length; i++) if (!fencedSet.has(i)) scanIdx.push(i);

  // Concatenate the scanned lines with "\n" joiners so a span can cross a line
  // break, then walk the joined text once.
  const parts = scanIdx.map((i) => lines[i]!);
  const joined = parts.join("\n");
  const masked = new Array<boolean>(joined.length).fill(false);

  let i = 0;
  while (i < joined.length) {
    if (joined[i] !== "`") {
      i++;
      continue;
    }
    let n = 0;
    while (i + n < joined.length && joined[i + n] === "`") n++;
    let j = i + n;
    let closed = false;
    while (j < joined.length) {
      if (joined[j] === "`") {
        let m = 0;
        while (j + m < joined.length && joined[j + m] === "`") m++;
        if (m === n) {
          for (let k = i; k < j + n; k++) masked[k] = true;
          i = j + n;
          closed = true;
          break;
        }
        j += m;
      } else {
        j++;
      }
    }
    if (!closed) i += n;
  }

  const out = lines.slice();
  let pos = 0;
  for (let s = 0; s < scanIdx.length; s++) {
    const part = parts[s]!;
    let line = "";
    for (let k = 0; k < part.length; k++) line += masked[pos + k] ? " " : part[k];
    out[scanIdx[s]!] = line;
    pos += part.length + 1; // +1 for the "\n" joiner
  }
  return out;
}
