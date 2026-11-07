// The Reviewer's six blockers, through the real renderer: a project shaped like the crew run that showed them.
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { darkShare, lintFrames, lintProject, missingAssets } from "@pap/engine/lints";
import { buildRegistry, Workspace } from "../../tools/src/index.ts";
import { loadProject, openRenderer, subtitles } from "../src/index.ts";

const LIB = (id: string) => ({ id, src: `lib:${id}@1`, flags: { private: false } });

/** the questday_launch scenes that showed the bugs: a typographic cue, walk_in + item_collect on one hero, a long
 * banner, and flag_raise with its castle */
function projectDir(opts: { cue1?: string; assets?: string[] } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "pap-review-"));
  const assets = opts.assets ?? ["font", "mentor-validate", "items", "props", "moon", "skyline", "tiles", "castle"];
  writeFileSync(
    join(dir, "pitch.json"),
    JSON.stringify({
      pap: 1,
      rev: 0,
      id: "t",
      title: "t",
      canvas: { w: 320, h: 180, fps: 30, palette: "pap-night@1" },
      brief: { idea: "test", lengthSec: 10 },
      script: {
        cues: [
          { id: "c01", text: opts.cue1 ?? "Tired of boring to‑do lists?" },
          { id: "c02", text: "QuestDay turns chores into quests." },
          { id: "c03", text: "Collect stars, raise flags, finish happy." },
        ],
        timing: { mode: "estimate", wps: 2.5, pause: 0.2, lead: 0.6, minCue: 1.1 },
      },
      composition: { hold: 1, endHold: 1, duration: "E(c03)+endHold", dissolveIn: 0.3, fadeOut: 0.4 },
      scenes: [
        { id: "s1", kind: "decl", from: "0", to: "E(c01)+0.1", cues: ["c01"], recipes: [{ id: "backdrop_night" }] },
        {
          id: "s2",
          kind: "decl",
          from: "E(c01)+0.1",
          to: "E(c02)+0.1",
          cues: ["c02"],
          recipes: [
            { id: "backdrop_night", params: {} },
            { id: "walk_in", params: { hero: "mentor-validate", at: "S(c02)+0.4", arrive: "S(c02)+0.9" } },
            { id: "item_collect", params: { hero: "mentor-validate", at: "S(c02)+1.0", x: 120 } },
            { id: "banner", params: { text: "QuestDay turns chores into quests.", at: "S(c02)+1.2" } },
          ],
        },
        {
          id: "s3",
          kind: "decl",
          from: "E(c02)+0.1",
          to: "duration",
          cues: ["c03"],
          recipes: [{ id: "backdrop_night" }, { id: "flag_raise", params: { at: "S(c03)+0.5" } }],
        },
      ],
      audio: { sfx: {} },
      assets: assets.map((a) => (a === "font" ? { id: "font", src: "lib:font-5x8@1" } : LIB(a))),
      budget: { capUsd: 0 },
    }),
  );
  return dir;
}

test("the rendered project: a typographic cue draws like ASCII, the cuts are not black, the lints are clean", async () => {
  const fancy = loadProject(projectDir());
  const plain = loadProject(projectDir({ cue1: "Tired of boring to-do lists?" }));
  const [rf, rp] = await Promise.all([openRenderer(fancy), openRenderer(plain)]);
  try {
    // 1. the caption with a non-breaking hyphen is the same picture as with "-"
    assert.ok((await rf.frame(1.5)).equals(await rp.frame(1.5)));
    assert.match(subtitles(fancy).srt, /to-do/);
    // 5. no near-black frame at any cut: the dissolve shows the outgoing scene first
    const tl = fancy.timeline;
    const sky = fancy.palette.sky;
    for (const w of tl.scenes.slice(1))
      for (const t of [w.from, w.from + 1 / 30]) assert.ok(darkShare(await rf.frame(t), sky) < 0.5, `${w.id} at ${t}`);
    const frames = await lintFrames(tl, (t) => rf.frame(t), 1, { sky, fadeOut: fancy.doc.composition.fadeOut });
    assert.deepEqual(
      frames.filter((l) => l.rule === "empty-frame"),
      [],
    );
    // 2, 3, 4, 6: the scene sampler finds no twin, no covered face, no clipped text, nothing uncast
    const found = lintProject(fancy.doc, tl, {
      assets: fancy.assets,
      colours: fancy.palette.colours,
      sky,
    }).filter((l) =>
      ["duplicate-actor", "covers-face", "text-clipped", "missing-asset", "empty-frame"].includes(l.rule),
    );
    assert.deepEqual(found, []);
  } finally {
    rf.close();
    rp.close();
  }
});

test("without castle, moon, skyline and tiles the lints name them and cast_asset fills them from the library", async () => {
  const dir = projectDir({ assets: ["font", "mentor-validate", "items", "props"] });
  const workspace = new Workspace(() => []);
  const p = workspace.openDir(dir);
  try {
    const lib = new Set(["castle", "moon", "skyline", "tiles", "props", "items", "font-5x8", "mentor-validate"]);
    const miss = missingAssets(p.doc(), p.timeline().at, lib);
    assert.deepEqual([...new Set(miss.map((m) => m.id))].sort(), ["castle", "moon", "skyline", "tiles"]);
    // the orchestrator's post-board step: cast every one the library has
    const registry = buildRegistry();
    const ctx = { author: { kind: "user" as const }, project: p, workspace, emit: () => {} };
    for (const m of miss)
      if (m.libraryId && !p.doc().assets.some((a) => a.id === m.id)) {
        const r = await registry.call("cast_asset", { name: m.id, libraryId: m.libraryId }, ctx);
        assert.ok(r.ok);
      }
    assert.deepEqual(missingAssets(p.doc(), p.timeline().at, lib), []);
    // and the stored cues come out plain
    const r = await registry.call(
      "script_set_cues",
      { cues: [{ text: "Tired of boring to‑do lists…" }, { text: "“Quests” now." }, { text: "Go." }], reason: "test" },
      ctx,
    );
    assert.ok(r.ok);
    assert.deepEqual(
      p.doc().script.cues.map((c) => c.text),
      ["Tired of boring to-do lists...", '"Quests" now.', "Go."],
    );
  } finally {
    workspace.closeAll();
  }
});
