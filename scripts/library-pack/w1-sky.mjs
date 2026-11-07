// Wave 1c: sky bands, clouds and stars.
import { asset, Grid, lump, ol } from "./lib.mjs";

const recipe = "w1-sky.mjs";
const wave = "w1-sky";

// ---------- sky-bands (backdrop 96x40, tileable sideways) ----------
// each boundary steps by one row along a 32-wide pattern (32 divides 96, so the strip joins)
const STEP = [...Array(13).fill(0), ...Array(11).fill(1), ...Array(8).fill(0)];
function bands(list, { stars = [] } = {}) {
  const g = new Grid(96, 40);
  let y0 = 0;
  const bounds = [];
  for (const [, h] of list) {
    bounds.push(y0);
    y0 += h;
  }
  for (let x = 0; x < 96; x++)
    for (let y = 0; y < 40; y++) {
      // which band: the boundary b sits at bounds[b] - STEP (shifted per band so the steps don't stack)
      let band = 0;
      for (let b = 1; b < list.length; b++) {
        const lift = STEP[(x + b * 13) % 32];
        if (y >= bounds[b] - lift) band = b;
      }
      g.set(x, y, list[band][0]);
    }
  // bright stars are a small cross, dim ones a diagonal pair
  for (const [x, y, c] of stars) {
    g.set(x, y, c);
    if (c === "P")
      for (const [dx, dy] of [
        [1, 0],
        [-1, 0],
        [0, 1],
        [0, -1],
      ])
        g.set(x + dx, y + dy, "q");
    else g.set(x + 1, y + 1, "q");
  }
  return g.rows();
}
const starList = [
  [5, 3, "P"],
  [21, 7, "p"],
  [38, 2, "p"],
  [52, 9, "P"],
  [67, 4, "p"],
  [83, 11, "p"],
  [90, 2, "P"],
  [30, 14, "q"],
  [74, 16, "q"],
];
asset({
  id: "sky-bands",
  kind: "backdrop",
  w: 96,
  h: 40,
  wave,
  recipe,
  frames: {
    dusk: bands([
      ["N", 7],
      ["I", 7],
      ["U", 7],
      ["R", 7],
      ["z", 6],
      ["s", 6],
    ]),
    night: bands(
      [
        ["K", 8],
        ["f", 8],
        ["N", 9],
        ["I", 8],
        ["d", 7],
      ],
      { stars: starList },
    ),
    dawn: bands([
      ["I", 6],
      ["D", 7],
      ["L", 7],
      ["Q", 7],
      ["M", 7],
      ["S", 6],
    ]),
  },
  tile: "lr",
  tags: ["sky", "gradient", "dusk", "dawn", "backdrop"],
  description:
    "Full-width sky gradient strips in flat stepped bands (no dithering), tileable left-right, opaque. dusk = navy to violet to wine to a warm horizon (N I U R z s); night = ink to navy to denim with a few small stars, bright crosses and dim diagonal pairs (K f N I d, P p q); dawn = indigo through blue to mint and a peach horizon (I D L Q M S). Place behind everything; the horizon is the bottom row.",
});

// ---------- clouds (decor 32x16, three sizes, flat bottoms) ----------
const CT = ["P", "W", "w", "p"];
function cloud(lumps, bottom) {
  const g = new Grid(32, 16);
  for (const [cx, cy, rx, ry] of lumps) lump(g, cx, cy, rx, ry, CT, { cut: (_x, y) => y <= bottom });
  // flat underside in the darker tone
  for (let x = 0; x < 32; x++) if (g.get(x, bottom) !== ".") g.set(x, bottom, "q");
  return ol(g.rows());
}
asset({
  id: "clouds",
  kind: "decor",
  w: 32,
  h: 16,
  wave,
  recipe,
  frames: {
    "cloud-s": cloud(
      [
        [12, 11, 4, 3],
        [16.5, 9.5, 4, 4],
        [20.5, 11.5, 3.5, 2.5],
      ],
      12,
    ),
    "cloud-m": cloud(
      [
        [8, 11.5, 4.5, 3],
        [13.5, 8.5, 5, 5],
        [19.5, 9.5, 4.5, 4],
        [24, 12, 4, 2.5],
      ],
      13,
    ),
    "cloud-l": cloud(
      [
        [5.5, 12, 4, 2.5],
        [10, 9, 5, 5],
        [16, 6.5, 5.5, 5.5],
        [22, 8.5, 5, 4.5],
        [27, 11.5, 3.5, 3],
      ],
      14,
    ),
  },
  tags: ["sky", "cloud", "weather", "night", "decor"],
  description:
    "Lumpy grey night clouds in three sizes (small, medium, large), flat-bottomed, with a 1 px k outline, a pale top-left (P W) and a grey underside (w p q). Each sits on the bottom rows of its 32x16 frame, transparent around.",
});

// ---------- stars (decor 16x16, 2-frame twinkle) ----------
function star(arm, core, inner, outer, diag = null) {
  const g = new Grid(16, 16);
  const c = 7;
  g.set(c, c, core);
  for (let i = 1; i <= arm; i++) {
    const t = i === 1 ? inner : outer;
    g.set(c + i, c, t);
    g.set(c - i, c, t);
    g.set(c, c + i, t);
    g.set(c, c - i, t);
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
asset({
  id: "stars",
  kind: "decor",
  w: 16,
  h: 16,
  wave,
  recipe,
  frames: {
    big0: star(2, "P", "H", "B"),
    big1: star(4, "P", "P", "H", "B"),
    small0: star(1, "p", "q", "q"),
    small1: star(1, "P", "H", "H"),
  },
  loops: [
    ["big0", "big1"],
    ["small0", "small1"],
  ],
  swapExempt: true,
  tags: ["sky", "star", "twinkle", "night", "decor"],
  description:
    "Twinkling stars, centred on cell (7,7) in every frame so the loops stay registered. big0 / big1 = a brass cross star (P H B) that stretches its arms and adds diagonal glints on the twinkle; small0 / small1 = a small grey cross star (p q) that brightens (P H). No outline.",
});
