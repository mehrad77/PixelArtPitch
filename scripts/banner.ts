// The repo's social banner (GitHub social preview, README header): one 320×160 night scene drawn with PAP's own
// engine and public library, scaled ×4 to 1280×640. Deterministic: run it again and you get the same bytes.
//   node scripts/banner.ts [out.png]   (default docs/banner.png)
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { createEngine, type Frames, type RGBT, rnd } from "../packages/engine/src/index.ts";
import { LIBRARY_DIR, loadLibraryAsset, loadPalette } from "../packages/render/src/project.ts";
import { encodePng } from "../packages/render/src/vendor/png.mjs";
import { upscale } from "../packages/render/src/video.ts";

const W = 320;
const H = 160;
const SCALE = 4;
const out = process.argv[2] ?? join(LIBRARY_DIR, "..", "docs", "banner.png");

const IDS = [
  "font-5x8",
  "moon",
  "skyline",
  "tiles",
  "castle",
  "props",
  "qblock",
  "items",
  "users-crowd",
  "cast-founder",
  "cast-developer",
  "cast-designer",
  "cast-investor",
];
const assets = new Map<string, Frames>(IDS.map((id) => [id, loadLibraryAsset(id).grid]));
const pal = loadPalette("pap-night@1");
const e = createEngine({ colours: pal.colours, sky: pal.sky, assets, fontAssets: ["font-5x8"], w: W, h: H });
const f = (id: string, frame: string) => e.frame(id, frame);
const rgb = (hex: string): RGBT => [1, 3, 5].map((i) => Number.parseInt(hex.slice(i, i + 2), 16)) as RGBT;

// ---- sky: the night, a little greener toward the horizon, in dithered bands ----
e.clear();
const GROUND = 128;
for (let y = 60; y < GROUND; y++) {
  const t = (y - 60) / (GROUND - 60);
  for (let x = 0; x < W; x++) if ((x + y) % 2 === 0 || t > 0.6) e.px(x, y, e.RGB.g, t * 0.22);
}
for (let i = 0; i < 70; i++) {
  const x = Math.floor(rnd(i * 3 + 1) * W);
  const y = Math.floor(rnd(i * 3 + 2) * 100);
  const bright = rnd(i * 3 + 3);
  e.px(x, y, bright > 0.85 ? e.RGB.P : e.RGB.p, bright > 0.85 ? 1 : 0.55);
  if (bright > 0.96)
    for (const [dx, dy] of [
      [-1, 0],
      [1, 0],
      [0, -1],
      [0, 1],
    ])
      e.px(x + dx, y + dy, e.RGB.p, 0.5);
}
e.sprite(f("moon", "moon"), 276, 10);

// ---- the far city, the castle, the ground ----
for (let x = -20; x < W; x += 96) e.sprite(f("skyline", "far"), x, GROUND - 40, { alpha: 0.7 });
for (let x = 30; x < W; x += 96) e.sprite(f("skyline", "near"), x, GROUND - 40);
e.sprite(f("castle", "castle"), 244, GROUND - 56);
for (let x = 0; x < W; x += 16) {
  e.sprite(f("tiles", "ground-top"), x, GROUND);
  e.sprite(f("tiles", "ground"), x, GROUND + 16);
}

// ---- the crowd, the flag, the cast and a block that just gave up its star ----
e.sprite(f("users-crowd", "cheer1"), 190, GROUND - 16);
e.sprite(f("props", "flagpole"), 214, GROUND - 32);
e.sprite(f("props", "flag1"), 214, GROUND - 32);
e.sprite(f("props", "lamp"), 10, GROUND - 32);
e.sprite(f("cast-designer", "idle0"), 40, GROUND - 24, { flip: true });
e.sprite(f("cast-developer", "idle1"), 64, GROUND - 24, { flip: true });
e.sprite(f("cast-founder", "give"), 150, GROUND - 24);
e.sprite(f("cast-investor", "idle0"), 170, GROUND - 24);
e.sprite(f("qblock", "used"), 104, GROUND - 42);
e.sprite(f("items", "star"), 106, GROUND - 56, { outline: "k" });
for (const [dx, dy] of [
  [-4, 2],
  [15, 0],
  [5, -5],
])
  e.px(106 + dx, GROUND - 54 + dy, e.RGB.B);

