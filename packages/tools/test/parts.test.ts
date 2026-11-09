// Parts (docs/GLOSSARY.md): what a project has, from its document, scene status, patch history and versions, never
// from the crew's stage. A handmade project reads as far as its content goes.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

const home = mkdtempSync(join(tmpdir(), "pap-parts-"));
process.env.PAP_HOME = home;
after(() => rmSync(home, { recursive: true, force: true }));
const { partsOf, newProjectDoc } = await import("../src/index.ts");
const { Project } = await import("@pap/schema");

/** a handmade project shaped like GameScrobbler × Divan: code scenes, its own art, the person's aligned narration */
function handmade(over: Record<string, unknown> = {}) {
  const cues = Array.from({ length: 6 }, (_, n) => ({ id: `c0${n + 1}`, text: `Line ${n + 1} of the pitch.` }));
  return Project.parse({
    pap: 1,
    rev: 0,
    id: "handmade",
    title: "Handmade",
    canvas: { w: 320, h: 180, fps: 30 },
    brief: { idea: "A game scrobbler for a hackathon", lengthSec: 30, narration: "user" },
    script: {
      cues,
      timing: { mode: "aligned", aligned: Object.fromEntries(cues.map((c, n) => [c.id, [n * 2, n * 2 + 1.5]])) },
    },
    composition: { duration: "E(c06)+endHold" },
    code: [{ id: "legacy", file: "code/legacy.mjs", sfx: true }],
    scenes: [
      { id: "title", kind: "code", bundle: "legacy", from: 0, to: "S(c03)", cues: ["c01", "c02"] },
      { id: "end", kind: "code", bundle: "legacy", from: "S(c03)", to: "duration", cues: ["c03", "c04", "c05", "c06"] },
    ],
    audio: {
      sfx: { source: "legacy" },
      music: { generator: "chip-bed", settle: "end" },
      vo: [{ file: "private/vo.wav", offset: 0 }],
    },
    assets: [
      { id: "hero", src: "file:assets/hero.json" },
      { id: "moon", src: "lib:moon@1" },
    ],
    budget: { capUsd: 5 },
    ...over,
  });
}
const states = (r: { parts: { id: string; state: string }[] }) =>
  Object.fromEntries(r.parts.map((p) => [p.id, p.state]));

test("a handmade project with no state: Idea, Story, Pictures and Sound ready, Video missing", () => {
  const r = partsOf({ doc: handmade() });
  assert.deepEqual(states(r), { idea: "ready", story: "ready", pictures: "ready", sound: "ready", video: "missing" });
  assert.equal(r.next, "review");
  const pics = r.parts.find((p) => p.id === "pictures")!;
  assert.equal(pics.done, 2);
  assert.equal(pics.of, 2);
});

test("an asset that doesn't resolve, or missing code, keeps its scenes out of Pictures", () => {
  const noHero = partsOf({ doc: handmade(), resolves: (src) => src !== "file:assets/hero.json" });
  assert.equal(states(noHero).pictures, "partial");
  assert.equal(noHero.next, "art");
  const noCode = partsOf({ doc: handmade(), resolves: (src) => !src.startsWith("file:code/") });
  assert.equal(noCode.parts.find((p) => p.id === "pictures")!.done, 0);
});

test("a stale scene makes Pictures partial and Video stale", () => {
  const doc = handmade();
  const versions = [{ v: 1, rev: 0, at: "2026-11-09T10:00:00.000Z", file: "out/versions/v1.mp4", sec: 30, sha1: "x" }];
  assert.equal(states(partsOf({ doc, versions })).video, "ready");
  const r = partsOf({
    doc,
    versions,
    sceneStatus: { title: { version: "render", state: "ready" }, end: { version: "animatic", state: "stale" } },
  });
  assert.equal(states(r).pictures, "partial");
  assert.equal(r.parts.find((p) => p.id === "pictures")!.done, 1);
  assert.equal(states(r).video, "stale");
  assert.equal(r.next, "art");
});

test("a scene the crew is redrawing (drafting) keeps Video stale", () => {
  const doc = handmade();
  const versions = [{ v: 1, rev: 0, at: "2026-11-09T10:00:00.000Z", file: "out/versions/v1.mp4", sec: 30, sha1: "x" }];
  const r = partsOf({
    doc,
    versions,
    sceneStatus: { title: { version: "render", state: "ready" }, end: { version: "animatic", state: "drafting" } },
  });
  assert.equal(states(r).video, "stale");
});

test("a scene the crew has only boarded isn't a picture yet", () => {
  const r = partsOf({
    doc: handmade(),
    sceneStatus: { title: { version: "render", state: "ready" }, end: { version: "board", state: "ready" } },
  });
  assert.equal(states(r).pictures, "partial");
  // the animatic is a finished picture: a crew's export plays it when no tune pass ran
  const animated = partsOf({
    doc: handmade(),
    sceneStatus: { title: { version: "render", state: "ready" }, end: { version: "animatic", state: "ready" } },
  });
  assert.equal(states(animated).pictures, "ready");
});

