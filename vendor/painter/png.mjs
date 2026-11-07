/**
 * A dependency-free PNG encoder (RGB, 8 bits per channel, zlib from node:zlib) and a sheet renderer that lays frames
 * out in a strip or grid at an integer scale, on one or more background colours.
 */
import { deflateSync } from "node:zlib";
import { CLEAR, toRows } from "./grid.mjs";

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

/** "#rrggbb" (or "#rgb") as [r, g, b]. */
export function parseHex(hex) {
  const h = hex.replace(/^#/, "");
  const full = h.length === 3 ? [...h].map((c) => c + c).join("") : h;
  if (!/^[0-9a-f]{6}$/i.test(full)) throw new Error(`not a hex colour: ${hex}`);
  return [0, 2, 4].map((i) => Number.parseInt(full.slice(i, i + 2), 16));
}

/** Encode `rgb` (a Buffer of w * h * 3 bytes, row by row) as a PNG file. */
export function encodePng(w, h, rgb) {
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (w * 3 + 1)] = 0; // filter: none
    rgb.copy(raw, y * (w * 3 + 1) + 1, y * w * 3, (y + 1) * w * 3);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // colour type: RGB
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

/**
 * Render frames onto one PNG sheet.
 * - frames: a Record<name, rows> or an array of rows
 * - colours: legend letter -> "#rrggbb" (letters without a colour show as magenta)
 * - scale: device pixels per cell (default 4)
 * - columns: frames per row (default: all in one strip)
 * - gap: pixels between frames and round the edge (default 2 cells)
 * - bg: a background colour, or several: the sheet repeats in one band per background
 * Returns the PNG as a Buffer.
 */
export function renderSheet(frames, { colours, scale = 4, columns, gap, bg = "#000000" }) {
  const list = (Array.isArray(frames) ? frames : Object.values(frames)).map(toRows);
  if (!list.length) throw new Error("renderSheet: no frames");
  const bgs = (Array.isArray(bg) ? bg : [bg]).map(parseHex);
  const pad = gap ?? scale * 2;
  const cols = Math.max(1, Math.min(columns ?? list.length, list.length));
  const fw = Math.max(...list.map((r) => r[0]?.length ?? 0)) * scale;
  const fh = Math.max(...list.map((r) => r.length)) * scale;
  const rowsOfFrames = Math.ceil(list.length / cols);
  const bandH = pad + rowsOfFrames * (fh + pad);
  const W = pad + cols * (fw + pad);
  const H = bandH * bgs.length;
  const px = Buffer.alloc(W * H * 3);
  const paint = (X, Y, [r, g, b]) => {
    if (X < 0 || Y < 0 || X >= W || Y >= H) return;
    const i = (Y * W + X) * 3;
    px[i] = r;
    px[i + 1] = g;
    px[i + 2] = b;
  };
  const cache = new Map();
  const colourOf = (ch) => {
    if (!cache.has(ch)) cache.set(ch, colours?.[ch] ? parseHex(colours[ch]) : [255, 0, 255]);
    return cache.get(ch);
  };
  bgs.forEach((back, band) => {
    for (let y = band * bandH; y < (band + 1) * bandH; y++) for (let x = 0; x < W; x++) paint(x, y, back);
    list.forEach((rows, i) => {
      const ox = pad + (i % cols) * (fw + pad);
      const oy = band * bandH + pad + Math.floor(i / cols) * (fh + pad);
      rows.forEach((row, y) => {
        [...row].forEach((ch, x) => {
          if (ch === CLEAR) return;
          const c = colourOf(ch);
          for (let dy = 0; dy < scale; dy++)
            for (let dx = 0; dx < scale; dx++) paint(ox + x * scale + dx, oy + y * scale + dy, c);
        });
      });
    });
  });
  return encodePng(W, H, px);
}
