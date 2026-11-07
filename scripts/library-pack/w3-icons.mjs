// Wave 3: 16x16 icons. Hand-placed grids (or painter shapes) with bevel shading and an automatic 1 px k outline.
import { asset, bevel, capsule, ellipse, Grid, polygon, sprite } from "./lib.mjs";

const recipe = "w3-icons.mjs";
const wave = "w3-icons";
const I = (s, o) => sprite(s, 16, 16, { anchor: "center", ...o });
/** paint with painter primitives on a 14x14 grid, bevel the body letter, outline */
function shape(paint, [body, hi, lo], o) {
  const g = new Grid(14, 14);
  paint(g, body);
  return I(bevel(g.rows(), body, hi, lo), o);
}

// ---------- UI ----------
const check = shape(
  (g, c) => {
    capsule(g, 1.6, 7.6, 5, 11, 3, c);
    capsule(g, 5, 11, 12.2, 2.6, 3, c);
  },
  ["T", "M", "G"],
);
const cross = shape(
  (g, c) => {
    capsule(g, 2.5, 2.5, 11.5, 11.5, 3.2, c);
    capsule(g, 11.5, 2.5, 2.5, 11.5, 3.2, c);
  },
  ["r", "r", "R"],
);
const play = shape(
  (g, c) =>
    polygon(
      g,
      [
        [3, 1],
        [12.5, 7],
        [3, 13],
      ],
      c,
    ),
  ["D", "L", "d"],
);
const home = I(`
..............
....rr...pq...
...rrRR..qe...
..rrrRRRRqe...
.rrrrRRRRRR...
rrrrRRRRRRRRR.
RRRRRRRRRRRRRR
.PWWWWWWWWWw..
.PWWWccnWWWw..
.PWWWcsnWWWw..
.PWWWccnWWWw..
.PWWWccBWWWw..
.PWWWccnWWWw..
.wwwwccnwwww..
`);
const user = I(`
....QQQQ....
...QLLLLD...
..QLLLLLLD..
..QLLLLLLD..
..QLLLLLDd..
...DLLLDd...
....dDDd....
............
...QLLLLLD..
..QLLLLLLLD.
.QLLLLLLLLDd
.QLLLLLLLDDd
.DDDDDDDDDdd
`);
const trash = I(`
....pppp....
...p....q...
WWWWWWWWWWWw
pppppppppppq
.PWWpWWpWWw.
.PWWpWWpWWw.
.PWWpWWpWWw.
.PWWpWWpWWw.
.PWWpWWpWWw.
.PWWpWWpWWw.
.PWWpWWpWww.
.wwwwwwwwww.
`);
const folder = I(`
HHHHH.......
HBBBBH......
HBBBBBHHHHHH
HBBBBBBBBBBc
HHHHHHHHHHHB
HBBBBBBBBBBc
HBBBBBBBBBBc
HBBBBBBBBBBc
HBBBBBBBBBBc
HBBBBBBBBBcc
cccccccccccc
`);
const lock = I(`
...pqqqq...
..pq...qe..
..pq...qe..
..pq...qe..
.HHHHHHHHB.
.HBBBBBBBc.
.HBBBkkBBc.
.HBBBkkBBc.
.HBBBBkBBc.
.HBBBBkBBc.
.HBBBBBBBc.
.cccccccccc
`);
const key = I(`
.HHHH.........
HBBBBc........
HB..Bc........
HB..BHHHHHHHHB
HBBBBBBBBBBBBc
.cccc.....Bc.c
..........Bc.c
`);
asset({
  id: "icons-ui",
  kind: "icon",
  w: 16,
  h: 16,
  wave,
  recipe,
  frames: { check, cross, play, home, user, trash, folder, lock, key },
  tags: ["icon", "ui", "interface", "action", "symbol"],
  description:
    "Interface icons, each centred in its 16x16 frame with a 1 px k outline, light from the upper left. check = a thick green check mark (M T G); cross = a red X (r R); play = a blue play triangle pointing right (L D d); home = a house with a red roof (r R), white walls (P W w), a wooden door (c s n) and a grey chimney (p q e); user = a generic person silhouette, head and shoulders (Q L D d); trash = a grey bin with a lid and ribs (P W w p q); folder = a brass file folder with a tab (H B c); lock = a closed brass padlock (H B c) with a grey shackle (p q e) and a k keyhole; key = a brass key (H B c) with a round bow and two teeth. No brands, no text.",
});

