// The closed vocabulary of declarative scenes: every layer kind, widget, fx and behaviour with its props, types,
// defaults and ranges, plus the eases and the few scene constants. Pure data and tiny pure functions: decl.ts (which
// also runs inside the render sandbox) and recipes.ts import it at runtime, so it must never import zod.

/** feet line of the ground tiles; the caption box sits below CAPTION_TOP */
export const GROUND = 148;
export const CAPTION_TOP = 146;
export const SCREEN_W = 320;
export const SCREEN_H = 180;

/** the SFX names a scene may emit; kept equal to SfxType in @pap/schema (a test checks it) */
export const SFX_TYPES = [
  "select",
  "confirm",
  "whoosh",
  "coin",
  "jump",
  "bump",
  "sign",
  "pipe",
  "land",
  "fall",
  "join",
  "powerup",
  "cheer",
  "block",
  "fanfare-short",
  "achieve",
  "quest",
  "flag",
  "alarm",
  "brick",
  "flagpole",
  "fanfare",
  "start",
] as const;
export type SfxName = (typeof SFX_TYPES)[number];

// ---- eases ----
export const EASES = ["linear", "in", "out", "inOut", "outCubic", "backOut", "step"] as const;
export type EaseName = (typeof EASES)[number];
const c01 = (p: number) => (p < 0 ? 0 : p > 1 ? 1 : p);
export function easeFn(name: string | undefined, p: number): number {
  p = c01(p);
  switch (name) {
    case "in":
      return p * p;
    case "out":
      return 1 - (1 - p) * (1 - p);
    case "inOut":
      return p < 0.5 ? 2 * p * p : 1 - (-2 * p + 2) ** 2 / 2;
    case "outCubic":
      return 1 - (1 - p) ** 3;
    case "backOut": {
      const c1 = 1.70158;
      const q = p - 1;
      return 1 + (c1 + 1) * q * q * q + c1 * q * q;
    }
    case "step":
      return p < 1 ? 0 : 1;
    default:
      return p;
  }
}

// ---- prop specs ----
export type PType =
  | "num"
  | "int"
  | "str"
  | "bool"
  | "colour"
  | "time"
  | "times"
  | "enum"
  | "strs"
  | "list"
  | "obj"
  | "sfx";
export type PSpec = {
  t: PType;
  /** default; undefined with req=false means "absent" */
  d?: unknown;
  req?: boolean;
  min?: number;
  max?: number;
  of?: readonly string[];
  doc: string;
};
export type Spec = Record<string, PSpec>;

const num = (d: number, doc: string, min?: number, max?: number): PSpec => ({ t: "num", d, doc, min, max });
const int = (d: number, doc: string, min?: number, max?: number): PSpec => ({ t: "int", d, doc, min, max });
const str = (d: string, doc: string): PSpec => ({ t: "str", d, doc });
const bool = (d: boolean, doc: string): PSpec => ({ t: "bool", d, doc });
const colour = (d: string | null, doc: string): PSpec => ({ t: "colour", d, doc });
const en = (of: readonly string[], d: string, doc: string): PSpec => ({ t: "enum", of, d, doc });
const time = (doc: string, req = false): PSpec => ({ t: "time", doc, req });
const sfx = (d: string | null, doc: string): PSpec => ({ t: "sfx", d, doc });

const X = num(0, "x in pixels", -2000, 4000);
const Y = num(0, "y in pixels", -400, 400);
const ALPHA = num(1, "opacity 0..1", 0, 1);

/** layer kinds a scene may use ("code" is for code bundles, not decl scenes) */
export const DECL_KINDS = [
  "backdrop",
  "tiled",
  "sprite",
  "actor",
  "text",
  "panel",
  "group",
  "shape",
  "fx",
  "widget",
] as const;

