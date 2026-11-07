/**
 * Finishing passes: edge shading by light direction, outlines, hole filling and orphan removal. Each pass reads a
 * snapshot taken before it starts, so its result does not depend on the order cells are visited (fillHoles with
 * `order` set is the one deliberate exception).
 */
import { CLEAR } from "./grid.mjs";

const N4 = [
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1],
];
const N8 = [...N4, [1, 1], [-1, 1], [1, -1], [-1, -1]];

/** The sides facing away from a light at (lx, ly), e.g. [-1, -1] for the upper left: [[1, 0], [0, 1]]. */
export function awaySides([lx, ly]) {
  const out = [];
  if (lx) out.push([-Math.sign(lx), 0]);
  if (ly) out.push([0, -Math.sign(ly)]);
  return out;
}

/**
 * Recolour edge cells by rules, all read against one snapshot (later rules win on the same cell).
 * A rule { from, to, sides, outside } recolours a `from` cell to `to` when any neighbour at one of `sides`
 * ([dx, dy] offsets) is outside: transparent by default, or, with `outside` a string of letters, any letter not in it.
 */
export function edgeRules(g, rules) {
  const snap = g.snapshot();
  const at = (x, y) => (g.inBounds(x, y) ? snap[y][x] : CLEAR);
  const prepared = rules.map((r) => ({
    ...r,
    out: r.outside ? (ch) => !r.outside.includes(ch) : (ch) => ch === CLEAR,
  }));
  for (let y = 0; y < g.h; y++)
    for (let x = 0; x < g.w; x++)
      for (const r of prepared)
        if (snap[y][x] === r.from && r.sides.some(([dx, dy]) => r.out(at(x + dx, y + dy)))) g.set(x, y, r.to);
}

/**
 * Light from `light` ([-1, -1] = upper left, the default): cells of `from` whose far sides (right and bottom for the
 * upper left) face transparency take the darker tone `to`. Options: light, outside (see edgeRules).
 */
export function shadeEdges(g, from, to, { light = [-1, -1], outside } = {}) {
  edgeRules(g, [{ from, to, sides: awaySides(light), outside }]);
}

/** Cells of `from` touching transparency on any side (4 or 8 neighbours) take `to`: a rim or an outline. */
export function outline(g, from, to, { neighbours = 4, outside } = {}) {
  edgeRules(g, [{ from, to, sides: neighbours === 8 ? N8 : N4, outside }]);
}

/**
 * Fill enclosed transparent holes (cells not reachable from the border through transparency) with their commonest
 * neighbour, ties going to the first neighbour seen. Options:
 * - neighbours: 4 or 8 (4 by default)
 * - passes: how many sweeps (a hole with no painted neighbour waits for the next sweep)
 * - order: "forward" (row by row) or "reverse"; fills are live, so a filled hole counts for the holes after it
 */
export function fillHoles(g, { neighbours = 4, passes = 1, order = "forward" } = {}) {
  const seen = Array.from({ length: g.h }, () => Array(g.w).fill(false));
  const stack = [];
  for (let y = 0; y < g.h; y++)
    for (let x = 0; x < g.w; x++)
      if ((x === 0 || y === 0 || x === g.w - 1 || y === g.h - 1) && g.cells[y][x] === CLEAR) {
        seen[y][x] = true;
        stack.push([x, y]);
      }
  while (stack.length) {
    const [x, y] = stack.pop();
    for (const [dx, dy] of N4) {
      const X = x + dx;
      const Y = y + dy;
      if (X < 0 || Y < 0 || X >= g.w || Y >= g.h || seen[Y][X] || g.cells[Y][X] !== CLEAR) continue;
      seen[Y][X] = true;
      stack.push([X, Y]);
    }
  }
  const holes = [];
  for (let y = 0; y < g.h; y++)
    for (let x = 0; x < g.w; x++) if (g.cells[y][x] === CLEAR && !seen[y][x]) holes.push([x, y]);
  const around = neighbours === 8 ? N8 : N4;
  const tryFill = ([x, y]) => {
    const n = {};
    for (const [dx, dy] of around) {
      const ch = g.get(x + dx, y + dy);
      if (ch !== CLEAR) n[ch] = (n[ch] || 0) + 1;
    }
    const best = Object.keys(n).sort((a, b) => n[b] - n[a])[0];
    if (best) g.set(x, y, best);
    return Boolean(best);
  };
  for (let pass = 0; pass < passes && holes.length; pass++) {
    if (order === "reverse") {
      for (let i = holes.length - 1; i >= 0; i--) if (tryFill(holes[i])) holes.splice(i, 1);
    } else {
      const left = holes.filter((h) => !tryFill(h));
      holes.length = 0;
      holes.push(...left);
    }
  }
  return holes.length;
}

/**
 * Remove orphans within a family of tones (e.g. "Hhj", light to dark): a cell whose 8 neighbours include none of its
 * own tone, but some of the family, takes the family's commonest neighbouring tone (ties to the earlier tone).
 * Options: rows [y0, y1] to limit the pass (inclusive).
 */
export function despeckle(g, tones, { rows = [0, g.h - 1] } = {}) {
  const snap = g.snapshot();
  const [y0, y1] = rows;
  for (let y = y0; y <= y1; y++)
    for (let x = 0; x < g.w; x++) {
      const c = snap[y][x];
      if (!tones.includes(c)) continue;
      const n = Object.fromEntries([...tones].map((t) => [t, 0]));
      let any = 0;
      for (let dy = -1; dy <= 1; dy++)
        for (let dx = -1; dx <= 1; dx++)
          if ((dx || dy) && g.inBounds(x + dx, y + dy) && tones.includes(snap[y + dy][x + dx])) {
            n[snap[y + dy][x + dx]]++;
            any++;
          }
      if (!n[c] && any) g.set(x, y, Object.keys(n).sort((a, b) => n[b] - n[a])[0]);
    }
}

/** Remove lone cells: an opaque cell with no opaque 4-neighbour becomes transparent. Returns how many went. */
export function removeOrphans(g, { neighbours = 4 } = {}) {
  const snap = g.snapshot();
  const around = neighbours === 8 ? N8 : N4;
  let n = 0;
  for (let y = 0; y < g.h; y++)
    for (let x = 0; x < g.w; x++)
      if (
        snap[y][x] !== CLEAR &&
        around.every(([dx, dy]) => !g.inBounds(x + dx, y + dy) || snap[y + dy][x + dx] === CLEAR)
      ) {
        g.set(x, y, CLEAR);
        n++;
      }
  return n;
}
