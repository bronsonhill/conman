// Aggregation and rendering. Pure functions over the raw trial records.
// Deterministic: no Date, no absolute paths, stable ordering.

function mean(xs) {
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0;
}
function stddev(xs) {
  if (xs.length < 2) return 0;
  const m = mean(xs);
  return Math.sqrt(mean(xs.map((x) => (x - m) ** 2)));
}

/**
 * @param {Array} cells  [{ size, quality, trials: [{score, usage, costUSD, ...}] }]
 * @returns aggregated cells with `agg` filled in.
 */
export function aggregate(cells) {
  return cells.map((c) => {
    const scores = c.trials.map((t) => t.score);
    const inTok = c.trials.map((t) => t.usage.input_tokens ?? 0);
    const outTok = c.trials.map((t) => t.usage.output_tokens ?? 0);
    const costs = c.trials.map((t) => t.costUSD ?? 0);
    return {
      ...c,
      agg: {
        n: scores.length,
        meanScore: mean(scores),
        sdScore: stddev(scores),
        meanInputTokens: Math.round(mean(inTok)),
        meanOutputTokens: Math.round(mean(outTok)),
        totalCostUSD: costs.reduce((a, b) => a + b, 0),
      },
    };
  });
}

/**
 * Knee = first swept size whose mean score falls `drop` or more below the
 * running maximum mean score seen at a smaller size. null if the curve never
 * drops that far.
 */
export function findKnee(sizes, byQuality, drop) {
  const out = {};
  for (const [quality, points] of Object.entries(byQuality)) {
    const bySize = new Map(points.map((p) => [p.size, p.meanScore]));
    let best = -Infinity;
    let knee = null;
    for (const s of sizes) {
      const v = bySize.get(s);
      if (v === undefined) continue;
      if (best - v >= drop) {
        knee = s;
        break;
      }
      if (v > best) best = v;
    }
    out[quality] = knee;
  }
  return out;
}

function fmtTokens(n) {
  if (n >= 1000) return (n / 1000).toFixed(n % 1000 ? 1 : 0) + "k";
  return String(n);
}

/** ASCII score-vs-size curve, one row per swept size, one column-band per quality. */
function asciiCurve(sizes, byQuality) {
  const qualities = Object.keys(byQuality);
  const width = 40;
  const blocks = " .:-=+*#%@";
  const lines = [];
  lines.push(`  score 0.0${" ".repeat(width - 8)}1.0`);
  for (const s of sizes) {
    const cellsForSize = qualities.map((q) => {
      const pt = byQuality[q].find((p) => p.size === s);
      return pt ? pt.meanScore : null;
    });
    for (let qi = 0; qi < qualities.length; qi++) {
      const v = cellsForSize[qi];
      const label =
        qi === 0 ? fmtTokens(s).padStart(6) : " ".repeat(6);
      if (v === null) {
        lines.push(`${label} ${qualities[qi].padEnd(6)} (no data)`);
        continue;
      }
      const filled = Math.round(v * width);
      let bar = "";
      for (let i = 0; i < width; i++) {
        if (i < filled) bar += "#";
        else bar += i === filled ? blocks[Math.floor((v * width - filled) * 9)] || " " : " ";
      }
      lines.push(
        `${label} ${qualities[qi].padEnd(6)} |${bar}| ${v.toFixed(3)}`,
      );
    }
    lines.push("");
  }
  return lines.join("\n");
}

export function renderSummary({ meta, cells, sizes, qualities, knee }) {
  const byQuality = {};
  for (const q of qualities) {
    byQuality[q] = cells
      .filter((c) => c.quality === q)
      .map((c) => ({ size: c.size, ...c.agg }))
      .sort((a, b) => a.size - b.size);
  }

  const L = [];
  L.push("conman budget calibration -- size sweep");
  L.push("=".repeat(60));
  L.push(`provider     ${meta.provider}`);
  L.push(`model        ${meta.model}`);
  L.push(`trials/cell  ${meta.n}`);
  L.push(`seed         ${meta.seed}`);
  L.push(`task         niah  needles=${meta.needles}  distractors=${meta.distractors}`);
  L.push(`effort       ${meta.effort || "(unset)"}   thinking=${meta.thinking}`);
  L.push(`sizes        ${sizes.join(", ")}`);
  L.push(`qualities    ${qualities.join(", ")}`);
  L.push("");

  // Results table.
  const head = ["stack".padStart(7), "quality".padEnd(7), "score".padEnd(7), "sd".padEnd(6), "in_tok".padStart(8), "out_tok".padStart(8), "cost_usd".padStart(10)];
  L.push(head.join("  "));
  L.push("-".repeat(head.join("  ").length));
  for (const s of sizes) {
    for (const q of qualities) {
      const pt = byQuality[q].find((p) => p.size === s);
      if (!pt) continue;
      L.push(
        [
          fmtTokens(s).padStart(7),
          q.padEnd(7),
          pt.meanScore.toFixed(3).padEnd(7),
          pt.sdScore.toFixed(3).padEnd(6),
          String(pt.meanInputTokens).padStart(8),
          String(pt.meanOutputTokens).padStart(8),
          (pt.totalCostUSD ? pt.totalCostUSD.toFixed(4) : "0").padStart(10),
        ].join("  "),
      );
    }
  }
  L.push("");

  const grandCost = cells.reduce((a, c) => a + (c.agg.totalCostUSD || 0), 0);
  L.push(`total cost   $${grandCost.toFixed(4)}  over ${cells.reduce((a, c) => a + c.agg.n, 0)} calls`);
  L.push("");

  L.push("score vs stack size");
  L.push("-".repeat(60));
  L.push(asciiCurve(sizes, byQuality));

  L.push("knee (first size dropping >= knee-drop below the running best)");
  for (const q of qualities) {
    L.push(`  ${q.padEnd(7)} ${knee[q] === null ? "none in swept range" : fmtTokens(knee[q]) + `  (${knee[q]} tokens)`}`);
  }
  L.push("");
  L.push(
    "The knee is the candidate defensible budget.total. If it is 'none in",
  );
  L.push(
    "swept range', the task did not degrade -- widen --sizes or harden the task.",
  );

  return L.join("\n");
}
