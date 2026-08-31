// Split a block of markdown-ish text into segments.
//
// A segment is a maximal run of non-blank lines. A fenced code block (``` ... ```)
// is always its own segment, fence lines included, and blank lines inside it do
// not split it. An ATX heading (`#`, `##`, ...) starts a new segment.
//
// Segments are the unit for duplication and value-conflict detection: coarse
// enough to be meaningful, fine enough that a shared "Build & test" section
// between a parent and child file shows up as one finding, not a whole-file diff.

import type { Segment } from "./types.js";
import type { Tokenizer } from "./tokenizer.js";
import { FENCE } from "./findings/_fence.js";

const ATX_HEADING = /^\s{0,3}#{1,6}\s/;

export function splitSegments(
  source: string,
  text: string,
  firstLine: number,
  tok: Tokenizer,
): Segment[] {
  const lines = text.split("\n");
  const segments: Segment[] = [];
  let cur: string[] = [];
  let curStart = 0; // 1-indexed absolute line where the current segment began
  let inFence = false;
  let fenceMarker = "";

  const flush = (endLineAbs: number) => {
    if (cur.length === 0) return;
    const raw = cur.join("\n");
    const trimmed = raw.replace(/^\s+|\s+$/g, "");
    if (trimmed.length > 0) {
      segments.push({
        source,
        lineStart: curStart,
        lineEnd: endLineAbs,
        text: trimmed,
        headingOnly: cur.length === 1 && ATX_HEADING.test(cur[0]!),
        fenced: cur[0] !== undefined && FENCE.test(cur[0]!),
        tokens: tok.countTokens(trimmed),
      });
    }
    cur = [];
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const abs = firstLine + i;
    const fenceMatch = line.match(FENCE);

    if (inFence) {
      if (cur.length === 0) curStart = abs;
      cur.push(line);
      if (fenceMatch && fenceMatch[2]!.startsWith(fenceMarker)) {
        inFence = false;
        flush(abs);
      }
      continue;
    }

    if (fenceMatch) {
      flush(abs - 1);
      inFence = true;
      fenceMarker = fenceMatch[2]![0]!.repeat(3);
      curStart = abs;
      cur.push(line);
      continue;
    }

    if (line.trim() === "") {
      flush(abs - 1);
      continue;
    }

    if (ATX_HEADING.test(line)) {
      flush(abs - 1);
      curStart = abs;
      cur.push(line);
      continue;
    }

    if (cur.length === 0) curStart = abs;
    cur.push(line);
  }
  flush(firstLine + lines.length - 1);
  return segments;
}