test("a script edit after the board makes Story stale; a board after it makes it ready again", () => {
  // the edit added a cue no scene carries yet
  const base = handmade();
  const doc = handmade({
    script: {
      ...base.script,
      cues: [...base.script.cues, { id: "c07", text: "One more line." }],
      timing: { mode: "estimate" },
    },
    brief: { ...base.brief, narration: "none" },
  });
  const board = { seq: 1, baseRev: 0, ops: [{ path: "/scenes/0/to" }] };
  const cue = { seq: 2, baseRev: 1, ops: [{ path: "/script/cues" }] };
  assert.equal(states(partsOf({ doc, history: [board, cue] })).story, "stale");
  assert.equal(partsOf({ doc, history: [board, cue] }).next, "script");
  // the script came first (the normal order), or the board followed the edit
  assert.equal(states(partsOf({ doc, history: [{ ...cue, seq: 0 }, board] })).story, "ready");
  assert.equal(states(partsOf({ doc, history: [board, cue, { ...board, seq: 3 }] })).story, "ready");
  // lining narration up to the cues isn't a script edit
  assert.equal(
    states(partsOf({ doc, history: [board, { seq: 2, baseRev: 1, ops: [{ path: "/script/timing/aligned" }] }] })).story,
    "ready",
  );
});

test("a caption fix after the board (the same cues, new words) keeps Story ready", () => {
  const doc = handmade();
  const board = { seq: 1, baseRev: 0, ops: [{ path: "/scenes/0/to" }] };
  // the Editor's script_set_cues at review replaces /script/cues with the same ids
  const fix = { seq: 2, baseRev: 1, ops: [{ path: "/script/cues" }, { path: "/script/timing/mode" }] };
  const r = partsOf({ doc, history: [board, fix] });
  assert.equal(states(r).story, "ready");
  assert.equal(r.next, "review");
});

test("the person's narration: every cue aligned to the take is ready, some is partial, none is missing", () => {
  const all = handmade();
  assert.equal(states(partsOf({ doc: all })).sound, "ready");
  const some = handmade({
    script: { ...all.script, timing: { ...all.script.timing, aligned: { c01: [0, 1], c02: [2, 3] } } },
  });
  const r = partsOf({ doc: some });
  assert.equal(states(r).sound, "partial");
  assert.deepEqual([r.parts[3].done, r.parts[3].of], [2, 6]);
  // no take yet, but a music bed: partial
  assert.equal(states(partsOf({ doc: handmade({ audio: { ...all.audio, vo: [] } }) })).sound, "partial");
  // no audio at all
  assert.equal(
    states(partsOf({ doc: handmade({ audio: { sfx: { source: "doc", events: [] }, music: null, vo: [] } }) })).sound,
    "missing",
  );
  // no narration asked for: the bed is enough
  assert.equal(
    states(partsOf({ doc: handmade({ brief: { ...all.brief, narration: "none" }, audio: { ...all.audio, vo: [] } }) }))
      .sound,
    "ready",
  );
});

test("Video: older than a change the export uses, not one it doesn't", () => {
  const doc = handmade({ rev: 3 });
  const versions = [
    { v: 1, rev: 1, at: "2026-11-09T10:00:00.000Z", file: "out/versions/v1.mp4", sec: 30, sha1: "a" },
    { v: 2, rev: 2, at: "2026-11-09T11:00:00.000Z", file: "out/versions/v2.mp4", sec: 30, sha1: "b" },
  ];
  const note = [{ seq: 5, baseRev: 2, ops: [{ path: "/notes/0" }] }];
  assert.equal(states(partsOf({ doc, versions, history: note })).video, "ready");
  const cut = [{ seq: 5, baseRev: 2, ops: [{ path: "/composition/endHold" }] }];
  const r = partsOf({ doc, versions, history: cut });
  assert.equal(states(r).video, "stale");
  assert.match(r.parts[4].why ?? "", /v2/);
  // a rev with no patch on record (pitch.json edited by hand) counts as a change
  assert.equal(states(partsOf({ doc, versions })).video, "stale");
  assert.equal(states(partsOf({ doc: handmade({ rev: 2 }), versions })).video, "ready");
});

test("a new project isn't ready for anything but its idea", () => {
  const doc = newProjectDoc({
    title: "New one",
    brief: { idea: "A pitch", lengthSec: 30 } as any,
    budgetUsd: 2,
  });
  const r = partsOf({ doc });
  assert.deepEqual(states(r), {
    idea: "ready",
    story: "missing",
    pictures: "missing",
    sound: "missing",
    video: "missing",
  });
  assert.equal(r.next, "script");
});

test("a declarative scene counts what its recipes draw", () => {
  const base = newProjectDoc({ title: "Decl", brief: { idea: "A pitch", lengthSec: 30 } as any, budgetUsd: 2 });
  const doc = { ...base, script: { ...base.script, cues: [{ id: "c01", text: "The night market opens." }] } };
  assert.equal(states(partsOf({ doc })).pictures, "ready");
  // without the moon in the project, the backdrop draws a placeholder box
  const r = partsOf({ doc, resolves: (src) => src !== "lib:moon@1" });
  assert.equal(states(r).pictures, "partial");
  assert.match(r.parts[2].why ?? "", /moon/);
});
