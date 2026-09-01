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
 * closes only on the next run of exactly N. A span may wrap across a line break
 * inside one paragraph. An opener with no matching closer is literal text and
 * stays untouched. Lines inside a fenced code block are passed through verbatim
 * and never open or close a span; callers that already skip fenced lines can
 * hand the set in.
 *
 * One home for inline-code-span scanning, next to `fencedLineSet`. `resolver`'s
 * `findImports` and `deadReference`'s dead-import stage each used to carry a
 * `` `[^`]*` `` regex that could not see a span crossing a line break;
 * `deadReference`'s dead-path stage reads the span interiors via
 * `inlineCodeSpans` below. `_fence.test.ts` pins the shared behaviour, including
 * the wekan `CLAUDE.md:516` case from issue #36.
 */
export function maskInlineCode(lines: string[], fenced?: Set<number>): string[] {
  const { masked } = scanInlineCode(lines, fenced);
  return lines.map((line, i) => {
    const flags = masked[i]!;
    let out = "";
    for (let k = 0; k < line.length; k++) out += flags[k] ? " " : line[k];
    return out;
  });
}

/**
 * Every CommonMark inline code span in `lines`, in source order. `text` is the
 * span interior with the backtick delimiters stripped; a span that wraps across
 * a line break keeps its embedded "\n". `line` is the 0-based index of the line
 * the span opens on. Same backtick-run matching and paragraph bounding as
 * `maskInlineCode`; an opener with no matching closer yields no span. This is
 * the shared replacement for the `` /`([^`]+)`/g `` extraction regex that
 * `deadReference`'s dead-path stage used to carry.
 */
export function inlineCodeSpans(
  lines: string[],
  fenced?: Set<number>,
): { line: number; text: string }[] {
  return scanInlineCode(lines, fenced).spans;
}

interface InlineScan {
  /** Per-line, per-column flag: true inside a code span, delimiters included. */
  masked: boolean[][];
  /** Every closed span, in source order. */
  spans: { line: number; text: string }[];
}

/**
 * Single pass shared by `maskInlineCode` and `inlineCodeSpans`.
 *
 * Pairing runs per *paragraph*: a maximal run of consecutive lines that are
 * neither blank nor fenced. CommonMark ends a code span at a blank line, and
 * scanning the whole file as one string would let a lone backtick in one
 * paragraph pair with the opening backtick of a real span further down --
 * unmasking that span's contents and reintroducing the very false positive
 * issue #36 is about.
 */
function scanInlineCode(lines: string[], fenced?: Set<number>): InlineScan {
  const fencedSet = fenced ?? fencedLineSet(lines);
  const masked = lines.map((l) => new Array<boolean>(l.length).fill(false));
  const spans: { line: number; text: string }[] = [];

  const scannable = (i: number) => !fencedSet.has(i) && lines[i]!.trim() !== "";

  let i = 0;
  while (i < lines.length) {
    if (!scannable(i)) {
      i++;
      continue;
    }
    let end = i;
    while (end < lines.length && scannable(end)) end++;
    scanParagraph(lines, i, end, masked, spans);
    i = end;
  }
  return { masked, spans };
}

/** Backtick-run pairing over `lines[lo, hi)` joined by "\n". */
function scanParagraph(
  lines: string[],
  lo: number,
  hi: number,
  masked: boolean[][],
  spans: { line: number; text: string }[],
): void {
  const parts = lines.slice(lo, hi);
  const joined = parts.join("\n");
  // offset -> index within `parts`, and the offset each part starts at.
  const partStart: number[] = [];
  const partAt = new Int32Array(joined.length);
  let acc = 0;
  parts.forEach((p, s) => {
    partStart.push(acc);
    for (let k = 0; k <= p.length && acc + k < joined.length; k++) partAt[acc + k] = s;
    acc += p.length + 1;
  });

  const mark = (from: number, to: number) => {
    for (let k = from; k < to; k++) {
      const s = partAt[k]!;
      const col = k - partStart[s]!;
      if (col >= 0 && col < parts[s]!.length) masked[lo + s]![col] = true;
    }
  };

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
          mark(i, j + n);
          spans.push({ line: lo + partAt[i]!, text: joined.slice(i + n, j) });
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
}