// ---- Pip and the crew: a white squircle with a crown, then seven discs, each with its mark ----
function disc(cx: number, cy: number, r: number, c: RGBT) {
  for (let y = -r; y < r; y++)
    for (let x = -r; x < r; x++) if ((x + 0.5) ** 2 + (y + 0.5) ** 2 <= r * r) e.px(cx + x, cy + y, c);
}
/** two "^" eyes, 3 px wide, 2 px tall */
function eyes(cx: number, cy: number, gap: number, c: RGBT) {
  for (const ex of [cx - gap, cx + gap]) {
    e.px(ex, cy, c);
    e.px(ex - 1, cy + 1, c);
    e.px(ex + 1, cy + 1, c);
  }
}
const MARK: Record<string, string[]> = {
  producer: ["#...#", "#####", "#...#"],
  writer: ["#.####..", "#.######", "#.####.."],
  artist: [".####.", "##.###", "######", ".###.."],
  animator: ["#...", "##..", "###.", "##..", "#..."],
  sound: ["..##", "..#.", "..#.", "###.", "###."],
  editor: ["##.##", "##.##", ".#.#.", "..#..", ".#.#."],
  reviewer: [".##..", "#..#.", "#..#.", ".##..", "...##"],
};
const CREW: [string, string][] = [
  ["producer", "#c46b7a"],
  ["writer", "#7f86d6"],
  ["artist", "#4b98cc"],
  ["animator", "#2f8a90"],
  ["sound", "#69a05e"],
  ["editor", "#a874b8"],
  ["reviewer", "#c27a43"],
];
const ink = e.RGB.K;

// Pip: 22×22 squircle at (16, 14), an accent ring, the crown on top
const PX = 16;
const PY = 16;
const PS = 22;
for (let y = -2; y < PS + 2; y++)
  for (let x = -2; x < PS + 2; x++) {
    const inside = (a: number, b: number, s: number, rad: number) => {
      const qx = Math.max(rad - a, 0, a - (s - 1 - rad));
      const qy = Math.max(rad - b, 0, b - (s - 1 - rad));
      return qx * qx + qy * qy <= rad * rad;
    };
    if (inside(x + 2, y + 2, PS + 4, 9)) e.px(PX + x, PY + y, e.RGB.G);
    if (inside(x + 1, y + 1, PS + 2, 8)) e.px(PX + x, PY + y, e.RGB.k);
    if (inside(x, y, PS, 7)) e.px(PX + x, PY + y, e.RGB.P);
  }
eyes(PX + 11, PY + 10, 4, ink);
e.sprite(["P..P..P", "PP.P.PP", "PPPPPPP", "PPPPPPP"], PX + 8, PY - 6, { colour: e.RGB.T });

// title and tagline beside Pip
e.text("PixelArtPitch", 48, 15, { scale: 3, colour: "P" });
e.text("Pitch videos made by a crew of AI agents.", 49, 44, { colour: "p" });

// the crew row, under the tagline
CREW.forEach(([id, hex], i) => {
  const cx = 57 + i * 17;
  const cy = 64;
  disc(cx, cy, 8, e.RGB.K);
  disc(cx, cy, 7, rgb(hex));
  eyes(cx, cy - 3, 2, ink);
  const m = MARK[id];
  e.sprite(
    m.map((r) => r.replaceAll("#", "K")),
    cx - Math.floor(m[0].length / 2),
    cy + 1,
  );
});
e.text("You watch, steer and pick.", 180, 61, { colour: "T" });

const png = encodePng(W * SCALE, H * SCALE, upscale(e.buf, SCALE, W, H));
writeFileSync(out, png);
console.log(`wrote ${out} (${W * SCALE}×${H * SCALE})`);
