// A tiny 320x180 RGB frame buffer with sprite, rect, text and effect helpers.
import { existsSync, readFileSync } from "node:fs";
import { COLOURS, hexToRgb, RGB, SKY } from "./palette.mjs";

export const W = 320;
export const H = 180;
export const buf = Buffer.alloc(W * H * 3);

const rgbOf = (c) => (Array.isArray(c) ? c : c.length === 1 ? RGB[c] : hexToRgb(c));

export function clear(c = SKY) {
  const [r, g, b] = rgbOf(c);
  for (let i = 0; i < W * H; i++) {
    buf[i * 3] = r;
    buf[i * 3 + 1] = g;
    buf[i * 3 + 2] = b;
  }
}

export function px(x, y, c, a = 1) {
  x = Math.round(x);
  y = Math.round(y);
  if (x < 0 || y < 0 || x >= W || y >= H) return;
  const [r, g, b] = c;
  const i = (y * W + x) * 3;
  if (a >= 1) {
    buf[i] = r;
    buf[i + 1] = g;
    buf[i + 2] = b;
  } else if (a > 0) {
    buf[i] = buf[i] + (r - buf[i]) * a;
    buf[i + 1] = buf[i + 1] + (g - buf[i + 1]) * a;
    buf[i + 2] = buf[i + 2] + (b - buf[i + 2]) * a;
  }
}

export function rect(x, y, w, h, c, a = 1) {
  const col = rgbOf(c);
  x = Math.round(x);
  y = Math.round(y);
  for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) px(x + i, y + j, col, a);
}

/** 1 px frame */
export function box(x, y, w, h, c) {
  rect(x, y, w, 1, c);
  rect(x, y + h - 1, w, 1, c);
  rect(x, y, 1, h, c);
  rect(x + w - 1, y, 1, h, c);
}

/** a dark panel with a coloured 1 px border and a shadow */
export function panel(x, y, w, h, { border = "G", fill = "k", alpha = 0.88 } = {}) {
  rect(x + 2, y + 2, w, h, "k", 0.5);
  rect(x, y, w, h, fill, alpha);
  box(x, y, w, h, border);
}

/** Draw letter rows at (x, y). opts: flip, outline (colour for a 1 px ring), alpha, colour override for all cells. */
export function sprite(rows, x, y, { flip = false, outline, alpha = 1, colour, scale = 1 } = {}) {
  if (!rows) return;
  x = Math.round(x);
  y = Math.round(y);
  const h = rows.length;
  const w = rows[0]?.length ?? 0;
  const at = (i, j) => {
    const r = rows[j];
    if (!r) return ".";
    return r[flip ? w - 1 - i : i] ?? ".";
  };
  if (outline) {
    const oc = rgbOf(outline);
    for (let j = -1; j <= h; j++)
      for (let i = -1; i <= w; i++) {
        if (at(i, j) !== "." && i >= 0 && j >= 0 && i < w && j < h) continue;
        if ([at(i - 1, j), at(i + 1, j), at(i, j - 1), at(i, j + 1)].some((c) => c && c !== ".")) {
          for (let sj = 0; sj < scale; sj++)
            for (let si = 0; si < scale; si++) px(x + i * scale + si, y + j * scale + sj, oc, alpha);
        }
      }
  }
  const over = colour ? rgbOf(colour) : null;
  for (let j = 0; j < h; j++)
    for (let i = 0; i < w; i++) {
      const c = at(i, j);
      if (c === "." || !RGB[c]) continue;
      for (let sj = 0; sj < scale; sj++)
        for (let si = 0; si < scale; si++) px(x + i * scale + si, y + j * scale + sj, over ?? RGB[c], alpha);
    }
}

