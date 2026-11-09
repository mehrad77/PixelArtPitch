// The Scene Coder's asset lines say which way a character's art faces and what each asset is (v0.5.1).
import assert from "node:assert/strict";
import { test } from "node:test";
import { assetLines } from "../src/scene-code.ts";

test("asset lines name a character's facing and a one-line description", () => {
  const rows = ["....", "...."];
  const lines = assetLines(
    {
      assets: [
        ["hero", { idle0: rows, run0: rows }],
        ["npc", { idle0: rows }],
        ["logo", { icon: rows }],
      ],
      about: {
        hero: { kind: "character", description: "A hero in a hoodie. More detail here.", facing: "right" },
        npc: { kind: "character", description: "" },
        logo: { kind: "icon", description: "The person's logo." },
      },
    },
    ["hero", "npc", "logo", "nope"],
  );
  assert.deepEqual(lines, [
    "hero (4x2, faces right): idle0, run0 (A hero in a hoodie.)",
    "npc (4x2, faces left): idle0",
    "logo (4x2): icon (The person's logo.)",
  ]);
});

test("the example bundles load and draw clean in a trial render", async () => {
  const { mkdirSync, mkdtempSync, writeFileSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { loadProject } = await import("@pap/render");
  const { EXAMPLES, trialRender } = await import("../src/scene-code.ts");
  const { readFileSync } = await import("node:fs");
  const dir = mkdtempSync(join(tmpdir(), "pap-examples-"));
  mkdirSync(join(dir, "code"));
  const ids = ["quest", "three", "finale"];
  for (const id of ids)
    writeFileSync(
      join(dir, "code", `${id}.mjs`),
      'import { clear } from "pap:engine";\nexport function draw() { clear(); }\n',
    );
  const cues = [
    "QuestDay gives you three things to try.",
    "Stars for every task you finish today.",
    "Hearts from friends who cheer you on.",
    "QuestDay. Press start.",
  ];
  writeFileSync(
    join(dir, "pitch.json"),
    JSON.stringify({
      pap: 1,
      rev: 0,
      id: "t",
      title: "t",
      canvas: { w: 320, h: 180, fps: 30, palette: "pap-night@1" },
      brief: { idea: "test", lengthSec: 15 },
      script: { cues: cues.map((text, i) => ({ id: `c0${i + 1}`, text })), timing: { mode: "estimate" } },
      composition: { hold: 0.5, endHold: 3, duration: "E(c04)+endHold" },
      code: ids.map((id) => ({ id, file: `code/${id}.mjs` })),
      scenes: [
        { id: "quest", kind: "code", bundle: "quest", from: 0, to: "S(c03)", cues: ["c01", "c02"] },
        { id: "three", kind: "code", bundle: "three", from: "quest.to", to: "S(c04)", cues: ["c03"] },
        { id: "finale", kind: "code", bundle: "finale", from: "three.to", to: "duration", cues: ["c04"] },
      ],
      audio: { sfx: {} },
      assets: [
        { id: "hero", src: "lib:gamer@1" },
        { id: "items", src: "lib:items@1" },
        { id: "qblock", src: "lib:qblock@1" },
        { id: "tiles", src: "lib:tiles@1" },
        { id: "moon", src: "lib:moon@1" },
        { id: "logo", src: "lib:icons-product@1" },
        { id: "font", src: "lib:font-5x8@1" },
      ],
      budget: { capUsd: 0 },
    }),
  );
  const lp = loadProject(dir);
  for (const [file] of EXAMPLES) {
    const src = readFileSync(new URL(`../prompts/scene-coder/${file}`, import.meta.url), "utf8");
    const id = /SCENES\.find\(\(s\) => s\.id === "(\w+)"\)|const ID = "(\w+)"/.exec(src)!.slice(1).find(Boolean)!;
    const tr = await trialRender(lp, id, src);
    assert.deepEqual(tr.errors, [], file);
    assert.deepEqual(
      tr.warnings.filter((w) => /walk-glide|glides/.test(w)),
      [],
      file,
    );
    assert.ok(tr.sfx, `${file} has sound events`);
  }
});
