// Wave 2b: 24x32 props (house, yard and misc) and the 16x32 streetlight. Regular parts (planks, shelves) are built in
// code; everything else is a hand-placed grid. sprite() adds the k outline. Light from the upper left.
import { asset, Grid, rect, sprite } from "./lib.mjs";

const recipe = "w2-big.mjs";
const wave = "w2-props";
const B = (s, o) => sprite(s, 24, 32, o);

// ---------- doors ----------
function doorFrame() {
  const g = new Grid(16, 28);
  rect(g, 0, 0, 15, 27, "q");
  rect(g, 0, 0, 15, 0, "p");
  rect(g, 0, 0, 0, 27, "p");
  rect(g, 15, 1, 15, 27, "e");
  return g;
}
function doorClosed() {
  const g = doorFrame();
  for (let y = 2; y <= 27; y++)
    for (let x = 2; x <= 13; x++) {
      const lx = (x - 2) % 4;
      g.set(x, y, lx === 0 ? "s" : lx === 3 ? "n" : "c");
    }
  // cross rails
  for (const y of [5, 21]) {
    rect(g, 2, y, 13, y, "s");
    rect(g, 2, y + 1, 13, y + 1, "n");
  }
  // handle
  g.set(11, 14, "H");
  g.set(11, 15, "B");
  g.set(12, 15, "c");
  // threshold
  rect(g, 1, 27, 14, 27, "e");
  return g.rows();
}
function doorOpen() {
  const g = doorFrame();
  rect(g, 2, 2, 13, 27, "F");
  rect(g, 2, 2, 13, 2, "f");
  // warm floor glimpse and the open leaf, swung in against the left jamb
  rect(g, 5, 24, 13, 26, "a");
  rect(g, 5, 24, 13, 24, "n");
  for (let y = 2; y <= 26; y++) {
    g.set(2, y, "s");
    g.set(3, y, "c");
    g.set(4, y, "n");
  }
  g.set(4, 14, "B");
  rect(g, 1, 27, 14, 27, "e");
  return g.rows();
}

// ---------- windows (wall-mounted, centred) ----------
function windowProp(lit) {
  const P = lit ? ["HHBB", "HBBB", "BBBc", "BBcO"] : ["QINN", "INNN", "NNNN", "NNNN"];
  const pane = (r) => `${P[r]}n${P[r]}`;
  const shutter = ["dLLd", "dDDd", "dLLd", "dDDd"];
  const rows = [];
  rows.push(`....${"c".repeat(11)}n....`);
  for (let y = 0; y < 14; y++) {
    const sh = shutter[y % 4];
    const pr =
      y === 6 ? "nnnnnnnnn" : pane(y < 6 ? Math.min(3, Math.floor(y / 1.6)) : Math.min(3, Math.floor((y - 7) / 1.8)));
    rows.push(`${sh}c${pr}n${sh}`);
  }
  rows.push(`....${"c".repeat(11)}n....`);
  rows.push(`...P${"W".repeat(11)}ww...`);
  rows.push(`....${"e".repeat(12)}....`);
  return B(rows.join("\n"), { anchor: "center" });
}

