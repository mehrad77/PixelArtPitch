import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { Project, resolveTimeline } from "@pap/schema";
import { type Lint, lintFrames, lintProject } from "../src/lints.ts";
import { ASSETS, COLOURS, oneScene, project, ROOT, SKY, timeline } from "./helpers.ts";

const opts = { assets: ASSETS, colours: COLOURS, sky: SKY };
const rules = (ls: Lint[]) => ls.map((l) => l.rule);
const lint = (doc: ReturnType<typeof project>, o: object = opts) => lintProject(doc, timeline(doc), o);

test("the public example has no lint errors or warnings", () => {
  const doc = Project.parse(JSON.parse(readFileSync(join(ROOT, "examples/questday/pitch.json"), "utf8")));
  const found = lintProject(doc, resolveTimeline(doc), opts);
  assert.deepEqual(found, []);
});

test("raw seconds in decl scenes", () => {
  const doc = oneScene({
    recipes: [{ id: "banner", params: { text: "GO", at: 1.5 } }],
    layers: [
      {
        id: "a",
        kind: "text",
        props: { text: "HI" },
        behaviors: [
          { kind: "appear", at: "2.5" },
          { kind: "pulse", at: 0 },
        ],
      },
    ],
  });
  const raw = lint(doc).filter((l) => l.rule === "raw-seconds");
  assert.equal(raw.length, 2, JSON.stringify(raw));
  assert.ok(raw.every((l) => l.severity === "error" && /S\(c01\)/.test(l.fix)));
});

test("two long texts at once, clipped text and the caption zone", () => {
  const doc = oneScene({
    layers: [
      { id: "one", kind: "text", props: { text: "THIS IS FOUR WORDS", y: 20 } },
      { id: "two", kind: "text", props: { text: "AND SO IS THIS", y: 40 } },
      { id: "wide", kind: "text", props: { text: "FAR TOO WIDE", x: 300, scale: 3, y: 60 } },
      { id: "low", kind: "text", props: { text: "LOW", y: 150 } },
    ],
  });
  const r = rules(lint(doc));
  assert.ok(r.includes("text-crowding"));
  assert.ok(r.includes("text-clipped"));
  assert.ok(r.includes("caption-zone"));
});

test("cues too long or too short", () => {
  const doc = project(
    [{ id: "s", kind: "decl", from: 0, to: "duration" }],
    ["one two three four five six seven eight nine ten eleven twelve thirteen", "Go."],
    {
      script: {
        cues: [
          { id: "c01", text: "one two three four five six seven eight nine ten eleven twelve thirteen" },
          { id: "c02", text: "Go." },
        ],
        timing: { mode: "estimate" },
      },
    },
  );
  const r = rules(lint(doc));
  assert.ok(r.includes("cue-long"));
  assert.ok(r.includes("cue-short"));
});

test("scenes that overlap or leave a gap", () => {
  const gap = project([
    { id: "a", kind: "decl", from: 0, to: "E(c01)" },
    { id: "b", kind: "decl", from: "E(c01)+0.5", to: "duration" },
  ]);
  assert.ok(rules(lint(gap)).includes("scene-gap"));
  const overlap = project([
    { id: "a", kind: "decl", from: 0, to: "E(c01)" },
    { id: "b", kind: "decl", from: "E(c01)-0.5", to: "duration" },
  ]);
  const o = lint(overlap).find((l) => l.rule === "scene-overlap")!;
  assert.match(o.fix, /a\.to/);
  const short = project([{ id: "a", kind: "decl", from: 0, to: "E(c01)" }]);
  assert.ok(rules(lint(short)).includes("scene-gap"));
});

test("recipe params out of range, compile errors and missing assets", () => {
  const doc = oneScene({
    recipes: [
      { id: "walk_in", params: { speed: 900 } },
      { id: "crowd_cheer", params: { count: 9 } },
    ],
  });
  const found = lint(doc).filter((l) => l.rule === "recipe-params");
  assert.equal(found.length, 2);
  assert.ok(found.every((l) => /from \d+ to \d+/.test(l.fix)));
  const noCastle = oneScene({ recipes: [{ id: "flag_raise" }] });
  noCastle.assets = noCastle.assets.filter((a) => a.id !== "castle");
  const miss = lint(noCastle).find((l) => l.rule === "missing-asset")!;
  assert.match(miss.fix, /lib:castle@1/);
});

test("a sprite that disappears into the sky", () => {
  const dark = { ...Object.fromEntries(ASSETS), ghost: { idle0: ["..llll..", ".lllllll", "llllllll", ".llllll."] } };
  const doc = oneScene({ layers: [{ id: "g", kind: "sprite", props: { asset: "ghost", x: 100, y: 60 } }] });
  doc.assets.push({ id: "ghost", src: "file:assets/ghost.json", flags: { private: false } });
  const found = lintProject(doc, timeline(doc), { ...opts, assets: Object.entries(dark) }).find(
    (l) => l.rule === "edge-contrast",
  );
  assert.ok(found, "edge contrast flagged");
});

test("flat frames from a sampler", async () => {
  const doc = oneScene({});
  const flat = new Uint8Array(320 * 180 * 3).fill(9);
  const found = await lintFrames(timeline(doc), () => flat, 2);
  assert.ok(found.length > 0 && found.every((l) => l.rule === "blank-frame"));
});
