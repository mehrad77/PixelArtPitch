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
  /** whose film: "questday" draws the journey's own 30 s cut (its four scenes), anything else the night market */
  look?: "questday";
  /** the scene's start and end, for motion inside it */
  from?: number;
  to?: number;
  /** the end card's achievement toast shows the logo (the draft had one, and the rights pick said use it) */
  logo?: boolean;
  /** the scene is stale (its board changed): only the sky, as the server draws it */
  empty?: boolean;
};

/** one 320×180 frame as a PNG data URL */
export function drawFrame(spec: FrameSpec): string {
  const key = `${Math.round(spec.t * 10)}|${spec.sceneIndex}|${spec.version}|${spec.variant ?? 0}|${spec.look ?? ""}|${spec.logo ? 1 : 0}|${spec.empty ? 1 : 0}`;
  const hit = frameCache.get(key);
  if (hit) return hit;
  paintFrame(spec);
  return cache(key);
}

/**
 * The rough cut's contact sheet as the server lays it out (packages/render contactSheet): one still per second, taken
 * at i + 0.5 s, in `cols` columns of 320×180 at 1×, the last row partial. A PNG data URL.
 */
export function drawContactSheet(specs: FrameSpec[], cols = 6): string {
  const rows = Math.max(1, Math.ceil(specs.length / cols));
  const sheet = document.createElement("canvas");
  sheet.width = 320 * cols;
  sheet.height = 180 * rows;
  const c = sheet.getContext("2d") as CanvasRenderingContext2D;
  c.imageSmoothingEnabled = false;
  c.fillStyle = ink().sky;
  c.fillRect(0, 0, sheet.width, sheet.height);
  specs.forEach((spec, i) => {
    paintFrame(spec);
    c.drawImage(canvas as HTMLCanvasElement, (i % cols) * 320, Math.floor(i / cols) * 180);
  });
  return sheet.toDataURL("image/png");
}

