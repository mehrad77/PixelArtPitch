// Ground and texture tiles (16x16, tile kind). One painter for "material body + surface band", with stamps that wrap
// round the tile edges so every fill tiles seamlessly.
import { Grid } from "./lib.mjs";

/** a w x h grid filled with one letter */
export const solid = (c, w = 16, h = 16) => new Grid(w, h, c);

/** paint `rows` at (x, y), wrapping round the edges (for seamless fills); "." cells are skipped */
export function stamp(g, x, y, rows) {
  rows.forEach((row, j) => {
    [...row].forEach((c, i) => {
      if (c !== ".") g.set((((x + i) % g.w) + g.w) % g.w, (((y + j) % g.h) + g.h) % g.h, c);
    });
  });
  return g;
}

/** many stamps: list of [x, y, rows] */
export function stamps(g, list) {
  for (const [x, y, rows] of list) stamp(g, x, y, rows);
  return g;
}

/**
 * A surface band on top of a body: `profile[x]` is the first opaque row in column x (0 = flush with the top),
 * then `bands` letters going down (the first is the highlight). Cells above the profile are cleared.
 * `drip[x]` extends the last band letter that many extra rows down (grass hanging into soil).
 */
export function surface(g, profile, bands, drip = []) {
  for (let x = 0; x < g.w; x++) {
    const top = profile[x % profile.length];
    for (let y = 0; y < top; y++) g.set(x, y, ".");
    bands.forEach((c, i) => {
      g.set(x, top + i, c);
    });
    const d = drip[x % (drip.length || 1)] ?? 0;
    for (let i = 0; i < d; i++) g.set(x, top + bands.length + i, bands[bands.length - 1]);
  }
  return g;
}

/** round off the left or right end of a top tile: clear a corner and outline the cut side with `edge` */
export function capEnd(rows, side, { corner = [3, 2, 1, 1], edge = "k", inner = null } = {}) {
  const g = Grid.from(rows);
  const W = g.w - 1;
  const xs = (i) => (side === "l" ? i : W - i);
  // clear corner: row y loses corner[y] cells from the side
  corner.forEach((n, y) => {
    for (let i = 0; i < n; i++) g.set(xs(i), y + firstRow(g), ".");
  });
  // outline the side: first opaque cell in each row from that side becomes edge, the next becomes `inner`
  for (let y = 0; y < g.h; y++) {
    for (let i = 0; i <= W; i++) {
      const x = xs(i);
      if (g.get(x, y) !== ".") {
        g.set(x, y, edge);
        if (inner) {
          const x2 = xs(i + 1);
          if (g.get(x2, y) !== "." && g.get(x2, y) !== edge) g.set(x2, y, inner(y, g.get(x2, y)));
        }
        break;
      }
    }
  }
  return g.rows();
}
const firstRow = (g) => {
  for (let y = 0; y < g.h; y++) if (g.cells[y].some((c) => c !== ".")) return y;
  return 0;
};

// ---------- reusable stamps ----------
export const PEBBLE = ["pq", "qe"]; // light top-left, dark bottom-right
export const PEBBLE3 = [".pq", "pqe", ".ee"];
