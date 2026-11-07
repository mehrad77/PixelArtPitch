// Wave 1a: ground sets (grass, dirt, stone, sand, snow).
import { solid, stamps, surface } from "./ground.mjs";
import { asset, fit, R } from "./lib.mjs";

const recipe = "w1-ground.mjs";
const wave = "w1-ground";

// ---------- soil (shared by grass and dirt) ----------
const soilFlecks = [
  [1, 3, ["cc"]],
  [9, 1, ["ccc"]],
  [12, 6, ["cc"]],
  [4, 9, ["ccc"]],
  [10, 12, ["cc"]],
  [0, 14, ["cc"]],
  [6, 14, ["AA"]],
  [14, 9, ["AA"]],
  [3, 5, ["A"]],
  [7, 6, ["pq", "qe"]],
  [13, 13, ["pq", "qe"]],
];
const soil = () => stamps(solid("n"), soilFlecks);

// ---------- grass ----------
// profile: tufts poke one row up at a few columns (never at the edges, so the tile joins)
const grassProfile = [1, 1, 1, 0, 1, 1, 1, 1, 1, 0, 0, 1, 1, 1, 1, 1];
const grassBands = ["T", "T", "G", "G", "g"];
const grassDrip = [1, 0, 0, 1, 2, 1, 0, 0, 1, 0, 2, 1, 0, 1, 0, 0];
function grassTop() {
  const g = soil();
  surface(g, grassProfile, grassBands, grassDrip);
  // a few darker blades inside the grass band, light flecks on top
  stamps(g, [
    [5, 3, ["G"]],
    [6, 2, ["G"]],
    [13, 3, ["G"]],
    [2, 4, ["g"]],
    [10, 4, ["g"]],
  ]);
  // keep the row under the drip edge a little darker (shade into soil)
  return g.rows();
}
const grassFill = () => stamps(soil(), [[5, 1, ["c"]]]).rows();
// platform ends: a k side edge, the grass draping 2 rows down the side; the lit left side keeps its soil, the shaded
// right side gets an A shadow column
function grassEnd(side) {
  const rows = grassTop().map((r) => [...r]);
  const X = (i) => (side === "l" ? i : 15 - i);
  for (let y = 0; y < 16; y++) {
    rows[y][X(0)] = y < 2 ? "." : "k";
    if (y < 1) rows[y][X(1)] = ".";
    else if (y === 1) rows[y][X(1)] = "k";
    else if (y <= 7) rows[y][X(1)] = side === "l" ? (y <= 3 ? "T" : "G") : y <= 3 ? "G" : "g";
    else if (side === "r") rows[y][X(1)] = "A";
  }
  // no tuft right at the cut
  rows[0][X(2)] = ".";
  rows[0][X(3)] = ".";
  return rows.map((r) => r.join(""));
}
const grassEndL = () => grassEnd("l");
const grassEndR = () => grassEnd("r");
const tuft = fit(
  R(`
  ...T...T....
  ..TG..TG..T.
  T.TG.TGG.TG.
  TGGgTGGgTGg.
  GGgggGggGggg
`),
  16,
  16,
  { anchor: "bottom" },
);

asset({
  id: "ground-grass",
  kind: "tile",
  w: 16,
  h: 16,
  wave,
  recipe,
  frames: {
    "grass-top": grassTop(),
    "grass-fill": grassFill(),
    "grass-end-l": grassEndL(),
    "grass-end-r": grassEndR(),
    "grass-tuft": tuft,
  },
  tile: "lr",
  tileFrames: ["grass-top", "grass-fill"],
  seams: [["grass-top", "grass-fill"]],
  compose: [
    [
      [null, "grass-tuft", null, null],
      ["grass-end-l", "grass-top", "grass-top", "grass-end-r"],
    ],
    [
      ["grass-top", "grass-top", "grass-top", "grass-top"],
      ["grass-fill", "grass-fill", "grass-fill", "grass-fill"],
      ["grass-fill", "grass-fill", "grass-fill", "grass-fill"],
    ],
  ],
  tags: ["ground", "grass", "terrain", "platform", "tileable"],
  description:
    "Grassy platform ground. grass-top = a grass band (T G g) with small tufts on top over umber soil (n c, A dents, q pebbles), tileable left-right; grass-fill = the soil below, tileable in all directions; grass-end-l / grass-end-r = the platform's rounded left and right ends (k side edge); grass-tuft = a loose tuft of blades (T G g) standing on the bottom row, transparent above.",
});

