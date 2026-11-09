// The drawing kit a code bundle gets on top of the engine's primitives (all exported from "pap:engine"): a walk that
// steps with the distance and faces its travel, a logo flag for a finale and numbered slots for a counted list.
// Built over whichever engine the sandbox hands a bundle (the probed one records what these draw), byte-exact like
// the rest: no randomness, no clock.
import type { Engine, Rows } from "./core.ts";

type Dir = "left" | "right";
export type WalkOpts = {
  /** where the walk starts and stops: the centre x of the feet */
  x0: number;
  x1: number;
  /** the feet line (the ground is 148) */
  y?: number;
  /** when it leaves x0 and when it reaches x1, in seconds */
  t0: number;
  t1: number;
  /** the time now (draw's t) */
  t: number;
  /** run-cycle frames per second at 32 px/s; the cycle follows the distance, so a faster walk steps faster */
  fps?: number;
  scale?: number;
  /** which way it looks while standing before and after (default: the way it walks) */
  face?: Dir;
};
export type FlagOpts = {
  /** the pole's x and the y its foot stands on */
  x: number;
  y?: number;
  /** pole height in pixels */
  pole?: number;
  t: number;
  /** how far up the pole the cloth is, 0..1 (animate it with prog(t, a, b) to raise the flag) */
  up?: number;
};
export type SlotsOpts = {
  /** top-left of the row */
  x: number;
  y: number;
  /** one slot's size and the gap between slots */
  w?: number;
  h?: number;
  gap?: number;
  /** how many are filled, or the time each slot fills (a 0.3 s flash at each) */
  filled?: number | number[];
  t: number;
};
export type Slot = { i: number; x: number; y: number; w: number; h: number; on: boolean };

const has = (fr: Record<string, Rows> | null, n: string) => !!fr && Array.isArray(fr[n]);

// ---------------------------------------------------------------- the sky for the time of day
/** the feet line: skies are painted down to it, the ground covers the rest */
const HORIZON = 148;
/** the day and dusk palettes' own sky letters (pap-day / pap-dusk), as hexes so any palette can draw them */
export const SKY_TONES = {
  day: {
    top: "#3f86cf",
    mid: "#64a2da",
    low: "#a9d3f0",
    cloud: "#f4f6f2",
    shade: "#c9d6e0",
    sun: "#ffe27a",
    rim: "#ffc94a",
  },
  dusk: {
    top: "#2a2a55",
    mid: "#4a3a6a",
    low: "#e8895a",
    cloud: "#f2a98a",
    shade: "#8a4d6e",
    sun: "#ffb347",
    rim: "#f2733f",
  },
} as const;
/** [from y, colour] bands of each sky, top down; two rows of checker dither join each pair */
const BANDS: Record<"day" | "dusk", [number, string][]> = {
  day: [
    [0, SKY_TONES.day.top],
    [44, SKY_TONES.day.mid],
    [104, SKY_TONES.day.low],
  ],
  dusk: [
    [0, SKY_TONES.dusk.top],
    [48, SKY_TONES.dusk.mid],
    [100, SKY_TONES.dusk.shade],
    [124, SKY_TONES.dusk.low],
  ],
};
const mod = (v: number, n: number) => ((v % n) + n) % n;

const SKYLINE_TONES: Record<"day" | "dusk", Record<string, Record<string, string>>> = {
  // by day the city is lit grey-blue stone with dark, unlit windows
  day: {
    far: { l: "w", e: "W", K: "q", k: "q", B: "q", O: "q", T: "q" },
    near: { K: "Y", l: "p", k: "e", B: "F", O: "F", T: "F" },
  },
  // at dusk the silhouettes stay dark and only some windows are lit
  dusk: { far: { O: "l", T: "l" }, near: { O: "K", T: "K" } },
};
const skylineCache = new WeakMap<Rows, Map<string, Rows>>();
/** a skyline layer's rows recoloured for the time of day (night: as drawn) */
export function skylineFor(rows: Rows, layer: string, time: string): Rows {
  if (time !== "day" && time !== "dusk") return rows;
  const key = `${time}:${layer}`;
  let byKey = skylineCache.get(rows);
  if (!byKey) {
    byKey = new Map();
    skylineCache.set(rows, byKey);
  }
  const hit = byKey.get(key);
  if (hit) return hit;
  const map = SKYLINE_TONES[time][layer === "near" ? "near" : "far"];
  const out = rows.map((r, j) =>
    [...r]
      .map((c, i) => {
        // dusk: two windows in three stay dark (the body tone around them)
        if (time === "dusk" && c === "B" && hash(j * 131 + i) < 0.66) return layer === "near" ? "K" : "l";
        return map[c] ?? c;
      })
      .join(""),
  );
  byKey.set(key, out);
  return out;
}
const hash = (i: number) => {
  let s = (i * 2654435761) >>> 0;
  s ^= s >>> 13;
  s = Math.imul(s, 1274126177) >>> 0;
  return (s >>> 0) / 4294967296;
};

