/**
 * Organic textures. `curls` paints a mass of round clumps (curly hair, a hedge, foam, a fleece) laid like scales:
 * each clump is lit from one side with a C of shade on the far side, and the cells between clumps sit in shade.
 */

import { inEllipse, scan } from "./draw.mjs";
import { CLEAR } from "./grid.mjs";

/**
 * A curl painter bound to a grid.
 * - tones (required): three letters, light to dark: { lit, mid, deep }
 * - light: { x, y, spreadX, spreadY, dir }. dir is the direction the light comes from, [-1, -1] (the upper left) by
 *   default; each clump's shade falls on the opposite side. (x, y) is where the mass is brightest and the spreads are
 *   how fast it darkens away from there: a clump's light runs from 1 (fully lit, at or beyond the origin toward the
 *   light) to -1 (deepest).
 * - footprint: the shape of the shadow pad under each clump, "ellipse" or "circle" (they differ by a cell here and
 *   there at the rim).
 * Returns { litAt, curl, mass, loop }.
 */
export function curls(g, { tones, light, footprint = "ellipse" } = {}) {
  if (!tones?.lit || !tones.mid || !tones.deep) throw new Error("curls: tones { lit, mid, deep } are required");
  const { lit: L, mid: M, deep: D } = tones;
  const family = `${L}${M}${D}`;
  const lx = light?.x ?? g.w / 2;
  const ly = light?.y ?? g.h / 4;
  const sx = light?.spreadX ?? g.w / 4;
  const sy = light?.spreadY ?? g.h / 4;
  // the side away from the light, as signs: [1, 1] (right and down) for light from the upper left
  const [hx, hy] = (light?.dir ?? [-1, -1]).map((v) => (v < 0 ? 1 : v > 0 ? -1 : 0));
  /** how lit a clump centred at (cx, cy) is: 1 lit .. -1 deep */
  const litAt = (cx, cy) => Math.max(-1, Math.min(1, ((hx * (lx - cx)) / sx + (hy * (ly - cy)) / sy) / 2));
  const gap = new Set();
  const key = (x, y) => y * g.w + x;

  /** one clump: a round blob with a C of shade on its far side and, in the shade, a dark lip and an inner hook */
  const curl = (cx, cy, r) => {
    const lit = litAt(cx, cy);
    for (let y = Math.floor(cy - r); y <= cy + r; y++)
      for (let x = Math.floor(cx - r); x <= cx + r; x++) {
        const dx = x + 0.5 - cx;
        const dy = y + 0.5 - cy;
        const d = Math.hypot(dx, dy);
        if (d > r) continue;
        const rim = (hx * dx * 0.8 + hy * dy) / r; // about -1.3 (toward the light) .. 1.3 (away)
        let c = L;
        if (lit > 0.3) {
          if (d > r - 1.4 && rim > 0.35) c = M;
        } else if (lit > -0.25) {
          if (d > r - 1.8 && rim > 0.1) c = M;
          if (d > r - 0.9 && rim > 0.85) c = D;
        } else {
          c = rim < -0.25 && d < r - 0.8 ? L : M;
          if (d > r - 1.1 && rim > 0.45) c = D;
        }
        if (g.set(x, y, c)) gap.delete(key(x, y));
      }
    // the inner turn: a short stroke from the middle out into the shade, so the C reads as a spiral
    if (r >= 2.9 && lit <= 0.3) {
      const hook = lit < -0.25 ? D : M;
      const y = Math.floor(cy);
      for (let x = Math.floor(cx - 0.5); x <= Math.floor(cx + 0.5); x++) g.set(x, y, hook);
    }
  };

  /** a loose coil seen end on: a dark core in a lit ring */
  const loop = (cx, cy, r) =>
    scan(
      g,
      (px, py) => Math.hypot(px - cx, py - cy) <= r,
      (x, y) => {
        const d = Math.hypot(x + 0.5 - cx, y + 0.5 - cy);
        g.set(x, y, d <= r - 1 ? D : hx * (x + 0.5 - cx) + hy * (y + 0.5 - cy) * 1.2 > 0.3 ? M : L);
        gap.delete(key(x, y));
      },
    );

  /**
   * A mass of clumps [[cx, cy, r], ...] (sorted in place, the rows and clumps farthest from the light first, so each
   * clump's shaded lip lies over its neighbours), plus optional end-on `loops`. The shade between clumps is trimmed back to the
   * outline afterwards, so it never pokes past the mass.
   */
  const mass = (list, { loops = [] } = {}) => {
    list.sort((a, b) => hy * (Math.round(b[1] / 2.5) - Math.round(a[1] / 2.5)) || hx * (b[0] - a[0]));
    const bare = g.snapshot();
    for (const [cx, cy, r] of list) {
      const pad =
        footprint === "circle" ? (px, py) => Math.hypot(px - cx, py - cy) <= r + 1 : inEllipse(cx, cy, r + 1, r + 1);
      scan(g, pad, (x, y) => {
        g.set(x, y, litAt(cx, cy) > 0.3 ? M : D);
        gap.add(key(x, y));
      });
    }
    for (const [cx, cy, r] of list) curl(cx, cy, r);
    for (const [cx, cy, r] of loops) loop(cx, cy, r);
    for (let pass = 0; pass < 2; pass++) {
      const snap = g.snapshot();
      for (const k of gap) {
        const x = k % g.w;
        const y = (k - x) / g.w;
        const open = [
          [1, 0],
          [-1, 0],
          [0, 1],
          [0, -1],
        ].some(([dx, dy]) => !family.includes(g.inBounds(x + dx, y + dy) ? snap[y + dy][x + dx] : CLEAR));
        if (open) {
          g.set(x, y, bare[y][x]);
          gap.delete(k);
        }
      }
    }
    gap.clear();
  };

  return { litAt, curl, loop, mass, family };
}
