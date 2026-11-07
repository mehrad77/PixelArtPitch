// Turn RGBA pixels (a drawing, a model's image, a sprite sheet) into palette letter rows. Nearest colour in OKLab;
// pixels under the alpha cut become "." (transparent). Pure code, no dependencies.

export type RGBA = { w: number; h: number; data: Uint8Array | Uint8ClampedArray };
export type Quantized = { rows: string[]; maxErr: number; meanErr: number };

const lin = (c: number) => {
  const v = c / 255;
  return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
};
/** sRGB 0..255 -> OKLab [L, a, b] */
export function oklab(r: number, g: number, b: number): [number, number, number] {
  const R = lin(r);
  const G = lin(g);
  const B = lin(b);
  const l = Math.cbrt(0.4122214708 * R + 0.5363325363 * G + 0.0514459929 * B);
  const m = Math.cbrt(0.2119034982 * R + 0.6806995451 * G + 0.1073969566 * B);
  const s = Math.cbrt(0.0883024619 * R + 0.2817188376 * G + 0.6299787005 * B);
  return [
    0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
  ];
}
const hex = (h: string) => [1, 3, 5].map((i) => Number.parseInt(h.slice(i, i + 2), 16)) as [number, number, number];

/** a reusable nearest-letter lookup for a palette (letter -> "#rrggbb") */
export function paletteMatcher(colours: Record<string, string>) {
  const entries = Object.entries(colours).map(([k, h]) => [k, oklab(...hex(h))] as const);
  const cache = new Map<number, [string, number]>();
  return (r: number, g: number, b: number): [string, number] => {
    const key = (r << 16) | (g << 8) | b;
    const hit = cache.get(key);
    if (hit) return hit;
    const p = oklab(r, g, b);
    let best = "";
    let bd = Number.POSITIVE_INFINITY;
    for (const [k, q] of entries) {
      const d = (p[0] - q[0]) ** 2 + (p[1] - q[1]) ** 2 + (p[2] - q[2]) ** 2;
      if (d < bd) {
        bd = d;
        best = k;
      }
    }
    const out: [string, number] = [best, Math.sqrt(bd)];
    cache.set(key, out);
    return out;
  };
}

export type QuantizeOpts = {
  /** alpha below this becomes "." (default 128) */
  alphaCut?: number;
  /** a sub-rectangle of the image */
  x?: number;
  y?: number;
  w?: number;
  h?: number;
  match?: ReturnType<typeof paletteMatcher>;
};

/** RGBA -> letter rows; maxErr / meanErr are OKLab distances over the opaque pixels (0 = exact palette colours) */
export function quantize(img: RGBA, colours: Record<string, string>, opts: QuantizeOpts = {}): Quantized {
  const { alphaCut = 128, x = 0, y = 0, w = img.w - x, h = img.h - y } = opts;
  const match = opts.match ?? paletteMatcher(colours);
  const rows: string[] = [];
  let maxErr = 0;
  let sum = 0;
  let n = 0;
  for (let j = 0; j < h; j++) {
    let row = "";
    for (let i = 0; i < w; i++) {
      const px = x + i;
      const py = y + j;
      if (px < 0 || py < 0 || px >= img.w || py >= img.h) {
        row += ".";
        continue;
      }
      const o = (py * img.w + px) * 4;
      if (img.data[o + 3] < alphaCut) {
        row += ".";
        continue;
      }
      const [k, err] = match(img.data[o], img.data[o + 1], img.data[o + 2]);
      row += k;
      maxErr = Math.max(maxErr, err);
      sum += err;
      n++;
    }
    rows.push(row);
  }
  return { rows, maxErr, meanErr: n ? sum / n : 0 };
}

export type SliceOpts = QuantizeOpts & {
  /** frame names in reading order (left to right, top to bottom); default f0, f1, ... */
  names?: string[];
  /** gap between cells and the sheet's outer margin, in pixels */
  gap?: number;
  margin?: number;
  /** drop cells that are fully transparent (default true) */
  skipEmpty?: boolean;
};

/** slice a sheet into cells of cellW x cellH and quantize each one */
export function sliceSheet(
  img: RGBA,
  cellW: number,
  cellH: number,
  colours: Record<string, string>,
  opts: SliceOpts = {},
) {
  const { gap = 0, margin = 0, skipEmpty = true, names } = opts;
  const match = opts.match ?? paletteMatcher(colours);
  const cols = Math.floor((img.w - 2 * margin + gap) / (cellW + gap));
  const rowsN = Math.floor((img.h - 2 * margin + gap) / (cellH + gap));
  const frames: Record<string, string[]> = {};
  let maxErr = 0;
  let sum = 0;
  let cells = 0;
  let k = 0;
  for (let r = 0; r < rowsN; r++)
    for (let c = 0; c < cols; c++) {
      const q = quantize(img, colours, {
        ...opts,
        match,
        x: margin + c * (cellW + gap),
        y: margin + r * (cellH + gap),
        w: cellW,
        h: cellH,
      });
      if (skipEmpty && q.rows.every((row) => /^\.*$/.test(row))) continue;
      const name = names?.[k] ?? `f${k}`;
      k++;
      if (names && k > names.length) continue;
      frames[name] = q.rows;
      maxErr = Math.max(maxErr, q.maxErr);
      sum += q.meanErr;
      cells++;
    }
  return { frames, maxErr, meanErr: cells ? sum / cells : 0, cols, rows: rowsN };
}

/** letter rows -> RGBA ("." transparent), laid out left to right; for previews and round-trip tests */
export function framesToSheet(frames: string[][], colours: Record<string, string>, gap = 0): RGBA {
  const w = Math.max(...frames.map((f) => f[0]?.length ?? 0));
  const h = Math.max(...frames.map((f) => f.length));
  const W = frames.length * w + (frames.length - 1) * gap;
  const data = new Uint8Array(W * h * 4);
  frames.forEach((rows, k) => {
    rows.forEach((row, y) => {
      for (let x = 0; x < row.length; x++) {
        const c = colours[row[x]];
        if (!c) continue;
        const o = (y * W + k * (w + gap) + x) * 4;
        const [r, g, b] = hex(c);
        data[o] = r;
        data[o + 1] = g;
        data[o + 2] = b;
        data[o + 3] = 255;
      }
    });
  });
  return { w: W, h, data };
}
