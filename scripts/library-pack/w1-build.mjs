// Wave 1b: floors, walls, roofs and water (16x16 tiles). Built from repeating cells, so every fill tiles.
import { solid, stamp, stamps, surface } from "./ground.mjs";
import { asset } from "./lib.mjs";

const recipe = "w1-build.mjs";
const wave = "w1-build";

/** rotate every row left by n cells (an animation step that stays seamless) */
const roll = (rows, n) => rows.map((r) => r.slice(n) + r.slice(0, n));

// ---------- floor-wood ----------
/** horizontal planks, 4 rows each: lit top edge, body with grain, a dark gap; joints offset per plank */
function planks({ hi, body, grain, gap }) {
  const g = solid(body);
  const joints = [3, 11, 7, 14];
  for (let p = 0; p < 4; p++) {
    const y = p * 4;
    for (let x = 0; x < 16; x++) {
      g.set(x, y, hi);
      g.set(x, y + 3, gap);
    }
    const j = joints[p];
    for (let r = 0; r < 3; r++) g.set(j, y + r, gap);
    // grain: a 3-cell dash in the middle of each board half
    stamp(g, j + 3, y + 1 + (p % 2), [grain.repeat(3)]);
    stamp(g, j + 10, y + 2 - (p % 2), [grain.repeat(2)]);
  }
  return g.rows();
}
asset({
  id: "floor-wood",
  kind: "tile",
  w: 16,
  h: 16,
  wave,
  recipe,
  frames: {
    planks: planks({ hi: "s", body: "c", grain: "n", gap: "A" }),
    "planks-dark": planks({ hi: "c", body: "n", grain: "a", gap: "A" }),
  },
  tile: "all",
  tags: ["floor", "wood", "planks", "interior", "tileable"],
  description:
    "Wooden floorboards, four horizontal planks per tile with offset joints, tileable in all directions. planks = warm wood (s lit edge, c body, n grain, A gaps); planks-dark = the same boards in dark wood (c n a A).",
});

// ---------- floor-tile ----------
function checker(n) {
  const g = solid("W");
  for (let y = 0; y < 16; y++)
    for (let x = 0; x < 16; x++) {
      const light = (Math.floor(x / n) + Math.floor(y / n)) % 2 === 0;
      const lx = x % n;
      const ly = y % n;
      let c;
      if (light) c = ly === 0 || lx === 0 ? "P" : ly === n - 1 || lx === n - 1 ? "w" : "W";
      else c = ly === 0 || lx === 0 ? "q" : ly === n - 1 || lx === n - 1 ? "e" : "Y";
      g.set(x, y, c);
    }
  return g.rows();
}
asset({
  id: "floor-tile",
  kind: "tile",
  w: 16,
  h: 16,
  wave,
  recipe,
  frames: { checker: checker(8), "checker-small": checker(4) },
  tile: "all",
  tags: ["floor", "tile", "checker", "interior", "tileable"],
  description:
    "Checkered floor tiles, tileable in all directions: light squares (P W w) and slate squares (q Y e), each with a lit top-left bevel. checker = 8x8 squares; checker-small = 4x4 squares.",
});

// ---------- wall-brick ----------
/** running-bond bricks 8x4 (3 rows of brick, 1 row of mortar), alternate courses offset by 4 */
function bricks({ hi, body, lo, mortar }) {
  const g = solid(body);
  for (let y = 0; y < 16; y++)
    for (let x = 0; x < 16; x++) {
      const course = Math.floor(y / 4);
      const ly = y % 4;
      const lx = (x + (course % 2) * 4) % 8;
      let c = body;
      if (ly === 3 || lx === 7) c = mortar;
      else if (ly === 0 && lx < 6) c = hi;
      else if (ly === 2 && lx >= 2) c = lo;
      g.set(x, y, c);
    }
  return g.rows();
}
asset({
  id: "wall-brick",
  kind: "tile",
  w: 16,
  h: 16,
  wave,
  recipe,
  frames: {
    "brick-red": bricks({ hi: "r", body: "R", lo: "R", mortar: "e" }),
    "brick-stone": bricks({ hi: "p", body: "q", lo: "e", mortar: "l" }),
  },
  tile: "all",
  tags: ["wall", "brick", "building", "masonry", "tileable"],
  description:
    "Brick walls in running bond (8x4 bricks, alternate courses offset), tileable in all directions. brick-red = wine-red bricks with a lit top edge (r R) on grey mortar (e); brick-stone = grey stone blocks (p q e) on dark joints (l).",
});