/**
 * The whole frame's sky for `time`: night is the palette sky with a soft lighter band near the horizon; dusk an
 * indigo-to-amber ramp; day a deep-to-pale blue ramp. Bands are whole colours joined by a checker row (pixel art,
 * never a smooth blend).
 */
export function drawSky(e: Engine, time: string, o: { band?: boolean } = {}) {
  e.clear();
  if (time !== "day" && time !== "dusk") {
    if (o.band !== false && e.RGB.l)
      for (let y = 70; y < HORIZON; y++) e.rect(0, y, e.W, 1, "l", ((y - 70) / (HORIZON - 70)) * 0.35);
    return;
  }
  const bands = BANDS[time];
  bands.forEach(([y0, c], i) => {
    const y1 = bands[i + 1]?.[0] ?? e.H;
    e.rect(0, y0, e.W, y1 - y0, c);
    const next = bands[i + 1]?.[1];
    // the join: every 4th pixel of the next colour two rows up, every 2nd one row up
    if (next) {
      for (let x = 0; x < e.W; x += 4) e.rect(x, y1 - 2, 1, 1, next);
      for (let x = 1; x < e.W; x += 2) e.rect(x, y1 - 1, 1, 1, next);
    }
  });
}

/** the sun: by day a small disc high up, at dusk a big low one sinking into the horizon; nothing at night */
export function drawSun(e: Engine, time: string, x?: number, y?: number) {
  if (time !== "day" && time !== "dusk") return;
  const day = time === "day";
  const tone = SKY_TONES[time];
  const cx = Math.round(x ?? 264);
  const cy = Math.round(y ?? (day ? 30 : 114));
  const r = day ? 8 : 13;
  for (let j = -r - 2; j <= r + 2; j++)
    for (let i = -r - 2; i <= r + 2; i++) {
      const d = Math.hypot(i, j);
      if (cy + j >= HORIZON) continue;
      if (d <= r - 1) e.rect(cx + i, cy + j, 1, 1, tone.sun);
      else if (d <= r + 0.5) e.rect(cx + i, cy + j, 1, 1, tone.rim);
      else if (d <= r + 2 && day && (i + j) % 2 === 0) e.rect(cx + i, cy + j, 1, 1, tone.sun, 0.35);
    }
}

/** slow clouds drifting right (day: white with a blue-grey underside; dusk: peach lit with plum); none at night */
export function drawClouds(e: Engine, time: string, t: number, cam = 0) {
  if (time !== "day" && time !== "dusk") return;
  const tone = SKY_TONES[time];
  const n = time === "day" ? 5 : 3;
  for (let k = 0; k < n; k++) {
    const w = 24 + Math.floor(hash(k * 7 + 1) * 28);
    const y = 12 + Math.floor(hash(k * 7 + 2) * (time === "day" ? 60 : 50));
    const x = Math.round(mod(hash(k * 7 + 3) * 420 + t * (2 + k * 0.5) - cam * 0.03, 420)) - 50;
    // a flat-bottomed puff: a body, two bumps on top, the shade along the bottom
    e.rect(x, y + 4, w, 5, tone.cloud);
    e.rect(x + 4, y + 1, Math.floor(w * 0.4), 4, tone.cloud);
    e.rect(x + Math.floor(w * 0.45), y - 1, Math.floor(w * 0.35), 6, tone.cloud);
    e.rect(x + 1, y + 8, w - 2, 2, tone.shade);
  }
}

