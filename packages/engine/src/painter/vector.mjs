/**
 * Vector shapes for sprites drawn in a source space (an SVG prototype, say) and rasterised onto the grid through a
 * transform. Polygons are arrays of [x, y].
 */
import { inPolygon } from "./draw.mjs";

/** An SVG path (M, L, C, Z; absolute) as a polygon, each cubic flattened into `steps` segments. */
export function pathToPolygon(d, steps = 16) {
  const toks = d.match(/[A-Za-z]|-?\d*\.?\d+/g) ?? [];
  const out = [];
  let i = 0;
  let cmd = "M";
  let cx = 0;
  let cy = 0;
  const num = () => Number(toks[i++]);
  while (i < toks.length) {
    if (/[A-Za-z]/.test(toks[i])) cmd = toks[i++];
    if (cmd === "Z" || cmd === "z") {
      if (i < toks.length && !/[A-Za-z]/.test(toks[i])) throw new Error(`pathToPolygon: number after Z in "${d}"`);
      continue;
    }
    if (cmd === "M" || cmd === "L") {
      cx = num();
      cy = num();
      out.push([cx, cy]);
    } else if (cmd === "C") {
      const [x1, y1, x2, y2, x3, y3] = [num(), num(), num(), num(), num(), num()];
      for (let k = 1; k <= steps; k++) {
        const t = k / steps;
        const u = 1 - t;
        out.push([
          u * u * u * cx + 3 * u * u * t * x1 + 3 * u * t * t * x2 + t * t * t * x3,
          u * u * u * cy + 3 * u * u * t * y1 + 3 * u * t * t * y2 + t * t * t * y3,
        ]);
      }
      cx = x3;
      cy = y3;
    } else throw new Error(`pathToPolygon: unsupported command "${cmd}" (absolute M, L, C and Z only)`);
  }
  return out;
}

/** An ellipse as a polygon of `n` points. */
export const ellipsePolygon = (cx, cy, rx, ry, n = 36) =>
  Array.from({ length: n }, (_, k) => [
    cx + rx * Math.cos((k / n) * Math.PI * 2),
    cy + ry * Math.sin((k / n) * Math.PI * 2),
  ]);

/** A polygon rotated `deg` degrees about [ox, oy]. */
export function rotateAbout(poly, [ox, oy], deg) {
  const r = (deg * Math.PI) / 180;
  return poly.map(([x, y]) => [
    ox + (x - ox) * Math.cos(r) - (y - oy) * Math.sin(r),
    oy + (x - ox) * Math.sin(r) + (y - oy) * Math.cos(r),
  ]);
}

/** A quadratic curve from A through control C to B, as n + 1 points. */
export const quadCurve = (A, C, B, n = 14) =>
  Array.from({ length: n + 1 }, (_, k) => {
    const t = k / n;
    const u = 1 - t;
    return [u * u * A[0] + 2 * u * t * C[0] + t * t * B[0], u * u * A[1] + 2 * u * t * C[1] + t * t * B[1]];
  });

/** A thin quadrilateral along p -> q, `w` either side: a feather line, a stripe. */
export function bar(p, q, w) {
  const nx = -(q[1] - p[1]);
  const ny = q[0] - p[0];
  const len = Math.hypot(nx, ny) || 1;
  const ox = (nx / len) * w;
  const oy = (ny / len) * w;
  return [
    [p[0] + ox, p[1] + oy],
    [q[0] + ox, q[1] + oy],
    [q[0] - ox, q[1] - oy],
    [p[0] - ox, p[1] - oy],
  ];
}

/**
 * Rasterise layered shapes [{ poly, c }] (later shapes on top): each cell centre is mapped into source space by
 * `toSource(px, py) => [sx, sy]` and takes the colour of the last shape containing it.
 */
export function rasterize(g, shapes, toSource) {
  const tests = shapes.map(({ poly, c }) => ({ inside: inPolygon(poly), c }));
  for (let y = 0; y < g.h; y++)
    for (let x = 0; x < g.w; x++) {
      const [px, py] = toSource(x + 0.5, y + 0.5);
      for (const { inside, c } of tests) if (inside(px, py)) g.set(x, y, c);
    }
}

/**
 * An affine map between source space and cells: scale `s` cells per source unit, an extra squash (sx, sy), a
 * rotation of `deg` degrees, with the source point `from` landing on the cell point `to`.
 * Returns { toSource(px, py), toCell([x, y]) }.
 */
export function affine({ from, to, s = 1, sx = 1, sy = 1, deg = 0 }) {
  const rad = (deg * Math.PI) / 180;
  return {
    toSource(x, y) {
      const ux = (x - to[0]) / s;
      const uy = (y - to[1]) / s;
      const rx = ux * Math.cos(-rad) - uy * Math.sin(-rad);
      const ry = ux * Math.sin(-rad) + uy * Math.cos(-rad);
      return [from[0] + rx / sx, from[1] + ry / sy];
    },
    toCell([px, py]) {
      const ux = (px - from[0]) * sx;
      const uy = (py - from[1]) * sy;
      return [
        to[0] + (ux * Math.cos(rad) - uy * Math.sin(rad)) * s,
        to[1] + (ux * Math.sin(rad) + uy * Math.cos(rad)) * s,
      ];
    },
  };
}
