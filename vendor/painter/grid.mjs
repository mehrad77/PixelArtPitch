/**
 * A grid of single-letter cells. "." is transparent; every other character is a palette letter that a legend maps to
 * a colour. Coordinates are cells, x to the right and y down, with (0, 0) at the top left.
 */

export const CLEAR = ".";

export class Grid {
  /**
   * @param {number} w
   * @param {number} h
   * @param {string} [fill]
   */
  constructor(w, h, fill = CLEAR) {
    this.w = w;
    this.h = h;
    /** @type {string[][]} rows of cells, y first */
    this.cells = Array.from({ length: h }, () => Array(w).fill(fill));
  }

  /** A grid from rows of letters (every row the same length). */
  static from(rows) {
    const h = rows.length;
    const w = h ? rows[0].length : 0;
    const g = new Grid(w, h);
    for (let y = 0; y < h; y++) g.cells[y] = [...rows[y]];
    return g;
  }

  inBounds(x, y) {
    return x >= 0 && x < this.w && y >= 0 && y < this.h;
  }

  /** The cell at (x, y), or "." outside the grid. */
  get(x, y) {
    return this.inBounds(x, y) ? this.cells[y][x] : CLEAR;
  }

  /** Paint one cell; cells outside the grid are ignored. Returns whether the cell was inside. */
  set(x, y, c) {
    if (!this.inBounds(x, y)) return false;
    this.cells[y][x] = c;
    return true;
  }

  /** Paint a cell only where it is still transparent. */
  setIfClear(x, y, c) {
    if (this.get(x, y) !== CLEAR) return false;
    return this.set(x, y, c);
  }

  /** A frozen copy of the cells, for rules that must read the grid as it was before a pass. */
  snapshot() {
    return this.cells.map((r) => [...r]);
  }

  clone() {
    const g = new Grid(this.w, this.h);
    g.cells = this.snapshot();
    return g;
  }

  /** The grid as rows of letters. */
  rows() {
    return this.cells.map((r) => r.join(""));
  }

  /** Call fn(x, y, c) for every cell, row by row. */
  forEach(fn) {
    for (let y = 0; y < this.h; y++) for (let x = 0; x < this.w; x++) fn(x, y, this.cells[y][x]);
  }

  /** The w x h cells at (x, y) as a new grid; cells outside the source come back transparent. */
  crop(x, y, w, h) {
    const g = new Grid(w, h);
    for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) g.cells[j][i] = this.get(x + i, y + j);
    return g;
  }

  /** A larger grid with this one inside it: { top, right, bottom, left } cells of `fill` around it. */
  pad({ top = 0, right = 0, bottom = 0, left = 0 } = {}, fill = CLEAR) {
    const g = new Grid(this.w + left + right, this.h + top + bottom, fill);
    for (let y = 0; y < this.h; y++) for (let x = 0; x < this.w; x++) g.cells[y + top][x + left] = this.cells[y][x];
    return g;
  }

  /** Mirrored left to right. */
  flipX() {
    const g = this.clone();
    for (const r of g.cells) r.reverse();
    return g;
  }

  /** Mirrored top to bottom. */
  flipY() {
    const g = this.clone();
    g.cells.reverse();
    return g;
  }

  /**
   * Paint `src` (a Grid or rows) with its top-left at (x, y). Transparent source cells leave what is there, unless
   * `opaque` is set, in which case the whole source rectangle replaces the cells under it. `flip` mirrors the source.
   */
  overlay(src, x = 0, y = 0, { opaque = false, flip = false } = {}) {
    const rows = src instanceof Grid ? src.rows() : src;
    rows.forEach((row, j) => {
      const cells = flip ? [...row].reverse() : [...row];
      cells.forEach((c, i) => {
        if (opaque || c !== CLEAR) this.set(x + i, y + j, c);
      });
    });
    return this;
  }

  /** Move every cell `dy` rows down (negative: up); rows shifted in are transparent. */
  shiftY(dy) {
    const src = this.snapshot();
    for (let y = 0; y < this.h; y++)
      for (let x = 0; x < this.w; x++) this.cells[y][x] = y >= dy && y - dy < this.h ? src[y - dy][x] : CLEAR;
    return this;
  }
}

/** Rows of letters from a Grid or rows. */
export const toRows = (g) => (g instanceof Grid ? g.rows() : [...g]);

/** Replace the cells under each overlay (its "." cells included), in order: a part variant composed onto a figure. */
export function compose(base, overlays) {
  const g = Grid.from(toRows(base));
  for (const { x, y, rows } of overlays) g.overlay(rows, x, y, { opaque: true });
  return g.rows();
}

/** The cells that differ between two equally sized bitmaps, as [x, y, a, b]. */
export function diff(a, b) {
  const ra = toRows(a);
  const rb = toRows(b);
  const out = [];
  const h = Math.max(ra.length, rb.length);
  for (let y = 0; y < h; y++) {
    const w = Math.max(ra[y]?.length ?? 0, rb[y]?.length ?? 0);
    for (let x = 0; x < w; x++) {
      const ca = ra[y]?.[x] ?? CLEAR;
      const cb = rb[y]?.[x] ?? CLEAR;
      if (ca !== cb) out.push([x, y, ca, cb]);
    }
  }
  return out;
}

/** How many cells differ between two bitmaps. */
export const diffCount = (a, b) => diff(a, b).length;

/** The bounding box { x, y, w, h } of the cells where any of `others` differs from `base`, or null. */
export function diffBox(base, others) {
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -1;
  let y1 = -1;
  for (const o of others)
    for (const [x, y] of diff(base, o)) {
      x0 = Math.min(x0, x);
      y0 = Math.min(y0, y);
      x1 = Math.max(x1, x);
      y1 = Math.max(y1, y);
    }
  return x1 < 0 ? null : { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 };
}

/** The smallest grid holding every opaque cell, and where it sat: { grid, x, y }. An empty grid trims to 0 x 0. */
export function trim(g) {
  const src = g instanceof Grid ? g : Grid.from(g);
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -1;
  let y1 = -1;
  src.forEach((x, y, c) => {
    if (c === CLEAR) return;
    x0 = Math.min(x0, x);
    y0 = Math.min(y0, y);
    x1 = Math.max(x1, x);
    y1 = Math.max(y1, y);
  });
  if (x1 < 0) return { grid: new Grid(0, 0), x: 0, y: 0 };
  return { grid: src.crop(x0, y0, x1 - x0 + 1, y1 - y0 + 1), x: x0, y: y0 };
}
