/**
 * Checks for sprites: row shape and legend, edge contrast against a background, and how many cells a swap between
 * two frames repaints. Every check returns a list of problem strings (empty when all is well).
 */
import { CLEAR, diffCount, toRows } from "./grid.mjs";

/**
 * Rows must be `h` rows of `w` cells, using only "." and letters in `legend`. `forbidden` characters (default "#",
 * which a hex-colour scan would misread) are never allowed.
 */
export function checkRows(label, rows, { w, h, legend, forbidden = "#" }) {
  const out = [];
  const r = toRows(rows);
  if (h !== undefined && r.length !== h) out.push(`${label}: ${r.length} rows, expected ${h}`);
  r.forEach((row, y) => {
    if (w !== undefined && row.length !== w) out.push(`${label} row ${y}: ${row.length} cells, expected ${w}`);
    for (const ch of row) {
      if (forbidden.includes(ch)) out.push(`${label} row ${y}: "${ch}" is not allowed`);
      else if (ch !== CLEAR && legend && !(ch in legend)) out.push(`${label} row ${y}: no legend entry for "${ch}"`);
    }
  });
  return out;
}

/** Legend letters with no colour in `colours` (letter -> hex). */
export function checkLegend(label, legend, colours) {
  return Object.keys(legend)
    .filter((k) => !/^#[0-9a-f]{6}$/i.test(colours?.[k] ?? ""))
    .map((k) => `${label}: legend letter "${k}" has no #rrggbb colour`);
}

/** WCAG relative luminance of a #rrggbb colour. */
export function luminance(hex) {
  const [r, g, b] = [1, 3, 5].map((i) => {
    const v = Number.parseInt(hex.slice(i, i + 2), 16) / 255;
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** WCAG contrast ratio between two #rrggbb colours (1 to 21). */
export function contrast(a, b) {
  const [x, y] = [luminance(a), luminance(b)];
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
}

/** Opaque cells touching transparency (4 neighbours; the box edge counts as transparent), as [x, y]. */
export function edgeCells(rows) {
  const r = toRows(rows);
  const at = (x, y) => r[y]?.[x] ?? CLEAR;
  const out = [];
  r.forEach((row, y) => {
    [...row].forEach((ch, x) => {
      if (ch === CLEAR) return;
      if (at(x - 1, y) === CLEAR || at(x + 1, y) === CLEAR || at(x, y - 1) === CLEAR || at(x, y + 1) === CLEAR)
        out.push([x, y]);
    });
  });
  return out;
}

/**
 * Edge cells must stand out from the background: contrast(colour, background) >= min. `colours` maps letters to
 * #rrggbb; `exempt` lists cells allowed under the bar, as "x,y".
 */
export function checkEdgeContrast(label, rows, { colours, background, min = 1.7, exempt = [] }) {
  const out = [];
  const r = toRows(rows);
  const skip = new Set(exempt);
  for (const [x, y] of edgeCells(r)) {
    const colour = colours[r[y][x]];
    if (!colour || skip.has(`${x},${y}`)) continue;
    const c = contrast(colour, background);
    if (c < min) out.push(`${label}: edge cell (${x},${y}) "${r[y][x]}" is ${c.toFixed(2)}:1 against ${background}`);
  }
  return out;
}

/**
 * Swapping frame `a` for frame `b` may repaint at most `max` cells. `pairs` lists [a, b] names in `frames` (see
 * loopPairs for a looping sequence).
 */
export function checkSwaps(label, frames, pairs, max) {
  const out = [];
  for (const [a, b] of pairs) {
    if (!frames[a] || !frames[b]) {
      out.push(`${label} swap ${a}->${b}: unknown frame`);
      continue;
    }
    const n = diffCount(frames[a], frames[b]);
    if (n > max) out.push(`${label} swap ${a}->${b}: ${n} cells, cap ${max}`);
  }
  return out;
}

/** Consecutive pairs of a sequence, wrapping round: ["a", "b", "c"] -> [a,b], [b,c], [c,a]. */
export const loopPairs = (seq) => seq.map((f, i) => [f, seq[(i + 1) % seq.length]]);
