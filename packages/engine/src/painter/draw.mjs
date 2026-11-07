/**
 * Drawing primitives. Shapes are sampled at cell centres (x + 0.5, y + 0.5) so every cell is whole: a cell is
 * either inside a shape or not. Colours are palette letters; a colour argument may also be a function returning the
 * letter for a cell (or null to leave it).
 */

/** Visit every cell whose centre passes `test(px, py, x, y)`, row by row, calling fn(x, y). */
export function scan(g, test, fn) {
  for (let y = 0; y < g.h; y++) for (let x = 0; x < g.w; x++) if (test(x + 0.5, y + 0.5, x, y)) fn(x, y);
}

/** Paint every cell whose centre passes `test`. `c` is a letter or fn(x, y) => letter | null. */
export function fill(g, test, c) {
  scan(g, test, (x, y) => {
    const ch = typeof c === "function" ? c(x, y) : c;
    if (ch) g.set(x, y, ch);
  });
}

/** A filled rectangle between two corner cells, inclusive. */
export function rect(g, x0, y0, x1, y1, c) {
  for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) g.set(x, y, c);
}

/** Point test for an axis-aligned ellipse. */
export const inEllipse = (cx, cy, rx, ry) => (px, py) => ((px - cx) / rx) ** 2 + ((py - cy) / ry) ** 2 <= 1;

/** A filled ellipse (cell centres within it). */
export function ellipse(g, cx, cy, rx, ry, c) {
  fill(g, inEllipse(cx, cy, rx, ry), c);
}

/** Point test for a polygon (even-odd rule), points as [x, y]. */
export const inPolygon = (pts) => (px, py) => {
  let inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const [xi, yi] = pts[i];
    const [xj, yj] = pts[j];
    if (yi > py !== yj > py && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
};

/** A filled polygon. */
export function polygon(g, pts, c) {
  fill(g, inPolygon(pts), c);
}

/** Distance from a point to the segment (x0, y0)-(x1, y1). */
export function segDist(px, py, x0, y0, x1, y1) {
  const dx = x1 - x0;
  const dy = y1 - y0;
  const t = Math.max(0, Math.min(1, ((px - x0) * dx + (py - y0) * dy) / (dx * dx + dy * dy || 1)));
  return Math.hypot(px - (x0 + t * dx), py - (y0 + t * dy));
}

/** A rounded stroke from (x0, y0) to (x1, y1), `w` cells thick: a limb, a tail, a strap. */
export function capsule(g, x0, y0, x1, y1, w, c) {
  fill(g, (px, py) => segDist(px, py, x0, y0, x1, y1) <= w / 2, c);
}

/**
 * A tapered stroke: `w0` thick at (x0, y0) to `w1` at (x1, y1), with round ends. `c` is a letter or
 * fn(t, perp) => letter | null, where t is the distance along the stroke and perp the signed distance across it
 * (positive to the right of the direction of travel, on screen, where y points down).
 */
export function taper(g, x0, y0, x1, y1, w0, w1, c) {
  const L = Math.hypot(x1 - x0, y1 - y0) || 1;
  const ux = (x1 - x0) / L;
  const uy = (y1 - y0) / L;
  scan(
    g,
    (px, py) => {
      const t = (px - x0) * ux + (py - y0) * uy;
      const tc = Math.max(0, Math.min(L, t));
      const half = (w0 + (w1 - w0) * (tc / L)) / 2;
      return Math.hypot(px - (x0 + ux * tc), py - (y0 + uy * tc)) <= half;
    },
    (x, y) => {
      const px = x + 0.5;
      const py = y + 0.5;
      const t = (px - x0) * ux + (py - y0) * uy;
      const perp = -(px - x0) * uy + (py - y0) * ux;
      const ch = typeof c === "function" ? c(t, perp) : c;
      if (ch) g.set(x, y, ch);
    },
  );
}

/** A one-cell line between two points (rounded to cells), endpoints included. */
export function line(g, x0, y0, x1, y1, c) {
  const n = Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0));
  for (let i = 0; i <= n; i++)
    g.set(Math.round(x0 + ((x1 - x0) * i) / (n || 1)), Math.round(y0 + ((y1 - y0) * i) / (n || 1)), c);
}

/** Single cells, as [x, y]. */
export function points(g, list, c) {
  for (const [x, y] of list) g.set(x, y, c);
}