/** stars that twinkle: many at night, a few faint ones high up at dusk, none by day */
export function drawStars(e: Engine, time: string, t: number, cam = 0, n = 70) {
  if (time === "day") return;
  const dusk = time === "dusk";
  const count = dusk ? Math.min(n, 14) : n;
  const P = e.RGB.P ? "P" : Object.keys(e.RGB)[0];
  for (let i = 0; i < count; i++) {
    const x = Math.floor(mod(hash(i) * 420 - cam * 0.05, 420)) - 50;
    const y = Math.floor(hash(i + 99) * (dusk ? 46 : 110));
    const tw = 0.35 + 0.65 * (0.5 + 0.5 * Math.sin(t * (1 + hash(i + 7) * 3) + i));
    e.rect(x, y, 1, 1, P, dusk ? tw * 0.6 : tw);
    if (!dusk && hash(i + 3) < 0.12) {
      e.rect(x - 1, y, 1, 1, P, tw * 0.4);
      e.rect(x + 1, y, 1, 1, P, tw * 0.4);
      e.rect(x, y - 1, 1, 1, P, tw * 0.4);
      e.rect(x, y + 1, 1, 1, P, tw * 0.4);
    }
  }
}
const cycle = (fr: Record<string, Rows> | null, base: string) =>
  [0, 1, 2, 3].map((i) => `${base}${i}`).filter((n) => has(fr, n));

