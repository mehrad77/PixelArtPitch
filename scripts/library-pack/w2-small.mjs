// Wave 2a: small props, 16x16, hand-placed grids with an automatic k outline (sprite()). Light from the upper left.
import { asset, sprite } from "./lib.mjs";

const recipe = "w2-small.mjs";
const wave = "w2-props";
const S = (s, o) => sprite(s, 16, 16, o);

// ---------- lights ----------
const candle = S(`
....B....
...BHB...
...BHB...
...OBO...
....n....
..PPWWw..
..PWWWw..
..PWWWw..
..PWWWw..
..PWWWw..
.qpppppq.
qppppppqe
.eeeeeee.
`);
const lantern = (lit) => {
  const panes = lit
    ? [".YHPYHBY.", ".YPBYBBY.", ".YHBYBOY.", ".YBBYBOY."]
    : [".YqpYqeY.", ".YpqYqeY.", ".YqqYeeY.", ".YqqYeeY."];
  return S(
    ["...qqq...", "..q...q..", "..YYYYY..", ".YqqqqqY.", ...panes, ".YYYYYYY.", "..YqqqY..", ".YYYYYYY."].join("\n"),
  );
};
// campfire: crossed logs and ring stones, flames sway over three frames (base and logs never move)
const fireBase = ["..c....n..", ".scc..cnn.", "pqscccnnqe", "qqnnnnnnee"];
const flames = [
  ["....O.....", "...OB.O...", "..OBHBO...", "..OBHHBO..", "..BHPHBO..", ".OBHPPHBO.", ".OBHHHHBO."],
  [".....O....", "..O.BO....", "..OBHBO...", ".OBHHBO...", ".OBHPHBO..", ".OBHPPHBO.", ".OBHHHHBO."],
  ["...O......", "...BO.O...", "..OBHOB...", "..OBHHBO..", "..BHPHBBO.", ".OBHPPHBO.", ".OBHHHHBO."],
];
const fire = (i) => S([...flames[i], ...fireBase].join("\n"));

// ---------- books, rock, stump ----------
const bookClosed = S(`
.rrrrrrrrrr.
rrRRRRRRRRRP
rRRRRRRRRRRP
rRRBBBBRRRRP
rRRRRRRRRRRP
rRRRRRRRRRRW
RRRRRRRRRRRW
PPPPPPPPPPWW
WWWWWWWWWWWw
RRRRRRRRRRRR
`);
const bookOpen = S(`
.PPPPP..PPPPP.
PPqqqPWWPqqqPW
PPPPPPWWPPPPWW
PPqqqPWWPqqqWW
PPPPPPWWPPPPWW
PPqqPPWwPqqPWw
WPPPPWwwWPPWww
RWWWWwwRwwwwwR
RRRRRRRRRRRRRR
.RRRRRRRRRRRR.
`);
const rock = S(`
....pppp....
..ppqqqqqp..
.pqqqqqqqqe.
pqqqqqqqqqee
pqqqqqqqqeee
qqqqqqqqeeee
eeeeeeeeeeel
`);
const stump = S(`
..SSSSSSSS..
.SsccccccsS.
Sscsssssscsn
Sscssccsscsn
.Sscccccsnnn
.nSsssssnnnA
.cnnnnnnnnAA
.cnncnnnnnAA
.cnncnnnAnAA
ccnncnnnAnAA
cn.cnnn.nAA.
`);
asset({
  id: "props-small",
  kind: "prop",
  w: 16,
  h: 16,
  wave,
  recipe,
  frames: {
    candle,
    "lantern-lit": lantern(true),
    "lantern-unlit": lantern(false),
    campfire0: fire(0),
    campfire1: fire(1),
    campfire2: fire(2),
    "book-closed": bookClosed,
    "book-open": bookOpen,
    rock,
    "tree-stump": stump,
  },
  loops: [["campfire0", "campfire1", "campfire2"]],
  tags: ["prop", "candle", "lantern", "campfire", "book"],
  description:
    "Small props standing on the bottom row, 1 px k outline, light from the upper left. candle = a white candle (P W w) with a small flame (B H O) on a grey dish (p q e); lantern-lit / lantern-unlit = a standing slate lantern (Y q p) with a warm glowing glass (H B P, O low right) or dark glass (q e); campfire0-2 = a 3-frame fire loop, flames (O B H P) sway over crossed logs (s c n) and stones (p q e), the logs never move; book-closed = a red hardback lying flat (r R, B title band, P W page edges); book-open = an open book (P W pages, q text lines, R cover); rock = a grey boulder (p q e l); tree-stump = a cut stump, its pale top showing rings (S s c) above dark bark (c n A).",
});

// ---------- storage ----------
const chestClosed = S(`
..cccccccccc..
.cssssssssssn.
csscccccccccnn
BBBBBBBBBBBBBc
cccccBHBcccccn
csccsBkBsccnnn
cccccBBBcccnnn
cscccccccccnnn
BBBBBBBBBBBBBc
cnnnnnnnnnnnnn
`);
const chestOpen = S(`
.cccccccccccc.
cnnnnnnnnnnnnn
cnAAAAAAAAAAnn
cnAAAAAAAAAAnn
BBBBBBBBBBBBBc
cHBHHBHBBHBHBc
cBHBBHBBHBBBnn
cscccccccccnnn
cscccBBBcccnnn
cscccccccccnnn
BBBBBBBBBBBBBc
cnnnnnnnnnnnnn
`);
const crate = S(`
ssssssssssss
sssccccccssc
sncsccccscnc
snncsccscnnc
snnncsscnnnc
snnnnscnnnnc
snnncscsnnnc
snncscnncsnc
sncscnnnncsc
sccccccccccc
cccccccccccc
`);
const barrel = S(`
..pqqqqqq..
.cssccccnn.
scsccccnnnn
pqqqqqqqqqe
scscccccnnn
scscccccnnn
scscccccnnn
pqqqqqqqqqe
.cscccccnn.
..nnnnnnn..
`);
const gift = S(`
...HB..BH...
..HBBHHBBH..
....BBBB....
rrrrrHBrrrrR
rrrrrHBrrrRR
RRRRRHBRRRRR
.rrrrHBrrrR.
.rrrrHBrrrR.
.rrrrHBrrRR.
.rrrrHBrRRR.
.RRRRHBRRRR.
`);
asset({
  id: "props-storage",
  kind: "prop",
  w: 16,
  h: 16,
  wave,
  recipe,
  frames: { "chest-closed": chestClosed, "chest-open": chestOpen, crate, barrel, "gift-box": gift },
  tags: ["prop", "chest", "crate", "barrel", "gift"],
  description:
    "Containers standing on the bottom row, 1 px k outline, light from the upper left. chest-closed = a wooden treasure chest (s c n) with brass bands and a lock (B H, k keyhole); chest-open = the same chest with its lid raised, showing the dark inside (A) and gold coins (B H); crate = a wooden crate, a lit frame round a dark panel with a diagonal X brace (s c n); barrel = a wooden barrel (s c n) with two grey hoops (p q e); gift-box = a red present (r R) with a brass ribbon and bow (H B).",
});