// ---------- furniture ----------
const table = B(`
SSSSSSSSSSSSSSSSSSSSSS
ssssssssssssssssssssss
cccccccccccccccccccccn
nnnnnnnnnnnnnnnnnnnnnn
.scn..............scn.
.scn..............scn.
.scn..............scn.
.scn..............scn.
.scn..............scn.
.scn..............scn.
.scn..............scn.
.scnn............scnn.
`);
const chair = B(`
ssssssssssss
scccccccccnn
sc.s.s.s.cnn
sc.s.s.s.cnn
sc.c.c.c.cnn
sc.c.c.c.cnn
sc.n.n.n.cnn
scccccccccnn
SSSSSSSSSSSS
sssssssssssn
nnnnnnnnnnnn
sn........cn
sn........cn
sn........cn
sn........cn
sn........cn
`);
const bed = B(`
sc....................
scc...................
sccn..................
scnn..............sc..
scnn..............scn.
scnPPPPW..........scn.
scnPPPWwLLLLLLLLLLscn.
scnWWWwwLLLDDDDDDDscn.
scnPPPPPLDDDDDDDDDscn.
scnWWWWWDDDDDDDDDddscn
scnnnnnnddddddddddscnn
scnnnnnnnnnnnnnnnnscnn
sn..................cn
`);
function bookshelf() {
  const g = new Grid(18, 28);
  rect(g, 0, 0, 17, 27, "c");
  rect(g, 0, 0, 17, 0, "s");
  rect(g, 0, 0, 0, 27, "s");
  rect(g, 17, 0, 17, 27, "n");
  // four bays, back panel dark
  const bays = [1, 7, 13, 19];
  const spines = [
    [
      ["r", "R", 5],
      ["D", "d", 4],
      ["T", "G", 5],
      ["B", "c", 3],
      ["W", "w", 5],
      ["V", "U", 4],
      ["r", "R", 4],
    ],
    [
      ["Q", "D", 4],
      ["H", "h", 5],
      ["r", "R", 5],
      ["M", "m", 3],
      ["L", "D", 5],
      ["T", "G", 4],
    ],
    [
      ["W", "w", 5],
      ["r", "R", 4],
      ["B", "c", 5],
      ["E", "C", 4],
      ["V", "U", 5],
      ["H", "h", 3],
      ["D", "d", 4],
    ],
    [
      ["T", "G", 4],
      ["s", "c", 5],
      ["Q", "D", 5],
      ["r", "R", 3],
      ["P", "p", 5],
    ],
  ];
  bays.forEach((y0, i) => {
    rect(g, 1, y0, 16, y0 + 4, "A");
    let x = 2;
    for (const [lit, dark, h] of spines[i]) {
      if (x > 15) break;
      for (let y = y0 + 5 - h; y <= y0 + 4; y++) {
        g.set(x, y, lit);
        if (x + 1 <= 15) g.set(x + 1, y, dark);
      }
      x += 2;
    }
    // shelf board under the bay
    rect(g, 1, y0 + 5, 16, y0 + 5, "s");
  });
  rect(g, 1, 25, 16, 26, "c");
  rect(g, 0, 27, 17, 27, "n");
  return B(g.rows());
}

asset({
  id: "props-house",
  kind: "prop",
  w: 24,
  h: 32,
  wave,
  recipe,
  frames: {
    "door-closed": B(doorClosed()),
    "door-open": B(doorOpen()),
    "window-lit": windowProp(true),
    "window-dark": windowProp(false),
    table,
    chair,
    bed,
    bookshelf: bookshelf(),
  },
  tags: ["prop", "house", "furniture", "door", "window"],
  description:
    "House props, 1 px k outline, light from the upper left; all stand on the bottom row except the windows, which are centred for a wall. door-closed = a plank door (s c n, brass handle H B) in a grey stone frame (p q e); door-open = the same frame with the door swung in against the jamb, a dark interior (F f) and a floor glimpse (a n); window-lit / window-dark = a four-pane window with blue shutters (L D d), a wooden frame (c n) and a pale sill (P W w e), lit warm (H B c, two O cells low right) or dark (N I, Q glint); table = a wooden table (S s c n); chair = a slat-back chair seen from the front (S s c n); bed = a bed with a head- and footboard (s c n), white pillow and sheet (P W w) and a blue blanket (L D d); bookshelf = a tall shelf (s c n) with four rows of coloured book spines.",
});