export function createKit(e: Engine) {
  /** an asset's idle frame at t (idle0/idle1 breathing at 2.5 fps), else its first frame */
  function idleFrame(name: string, t: number) {
    const fr = e.asset(name);
    const idles = ["idle0", "idle1"].filter((n) => has(fr, n));
    if (idles.length) return idles[Math.floor(Math.max(0, t) * 2.5) % idles.length];
    return fr ? (Object.keys(fr)[0] ?? "idle0") : "idle0";
  }

  /**
   * A character or creature walking from x0 to x1 between t0 and t1, feet on y: idle before and after, run0-run3
   * (a creature's move0-move3) while it walks, one step per 32/fps pixels so the feet never slide, mirrored by its
   * art's facing to look where it goes. Returns where it is and what it drew.
   */
  function walk(name: string, o: WalkOpts) {
    const { x0, x1, t0, t1, t } = o;
    const y = o.y ?? 148;
    const scale = Math.max(1, Math.round(o.scale ?? 1));
    const dir: Dir = x1 < x0 ? "left" : "right";
    const k = t1 > t0 ? Math.min(1, Math.max(0, (t - t0) / (t1 - t0))) : t >= t1 ? 1 : 0;
    const x = x0 + (x1 - x0) * k;
    const fr = e.asset(name);
    const runs = cycle(fr, "run").length ? cycle(fr, "run") : cycle(fr, "move");
    const moving = k > 0 && k < 1 && Math.abs(x1 - x0) >= 1;
    const stride = 32 / Math.max(1, o.fps ?? 8);
    let f: string;
    let bob = 0;
    if (moving && runs.length) f = runs[Math.floor(Math.abs(x - x0) / stride) % runs.length];
    else if (moving) {
      // a character without a run cycle steps on its idle frames with a 1 px bob
      const n = Math.floor(Math.abs(x - x0) / stride);
      f = idleFrame(name, n / 2.5);
      bob = n % 2 ? -1 : 0;
    } else f = idleFrame(name, t);
    const rows = e.frame(name, f, [16, 24]);
    const w = (rows[0]?.length ?? 16) * scale;
    const h = rows.length * scale;
    const facing: Dir = moving ? dir : (o.face ?? dir);
    const sx = Math.round(x - w / 2);
    e.sprite(rows, sx, Math.round(y - h + bob * scale), { flip: e.faceTo(name, facing), scale });
    return { x: Math.round(x), y, frame: f, facing, moving, box: { x: sx, y: y - h, w, h } };
  }

  /**
   * A flag on a pole flying an asset: the pole stands at x on y, the green cloth is the logo plus 8 px with a 1 px
   * light ring round the logo, and the cloth's tail ripples 1 px. It flies the asset's `big` frame (32x32) when it
   * has one, else its `icon` frame, else its first. `up` (0..1) is how far up the pole the cloth is.
   */
  function flag(name: string, o: FlagOpts) {
    const y = Math.round(o.y ?? 148);
    const pole = Math.max(24, Math.round(o.pole ?? 96));
    const x = Math.round(o.x);
    const fr = e.asset(name);
    const logo = has(fr, "big") ? fr!.big : has(fr, "icon") ? fr!.icon : fr ? (Object.values(fr)[0] ?? null) : null;
    const lw = logo?.[0]?.length ?? 16;
    const lh = logo?.length ?? 16;
    const cw = lw + 8;
    const ch = lh + 8;
    // the pole: a lit left column, a shaded right one, a brass ball on top
    const top = y - pole;
    e.rect(x, top, 1, pole, "p");
    e.rect(x + 1, top, 1, pole, "q");
    e.rect(x - 1, top - 3, 4, 3, "B");
    e.rect(x - 1, top - 1, 4, 1, "c");
    const up = Math.min(1, Math.max(0, o.up ?? 1));
    const cy = Math.round(top + 2 + (pole - ch - 4) * (1 - up));
    const cx = x + 2;
    // the cloth: green with a dark rim, its tail (the last 4 columns) rippling 1 px
    for (let i = 0; i < cw; i++) {
      const dy = i >= cw - 4 ? Math.round(Math.sin(o.t * 6 - i * 0.9) * 0.5 + 0.5) : 0;
      const edge = i === cw - 1;
      e.rect(cx + i, cy + dy, 1, ch, edge ? "g" : "G");
      e.rect(cx + i, cy + dy, 1, 1, "T");
      e.rect(cx + i, cy + dy + ch - 1, 1, 1, "g");
    }
    if (logo) e.sprite(logo, cx + 4, cy + 4, { outline: "P" });
    return { x: cx, y: cy, w: cw, h: ch };
  }

  /**
   * n numbered slots in a row from x, y, each w x h: a dark panel with its number in the top-left corner, grey while
   * empty and green once filled. `filled` is a count, or the time each slot fills (each flashes for 0.3 s then).
   * Returns each slot's box so the scene can draw what fills it inside.
   */
  function slots(n: number, o: SlotsOpts): Slot[] {
    const w = Math.round(o.w ?? 48);
    const h = Math.round(o.h ?? 40);
    const gap = Math.round(o.gap ?? 8);
    const times = Array.isArray(o.filled) ? o.filled : null;
    const count = typeof o.filled === "number" ? Math.max(0, Math.floor(o.filled)) : 0;
    const out: Slot[] = [];
    for (let i = 0; i < Math.max(0, Math.floor(n)); i++) {
      const sx = Math.round(o.x + i * (w + gap));
      const sy = Math.round(o.y);
      const on = times ? o.t >= times[i] : i < count;
      e.panel(sx, sy, w, h, { border: on ? "G" : "q", fill: "k", alpha: 0.88 });
      e.text(String(i + 1), sx + 3, sy + 3, { colour: on ? "B" : "q", shadow: false });
      if (times && on) {
        const f = (o.t - times[i]) / 0.3;
        if (f < 1) {
          e.box(sx - 1, sy - 1, w + 2, h + 2, "P");
          e.rect(sx + 1, sy + 1, w - 2, h - 2, "P", 0.5 * (1 - f));
        }
      }
      out.push({ i, x: sx, y: sy, w, h, on });
    }
    return out;
  }

  return {
    walk,
    flag,
    slots,
    /** the sky for TIME over the whole frame: call it first in draw(t), in place of clear() */
    skyGradient: () => drawSky(e, e.TIME),
    /** the sun at x, y (default: high by day, low and big at dusk; nothing at night) */
    sun: (x?: number, y?: number) => drawSun(e, e.TIME, x, y),
    /** slow drifting clouds by day and dusk, at t */
    clouds: (t: number) => drawClouds(e, e.TIME, t),
    /** twinkling stars at night (a few at dusk, none by day), at t */
    stars: (t: number) => drawStars(e, e.TIME, t),
  };
}
export type Kit = ReturnType<typeof createKit>;

/** the engine with the kit on it: what a code bundle imports from "pap:engine" */
export const withKit = <E extends Engine>(e: E) => ({ ...e, ...createKit(e) });