// ---- assets ----
const cache = new Map();
/** frames of a generated asset (gen/out/<name>/chosen.json), or a placeholder */
export function asset(name) {
  if (cache.has(name)) return cache.get(name);
  const file = new URL(`./gen/out/${name}/chosen.json`, import.meta.url);
  const frames = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")).frames : null;
  cache.set(name, frames);
  return frames;
}
export function frame(name, f, fallback = [16, 24]) {
  const a = asset(name);
  const rows = a?.[f] ?? (a ? Object.values(a)[0] : null);
  if (rows) return rows;
  const [w, h] = fallback;
  return Array.from({ length: h }, (_, j) =>
    Array.from({ length: w }, (_, i) => (i === 0 || j === 0 || i === w - 1 || j === h - 1 ? "O" : "e")).join(""),
  );
}

// ---- text ----
let glyphs = null;
function font() {
  if (glyphs) return glyphs;
  glyphs = new Map();
  for (let i = 1; i <= 6; i++) {
    const a = asset(`font${i}`);
    if (a) for (const [k, rows] of Object.entries(a)) glyphs.set(String.fromCodePoint(Number(k.slice(1))), rows);
  }
  return glyphs;
}
/** glyph advance: its inked width + 1 (min 2), space 4 */
function glyphW(ch) {
  if (ch === " ") return 4;
  const g = font().get(ch) ?? font().get(ch.toUpperCase());
  if (!g) return 6;
  let w = 0;
  for (const r of g) {
    const last = r.search(/P[^P]*$/);
    if (last >= 0) w = Math.max(w, last + 1);
  }
  return Math.max(2, w + 1);
}
export function measure(str, scale = 1) {
  return [...str].reduce((s, ch) => s + glyphW(ch), 0) * scale - scale;
}
/** text at (x, y) top-left; align "left" | "center" | "right"; shadow draws a 1 px dark drop shadow */
export function text(str, x, y, { colour = "P", scale = 1, align = "left", shadow = true, alpha = 1 } = {}) {
  const w = measure(str, scale);
  let cx = Math.round(align === "center" ? x - w / 2 : align === "right" ? x - w : x);
  const col = rgbOf(colour);
  const sh = RGB.k;
  for (const ch of str) {
    const g = font().get(ch) ?? font().get(ch.toUpperCase());
    if (g) {
      for (let j = 0; j < g.length; j++)
        for (let i = 0; i < g[j].length; i++) {
          if (g[j][i] !== "P") continue;
          for (let sj = 0; sj < scale; sj++)
            for (let si = 0; si < scale; si++) {
              if (shadow) px(cx + i * scale + si + scale, y + j * scale + sj + scale, sh, alpha);
              px(cx + i * scale + si, y + j * scale + sj, col, alpha);
            }
        }
    } else if (ch !== " ") {
      rect(cx, y + 1 * scale, 4 * scale, 6 * scale, col, alpha * 0.5);
    }
    cx += glyphW(ch) * scale;
  }
  return w;
}
/** greedy word wrap to a pixel width */
export function wrap(str, maxW, scale = 1) {
  const lines = [];
  let cur = "";
  for (const word of str.split(" ")) {
    const next = cur ? `${cur} ${word}` : word;
    if (measure(next, scale) > maxW && cur) {
      lines.push(cur);
      cur = word;
    } else cur = next;
  }
  if (cur) lines.push(cur);
  return lines;
}

// ---- helpers ----
export const clamp = (v, a = 0, b = 1) => Math.max(a, Math.min(b, v));
export const lerp = (a, b, t) => a + (b - a) * t;
export const ease = (t) => 1 - (1 - clamp(t)) ** 3;
export const step = (v, n = 1) => Math.round(v / n) * n;
/** 0..1 progress of t through [a, b] */
export const prog = (t, a, b) => clamp((t - a) / (b - a));
/** deterministic hash noise */
export function rnd(i) {
  let s = (i * 2654435761) >>> 0;
  s ^= s >>> 13;
  s = Math.imul(s, 1274126177) >>> 0;
  return (s >>> 0) / 4294967296;
}
export { COLOURS, RGB, SKY };
