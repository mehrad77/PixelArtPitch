// Wave 4: small animated effects (decor kind, tagged fx). Particles are always 2+ connected cells, so none is an
// orphan; frames share one centre so they stay registered.
import { asset, Grid, lump, R, sprite } from "./lib.mjs";

const recipe = "w4-fx.mjs";
const wave = "w4-fx";
const fx = (o) =>
  asset({
    kind: "decor",
    wave,
    recipe,
    swapExempt: true,
    loops: [Object.keys(o.frames)],
    ...o,
  });

// ---------- sparkle ----------
function sparkle(arm, { core = "P", near = "H", far = "B", diag = null, corners = false } = {}) {
  const g = new Grid(16, 16);
  const c = 7;
  if (corners) {
    for (const [x, y] of [
      [3, 3],
      [11, 3],
      [3, 11],
      [11, 11],
    ]) {
      g.set(x, y, "H");
      g.set(x + 1, y + 1, "B");
    }
    return g.rows();
  }
  g.set(c, c, core);
  for (let i = 1; i <= arm; i++) {
    const t = i === 1 ? near : far;
    for (const [dx, dy] of [
      [1, 0],
      [-1, 0],
      [0, 1],
      [0, -1],
    ])
      g.set(c + dx * i, c + dy * i, t);
  }
  if (diag)
    for (const [dx, dy] of [
      [1, 1],
      [-1, 1],
      [1, -1],
      [-1, -1],
    ])
      g.set(c + dx, c + dy, diag);
  return g.rows();
}
fx({
  id: "fx-sparkle",
  w: 16,
  h: 16,
  frames: {
    sparkle0: sparkle(1),
    sparkle1: sparkle(3, { diag: "H" }),
    sparkle2: sparkle(5, { near: "P", far: "H", diag: "B" }),
    sparkle3: sparkle(0, { corners: true }),
  },
  tags: ["fx", "sparkle", "shine", "magic", "animated"],
  description:
    "A sparkle burst, 4 frames centred on cell (7,7), no outline: sparkle0 = a small cross glint (P H); sparkle1 = a four-point star with diagonal glints (P H B); sparkle2 = the star at full stretch (P H B); sparkle3 = it breaks into four tiny diagonal glints at the corners (H B). Play once over an item or a reveal.",
});

// ---------- dust puff ----------
const D = ["W", "p", "q", "q"];
function dust(list) {
  const g = new Grid(16, 16);
  for (const l of list) lump(g, ...l, D);
  return g.rows();
}
fx({
  id: "fx-dust",
  w: 16,
  h: 16,
  frames: {
    dust0: dust([
      [6, 13, 2.2, 1.8],
      [9.5, 13, 2.2, 1.8],
      [8, 11.5, 2.2, 2],
    ]),
    dust1: dust([
      [3.5, 12.5, 2.6, 2.2],
      [12.5, 12.5, 2.6, 2.2],
      [6.5, 10.5, 2.8, 2.6],
      [10, 10, 2.6, 2.4],
    ]),
    dust2: dust([
      [2.5, 10.5, 1.8, 1.6],
      [13.5, 10.5, 1.8, 1.6],
      [6, 7.5, 1.8, 1.6],
      [10.5, 6.5, 1.6, 1.5],
    ]),
  },
  tags: ["fx", "dust", "puff", "landing", "animated"],
  description:
    "A dust puff for landings and quick starts, 3 frames sharing the bottom-centre: dust0 = a small pale cloud on the ground (W p q); dust1 = it spreads wider; dust2 = it breaks into small rising wisps. No outline.",
});

// ---------- pop ----------
function ring(r0, r1, inner, outer) {
  const g = new Grid(16, 16);
  for (let y = 0; y < 16; y++)
    for (let x = 0; x < 16; x++) {
      const d = Math.hypot(x + 0.5 - 8, y + 0.5 - 8);
      if (d >= r0 && d < r1) g.set(x, y, x + y < 15 ? inner : outer);
    }
  return g.rows();
}
const rays = R(`
................
.......PH.......
.......HB.......
................
..PH........HP..
..HB........BH..
................
................
.PH..........PH.
.HB..........HB.
................
..PH........HP..
..HB........BH..
................
.......PH.......
.......HB.......
`);
fx({
  id: "fx-pop",
  w: 16,
  h: 16,
  frames: { pop0: ring(0, 3.2, "P", "W"), pop1: ring(3.6, 5.6, "P", "H"), pop2: rays },
  tags: ["fx", "pop", "burst", "impact", "animated"],
  description:
    "A pop, 3 frames centred in the 16x16 frame: pop0 = a small bright disc (P W); pop1 = an expanding ring (P H); pop2 = eight short sparks flying out (P H B). For a bubble bursting, an item appearing or a hit. No outline.",
});