// ---------- yard ----------
const bench = B(`
.YYYYYYYYYYYYYYYYYYYY.
YsssssssssssssssssssY.
YcccccccccccccccccccnY
Y....................Y
YsssssssssssssssssssY.
YcccccccccccccccccccnY
YqqqqqqqqqqqqqqqqqqqqY
Ysssssssssssssssssssss
cnnnnnnnnnnnnnnnnnnnnn
.qY................qY.
.qY................qY.
.qY................qY.
qYYY..............qYYY
`);
function fence() {
  const g = new Grid(24, 32);
  // pickets every 6 cells, pointed tops; two rails; pickets 4 wide: lit, body, body, shade
  for (let p = 0; p < 4; p++) {
    const x0 = p * 6 + 1;
    for (let y = 14; y <= 31; y++) {
      g.set(x0, y, "S");
      g.set(x0 + 1, y, "s");
      g.set(x0 + 2, y, "s");
      g.set(x0 + 3, y, "c");
    }
    g.set(x0, 14, ".");
    g.set(x0 + 3, 14, ".");
    g.set(x0, 15, "S");
    g.set(x0 + 1, 13, "S");
    g.set(x0 + 2, 13, "s");
  }
  for (const y of [18, 26])
    for (let x = 0; x < 24; x++) {
      const inPicket = (x - 1) % 6 < 4 && x >= 1;
      if (!inPicket) {
        g.set(x, y, "c");
        g.set(x, y + 1, "n");
      } else g.set(x, y + 1, g.get(x, y + 1) === "S" ? "s" : "c");
    }
  // outline only the pickets' silhouette, not the tiling edge: k on transparent cells next to wood
  const rows = g.rows();
  const out = rows.map((r, y) =>
    [...r]
      .map((c, x) => {
        if (c !== ".") return c;
        const n = [rows[y - 1]?.[x], rows[y + 1]?.[x], r[x - 1], r[x + 1]];
        return n.some((v) => v && v !== ".") ? "k" : ".";
      })
      .join(""),
  );
  return out;
}
const mailbox = B(`
..pWWWWWWw..
.pWWWWWWWWw.
pWWWWWWWWWwq
WWWWWWWWWWwq
WqqqqqqqqqwqRr
WWWWWWWWWWwqrR
wwwwwwwwwwqqr.
qqqqqqqqqqqqr.
....scn.......
....scn.......
....scn.......
....scn.......
....scn.......
....scn.......
....scn.......
...sscnn......
`);
const signBlank = B(`
...scn..........scn...
.nnscnnnnnnnnnnnscnnn.
.nSSSSSSSSSSSSSSSSSsn.
.nSsssssssssssssssscn.
.nSsssssssssssssssscn.
.nSsssssssssssssssscn.
.nSsssssssssssssssscn.
.nSsssssssssssssssscn.
.nSsssssssssssssssscn.
.nscccccccccccccccccn.
.nnscnnnnnnnnnnnscnnn.
...scn..........scn...
...scn..........scn...
...scn..........scn...
...scn..........scn...
...scn..........scn...
...scn..........scn...
...scn..........scn...
...scn..........scn...
...scn..........scn...
...scn..........scn...
...scn..........scn...
...scn..........scn...
...scn..........scn...
...scn..........scn...
...scn..........scn...
...scn..........scn...
..sscnn........sscnn..
`);
asset({
  id: "props-yard",
  kind: "prop",
  w: 24,
  h: 32,
  wave,
  recipe,
  frames: { bench, fence: fence(), mailbox, "sign-blank": signBlank },
  tile: "lr",
  tileFrames: ["fence"],
  tags: ["prop", "outdoor", "bench", "fence", "sign"],
  description:
    "Outdoor props standing on the bottom row, 1 px k outline, light from the upper left. bench = a park bench with wooden slats (s c n) on slate iron legs and arms (Y q); fence = a white-wood picket fence (S s c n), four pointed pickets on two rails, tileable left-right; mailbox = a grey metal mailbox (W w p q) with a raised red flag (r R) on a wooden post (s c n); sign-blank = a tall signboard: a blank wooden board (S s c in an n frame) held high on two long posts (s c n) that poke above it, its face left empty for one short word.",
});

