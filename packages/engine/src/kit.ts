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

  return { walk, flag, slots };
}
export type Kit = ReturnType<typeof createKit>;

/** the engine with the kit on it: what a code bundle imports from "pap:engine" */
export const withKit = <E extends Engine>(e: E) => ({ ...e, ...createKit(e) });
