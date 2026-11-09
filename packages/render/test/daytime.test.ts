// Videos in the day and at dusk (v0.5.1): canvas.time picks the palette and the sky, each backdrop draws a day and a
// dusk frame, night stays as it was, and the library's art passes the sprite check on the new skies.
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { checkAsset } from "@pap/engine/standard";
import { Project, paletteFor } from "@pap/schema";
import { loadPalette, openDoc, openRenderer, PAP_ROOT } from "../src/index.ts";

const QUESTDAY = join(PAP_ROOT, "examples/questday");
const base = () => JSON.parse(readFileSync(join(QUESTDAY, "pitch.json"), "utf8"));
const px = (f: Buffer, x: number, y: number) =>
  `#${[...f.subarray((y * 320 + x) * 3, (y * 320 + x) * 3 + 3)].map((v) => v.toString(16).padStart(2, "0")).join("")}`;

/** the questday project with its first scene on one backdrop, at a time of day */
async function frameOf(recipe: string, time?: string, sky?: string) {
  const raw = base();
  if (time) raw.canvas.time = time;
  raw.scenes[0].recipes = [{ id: recipe, ...(sky ? { params: { sky } } : {}) }];
  const doc = Project.parse(raw);
  const r = await openRenderer(openDoc(QUESTDAY, doc));
  try {
    return await r.frame(1);
  } finally {
    r.close();
  }
}

test("paletteFor: a built-in palette follows canvas.time; another palette is kept", () => {
  assert.equal(paletteFor({ palette: "pap-night@1" }), "pap-night@1");
  assert.equal(paletteFor({ palette: "pap-night@1", time: "day" }), "pap-day@1");
  assert.equal(paletteFor({ palette: "pap-day@1", time: "dusk" }), "pap-dusk@1");
  assert.equal(paletteFor({ palette: "mine@2", time: "day" }), "mine@2");
  assert.equal(Project.parse(base()).canvas.time, undefined, "old projects carry no time");
});

test("the day and dusk palettes keep every night letter and hex", () => {
  const night = loadPalette("pap-night@1");
  for (const id of ["pap-day@1", "pap-dusk@1"]) {
    const p = loadPalette(id);
    for (const [k, v] of Object.entries(night.colours)) assert.equal(p.colours[k], v, `${id} ${k}`);
    assert.ok(Object.keys(p.colours).length > Object.keys(night.colours).length);
    assert.notEqual(p.sky, night.sky);
  }
});

test("each backdrop draws a day frame and a dusk frame; a scene's sky param overrides the video's", async () => {
  for (const recipe of ["backdrop_night", "backdrop_rooftop"]) {
    const night = await frameOf(recipe);
    const day = await frameOf(recipe, "day");
    const dusk = await frameOf(recipe, "dusk");
    assert.equal(px(day, 4, 2), "#3f86cf", `${recipe}: the day sky's top`);
    assert.equal(px(day, 4, 80), "#64a2da", `${recipe}: the day sky`);
    assert.equal(px(dusk, 4, 2), "#2a2a55", `${recipe}: the dusk sky's top`);
    assert.notEqual(px(night, 4, 2), "#3f86cf");
    // the sun by day (no moon), and nothing of the night's stars in the top band
    const top = new Set<string>();
    for (let y = 0; y < 40; y++) for (let x = 0; x < 320; x++) top.add(px(day, x, y));
    assert.ok(top.has("#ffe27a"), `${recipe}: a sun`);
    assert.ok(!top.has("#e6e4da"), `${recipe}: no stars or moon by day`);
    const own = await frameOf(recipe, undefined, "day");
    assert.equal(px(own, 4, 2), "#3f86cf", `${recipe}: sky: "day" on a night video`);
  }
});

test("the library's characters and props pass the sprite check on the day and dusk skies", () => {
  const lib = join(PAP_ROOT, "library");
  for (const id of ["pap-day@1", "pap-dusk@1"]) {
    const pal = loadPalette(id);
    for (const d of readdirSync(lib)) {
      const f = join(lib, d, "asset.json");
      if (!existsSync(f)) continue;
      const a = JSON.parse(readFileSync(f, "utf8"));
      if (!["character", "creature", "crowd", "prop", "icon", "block"].includes(a.kind)) continue;
      const r = checkAsset(a, { colours: pal.colours, sky: pal.sky });
      assert.deepEqual(
        r.hard.filter((i) => i.rule === "contrast"),
        [],
        `${d} on ${id}`,
      );
    }
  }
});