// ---------- misc ----------
const clock = B(`
....B.....
...sccn...
..sccccn..
.sccccccn.
scPPPPPWcn
sPPWWWWWwn
sPWWkWWWwn
sPWWkWWWwn
sPWWkkkWwn
sPWWWWWWwn
scwwwwwwcn
sccccccccn
scAAAAAAcn
scAAqAAAcn
scAAqAAAcn
scAAqAAAcn
scAABBAAcn
scAABcAAcn
scAAAAAAcn
sccccccccn
scnnnnnncn
scnccccncn
scnccccncn
scnnnnnncn
sccccccccn
ssccccccnn
`);
const trophy = B(`
.HHHHHHHHHHHHHB.
HHPPHBBBBBBBBBBc
HHPHBBBBBBBBBBBc
BBHPHBBBBBBBBBcB
B.HHBBBBBBBBBBc.B
B.HHBBBBBBBBBBc.B
.BBHBBBBBBBBBcBB.
...HBBBBBBBBBc...
....HBBBBBBBc....
.....cBBBBBc.....
.......HBc.......
.......HBc.......
......HBBcc......
.....HBBBBcc.....
...qqqqqqqqqqe...
...pYYYYYYYYYe...
...pYYHBBBcYYe...
...pYYYYYYYYYe...
...peeeeeeeeee...
`);
const rocket = B(`
.....rr.....
....rrRR....
...rrrRRR...
...WWWWwW...
..PWWWWWww..
..PWWEEWww..
..PWECCCww..
..PWECCxww..
..PWWxxWww..
..PWWWWWww..
..PWWWWWww..
..PWrrRRww..
..PWWWWWww..
..PWWWWWww..
.rPWWWWWwwR.
rrPWWWWWwwRR
rr.qqqqqq.RR
r..q.qq.q..R
`);
asset({
  id: "props-misc",
  kind: "prop",
  w: 24,
  h: 32,
  wave,
  recipe,
  frames: { clock, trophy, rocket },
  tags: ["prop", "clock", "trophy", "rocket", "award"],
  description:
    "Standing props on the bottom row, 1 px k outline, light from the upper left. clock = a wooden grandfather clock (s c n) with a pale face (P W w, k hands), a brass finial and a brass pendulum (B c) behind a dark glass (A q); trophy = a big gold cup (H B c, P shine) with handles on a slate plinth (Y q p e) with a brass plate; rocket = a white toy rocket (P W w) on its launch fins, red nose, band and fins (r R), a round porthole (E C x) and grey nozzles (q).",
});

// ---------- streetlight (16x32, on and off) ----------
function streetlight(on) {
  const glass = on ? ["HPPPH", "BHHHB", ".BBB."] : ["qpppq", "eqqqe", ".eee."];
  const s = `
......pqqqqq...
.....pq....qq..
.....pq...YYYYY
.....pq...YqqqY
.....pq...${glass[0]}
.....pq...${glass[1]}
.....pq...${glass[2]}
.....pq........
.....pq........
.....pq........
.....pq........
.....pq........
.....pq........
.....pq........
.....pq........
.....pq........
.....pq........
.....pq........
....YYYY.......
.....pq........
.....pq........
.....pq........
.....pq........
.....pq........
.....pq........
....pqqe.......
...pqqqqe......
..pqqqqqqe.....
`;
  return sprite(s, 16, 32);
}
asset({
  id: "streetlight",
  kind: "prop",
  w: 16,
  h: 32,
  wave,
  recipe,
  frames: { "streetlight-on": streetlight(true), "streetlight-off": streetlight(false) },
  tags: ["prop", "streetlight", "lamp", "street", "night"],
  description:
    "A tall curved-arm streetlight standing on the bottom row, 1 px k outline: a grey pole (p q e) with a collar (Y) and a flared base, the arm bending right to a slate lamp head (Y q). streetlight-on = a glowing lamp (P H B); streetlight-off = the same lamp dark (p q e).",
});
