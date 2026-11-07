// Mock pictures drawn on a 320×180 canvas in whole pixels. Colours come from the kit's tokens at runtime
// (getComputedStyle), so no colour literal lives in the source.
import type { SceneVersion } from "../lib/types.ts";

type Ink = Record<
  | "sky"
  | "sky2"
  | "sky3"
  | "ground"
  | "line"
  | "text"
  | "muted"
  | "moon"
  | "moonShade"
  | "leaf"
  | "leafShade"
  | "bloom"
  | "signal"
  | "accent"
  | "hue4"
  | "hue7",
  string
>;
let inkCache: Ink | null = null;
function ink(): Ink {
  if (inkCache) return inkCache;
  const cs = getComputedStyle(document.documentElement);
  const v = (name: string) => cs.getPropertyValue(name).trim() || "gray";
  inkCache = {
    sky: v("--ink"),
    sky2: v("--ink-2"),
    sky3: v("--ink-3"),
    ground: v("--ink-4"),
    line: v("--line-control"),
    text: v("--paper"),
    muted: v("--paper-dim"),
    moon: v("--art-moon"),
    moonShade: v("--art-moon-shade"),
    leaf: v("--art-leaf"),
    leafShade: v("--art-leaf-shade"),
    bloom: v("--art-bloom"),
    signal: v("--signal"),
    accent: v("--accent-strong"),
    hue4: v("--hue-4"),
    hue7: v("--hue-7"),
  };
  return inkCache;
}

let canvas: HTMLCanvasElement | null = null;
function ctx2d(w: number, h: number) {
  canvas ??= document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const c = canvas.getContext("2d") as CanvasRenderingContext2D;
  c.imageSmoothingEnabled = false;
  return c;
}

/** a tiny seeded PRNG, so the same input always draws the same picture */
export function rng(seed: number) {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    return ((s >>> 0) % 10000) / 10000;
  };
}
export const hash = (str: string) => [...str].reduce((h, ch) => (h * 31 + ch.charCodeAt(0)) | 0, 7);

const frameCache = new Map<string, string>();

export type FrameSpec = {
  t: number;
  sceneIndex: number;
  sceneTitle: string;
  version: SceneVersion;
  caption?: string;
  variant?: number;
};

/** one 320×180 frame as a PNG data URL */
export function drawFrame(spec: FrameSpec): string {
  const key = `${Math.round(spec.t * 10)}|${spec.sceneIndex}|${spec.version}|${spec.variant ?? 0}`;
  const hit = frameCache.get(key);
  if (hit) return hit;
  const W = 320;
  const H = 180;
  const c = ctx2d(W, H);
  const k = ink();
  const px = (x: number, y: number, w: number, h: number, col: string) => {
    c.fillStyle = col;
    c.fillRect(Math.round(x), Math.round(y), Math.round(w), Math.round(h));
  };
  const font = getComputedStyle(document.documentElement).getPropertyValue("--font-mono") || "monospace";

  if (spec.version === "slate") {
    px(0, 0, W, H, k.sky2);
    px(8, 8, W - 16, 1, k.line);
    px(8, H - 9, W - 16, 1, k.line);
    c.fillStyle = k.muted;
    c.font = `8px ${font}`;
    c.fillText(`SCENE ${spec.sceneIndex + 1}`, 16, 28);
    c.fillStyle = k.text;
    c.font = `14px ${font}`;
    c.fillText(spec.sceneTitle, 16, 92);
    c.fillStyle = k.muted;
    c.font = `8px ${font}`;
    c.fillText("not drawn yet", 16, 110);
    return cache(key);
  }

  // sky in three dithered bands
  px(0, 0, W, H, k.sky);
  for (let y = 0; y < 120; y++)
    for (let x = (y % 2) * 1; x < W; x += 2) {
      if (y > 60 && y < 90 && (x + y) % 4 === 0) px(x, y, 1, 1, k.sky2);
      if (y >= 90 && (x + y) % 2 === 0) px(x, y, 1, 1, k.sky3);
    }
  const r = rng(spec.sceneIndex * 97 + 13);
  // stars
  for (let i = 0; i < 40; i++) px(Math.floor(r() * W), Math.floor(r() * 70), 1, 1, i % 7 === 0 ? k.moon : k.muted);
  // moon, lit from the upper left
  const mx = 250 - spec.sceneIndex * 18;
  for (let y = -9; y <= 9; y++)
    for (let x = -9; x <= 9; x++) if (x * x + y * y <= 81) px(mx + x, 30 + y, 1, 1, x + y > 6 ? k.moonShade : k.moon);
  // ground and stalls
  px(0, 132, W, 48, k.ground);
  px(0, 132, W, 1, k.line);
  const stalls = 4 + spec.sceneIndex;
  const lit = spec.sceneIndex >= 2;
  for (let i = 0; i < stalls; i++) {
    const sx = 14 + i * (290 / stalls);
    px(sx, 104, 30, 28, k.sky3);
    px(sx - 2, 100, 34, 5, i % 2 ? k.hue7 : k.accent);
    if (lit) {
      const on = (spec.t * 2 + i) % 3 > 0.6;
      px(sx + 13, 92, 4, 6, on ? k.signal : k.hue7);
      px(sx + 14, 90, 2, 2, k.moon);
    }
  }
  if (spec.version === "board") {
    // a board is a sketch: wipe colour back to outlines
    c.globalCompositeOperation = "saturation";
    px(0, 0, W, H, k.sky);
    c.globalCompositeOperation = "source-over";
  }
  // a walker crossing the scene
  const wx = ((spec.t * 22) % (W + 20)) - 10;
  const step = Math.floor(spec.t * 6) % 2;
  px(wx, 116, 6, 7, spec.variant ? k.bloom : k.hue4);
  px(wx + 1, 110, 4, 5, k.moon);
  px(wx + (step ? 0 : 3), 123, 2, 6, k.leafShade);
  px(wx + (step ? 3 : 0), 123, 2, 4, k.leafShade);
  // bushes
  for (let i = 0; i < 6; i++) {
    const bx = 20 + i * 52;
    px(bx, 128, 10, 4, k.leaf);
    px(bx + 2, 126, 6, 2, k.leaf);
    px(bx + 6, 129, 4, 3, k.leafShade);
  }
  return cache(key);
}
function cache(key: string) {
  const url = (canvas as HTMLCanvasElement).toDataURL("image/png");
  if (frameCache.size > 600) frameCache.clear();
  frameCache.set(key, url);
  return url;
}