// ---------- confetti (falling loop: every piece moves 4 rows down per frame and wraps) ----------
const PIECES = [
  [1, 0, ["rR"]],
  [6, 2, ["B", "c"]],
  [11, 1, ["TG"]],
  [3, 5, ["Q", "D"]],
  [12, 6, ["VU"]],
  [8, 8, ["rR"]],
  [0, 10, ["B", "c"]],
  [5, 12, ["TG"]],
  [10, 13, ["Q", "D"]],
  [2, 14, ["VU"]],
];
function confetti(f) {
  const g = new Grid(16, 16);
  PIECES.forEach(([x, y, p], i) => {
    // flip each piece between flat and upright as it tumbles
    const rows = (f + i) % 2 ? (p.length === 1 ? [p[0][0], p[0][1]] : [p[0] + p[1]]) : p;
    const yy = (y + f * 4) % 16;
    const xx = x + (f % 2 && i % 3 === 0 ? 1 : 0);
    rows.forEach((row, j) => {
      [...row].forEach((c, k) => {
        g.set((xx + k) % 16, (yy + j) % 16, c);
      });
    });
  });
  return g.rows();
}
fx({
  id: "fx-confetti",
  w: 16,
  h: 16,
  frames: { confetti0: confetti(0), confetti1: confetti(1), confetti2: confetti(2), confetti3: confetti(3) },
  tags: ["fx", "confetti", "party", "celebrate", "animated"],
  description:
    "Falling confetti, a seamless 4-frame loop: ten 2-cell paper bits (r R, B c, T G, Q D, V U) drop 4 rows a frame and tumble between flat and upright; pieces wrap from the bottom back to the top, so the loop never runs dry. No outline.",
});

// ---------- heart burst ----------
const BIG_HEART = ["rr.rR", "rrrRR", ".rRR.", "..R.."];
const SMALL_HEART = ["r.R", "rRR", ".R."];
function hearts(list) {
  const g = new Grid(16, 16);
  for (const [x, y, big] of list) g.overlay(big ? BIG_HEART : SMALL_HEART, x, y);
  return g.rows();
}
fx({
  id: "fx-hearts",
  w: 16,
  h: 16,
  frames: {
    hearts0: hearts([[5, 10, true]]),
    hearts1: hearts([
      [5, 6, true],
      [1, 10, false],
      [11, 9, false],
    ]),
    hearts2: hearts([
      [6, 1, true],
      [0, 5, false],
      [12, 4, false],
      [3, 12, false],
      [11, 12, false],
    ]),
  },
  tags: ["fx", "heart", "love", "like", "animated"],
  description:
    "A heart burst, 3 frames: hearts0 = one red heart (r R) low in the middle; hearts1 = it rises as two small hearts pop out to the sides; hearts2 = the big heart near the top, four small hearts scattered. Play once for a like or affection. No outline.",
});

// ---------- zzz ----------
const Z6 = ["PPPPPp", "....P.", "...P..", "..P...", ".P....", "Pppppp"];
const Z4 = ["PPPp", "..P.", ".P..", "Pppp"];
const Z5 = ["PPPPp", "...P.", "..P..", ".P...", "Ppppp"];
function zzz(list) {
  const g = new Grid(16, 16);
  for (const [x, y, z] of list) g.overlay(z, x, y);
  return g.rows();
}
fx({
  id: "fx-zzz",
  w: 16,
  h: 16,
  frames: {
    zzz0: zzz([[0, 12, Z4]]),
    zzz1: zzz([
      [0, 12, Z4],
      [4, 6, Z5],
    ]),
    zzz2: zzz([
      [0, 12, Z4],
      [4, 6, Z5],
      [10, 0, Z6],
    ]),
  },
  tags: ["fx", "sleep", "zzz", "tired", "animated"],
  description:
    "Sleep letters rising to the upper right, 3 frames: zzz0 = one small z (P p) at the lower left; zzz1 = a medium z joins above; zzz2 = a large z at the top right. Place above a sleeping head. No outline.",
});

