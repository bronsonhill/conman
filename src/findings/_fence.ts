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
 * `findImports` and `deadReference`'s dead-import stage each used to carry a
 * `` `[^`]*` `` regex that could not see a span crossing a line break;
 * `deadReference`'s dead-script and dead-path stages read the span interiors via
 * `inlineCodeSpans` below. `_fence.test.ts` pins the shared behaviour, including
 * the wekan `CLAUDE.md:516` case from issue #36.
 */
interface InlineScan {
  /** 0-based indices of the lines that were scanned (fenced lines excluded). */
  scanIdx: number[];
  /** The scanned line texts, in `scanIdx` order. */
  parts: string[];
  /** Joined text (`parts` glued with "\n"). */
  joined: string;
  /** Per-char flag over `joined`: true inside a code span, delimiters included. */
  masked: boolean[];
  /** One entry per closed span: half-open interior range over `joined`. */
  spans: { innerLo: number; innerHi: number }[];
}

/** Single pass shared by every inline-code consumer. See `maskInlineCode`. */
function scanInlineCode(lines: string[], fenced?: Set<number>): InlineScan {
  const fencedSet = fenced ?? fencedLineSet(lines);
  const scanIdx: number[] = [];
  for (let i = 0; i < lines.length; i++) if (!fencedSet.has(i)) scanIdx.push(i);

  const parts = scanIdx.map((i) => lines[i]!);
  const joined = parts.join("\n");
  const masked = new Array<boolean>(joined.length).fill(false);
  const spans: { innerLo: number; innerHi: number }[] = [];

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
          spans.push({ innerLo: i + n, innerHi: j });
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

  return { scanIdx, parts, joined, masked, spans };
}

export function maskInlineCode(lines: string[], fenced?: Set<number>): string[] {
  const { scanIdx, parts, masked } = scanInlineCode(lines, fenced);
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

/**
 * Every CommonMark inline code span in `lines`, in source order. `text` is the
 * span interior with the backtick delimiters stripped; a span that wraps across
 * a line break keeps its embedded "\n". `line` is the 0-based index of the line
 * the span opens on. Same backtick-run matching and fenced-line skipping as
 * `maskInlineCode`; an opener with no matching closer yields no span. This is
 * the shared replacement for the `` /`([^`]+)`/g `` extraction regexes that
 * `deadReference`'s dead-path and dead-script stages used to carry.
 */
export function inlineCodeSpans(
  lines: string[],
  fenced?: Set<number>,
): { line: number; text: string }[] {
  const { scanIdx, parts, joined, spans } = scanInlineCode(lines, fenced);
  // Offset of each scanned part's first char within `joined`.
  const partStart: number[] = [];
  let acc = 0;
  for (const p of parts) {
    partStart.push(acc);
    acc += p.length + 1;
  }
  const lineOf = (offset: number): number => {
    let s = 0;
    while (s + 1 < partStart.length && partStart[s + 1]! <= offset) s++;
    return scanIdx.length ? scanIdx[s]! : 0;
  };
  return spans.map((sp) => ({
    line: lineOf(sp.innerLo),
    text: joined.slice(sp.innerLo, sp.innerHi),
  }));
}