const sheetCache = new Map<string, string>();
/** a symmetrical sprite sheet for a library asset or an art variant */
export function drawSheet(id: string, w: number, h: number, frames: number): string {
  const key = `${id}|${w}|${h}|${frames}`;
  const hit = sheetCache.get(key);
  if (hit) return hit;
  const n = Math.max(1, Math.min(frames, 6));
  const cw = Math.max(8, Math.min(w, 32));
  const ch = Math.max(8, Math.min(h, 32));
  const c = ctx2d(cw * n + (n - 1) * 2, ch);
  const k = ink();
  const cols = [k.leaf, k.leafShade, k.moon, k.bloom, k.hue7, k.hue4, k.signal];
  c.clearRect(0, 0, c.canvas.width, ch);
  for (let f = 0; f < n; f++) {
    const r = rng(hash(id) + f * 17);
    const ox = f * (cw + 2);
    const half = Math.ceil(cw / 2);
    for (let y = 1; y < ch - 1; y++)
      for (let x = 1; x < half; x++) {
        const d = Math.abs(y - ch / 2) / (ch / 2) + (half - x) / half / 2;
        if (r() > 0.35 + d * 0.4) continue;
        c.fillStyle = cols[Math.floor(r() * 3 + (f % 3))];
        c.fillRect(ox + x, y, 1, 1);
        c.fillRect(ox + cw - 1 - x, y, 1, 1);
      }
  }
  const url = c.canvas.toDataURL("image/png");
  sheetCache.set(key, url);
  return url;
}

/** the journey's logo fixture: a fictional "Q" badge (QuestDay), 16×16, drawn in whole cells; never a real mark */
const Q_BADGE = [
  "....######......",
  "..##########....",
  ".####....####...",
  "####......####..",
  "###........###..",
  "###........###..",
  "###........###..",
  "###........###..",
  "###....##..###..",
  "####....#####...",
  ".####....####...",
  "..###########...",
  "....######.###..",
  "............###.",
  ".............##.",
  "................",
];
let logoCache: string | null = null;
export function drawLogo(scale = 1): string {
  if (logoCache && scale === 1) return logoCache;
  const c = ctx2d(16 * scale, 16 * scale);
  const k = ink();
  c.clearRect(0, 0, 16 * scale, 16 * scale);
  c.fillStyle = k.signal;
  Q_BADGE.forEach((row, y) => {
    for (let x = 0; x < row.length; x++) if (row[x] === "#") c.fillRect(x * scale, y * scale, scale, scale);
  });
  const url = c.canvas.toDataURL("image/png");
  if (scale === 1) logoCache = url;
  return url;
}
