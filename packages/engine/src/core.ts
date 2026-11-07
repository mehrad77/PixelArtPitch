// The 320x180 frame buffer and its drawing primitives. Ported line for line from the first video's engine.mjs, so the
// arithmetic (and every pixel) stays identical: a Uint8Array RGB buffer where blended values truncate on store.
// Isomorphic: no fs, no Buffer. Assets and the font arrive as data.

export type Rows = string[];
export type Frames = Record<string, Rows>;
export type RGBT = [number, number, number];
export type Colour = string | RGBT;

export const hexToRgb = (h: string): RGBT => [1, 3, 5].map((i) => Number.parseInt(h.slice(i, i + 2), 16)) as RGBT;

export type EngineInit = {
  /** letter -> "#rrggbb" */
  colours: Record<string, string>;
  /** the night sky the sprites stand on */
  sky: string;
  /** asset name -> frames (letter grids), already resolved with any frame aliases */
  assets: Map<string, Frames | null>;
  /** the 5x8 font: frame "g<codepoint>" -> rows of "P"/"." */
  fontAssets?: string[];
  w?: number;
  h?: number;
  /** a buffer to draw into (Node passes a Buffer); defaults to a new Uint8Array */
  buffer?: Uint8Array;
};

export function createEngine(init: EngineInit) {
  const W = init.w ?? 320;
  const H = init.h ?? 180;
  const buf = init.buffer ?? new Uint8Array(W * H * 3);
  const COLOURS = { ...init.colours };
  const RGB: Record<string, RGBT> = Object.fromEntries(Object.entries(COLOURS).map(([k, h]) => [k, hexToRgb(h)]));
  const SKY = init.sky;

  const rgbOf = (c: Colour): RGBT => (Array.isArray(c) ? c : c.length === 1 ? RGB[c] : hexToRgb(c));

  function clear(c: Colour = SKY) {
    const [r, g, b] = rgbOf(c);
    for (let i = 0; i < W * H; i++) {
      buf[i * 3] = r;
      buf[i * 3 + 1] = g;
      buf[i * 3 + 2] = b;
    }
  }

  function px(x: number, y: number, c: RGBT, a = 1) {
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

  function rect(x: number, y: number, w: number, h: number, c: Colour, a = 1) {
    const col = rgbOf(c);
    x = Math.round(x);
    y = Math.round(y);
    for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) px(x + i, y + j, col, a);
  }

  /** 1 px frame */
  function box(x: number, y: number, w: number, h: number, c: Colour) {
    rect(x, y, w, 1, c);
    rect(x, y + h - 1, w, 1, c);
    rect(x, y, 1, h, c);
    rect(x + w - 1, y, 1, h, c);
  }

  /** a dark panel with a coloured 1 px border and a shadow */
  function panel(
    x: number,
    y: number,
    w: number,
    h: number,
    { border = "G", fill = "k", alpha = 0.88 }: { border?: Colour; fill?: Colour; alpha?: number } = {},
  ) {
    rect(x + 2, y + 2, w, h, "k", 0.5);
    rect(x, y, w, h, fill, alpha);
    box(x, y, w, h, border);
  }

  type SpriteOpts = { flip?: boolean; outline?: Colour; alpha?: number; colour?: Colour; scale?: number };
  /** Draw letter rows at (x, y). opts: flip, outline (colour for a 1 px ring), alpha, colour override for all cells. */
  function sprite(rows: Rows | null | undefined, x: number, y: number, opts: SpriteOpts = {}) {
    const { flip = false, outline, alpha = 1, colour, scale = 1 } = opts;
    if (!rows) return;
    x = Math.round(x);
    y = Math.round(y);
    const h = rows.length;
    const w = rows[0]?.length ?? 0;
    const at = (i: number, j: number) => {
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
  /** frames of an asset, or null when the project has none by that name */
  function asset(name: string): Frames | null {
    return init.assets.get(name) ?? null;
  }
  function frame(name: string, f: string, fallback: [number, number] = [16, 24]): Rows {
    const a = asset(name);
    const rows = a?.[f] ?? (a ? Object.values(a)[0] : null);
    if (rows) return rows;
    const [w, h] = fallback;
    return Array.from({ length: h }, (_, j) =>
      Array.from({ length: w }, (_, i) => (i === 0 || j === 0 || i === w - 1 || j === h - 1 ? "O" : "e")).join(""),
    );
  }

  // ---- text ----
  let glyphs: Map<string, Rows> | null = null;
  function font() {
    if (glyphs) return glyphs;
    glyphs = new Map();
    for (const name of init.fontAssets ?? ["font1", "font2", "font3", "font4", "font5", "font6"]) {
      const a = asset(name);
      if (a) for (const [k, rows] of Object.entries(a)) glyphs.set(String.fromCodePoint(Number(k.slice(1))), rows);
    }
    return glyphs;
  }
  const has = (ch: string) => font().has(ch) || font().has(ch.toUpperCase());
  /** typographic characters the font lacks, swapped for the plain ones it has (others pass through unchanged) */
  function norm(str: string) {
    let out = "";
    for (const ch of str) out += has(ch) ? ch : (TYPO[ch] ?? ch);
    return out;
  }
  /** glyph advance: its inked width + 1 (min 2), space 4 */
  function glyphW(ch: string) {
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
  function measure(str: string, scale = 1) {
    return [...norm(str)].reduce((s, ch) => s + glyphW(ch), 0) * scale - scale;
  }
  type TextOpts = {
    colour?: Colour;
    scale?: number;
    align?: "left" | "center" | "right";
    shadow?: boolean;
    alpha?: number;
  };
  /** text at (x, y) top-left; align "left" | "center" | "right"; shadow draws a 1 px dark drop shadow */
  function text(str: string, x: number, y: number, opts: TextOpts = {}) {
    const { colour = "P", scale = 1, align = "left", shadow = true, alpha = 1 } = opts;
    str = norm(str);
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
  function wrap(str: string, maxW: number, scale = 1) {
    const lines: string[] = [];
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

  return {
    W,
    H,
    buf,
    COLOURS,
    RGB,
    SKY,
    rgbOf,
    clear,
    px,
    rect,
    box,
    panel,
    sprite,
    asset,
    frame,
    measure,
    text,
    wrap,
    clamp,
    lerp,
    ease,
    step,
    prog,
    rnd,
  };
}
export type Engine = ReturnType<typeof createEngine>;

/** typographic characters a writer model may emit, mapped to the plain ASCII the 5x8 font draws */
export const TYPO: Record<string, string> = {
  "\u2010": "-",
  "\u2011": "-",
  "\u2012": "-",
  "\u2013": "-",
  "\u2014": "-",
  "\u2015": "-",
  "\u2212": "-",
  "\u00ad": "",
  "\u2018": "'",
  "\u2019": "'",
  "\u201a": "'",
  "\u201b": "'",
  "\u2032": "'",
  "\u201c": '"',
  "\u201d": '"',
  "\u201e": '"',
  "\u201f": '"',
  "\u2033": '"',
  "\u00ab": '"',
  "\u00bb": '"',
  "\u2039": "'",
  "\u203a": "'",
  "\u2026": "...",
  "\u00a0": " ",
  "\u2007": " ",
  "\u2009": " ",
  "\u200a": " ",
  "\u202f": " ",
  "\u2002": " ",
  "\u2003": " ",
  "\u200b": "",
  "\u2060": "",
  "\ufeff": "",
  "\u2022": "*",
  "\u00b7": "*",
  "\u00d7": "x",
};
const TYPO_RE = new RegExp(`[${Object.keys(TYPO).join("")}]`, "gu");
/** plain-ASCII punctuation for stored text (captions, SRT, the doc): dashes, quotes, ellipsis, odd spaces */
export const plainText = (s: string) => s.replace(TYPO_RE, (c) => TYPO[c] ?? c);

/**
 * The characters of `text` the pixel font can't draw, once the typographic swaps are made (whitespace always
 * passes; a lowercase letter passes when its capital is drawn). `fontFrames` is the font asset's frames,
 * named "g<codepoint>". An empty list means captions in this text can be burned into the picture.
 */
export function missingGlyphs(text: string, fontFrames: Record<string, unknown>): string[] {
  const have = new Set(
    Object.keys(fontFrames)
      .filter((k) => /^g\d+$/.test(k))
      .map((k) => String.fromCodePoint(Number(k.slice(1)))),
  );
  const out = new Set<string>();
  for (const ch of plainText(text)) {
    if (/\s/.test(ch) || have.has(ch) || have.has(ch.toUpperCase())) continue;
    out.add(ch);
  }
  return [...out];
}

// ---- helpers (pure) ----
export const clamp = (v: number, a = 0, b = 1) => Math.max(a, Math.min(b, v));
export const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
export const ease = (t: number) => 1 - (1 - clamp(t)) ** 3;
export const step = (v: number, n = 1) => Math.round(v / n) * n;
/** 0..1 progress of t through [a, b] */
export const prog = (t: number, a: number, b: number) => clamp((t - a) / (b - a));
/** deterministic hash noise */
export function rnd(i: number) {
  let s = (i * 2654435761) >>> 0;
  s ^= s >>> 13;
  s = Math.imul(s, 1274126177) >>> 0;
  return (s >>> 0) / 4294967296;
}

/** the names a code bundle may import from "pap:engine" (and the PoC's "./engine.mjs") */
export const ENGINE_EXPORTS = [
  "W",
  "H",
  "buf",
  "COLOURS",
  "RGB",
  "SKY",
  "clear",
  "px",
  "rect",
  "box",
  "panel",
  "sprite",
  "asset",
  "frame",
  "measure",
  "text",
  "wrap",
  "clamp",
  "lerp",
  "ease",
  "step",
  "prog",
  "rnd",
] as const;
