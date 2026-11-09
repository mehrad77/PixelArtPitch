// Logos that read (v0.5.1): an SVG upload is kept and drawn at 512 px, a flat background is cleared before
// quantizing, and the import makes a 16x16 icon and a 32x32 big frame from the full image.
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { deflateSync } from "node:zlib";
import { checkAsset } from "@pap/engine/standard";
import { DraftStore } from "@pap/tools/drafts";
import { isSvg, rasterizeSvg } from "@pap/tools/svg";
import { decodePng, logoFrames } from "../src/plan/import.ts";

const COLOURS = { k: "#090c0a", P: "#e6e4da", G: "#2c7a53", O: "#ff6b3d", B: "#d6a642", W: "#c9c6bc" };
const SVG = `<?xml version="1.0"?>
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" width="100" height="100">
  <circle cx="50" cy="50" r="40" fill="#ff6b3d"/><rect x="40" y="40" width="20" height="20" fill="#d6a642"/>
</svg>`;

/** an 8-bit RGBA PNG from a pixel function (no filters; decodePng doesn't check CRCs) */
function pngOf(w: number, h: number, px: (x: number, y: number) => number[]) {
  const raw = Buffer.alloc(h * (w * 4 + 1));
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) raw.set(px(x, y), y * (w * 4 + 1) + 1 + x * 4);
  const chunk = (kind: string, data: Buffer) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    return Buffer.concat([len, Buffer.from(kind, "latin1"), data, Buffer.alloc(4)]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr.set([8, 6, 0, 0, 0], 8);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

test("an SVG is drawn to a 512 px PNG with a transparent surround", () => {
  assert.ok(isSvg(Buffer.from(SVG)));
  assert.ok(!isSvg(Buffer.from("<html><svg></svg></html>")));
  const img = decodePng(rasterizeSvg(SVG));
  assert.deepEqual([img.w, img.h], [512, 512]);
  assert.equal(img.data[3], 0, "the corner is clear");
  assert.equal(img.data[(256 * 512 + 256) * 4 + 3], 255, "the middle is drawn");
});

test("an SVG upload is kept as the source; one that can't be drawn is refused with a fix", () => {
  const store = new DraftStore(mkdtempSync(join(tmpdir(), "pap-svg-")));
  const d = store.create();
  const ref = store.addFile(d.id, "gs.svg", Buffer.from(SVG), "logo");
  assert.equal(ref.name, "gs.svg");
  assert.throws(
    () => store.addFile(d.id, "bad.svg", Buffer.from("not an svg at all"), "logo"),
    (e: any) => e.code === "bad_image" && /PNG/.test(e.fix),
  );
});

test("a white-backed logo comes out with a transparent surround; a full-bleed one keeps its edge", () => {
  // an orange disc with a brass core on a white square
  const disc = pngOf(64, 64, (x, y) => {
    const d = Math.hypot(x - 32, y - 32);
    return d < 8 ? [214, 166, 66, 255] : d < 24 ? [255, 107, 61, 255] : [255, 255, 255, 255];
  });
  const f = logoFrames(disc, COLOURS);
  assert.ok(f.background.cleared > 0);
  assert.equal(f.icon[0][0], ".", "the white corner is gone");
  assert.equal(f.big[0][0], ".");
  assert.ok(!f.big.join("").includes("P") && !f.big.join("").includes("W"), "no white left round the disc");
  assert.equal(f.big[16][16], "B", "the core stays");
  // a striped edge (the logo's own shape reaching it) is left alone
  const striped = pngOf(64, 64, (x, y) => ((x + y) % 16 < 8 ? [255, 255, 255, 255] : [44, 122, 83, 255]));
  const s = logoFrames(striped, COLOURS);
  assert.equal(s.background.cleared, 0);
  assert.match(String(s.background.skipped), /edge/);
});

test("the import's frames: icon 16x16 and big 32x32 from the full image, and the standard takes them", () => {
  const f = logoFrames(Buffer.from(SVG), COLOURS);
  assert.equal(f.icon.length, 16);
  assert.ok(f.icon.every((r) => r.length === 16));
  assert.equal(f.big.length, 32);
  assert.ok(f.big.every((r) => r.length === 32));
  // big is downscaled from the 512 px raster, not an upscale of the icon: it has detail the icon can't
  const up = f.icon.flatMap((r) => [r, r]).map((r) => [...r].map((c) => c + c).join(""));
  assert.notDeepEqual(f.big, up);
  const std = checkAsset(
    {
      id: "logo",
      version: 1,
      kind: "icon",
      w: 16,
      h: 16,
      frames: ["icon", "big"],
      palette: "pap-night@1",
      tags: ["icon"],
      description: "a logo",
      licence: "LicenseRef-Private",
      rights: { likeness: false, brand: true, trademark: true, public: false },
      provenance: { source: "imported" },
      hash: "x",
      standard: null,
      grid: { icon: f.icon, big: f.big },
    },
    { colours: COLOURS, sky: "#0f1411" },
  );
  assert.deepEqual(
    std.hard.filter((i) => i.rule === "grid"),
    [],
  );
});
