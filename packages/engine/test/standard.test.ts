import assert from "node:assert/strict";
import { test } from "node:test";
import { framesToSheet, oklab, quantize, sliceSheet } from "../src/quantize.ts";
import { checkAsset } from "../src/standard.ts";
import { COLOURS, libAsset, libIndex, SKY } from "./helpers.ts";

const pal = { colours: COLOURS, sky: SKY };
const rulesOf = (a: unknown) => checkAsset(a, pal).hard.map((h) => h.rule);

test("every library asset meets the standard", () => {
  for (const { id } of libIndex) {
    const r = checkAsset(libAsset(id), pal);
    assert.ok(r.ok, `${id}: ${r.hard.map((h) => `${h.rule} ${h.frame ?? ""} ${h.message}`).join("; ")}`);
    assert.ok(r.soft.length > 0, `${id} has notes for the reviewer`);
  }
});

test("broken assets fail the rule they break, with a fix", () => {
  const mentor = libAsset("mentor-ai");
  const clone = () => structuredClone(mentor);

  const hero = clone();
  hero.tags = hero.tags.filter((t: string) => t !== "npc");
  assert.ok(rulesOf(hero).includes("frames"), "a hero needs run, jump and wave");

  const size = clone();
  size.w = 20;
  assert.ok(rulesOf(size).includes("size"));

  const hash = clone();
  hash.grid.idle0[3] = `#${hash.grid.idle0[3].slice(1)}`;
  assert.ok(rulesOf(hash).includes("legend"));

  const letter = clone();
  letter.grid.idle0[3] = `${letter.grid.idle0[3].slice(0, 15)}9`;
  assert.ok(rulesOf(letter).includes("legend"));

  const short = clone();
  short.grid.idle0 = short.grid.idle0.slice(1);
  assert.ok(rulesOf(short).includes("grid"));

  const floating = clone();
  floating.grid.idle0 = [...floating.grid.idle0.slice(1), "................"];
  assert.ok(rulesOf(floating).includes("feet"));

  const orphan = clone();
  orphan.grid.idle0[0] = "P...............";
  assert.ok(rulesOf(orphan).includes("orphans"));

  const swap = clone();
  swap.grid.idle1 = swap.grid.idle1.map((r: string) => r.replace(/[^.]/g, "P"));
  assert.ok(rulesOf(swap).includes("swap"));

  const dim = clone();
  dim.grid.idle0 = dim.grid.idle0.map((r: string) => r.replace(/[^.k]/g, "l"));
  assert.ok(rulesOf(dim).includes("contrast"));

  const rights = clone();
  rights.licence = " ";
  assert.ok(rulesOf(rights).includes("rights"));
  const noRights = clone();
  delete noRights.rights;
  assert.ok(rulesOf(noRights).includes("shape"));

  for (const h of checkAsset(floating, pal).hard) assert.ok(h.fix.length > 5);
});

test("quantize round-trips library sheets exactly", () => {
  for (const id of ["mentor-ai", "items", "props", "qblock", "castle"]) {
    const a = libAsset(id);
    const names = Object.keys(a.grid);
    const sheet = framesToSheet(
      names.map((n) => a.grid[n]),
      COLOURS,
      2,
    );
    const s = sliceSheet(sheet, a.w, a.h, COLOURS, { gap: 2, names, skipEmpty: false });
    assert.equal(s.maxErr < 1e-9, true, `${id} exact colours`);
    for (const n of names) assert.deepEqual(s.frames[n], a.grid[n], `${id}/${n}`);
  }
});

test("quantize maps near colours to the nearest letter and alpha to transparent", () => {
  const data = new Uint8Array([230, 228, 218, 255, 216, 168, 64, 255, 255, 0, 0, 10, 10, 13, 11, 200]);
  const q = quantize({ w: 4, h: 1, data }, COLOURS);
  assert.equal(q.rows[0], "PB.k");
  assert.ok(q.maxErr > 0 && q.maxErr < 0.05, String(q.maxErr));
  const [L] = oklab(255, 255, 255);
  assert.ok(Math.abs(L - 1) < 1e-3);
});