export const KIND_SPECS: Record<string, Spec> = {
  backdrop: {
    style: en(["night", "plain"], "night", "night: sky band, stars, moon and skyline; plain: flat sky colour"),
    sky: colour(null, "sky colour (default: the palette sky)"),
    band: bool(true, "a soft lighter band near the horizon"),
    stars: int(70, "number of twinkling stars", 0, 200),
    moon: bool(true, "draw the moon asset"),
    moonX: num(262, "moon x", -40, 340),
    moonY: num(18, "moon y", -40, 120),
    skyline: bool(true, "draw the two parallax skyline rows"),
  },
  tiled: {
    asset: str("tiles", "tile asset"),
    frame: str("ground-top", "frame for the top row"),
    fill: str("ground", 'frame repeated below the top row to the bottom of the screen ("" for none)'),
    y: num(GROUND, "top of the tile row", -200, 400),
    tile: int(16, "tile width in pixels", 4, 64),
    fromX: num(-100000, "world x where the row starts", -100000, 100000),
    toX: num(100000, "world x where the row ends", -100000, 100000),
    gaps: { t: "list", d: [], doc: "[[fromX, toX], ...] world ranges left empty" },
  },
  sprite: {
    asset: { t: "str", req: true, doc: "asset id from the project's assets" },
    frame: str("", "frame name (default: the first frame)"),
    frames: { t: "strs", d: [], doc: "frames to cycle through instead of one frame" },
    fps: num(4, "cycle rate for frames", 0.1, 30),
    x: X,
    y: Y,
    anchor: en(["topLeft", "bottom", "center"], "topLeft", "what x,y refers to: top-left, bottom-centre or centre"),
    flip: bool(false, "mirror horizontally"),
    outline: colour(null, "1 px outline colour"),
    alpha: ALPHA,
    scale: int(1, "whole-pixel scale", 1, 4),
    colour: colour(null, "paint every cell this colour (silhouettes)"),
  },
  actor: {
    asset: { t: "str", req: true, doc: "character asset id (16x24)" },
    x: num(160, "centre x of the feet", -2000, 4000),
    y: num(GROUND, "feet y (the ground is 148)", -400, 400),
    facing: en(["right", "left"], "right", "which way the actor looks when standing"),
    artFaces: en(["right", "left"], "left", "which way the art itself looks (library characters look left)"),
    runFps: num(10, "run cycle frames per second", 1, 24),
    idleFps: num(2.5, "idle breathing frames per second", 0.5, 12),
    dust: bool(true, "footstep puffs while walking and dust on landing"),
    outline: colour(null, "1 px outline colour"),
    frames: { t: "obj", d: {}, doc: '{ idle?: [..], run?: [..], jump?: "..", wave?: ".." } frame names' },
  },
  text: {
    text: { t: "str", req: true, doc: "the words (upper case reads best)" },
    x: num(160, "x (see align)", -400, 800),
    y: num(40, "top y", -100, 300),
    align: en(["left", "center", "right"], "center", "alignment around x"),
    scale: int(1, "glyph scale", 1, 4),
    fit: bool(false, "shrink the scale until the text fits 304 px"),
    colour: colour("P", "text colour"),
    shadow: bool(true, "1 px dark drop shadow"),
    alpha: ALPHA,
    maxW: int(0, "wrap at this pixel width (0: no wrap)", 0, 320),
    lineH: int(10, "line height for wrapped text (x scale)", 6, 30),
  },
  panel: {
    x: X,
    y: Y,
    w: { t: "int", req: true, min: 2, max: 320, doc: "width" },
    h: { t: "int", req: true, min: 2, max: 180, doc: "height" },
    border: colour("G", "border colour"),
    fill: colour("k", "fill colour"),
    alpha: num(0.88, "fill opacity", 0, 1),
  },
  group: { x: X, y: Y, alpha: ALPHA },
  shape: {
    shape: en(["rect", "box", "disc", "line"], "rect", "rect: filled; box: 1 px frame; disc: filled circle; line"),
    x: X,
    y: Y,
    w: int(1, "width", 1, 640),
    h: int(1, "height", 1, 360),
    r: int(4, "disc radius", 1, 90),
    x2: num(0, "line end x", -2000, 4000),
    y2: num(0, "line end y", -400, 400),
    colour: colour("P", "colour"),
    alpha: ALPHA,
  },
  fx: {
    fx: {
      t: "enum",
      req: true,
      of: ["sparkle", "dust", "ring", "twinkle", "flash", "fireworks", "shootingStar"],
      doc: "effect",
    },
    x: num(160, "centre x", -2000, 4000),
    y: num(60, "centre y", -400, 400),
    at: time("when a one-shot effect starts (default: the scene start)"),
    every: num(0, "repeat every N seconds (0: once)", 0, 30),
    colour: colour("B", "main colour"),
    n: int(10, "count (fireworks bursts, twinkle stars, dust puffs)", 1, 60),
    size: num(18, "radius or spread in pixels", 1, 160),
    dur: num(0.5, "duration of one burst", 0.05, 5),
    w: int(288, "area width for fireworks/twinkle", 1, 320),
    h: int(60, "area height for fireworks/twinkle", 1, 180),
  },
  widget: {
    widget: {
      t: "enum",
      req: true,
      of: ["banner", "toast", "nameTag", "hudSlots", "qblock", "counter", "flagpole"],
      doc: "which widget",
    },
  },
};