// ---------- wall-plaster ----------
function plaster() {
  return stamps(solid("q"), [
    [2, 2, ["pp", "p."]],
    [11, 1, ["ppp"]],
    [7, 7, ["e", "ee", ".e"]],
    [13, 10, ["pp"]],
    [1, 12, ["ee."]],
    [4, 13, ["pp"]],
    [10, 14, ["e"]],
  ]).rows();
}
/** a window opening (10 wide, 11 tall) in plaster: wood frame, 4 panes, a pale sill */
function plasterWindow(lit) {
  const g = solid("q");
  stamps(g, [
    [1, 1, ["pp"]],
    [13, 14, ["ee"]],
  ]);
  const pane = lit ? ["HBBB", "BBBB", "BBBc"] : ["QNNN", "INNN", "NNNN"];
  // frame
  for (let y = 2; y <= 12; y++)
    for (let x = 3; x <= 12; x++) g.set(x, y, y === 2 || x === 3 ? "c" : y === 12 || x === 12 ? "n" : "n");
  stamp(g, 4, 3, pane);
  stamp(g, 9, 3, lit ? ["BBB", "BBB", "BBc"] : ["NNN", "NNN", "NNN"]);
  stamp(g, 4, 8, lit ? ["BBBB", "BBBO", "BBOO"] : ["NNNN", "NNNN", "NNNN"]);
  stamp(g, 9, 8, lit ? ["BBB", "BBO", "BOO"] : ["NNN", "NNN", "NNN"]);
  if (!lit) stamp(g, 5, 4, ["I"]);
  // sill
  stamp(g, 2, 13, ["PWWWWWWWWWWw"]);
  stamp(g, 3, 14, ["eeeeeeeeee"]);
  return g.rows();
}
asset({
  id: "wall-plaster",
  kind: "tile",
  w: 16,
  h: 16,
  wave,
  recipe,
  frames: { plaster: plaster(), "window-lit": plasterWindow(true), "window-dark": plasterWindow(false) },
  tile: "all",
  compose: [
    [
      ["plaster", "plaster", "plaster", "plaster"],
      ["plaster", "window-lit", "plaster", "window-dark"],
      ["plaster", "plaster", "plaster", "plaster"],
    ],
  ],
  tags: ["wall", "plaster", "window", "house", "tileable"],
  description:
    "Plastered wall, tileable in all directions. plaster = grey render (q) with pale patches (p) and a hairline crack (e); window-lit = the same wall with a four-pane window in a wooden frame (c n), warm light (H B, O glow low right) and a pale sill (P W w e); window-dark = the window unlit (N I panes, a Q glint).",
});

// ---------- wall-wood ----------
function boards() {
  const g = solid("c");
  for (let y = 0; y < 16; y++)
    for (let x = 0; x < 16; x++) {
      const lx = x % 4;
      g.set(x, y, lx === 0 ? "s" : lx === 3 ? "A" : lx === 2 ? "n" : "c");
    }
  stamps(g, [
    [1, 4, ["n"]],
    [1, 5, ["n"]],
    [5, 11, ["n"]],
    [9, 2, ["n"]],
    [9, 3, ["n"]],
    [13, 9, ["n"]],
    [13, 10, ["n"]],
    [5, 6, ["A"]],
    [6, 6, ["A"]],
    [5, 7, ["A"]],
    [6, 7, ["A"]],
  ]);
  return g.rows();
}
function logs() {
  const g = solid("c");
  for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) g.set(x, y, ["s", "c", "n", "A"][y % 4]);
  stamps(g, [
    [3, 1, ["nn"]],
    [11, 5, ["nnn"]],
    [6, 9, ["nn"]],
    [13, 13, ["nn"]],
    [0, 13, ["n"]],
  ]);
  return g.rows();
}
asset({
  id: "wall-wood",
  kind: "tile",
  w: 16,
  h: 16,
  wave,
  recipe,
  frames: { boards: boards(), logs: logs() },
  tile: "all",
  tags: ["wall", "wood", "cabin", "boards", "tileable"],
  description:
    "Wooden walls, tileable in all directions. boards = vertical 4 px boards with a lit left edge and dark seam (s c n A) and a knot; logs = stacked horizontal logs, lit on top and shaded below (s c n A).",
});