// ---------- dirt ----------
const dirtProfile = [0, 0, 0, 0, 1, 1, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0];
function dirtTop() {
  const g = soil();
  surface(g, dirtProfile, ["c", "c", "n"]);
  stamps(g, [
    [2, 1, ["s"]],
    [8, 0, ["ss"]],
    [13, 1, ["s"]],
    [5, 3, ["pq", "qe"]],
  ]);
  return g.rows();
}
function dirtFill() {
  return stamps(solid("n"), [
    [2, 2, ["AA"]],
    [9, 3, ["cc"]],
    [12, 0, ["c"]],
    [5, 6, ["pq", "qe"]],
    [13, 8, ["AA"]],
    [0, 10, ["ccc"]],
    [8, 11, ["A"]],
    [11, 13, ["pq", "qe"]],
    [3, 13, ["cc"]],
    [7, 15, ["c"]],
  ]).rows();
}
asset({
  id: "ground-dirt",
  kind: "tile",
  w: 16,
  h: 16,
  wave,
  recipe,
  frames: { "dirt-top": dirtTop(), "dirt-fill": dirtFill() },
  tile: "lr",
  seams: [["dirt-top", "dirt-fill"]],
  tags: ["ground", "dirt", "soil", "terrain", "tileable"],
  description:
    "Bare dirt ground. dirt-top = packed soil with a lit chestnut crust (c s) and small pebbles (p q e) on umber (n A), tileable left-right; dirt-fill = the soil body (n c A, pebbles), tileable in all directions.",
});

// ---------- stone ----------
// cobbles: rounded stones on a dark grout (l), light from the upper left
function cobbles() {
  const g = solid("l");
  const stone = (w, h) => {
    const rows = [];
    for (let y = 0; y < h; y++) {
      let r = "";
      for (let x = 0; x < w; x++) {
        const corner = (x === 0 || x === w - 1) && (y === 0 || y === h - 1);
        if (corner) r += ".";
        else if (y === 0 || x === 0) r += "p";
        else if (y === h - 1 || x === w - 1) r += "e";
        else r += "q";
      }
      rows.push(r);
    }
    return rows;
  };
  stamps(g, [
    [0, 0, stone(5, 4)],
    [6, 0, stone(6, 4)],
    [13, 0, stone(4, 4)],
    [3, 5, stone(6, 4)],
    [10, 5, stone(5, 4)],
    [-1, 5, stone(3, 4)],
    [0, 10, stone(5, 5)],
    [6, 10, stone(4, 5)],
    [11, 10, stone(5, 5)],
  ]);
  return g.rows();
}
// path: two rows of flat flagstones with a lit top lip, on dark soil below
function stonePath() {
  const g = stamps(solid("n"), [
    [3, 12, ["AA"]],
    [10, 10, ["cc"]],
    [13, 14, ["A"]],
  ]);
  const slab = (w) => ["p".repeat(w), `p${"q".repeat(w - 2)}e`, `p${"q".repeat(w - 2)}e`, `${"e".repeat(w)}`];
  stamps(g, [
    [0, 0, ["l".repeat(16)]],
    [0, 1, slab(7)],
    [7, 1, ["l", "l", "l", "l"]],
    [8, 1, slab(8)],
    [0, 5, ["l".repeat(16)]],
    [12, 6, slab(8)],
    [4, 6, slab(7)],
    [11, 6, ["l", "l", "l", "l"]],
    [3, 6, ["l", "l", "l", "l"]],
    [0, 10, ["l".repeat(16)]],
  ]);
  // top lip: first row is the bright edge of the path (replace the grout line on row 0)
  for (let x = 0; x < 16; x++) g.set(x, 0, x === 7 ? "q" : "p");
  return g.rows();
}
// one flat stepping stone sitting on the bottom rows, transparent above
const steppingStone = fit(
  R(`
  ...pppppp...
  .ppqqqqqqpe.
  pqqqqqqqqqee
  eqqqqqqqqeel
  .eeeeeeeeel.
  ...llllll...
`),
  16,
  16,
  { anchor: "bottom" },
);
asset({
  id: "ground-stone",
  kind: "tile",
  w: 16,
  h: 16,
  wave,
  recipe,
  frames: { "stone-path": stonePath(), cobbles: cobbles(), "stepping-stone": steppingStone },
  tile: "all",
  tileFrames: ["cobbles"],
  tags: ["ground", "stone", "path", "cobbles", "tileable"],
  description:
    "Stone ground. stone-path = flat grey flagstones (p q e, l joints) laid over umber soil, a lit top edge, tileable left-right; cobbles = rounded cobblestones (p q e) on dark grout (l), tileable in all directions; stepping-stone = one flat stone (p q e l) resting on the bottom rows, transparent above.",
});