// ---------- marks ----------
const exclaim = sprite(
  `
.HHB.
HBBBc
HBBBc
HBBBc
.HBc.
.HBc.
.HBc.
..c..
.....
.HB..
.Bcc.
`,
  16,
  16,
  { anchor: "center" },
);
const question = sprite(
  `
..QLLL..
.QLLLLD.
QLD..LLD
.....LLD
....QLD.
...QLD..
...LLD..
...DD...
........
...QL...
...LD...
`,
  16,
  16,
  { anchor: "center" },
);
asset({
  id: "fx-marks",
  kind: "decor",
  w: 16,
  h: 16,
  wave,
  recipe,
  frames: { exclaim, question },
  tags: ["fx", "exclamation", "question", "alert", "emote"],
  description:
    "Emote marks to pop over a head, centred, 1 px k outline, light from the upper left: exclaim = a bold brass exclamation mark (H B c), for surprise or alert; question = a light blue question mark (Q L D), for confusion. Symbols only, not text.",
});

// ---------- smoke (rising loop: puffs move up 4 rows a frame, growing and greying, and wrap) ----------
function smoke(f) {
  const g = new Grid(16, 16);
  const tones = [
    ["P", "W", "p", "q"],
    ["W", "p", "q", "q"],
    ["p", "q", "q", "e"],
    ["q", "q", "e", "e"],
  ];
  // puffs 4 rows apart rise 1 row per frame, so after 4 frames each puff stands where the next one was: a seamless loop
  for (let i = 3; i >= 0; i--) {
    const s01 = (i * 4 + f) / 16;
    const y = 13.5 - s01 * 11;
    const r = s01 > 0.85 ? 1.7 : 2.2 + Math.sin(Math.PI * s01) * 1.8; // the last puff thins before it leaves, so the wrap does not pop
    const x = 8 + Math.sin(s01 * 7) * 1.5;
    lump(g, x, y, r, r * 0.85, tones[Math.min(3, Math.floor(s01 * 4))]);
  }
  return g.rows();
}
fx({
  id: "fx-smoke",
  w: 16,
  h: 16,
  frames: { smoke0: smoke(0), smoke1: smoke(1), smoke2: smoke(2), smoke3: smoke(3) },
  tags: ["fx", "smoke", "chimney", "fire", "animated"],
  description:
    "A rising smoke column, 4-frame loop over the bottom-centre: round puffs climb, swell then thin out, and darken from pale (P W p) to grey (q e) as they rise. Put it on a chimney or a campfire. No outline.",
});

// ---------- speed lines (32x16) ----------
function speed(f) {
  const g = new Grid(32, 16);
  const lines = [
    [2, 2, 12, "P"],
    [10, 4, 16, "p"],
    [0, 7, 18, "P"],
    [6, 9, 10, "q"],
    [12, 11, 14, "p"],
    [3, 13, 9, "P"],
  ];
  lines.forEach(([x, y, len, c], i) => {
    const off = f ? (i % 2 ? 3 : -2) : 0;
    for (let k = 0; k < len; k++) {
      const xx = x + off + k;
      if (xx < 0 || xx >= 32) continue;
      // bright head on the right, fading tail on the left
      g.set(xx, y, k > len - 4 ? c : k > len / 2 ? (c === "P" ? "p" : "q") : "q");
    }
  });
  return g.rows();
}
fx({
  id: "fx-speed",
  w: 32,
  h: 16,
  frames: { speed0: speed(0), speed1: speed(1) },
  tags: ["fx", "speed", "motion", "dash", "animated"],
  description:
    "Speed lines for a dash to the right, 2-frame flicker: six horizontal streaks with bright heads on the right (P p) fading to grey tails (q) on the left; speed1 shifts alternate streaks so they shimmer. Place behind a moving figure; flip for leftward motion. No outline.",
});