// ---------- roof-tiles ----------
/** overlapping shingles 4 wide x 4 tall, rows offset by 2, lit left edge, dark lower lip */
function shingles({ hi, body, lo, gap }) {
  const g = solid(body);
  for (let y = 0; y < 16; y++)
    for (let x = 0; x < 16; x++) {
      const row = Math.floor(y / 4);
      const ly = y % 4;
      const lx = (x + (row % 2) * 2) % 4;
      let c = body;
      if (ly === 3) c = gap;
      else if (lx === 3) c = gap;
      else if (ly === 2) c = lo;
      else if (lx === 0) c = hi;
      g.set(x, y, c);
    }
  return g.rows();
}
/** clay barrel tiles: rounded vertical channels 4 wide, rows of 8 with a dark lip */
function clay() {
  const g = solid("c");
  for (let y = 0; y < 16; y++)
    for (let x = 0; x < 16; x++) {
      const row = Math.floor(y / 8);
      const ly = y % 8;
      const lx = (x + row * 2) % 4;
      let c = ["s", "c", "c", "n"][lx];
      if (ly === 0) c = lx === 0 ? "S" : lx === 3 ? "n" : "s";
      // rounded lower lip of each tile, a dark shadow under it
      if (ly === 6) c = lx === 3 ? "A" : lx === 0 ? "n" : "z";
      if (ly === 7) c = lx === 1 || lx === 2 ? "n" : "A";
      g.set(x, y, c);
    }
  return g.rows();
}
/** the ridge: a row of rounded cap tiles along the top of a slate roof */
function ridge() {
  const g = Grid16(shingles({ hi: "q", body: "Y", lo: "e", gap: "F" }));
  surface(g, [2], ["."]);
  for (let x = 0; x < 16; x++) {
    const lx = x % 8;
    g.set(x, 0, lx === 0 || lx === 7 ? "." : "q");
    g.set(x, 1, lx === 0 ? "q" : lx >= 6 ? "e" : "p");
    g.set(x, 2, lx === 0 ? "p" : lx === 7 ? "e" : lx >= 5 ? "q" : "p");
    g.set(x, 3, lx === 7 ? "F" : "e");
    g.set(x, 4, "F");
  }
  return g.rows();
}

import { Grid } from "./lib.mjs";

const Grid16 = (rows) => Grid.from(rows);
asset({
  id: "roof-tiles",
  kind: "tile",
  w: 16,
  h: 16,
  wave,
  recipe,
  frames: {
    slate: shingles({ hi: "q", body: "Y", lo: "e", gap: "F" }),
    clay: clay(),
    ridge: ridge(),
  },
  tile: "all",
  tileFrames: ["slate", "clay"],
  compose: [
    [
      ["ridge", "ridge", "ridge", "ridge"],
      ["slate", "slate", "slate", "slate"],
      ["slate", "slate", "slate", "slate"],
    ],
    [
      ["clay", "clay", "clay", "clay"],
      ["clay", "clay", "clay", "clay"],
    ],
  ],
  tags: ["roof", "slate", "clay", "house", "tileable"],
  description:
    "Roof coverings, tileable in all directions. slate = grey overlapping shingles in offset rows (q Y e, F gaps); clay = staggered rounded terracotta tiles (S s c z n, A shadow lips); ridge = a row of rounded slate cap tiles along the top edge over slate (p q e F), transparent above, tileable left-right.",
});

// ---------- water ----------
function waterBody() {
  return stamps(solid("x"), [
    [1, 2, ["XXX"]],
    [10, 4, ["XX"]],
    [5, 7, ["XXXX"]],
    [13, 9, ["XX"]],
    [2, 11, ["XX"]],
    [8, 13, ["XXX"]],
    [12, 1, ["X"]],
  ]);
}
function waterTop() {
  const g = waterBody();
  // crest profile: 8-wide wave, crest on the left half
  surface(g, [1, 0, 0, 0, 1, 1, 1, 2, 2, 2, 1, 1, 1, 1, 2, 2], ["E", "C", "X"]);
  stamps(g, [
    [4, 6, ["CC"]],
    [12, 5, ["C"]],
  ]);
  return g.rows();
}
const wTop = waterTop();
asset({
  id: "water",
  kind: "tile",
  w: 16,
  h: 16,
  wave,
  recipe,
  frames: { "water-top0": wTop, "water-top1": roll(wTop, 4), "water-deep": waterBody().rows() },
  tile: "lr",
  loops: [["water-top0", "water-top1"]],
  seams: [
    ["water-top0", "water-deep"],
    ["water-top1", "water-deep"],
  ],
  tags: ["water", "sea", "river", "animated", "tileable"],
  description:
    "Water. water-top0 / water-top1 = the surface, pale crests (E C) over teal water (X x), a 2-frame loop where the waves roll 4 px, tileable left-right; water-deep = the body below (x with X streaks), tileable in all directions.",
});
