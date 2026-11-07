// Wave 1d: plants. Trees are 24x32 props; bushes, flowers and grass are 16x16 props. Canopies are built from shaded
// lumps (light from the upper left), then a k outline.
import { asset, fit, Grid, lump, ol, polygon, R, rect } from "./lib.mjs";

const recipe = "w1-plants.mjs";
const wave = "w1-plants";
const LEAF = ["T", "G", "g", "g"];

// ---------- trees ----------
function treeRound() {
  const g = new Grid(24, 32);
  // trunk: lit left column, shaded right
  rect(g, 10, 18, 13, 30, "c");
  for (let y = 18; y <= 30; y++) {
    g.set(10, y, "s");
    g.set(13, y, "n");
  }
  g.set(9, 30, "c");
  g.set(14, 30, "n");
  g.set(12, 22, "n");
  g.set(12, 23, "n");
  // canopy lumps, back to front
  for (const l of [
    [16, 12, 6, 5.5],
    [7, 13, 5.5, 5],
    [12, 16, 7, 4],
    [10, 8, 6, 5.5],
    [15, 7, 4.5, 4],
  ])
    lump(g, ...l, LEAF);
  return ol(g.rows());
}
function treePine() {
  const g = new Grid(24, 32);
  rect(g, 11, 26, 12, 30, "c");
  for (let y = 26; y <= 30; y++) g.set(12, y, "n");
  // three tiers, each a triangle, lit on the left half, dark on the right edge
  const tiers = [
    [2, 11, 5],
    [8, 19, 7],
    [14, 27, 10],
  ];
  for (const [top, bottom, half] of tiers) {
    polygon(
      g,
      [
        [12, top],
        [12 + half, bottom],
        [12 - half, bottom],
      ],
      (x, y) => {
        const rel = (x + 0.5 - 12) / half;
        if (y === bottom - 1) return rel > 0 ? "g" : "G";
        if (rel < -0.25) return "T";
        if (rel > 0.4) return "g";
        return "G";
      },
    );
  }
  return ol(g.rows());
}
function treePalm() {
  const g = new Grid(24, 32);
  // a gently curved trunk, ringed
  const trunk = [
    [9, 30],
    [9, 29],
    [9, 28],
    [10, 27],
    [10, 26],
    [10, 25],
    [10, 24],
    [11, 23],
    [11, 22],
    [11, 21],
    [11, 20],
    [12, 19],
    [12, 18],
    [12, 17],
    [12, 16],
    [12, 15],
    [12, 14],
    [12, 13],
    [12, 12],
  ];
  trunk.forEach(([x, y], i) => {
    g.set(x, y, i % 3 === 0 ? "n" : "s");
    g.set(x + 1, y, i % 3 === 0 ? "n" : "c");
  });
  g.set(8, 30, "s");
  g.set(11, 30, "n");
  // the crown: hand-placed drooping fronds (T lit tops, G body, g undersides) round two coconuts (n A)
  g.overlay(
    R(`
    ..........TT............
    ...TTT...TGGT...TTT.....
    .TTGGGGTTGGGGTTGGGGGT...
    TGGGGGGGGGGGGGGGGGGGGGT.
    TGGgg.ggGGGGGGgg.ggGGGGg
    TGg....gGGcnGGGg....ggGg
    Gg....TGg.nA.gGGg.....gg
    Gg....Gg......gGg.....g.
    g....TGg.......gGg......
    .....Gg.........gg......
    .....g...........g......
    `),
    0,
    2,
  );
  return ol(g.rows());
}
asset({
  id: "trees",
  kind: "prop",
  w: 24,
  h: 32,
  wave,
  recipe,
  frames: { "tree-round": treeRound(), "tree-pine": treePine(), "tree-palm": treePalm() },
  tags: ["tree", "plant", "nature", "forest", "park"],
  description:
    "Three trees standing on the bottom row, 1 px k outline, light from the upper left. tree-round = a leafy round canopy of clumps (T G g) on a brown trunk (s c n); tree-pine = a three-tier conifer (T G g) on a short trunk (c n); tree-palm = a palm with a curved ringed trunk (s c n) and drooping fronds (T G g), dark coconuts (n A).",
});

// ---------- small plants (16x16) ----------
function bush(berries) {
  const g = new Grid(16, 16);
  for (const l of [
    [5, 11, 4.5, 4],
    [11, 11.5, 4.5, 3.5],
    [8, 8.5, 4.5, 4],
  ])
    lump(g, ...l, LEAF, { cut: (_x, y) => y <= 14 });
  if (berries)
    for (const [x, y] of [
      [5, 9],
      [9, 7],
      [11, 11],
      [6, 12],
    ]) {
      g.set(x, y, "r");
      g.set(x + 1, y, "R");
      g.set(x, y + 1, "R");
    }
  return ol(g.rows());
}
const flower = (head) =>
  fit(
    ol(
      R(`
${head}
......G..
....G.G.T
....TGGG.
.....gG..
......G..
`),
    ),
    16,
    16,
    { anchor: "bottom" },
  );
const tulip = flower(`
.....r.r.
....rrRr.
....rrRR.
....rRRR.
.....RR..`);
const daisy = flower(`
.....P...
....PPP..
...PPBPp.
....pPp..
.....p...`);
const bell = flower(`
....VVV..
...VVVUU.
...VVUUU.
...V.U.U.
.........`);
const grass = fit(
  ol(
    R(`
...T.......T..
...T..T....G..
..TG..G..T.G..
..G..TG..G.Gg.
.TG..Gg.TG.g..
.Gg.TG..Gg.Gg.
GGg.Gg.gGgGgg.
`),
  ),
  16,
  16,
  { anchor: "bottom" },
);
asset({
  id: "plants-small",
  kind: "prop",
  w: 16,
  h: 16,
  wave,
  recipe,
  frames: {
    "bush-round": bush(false),
    "bush-berry": bush(true),
    "flower-tulip": tulip,
    "flower-daisy": daisy,
    "flower-bell": bell,
    "grass-blades": grass,
  },
  tags: ["plant", "bush", "flower", "grass", "garden"],
  description:
    "Small ground plants standing on the bottom row, 1 px k outline. bush-round = a clumpy green bush (T G g); bush-berry = the same bush with red berries (r R); flower-tulip = a red tulip (r R) on a stem with leaves (T G g); flower-daisy = a white daisy (P p) with a brass centre (B); flower-bell = a violet bellflower (V U); grass-blades = a clump of long grass blades (T G g).",
});