// ---------- sand ----------
function sandBody() {
  return stamps(solid("H"), [
    [1, 2, ["hhh"]],
    [9, 1, ["hh"]],
    [5, 5, ["hhh"]],
    [12, 6, ["hh"]],
    [0, 8, ["hh"]],
    [7, 9, ["hhh"]],
    [13, 11, ["hhh"]],
    [3, 12, ["hh"]],
    [9, 14, ["hh"]],
    [6, 13, ["j"]],
    [14, 3, ["j"]],
  ]);
}
function sandTop() {
  const g = sandBody();
  surface(g, [1, 1, 0, 0, 0, 0, 0, 1, 1, 1, 1, 0, 0, 0, 0, 1], ["P", "H", "H"]);
  stamps(g, [
    [4, 4, ["hhh"]],
    [11, 5, ["hh"]],
  ]);
  return g.rows();
}
asset({
  id: "ground-sand",
  kind: "tile",
  w: 16,
  h: 16,
  wave,
  recipe,
  frames: { "sand-top": sandTop(), "sand-fill": sandBody().rows() },
  tile: "lr",
  seams: [["sand-top", "sand-fill"]],
  tags: ["ground", "sand", "beach", "desert", "tileable"],
  description:
    "Sand ground. sand-top = a pale dune surface (P H) with a gentle wave in its top edge over straw sand (h H j ripples), tileable left-right; sand-fill = the sand body (h H j), tileable in all directions.",
});

// ---------- snow ----------
function snowBody() {
  return stamps(solid("W"), [
    [2, 1, ["ww"]],
    [10, 2, ["www"]],
    [6, 5, ["PP"]],
    [13, 6, ["ww"]],
    [0, 9, ["www"]],
    [8, 9, ["ww"]],
    [4, 12, ["PP"]],
    [11, 13, ["www"]],
    [1, 14, ["w"]],
  ]);
}
function snowTop() {
  const g = snowBody();
  surface(g, [1, 0, 0, 0, 0, 1, 1, 1, 0, 0, 0, 0, 0, 1, 1, 1], ["P", "P", "W"]);
  stamps(g, [
    [3, 4, ["ww"]],
    [12, 5, ["w"]],
  ]);
  return g.rows();
}
asset({
  id: "ground-snow",
  kind: "tile",
  w: 16,
  h: 16,
  wave,
  recipe,
  frames: { "snow-top": snowTop(), "snow-fill": snowBody().rows() },
  tile: "lr",
  seams: [["snow-top", "snow-fill"]],
  tags: ["ground", "snow", "winter", "ice", "tileable"],
  description:
    "Snow ground. snow-top = soft drifted snow with a bright rounded top edge (P W) and grey hollows (w), tileable left-right; snow-fill = the packed snow body (W w P), tileable in all directions.",
});