/** paint one frame into the shared canvas */
function paintFrame(spec: FrameSpec) {
  const W = 320;
  const H = 180;
  const c = ctx2d(W, H);
  const k = ink();
  const px = (x: number, y: number, w: number, h: number, col: string) => {
    c.fillStyle = col;
    c.fillRect(Math.round(x), Math.round(y), Math.round(w), Math.round(h));
  };
  const font = getComputedStyle(document.documentElement).getPropertyValue("--font-mono") || "monospace";
  // a scene whose board changed and isn't redrawn yet: the server draws its empty sky
  if (spec.empty) {
    px(0, 0, W, H, k.sky);
    for (let y = 90; y < H; y += 2) px(0, y, W, 1, k.sky2);
    return;
  }

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
    return;
  }

  if (spec.look === "questday") {
    drawQuestDay(spec, px, k, (text, x, y, size, col) => {
      c.fillStyle = col;
      c.font = `${size}px ${font}`;
      c.fillText(text, x, y);
    });
    if (spec.version === "board") {
      c.globalCompositeOperation = "saturation";
      px(0, 0, W, H, k.sky);
      c.globalCompositeOperation = "source-over";
    }
    return;
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
  return;
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

// ---- QuestDay's own cut (the journey "todo"): four scenes, 30 s, drawn from the doc's scene ids ----
type Px = (x: number, y: number, w: number, h: number, col: string) => void;
type Txt = (text: string, x: number, y: number, size: number, col: string) => void;

/** the founder, 10×18 cells, facing the way they walk; `big` doubles them (the step 10 change on scene 2) */
function founder(px: Px, k: Ink, x: number, y: number, step: number, big = 1) {
  const u = big;
  px(x + 2 * u, y, 6 * u, 5 * u, k.moon); // head
  px(x + 2 * u, y, 6 * u, 2 * u, k.bloom); // hair
  px(x + 6 * u, y + 2 * u, 1 * u, 1 * u, k.sky); // eye
  px(x + 1 * u, y + 5 * u, 8 * u, 7 * u, k.hue4); // hoodie
  px(x + 1 * u, y + 11 * u, 8 * u, 1 * u, k.sky3);
  px(x + (step ? 2 : 4) * u, y + 12 * u, 2 * u, 6 * u, k.sky3); // legs
  px(x + (step ? 6 : 5) * u, y + 12 * u, 2 * u, 6 * u, k.sky3);
}
function teammate(px: Px, k: Ink, x: number, y: number) {
  px(x + 2, y, 6, 5, k.moonShade);
  px(x + 2, y, 6, 2, k.hue7);
  px(x + 3, y + 2, 1, 1, k.sky);
  px(x + 1, y + 5, 8, 7, k.leaf);
  px(x + 2, y + 12, 2, 6, k.sky3);
  px(x + 6, y + 12, 2, 6, k.sky3);
}
/** a 7×7 star, the quest mark */
function star(px: Px, x: number, y: number, col: string) {
  px(x + 3, y, 1, 7, col);
  px(x, y + 3, 7, 1, col);
  px(x + 1, y + 1, 5, 5, col);
}

function drawQuestDay(spec: FrameSpec, px: Px, k: Ink, txt: Txt) {
  const W = 320;
  const H = 180;
  const from = spec.from ?? 0;
  const to = spec.to ?? from + 7;
  const u = Math.max(0, Math.min(1, (spec.t - from) / Math.max(0.1, to - from)));
  const step = Math.floor(spec.t * 6) % 2;
  // a desk at night: the room, a window with the moon, the floor
  px(0, 0, W, H, k.sky);
  px(0, 132, W, 48, k.ground);
  px(0, 132, W, 1, k.line);
  px(236, 18, 64, 48, k.sky2);
  px(236, 18, 64, 1, k.line);
  for (let y = -6; y <= 6; y++)
    for (let x = -6; x <= 6; x++) if (x * x + y * y <= 36) px(276 + x, 36 + y, 1, 1, x + y > 4 ? k.moonShade : k.moon);
  const r = rng(spec.sceneIndex * 31 + 7);
  for (let i = 0; i < 6; i++) px(240 + Math.floor(r() * 56), 22 + Math.floor(r() * 40), 1, 1, k.muted);

  if (spec.sceneIndex === 0) {
    // The list grows: a long todo list scrolls up beside the founder, who slumps
    px(120, 14, 96, 116, k.sky2);
    px(120, 14, 96, 1, k.line);
    txt("TODO", 128, 26, 8, k.muted);
    const rows = 3 + Math.floor(u * 10);
    for (let i = 0; i < Math.min(rows, 11); i++) {
      const y = 32 + i * 9;
      px(128, y, 5, 5, k.line);
      px(136, y + 1, 30 + ((i * 17) % 40), 3, k.muted);
    }
    founder(px, k, 64, 114, 0);
    px(66, 112, 6, 2, k.sky); // a slump: the head drops a cell
  } else if (spec.sceneIndex === 1) {
    // Every task a quest: the rows turn into quest cards, each with a star; the founder perks up
    const big = spec.variant === 2 ? 2 : 1;
    const turned = Math.floor(u * 5);
    for (let i = 0; i < 5; i++) {
      const y = 20 + i * 21;
      const on = i < turned;
      px(128, y, 100, 17, on ? k.sky3 : k.sky2);
      px(128, y, on ? 3 : 0, 17, k.signal);
      if (on) star(px, 134, y + 5, k.signal);
      px(146, y + 7, 40 + ((i * 13) % 30), 3, on ? k.text : k.muted);
      if (on) txt("+10", 202, y + 11, 7, k.leaf);
    }
    founder(px, k, 70 - (big - 1) * 10, 132 - 18 * big, step, big);
  } else if (spec.sceneIndex === 2) {
    // The quest board: three columns, cards moving to Done; two people left of the box, a toast for the line
    const cols = ["QUESTS", "DOING", "DONE"];
    cols.forEach((name, j) => {
      const x = 120 + j * 64;
      px(x, 14, 58, 112, k.sky2);
      txt(name, x + 4, 24, 7, k.muted);
    });
    const done = Math.floor(u * 4);
    for (let i = 0; i < 4; i++) {
      const col = i < done ? 2 : i === done ? 1 : 0;
      const x = 124 + col * 64;
      const y = 30 + (i % 4) * 22;
      px(x, y, 50, 16, k.sky3);
      star(px, x + 4, y + 5, col === 2 ? k.signal : k.muted);
      px(x + 15, y + 7, 26, 3, col === 2 ? k.text : k.muted);
    }
    founder(px, k, 40, 114, step);
    teammate(px, k, 78, 114);
    // the toast: one line instead of two people talking
    const tx = 14;
    px(tx, 70, 96, 22, k.sky3);
    px(tx, 70, 96, 1, k.signal);
    txt("Quest done!", tx + 6, 85, 8, k.text);
  } else {
    // End card: the wordmark, the line, and the achievement toast with the logo (or a star)
    px(0, 0, W, H, k.sky);
    for (let i = 0; i < 30; i++) px(Math.floor(r() * W), Math.floor(r() * 60), 1, 1, i % 5 ? k.muted : k.moon);
    txt("QuestDay", 106, 86, 20, k.text);
    txt("Make the day a quest.", 104, 104, 8, k.muted);
    const slide = Math.min(1, u * 3);
    const tx = Math.round(W - 8 - 130 * slide);
    px(tx, 132, 122, 28, k.sky3);
    px(tx, 132, 122, 1, k.signal);
    if (spec.logo) {
      // the 16 px Q badge, cell for cell
      Q_BADGE.forEach((row, y) => {
        for (let x = 0; x < row.length; x++) if (row[x] === "#") px(tx + 6 + x, 138 + y, 1, 1, k.signal);
      });
    } else star(px, tx + 9, 142, k.signal);
    txt("Achievement", tx + 28, 144, 7, k.muted);
    txt("Day complete", tx + 28, 154, 8, k.text);
  }
}