export const WIDGET_SPECS: Record<string, Spec> = {
  banner: {
    text: { t: "str", req: true, doc: "1-3 words" },
    at: time("when it slides in", true),
    dur: num(1.7, "seconds on screen", 0.5, 10),
    colour: colour("O", "border and flash colour"),
    y: num(34, "top y", 0, 120),
    scale: int(2, "text scale", 1, 3),
    sfx: sfx("achieve", "sound when it lands"),
  },
  toast: {
    title: { t: "str", req: true, doc: "short title, about 16 characters" },
    sub: str("", "second line, about 20 characters"),
    iconAsset: str("items", "icon asset"),
    icon: str("star", "icon frame"),
    at: time("when it slides in", true),
    dur: num(2.4, "seconds on screen", 0.8, 10),
    y: num(118, "top y (keep the bottom above 146)", 0, 124),
    w: int(150, "width", 60, 316),
    colour: colour("B", "border and title colour"),
    sfx: sfx("achieve", "sound when it slides in"),
  },
  nameTag: {
    label: { t: "str", req: true, doc: "a name, 1-2 words" },
    x: num(160, "centre x of the tag", -2000, 4000),
    y: num(100, "top y", -400, 400),
    colour: colour("T", "border colour"),
  },
  hudSlots: {
    x: num(4, "left", 0, 316),
    y: num(4, "top", 0, 176),
    slots: int(4, "number of slots", 1, 8),
    items: { t: "list", d: [], doc: "[{ asset, frame, at }] an item shows in slot i from its at" },
    colour: colour("G", "panel border"),
    check: bool(true, "flash and tick when an item lands"),
  },
  qblock: {
    asset: str("qblock", "block asset (frames normal, glow, used)"),
    x: X,
    y: num(78, "top y", -400, 400),
    hit: time("when it is bumped (default: never)"),
    bump: int(6, "bump height in pixels", 0, 16),
    sfx: sfx("bump", "sound on the hit"),
  },
  counter: {
    label: str("", "text before the number"),
    from: int(0, "start value", -1e9, 1e9),
    to: { t: "int", req: true, min: -1e9, max: 1e9, doc: "end value" },
    at: time("when counting starts", true),
    dur: num(1, "counting time", 0.05, 10),
    x: num(160, "x (see align)", -400, 800),
    y: num(40, "top y", -100, 300),
    align: en(["left", "center", "right"], "center", "alignment"),
    scale: int(1, "scale", 1, 3),
    pad: int(0, "zero-pad to this many digits", 0, 9),
    colour: colour("B", "colour"),
    sfx: sfx("coin", "sound when it reaches the end value"),
  },
  flagpole: {
    x: num(240, "pole x (left edge)", -2000, 4000),
    y: num(GROUND, "foot of the pole", -400, 400),
    height: int(96, "pole height", 32, 140),
    asset: str("props", "asset with the flag frames"),
    frames: { t: "strs", d: ["flag0", "flag1"], doc: "flag frames that wave" },
    raise: time("when the flag starts to climb (default: already at the top)"),
    dur: num(1.6, "climb time", 0.2, 6),
    sfx: bool(true, "flagpole, flag and fanfare sounds"),
  },
};