// ---------- misc ----------
const heart = I(`
.rrrr...rrrr.
rPPrrr.rrrrRR
rPrrrrrrrrrRR
rrrrrrrrrrrRR
rrrrrrrrrrRRR
.rrrrrrrrRRR.
..rrrrrrRRR..
...rrrrRRR...
....rrRRR....
.....rRR.....
......R......
`);
const star = shape(
  (g, c) => {
    const pts = [];
    for (let i = 0; i < 10; i++) {
      const a = -Math.PI / 2 + (i * Math.PI) / 5;
      const r = i % 2 ? 2.9 : 7;
      pts.push([7 + r * Math.cos(a), 7.6 + r * Math.sin(a)]);
    }
    polygon(g, pts, c);
  },
  ["B", "H", "c"],
);
const lightning = I(`
......HHHHH
.....HBBBc.
....HBBBc..
...HBBBc...
..HBBBBHHH.
.HBBBBBBBc.
..cccBBBc..
....HBBc...
...HBBc....
..HBc......
.HBc.......
.Hc........
`);
const battery = I(`
pWWWWWWWWWWw..
W..........qq.
W.TTGG.TTGG.qq
W.TGGg.TGGg.qq
W.TGGg.TGGg.qq
W.GGgg.GGgg.qq
W..........q..
wqqqqqqqqqqq..
`);
const wifi = (() => {
  const g = new Grid(14, 12);
  // three arcs and a dot round (7, 11), inside a 90-degree fan opening upward
  for (let y = 0; y < 12; y++)
    for (let x = 0; x < 14; x++) {
      const dx = x + 0.5 - 7;
      const dy = y + 0.5 - 11;
      const r = Math.hypot(dx, dy);
      if (dy > 0.6 || Math.abs(dx) > -dy * 1.15 + 0.9) continue;
      const band = [
        [0, 1.6, "L"],
        [3.4, 5, "L"],
        [6.8, 8.4, "L"],
        [10.2, 11.8, "L"],
      ].find(([a, b2]) => r >= a && r < b2);
      if (band) g.set(x, y, r - band[0] < 0.8 ? "Q" : "D");
    }
  return I(g.rows());
})();
const flag = I(`
HB..........
qp..........
qpTTTTTTT...
qpTGGGGGGTT.
qpTGGGGGGGGg
qpTGGGGGGGg.
qpGGGGGGgg..
qpgggg......
qp..........
qp..........
qp..........
qp..........
`);
const camera = I(`
...YYYY......
..YqqqqY..rR.
qqqqqqqqqqqqqq
qpppppEEEppppe
qpppEEEECCpppe
qppEEQCCxxxppe
qppECCCxxxIppe
qppECxxxxIIppe
qpppxxxIIIpppe
qppppIIIIppppe
qeeeeeeeeeeeee
`);
const music = I(`
....VVVVVVVV
....VUUUUUUU
....VUUUUUUU
....V......U
....V......U
....V......U
....V......U
.VVVV...VVVU
VVVUU..VVVUU
VVUUU..VVUUU
.UUU....UUU.
`);
const book = I(`
.LLLLLLLLLLd.
LLDDDDDDDDDdP
LDDDDDDDDDDdP
LDDPPPPPDDDdP
LDDDDDDDDDDdP
LDDqqqqDDDDdW
LDDDDDDDDDDdW
LDDDDDDDDDDdW
LDDDDDDDDDDdW
dDDDDDDDDDDdW
ddddddddddddW
.PPPPPPPPPPWW
`);
asset({
  id: "icons-misc",
  kind: "icon",
  w: 16,
  h: 16,
  wave,
  recipe,
  frames: { heart, star, lightning, battery, wifi, flag, camera, music, book },
  tags: ["icon", "symbol", "status", "media", "misc"],
  description:
    "General icons, each centred in its 16x16 frame with a 1 px k outline, light from the upper left. heart = a red heart (r R, P shine), a 16x16 companion to the 12x12 heart in items; star = a five-point gold star (H B c), a 16x16 companion to the 12x12 star in items; lightning = a gold zigzag bolt (H B c); battery = a grey battery case (W w q p) charged with two green cells (T G g); wifi = a blue wireless fan, three arcs over a dot (Q D), not the broadcast signal in icons-product; flag = a green pennant (T G g) on a grey pole (p q) with a brass ball (H B); camera = a grey camera (p q e) with a big round lens (E C Q x I), a top bump (Y) and a red light (r R); music = two joined violet eighth notes (V U); book = a closed blue book (L D d) with a pale title band and page edges (P W q). No brands, no text.",
});

// ---------- coin spin (4 frames, registered on the same centre and baseline) ----------
function coin(rx) {
  const g = new Grid(14, 14);
  if (rx < 1.5) {
    // edge-on: a 2-wide rim
    for (let y = 1; y <= 12; y++) {
      g.set(6, y, "H");
      g.set(7, y, "c");
    }
    g.set(6, 1, "B");
    g.set(7, 12, "n");
    return I(g.rows());
  }
  ellipse(g, 7, 7, rx, 6.2, "B");
  let rows = bevel(g.rows(), "B", "H", "c");
  // inner rim and an embossed mark scaled to the width
  const gg = Grid.from(rows);
  ellipse(gg, 7, 7, Math.max(0.8, rx - 1.6), 4.6, "B");
  rows = gg.rows();
  rows = rows.map((r, y) =>
    [...r]
      .map((c, x) => {
        if (c !== "B") return c;
        const inner = (x + 0.5 - 7) ** 2 / Math.max(0.6, rx - 1.6) ** 2 + (y + 0.5 - 7) ** 2 / 4.6 ** 2 <= 1;
        if (!inner) return c;
        // the inner disc: a lit top-left ring, a shaded lower-right ring, a centre bar
        const outer = (x + 0.5 - 7) ** 2 / Math.max(0.6, rx - 2.6) ** 2 + (y + 0.5 - 7) ** 2 / 3.6 ** 2 > 1;
        if (outer) return x + y < 14 ? "c" : "H";
        return Math.abs(x + 0.5 - 7) < 1 && Math.abs(y + 0.5 - 7) < 2.5 ? "H" : "B";
      })
      .join(""),
  );
  return I(rows);
}
const c0 = coin(6.2);
const c1 = coin(3.6);
const c2 = coin(1);
asset({
  id: "coin-spin",
  kind: "icon",
  w: 16,
  h: 16,
  wave,
  recipe,
  frames: { coin0: c0, coin1: c1, coin2: c2, coin3: c1.map((r) => [...r].reverse().join("")) },
  loops: [["coin0", "coin1", "coin2", "coin3"]],
  swapExempt: true,
  tags: ["icon", "coin", "money", "pickup", "animated"],
  description:
    "A spinning gold coin, 4-frame loop, centred and registered on the same middle in every frame, 1 px k outline: coin0 = the full face (H B c rim, an embossed inner ring and bar); coin1 = turned to a narrow oval; coin2 = edge-on (H c n); coin3 = the narrow oval from the other side (coin1 mirrored). Complements the static coin in icons-pitch.",
});