/** behaviour params; `at` and `until` live on the behaviour itself */
export const BEHAVIOR_SPECS: Record<string, { needsAt: boolean; doc: string; params: Spec }> = {
  walk: {
    needsAt: true,
    doc: "walk along x to `to` at `speed` px/s, slowing over the last `decel` seconds; actors play their run cycle",
    params: {
      to: { t: "num", req: true, min: -2000, max: 4000, doc: "x to stop at" },
      speed: num(30, "pixels per second", 4, 200),
      decel: num(0.3, "seconds of slowing down at the end", 0, 2),
    },
  },
  jumpArc: {
    needsAt: true,
    doc: "a parabolic jump; actors show their jump frame, squash and kick up dust on landing",
    params: {
      height: num(30, "peak height in pixels", 2, 120),
      dur: num(0.6, "seconds in the air", 0.15, 3),
      dx: num(0, "horizontal travel", -300, 300),
      squash: bool(true, "squash on landing"),
      sfx: bool(true, "jump and land sounds"),
    },
  },
  arc: {
    needsAt: true,
    doc: "fly from the current position to (toX, toY) on an arc, with a sparkle trail",
    params: {
      toX: { t: "num", req: true, min: -2000, max: 4000, doc: "target x" },
      toY: { t: "num", req: true, min: -400, max: 400, doc: "target y" },
      screen: bool(false, "the target is in screen pixels (a HUD slot) even for a world layer"),
      dur: num(0.5, "flight time", 0.1, 4),
      lift: num(20, "how high the arc bows", -120, 120),
      trail: bool(true, "sparkle trail"),
      hide: bool(false, "vanish on arrival"),
      sfx: sfx("coin", "sound on arrival"),
    },
  },
  bob: {
    needsAt: false,
    doc: "float up and down",
    params: {
      amp: num(1, "pixels", 0, 20),
      period: num(1.6, "seconds per cycle", 0.1, 20),
      phase: num(0, "offset in cycles", 0, 1),
      hop: bool(false, "only upward hops (|sin|), like a floating pickup"),
    },
  },
  blink: {
    needsAt: false,
    doc: "switch on and off",
    params: {
      rate: num(2.5, "cycles per second", 0.1, 30),
      duty: num(0.5, "share of a cycle it is visible", 0.05, 0.95),
    },
  },
  pulse: {
    needsAt: false,
    doc: "fade softly between `min` and full opacity",
    params: { min: num(0.6, "lowest opacity", 0, 1), period: num(1.6, "seconds per cycle", 0.1, 20) },
  },
  shake: {
    needsAt: true,
    doc: "jitter this layer (the camera has its own shakes)",
    params: { amp: num(2, "pixels", 0, 12), dur: num(0.25, "seconds", 0.02, 3) },
  },
  squash: {
    needsAt: true,
    doc: "squash a sprite or actor for a moment (an impact)",
    params: { dur: num(0.12, "seconds", 0.02, 1) },
  },
  appear: {
    needsAt: true,
    doc: "hidden before `at`, then comes in",
    params: {
      style: en(["fade", "pop", "drop", "slideLeft", "slideRight", "slideUp", "slideDown", "none"], "fade", "entrance"),
      dur: num(0.2, "seconds", 0, 3),
      dist: num(40, "pixels travelled by drop and slides", 0, 400),
      sfx: sfx(null, "sound when it appears"),
    },
  },
  disappear: {
    needsAt: true,
    doc: "fades away from `at`, hidden after",
    params: { style: en(["fade", "none"], "fade", "exit"), dur: num(0.2, "seconds", 0, 3), sfx: sfx(null, "sound") },
  },
  attach: {
    needsAt: false,
    doc: "follow another layer's position (name tags, carried items)",
    params: {
      to: { t: "str", req: true, doc: "layer id to follow" },
      dx: num(0, "offset x", -400, 400),
      dy: num(0, "offset y", -400, 400),
    },
  },
  dissolve: {
    needsAt: true,
    doc: "pixel dissolve in or out",
    params: {
      dir: en(["in", "out"], "in", "in: pixels arrive; out: pixels leave"),
      dur: num(0.5, "seconds", 0.05, 5),
      block: int(1, "dissolve block size in pixels", 1, 10),
    },
  },
  dust: {
    needsAt: true,
    doc: "small dust puffs at the layer's feet",
    params: {
      every: num(0, "repeat every N seconds until `until` (0: once)", 0, 10),
      n: int(3, "specks per side", 1, 10),
      spread: num(0.7, "how far they fly", 0.1, 3),
      dx: num(0, "offset x", -100, 100),
      colour: colour("q", "speck colour"),
    },
  },
  sparkle: {
    needsAt: true,
    doc: "a ring of sparkles around the layer",
    params: {
      colour: colour("B", "colour"),
      every: num(0, "repeat every N seconds until `until` (0: once)", 0, 10),
      dx: num(0, "offset x from the layer's centre", -200, 200),
      dy: num(0, "offset y from the layer's centre", -200, 200),
      size: num(18, "how far the ring grows", 4, 80),
    },
  },
};

/** props a key may animate, per kind (x/y for every kind that has them) */
export const KEYABLE: Record<string, Record<string, "num" | "str" | "bool">> = {
  common: { x: "num", y: "num", alpha: "num", visible: "bool" },
  sprite: { frame: "str", scale: "num" },
  actor: { state: "str", facing: "str" },
  text: { text: "str", colour: "str", scale: "num" },
  shape: { w: "num", h: "num", colour: "str" },
  panel: { w: "num", h: "num" },
};
export const ACTOR_STATES = ["auto", "idle", "run", "jump", "wave"] as const;

/** where HUD slot i sits for a hudSlots widget at (x, y) */
export const hudSlot = (x: number, y: number, i: number): [number, number] => [x + 3 + i * 15, y + 3];
export const hudWidth = (slots: number) => 6 + slots * 15;

/** a walk from `start` to `to`: full speed, then slowing to a stop over `decel` seconds */
export function walkPlan(start: number, p: { to: number; speed: number; decel: number }) {
  const D = Math.abs(p.to - start);
  const v = p.speed;
  let dc = p.decel;
  let lin = D / v - dc / 2;
  if (lin < 0) {
    dc = (2 * D) / v;
    lin = 0;
  }
  return { D, v, dc, lin, dur: lin + dc, dir: p.to >= start ? 1 : -1 };
}
