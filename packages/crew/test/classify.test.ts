// The change router's tiers (docs/PIP-ORCHESTRATION.md §1.12): a fixture of real notes, each with the tier and the
// cost it should get. An edit costs no model call; a code scene that reads TIME follows the time of day by itself; a
// note on what some scenes show touches those scenes only; "every scene" means every scene. Pure: no model, no disk.
import assert from "node:assert/strict";
import { test } from "node:test";
import { changeKinds, classifyChange } from "../src/plan/classify.ts";

const { constantsOf, setConstants } = await import("@pap/tools");

/** QuestDay as four scenes: a recipe opening, two code scenes with a second player, a code finale with a castle */
const SRC: Record<string, string> = {
  board: `import { flag, skyGradient, sprite, frame, walk, text } from "pap:engine";
import { S, E } from "pap:timeline";
export const LOGO_X = 144;
export const LOGO_Y = 40;
export const HOLD_END = 1.5;
export function draw(t) {
  skyGradient();
  walk("hero", { x0: 60, x1: 60, t0: S("c02"), t1: E("c02"), t });
  walk("gamer", { x0: 90, x1: 90, t0: S("c02"), t1: E("c02"), t });
  sprite(frame("logo", "big"), LOGO_X, LOGO_Y);
}`,
  stars: `import { skyGradient, walk } from "pap:engine";
import { S, E } from "pap:timeline";
export function draw(t) {
  skyGradient();
  walk("hero", { x0: 40, x1: 200, t0: S("c03"), t1: E("c03"), t });
  walk("gamer", { x0: 20, x1: 180, t0: S("c03"), t1: E("c03"), t });
}`,
  finale: `import { clear, rect, walk, text } from "pap:engine";
import { S, E } from "pap:timeline";
export function draw(t) {
  clear(); // a fixed night sky
  rect(200, 100, 60, 48, "K"); // the castle
  rect(258, 52, 2, 48, "P"); // the flag's pole, a plain pennant
  walk("hero", { x0: 120, x1: 120, t0: S("c04"), t1: E("c04"), t });
}`,
};
const DOC = {
  scenes: [
    {
      id: "grind",
      kind: "decl",
      title: "A grind",
      cues: ["c01"],
      recipes: [
        { id: "backdrop_night", params: {} },
        { id: "walk_in", params: { faces: "left" } },
      ],
    },
    { id: "board", kind: "code", bundle: "board", title: "One quest board", cues: ["c02"], beat: "the board" },
    { id: "stars", kind: "code", bundle: "stars", title: "Stars", cues: ["c03"], beat: "three stars" },
    {
      id: "finale",
      kind: "code",
      bundle: "finale",
      title: "Raise the flag",
      cues: ["c04"],
      beat: "the hero raises a flag on the castle",
      endCard: true,
    },
  ],
  script: {
    cues: [
      { id: "c01", text: "Your to-do list feels like a grind." },
      { id: "c02", text: "QuestDay turns every task into a quest." },
      { id: "c03", text: "Clear tasks, colect stars, raise your flag." },
      { id: "c04", text: "QuestDay. Press start." },
    ],
    timing: { mode: "estimate", wps: 2.5, pause: 0.2, lead: 0.6, minCue: 1.1 },
  },
  composition: { hold: 3, endHold: 4 },
  code: [],
  assets: [{ id: "hero" }, { id: "gamer" }, { id: "logo" }, { id: "castle" }],
} as any;
/** the same video with the finale's sky drawn from TIME */
const withTime: Record<string, string> = {
  ...SRC,
  finale: SRC.finale.replace("clear(); // a fixed night sky", "skyGradient();"),
};

const FIXTURE: { note: string; scene?: string; src?: Record<string, string>; tier: string; scenes?: string[] }[] = [
  { note: "make it in daytime", src: withTime, tier: "edit", scenes: [] },
  { note: "make it in daytime", tier: "code_patch", scenes: ["finale"] },
  { note: "fix the typo in cue 3", tier: "edit", scenes: [] },
  { note: "move the logo up a bit", tier: "edit", scenes: ["board"] },
  { note: "take the extra gamer out of every scene", tier: "code_patch", scenes: ["board", "stars"] },
  { note: "put the logo on the castle's own flag", tier: "code_patch", scenes: ["finale"] },
  { note: "add a scene about our users", tier: "replan" },
  { note: "slower", tier: "edit", scenes: [] },
  { note: "hold the end longer", tier: "edit", scenes: [] },
  { note: "make the walk in feel livelier", scene: "grind", tier: "tune", scenes: ["grind"] },
  { note: "move the hero a bit to the right", scene: "grind", tier: "edit", scenes: ["grind"] },
  { note: "the stars should twinkle more", scene: "stars", tier: "code_patch", scenes: ["stars"] },
  { note: "add more energy to every scene", tier: "code_patch", scenes: ["grind", "board", "stars", "finale"] },
];

for (const f of FIXTURE)
  test(`classify "${f.note}"${f.scene ? ` on ${f.scene}` : ""}: ${f.tier}`, () => {
    const src = f.src ?? SRC;
    const c = classifyChange({ text: f.note, ...(f.scene ? { target: { scene: f.scene } } : {}) }, DOC, {
      source: (id) => src[id] ?? null,
    });
    assert.equal(c.tier, f.tier, c.how);
    if (f.scenes) assert.deepEqual(c.scenes, f.scenes, c.how);
    // the cost: an edit makes no model call ($0); everything else does
    assert.equal(changeKinds(c).length === 0, f.tier === "edit");
  });

test("an edit says how: the time's tool and input, the cue it rewrites, the constants it sets, the pace by rule", () => {
  const src = (id: string) => withTime[id] ?? null;
  const day = classifyChange({ text: "make it in daytime" }, DOC, { source: src });
  assert.deepEqual(day.edits, [{ tool: "look_set_time", input: { time: "day" } }]);
  assert.equal(day.time, "day");
  assert.deepEqual(classifyChange({ text: "fix the typo in cue 3" }, DOC).edits, [
    { tool: "script_set_cues", cues: ["c03"] },
  ]);
  assert.deepEqual(classifyChange({ text: "move the logo up a bit" }, DOC, { source: src }).edits, [
    { tool: "code_set_constants", scene: "board", names: ["LOGO_X", "LOGO_Y"] },
  ]);
  const slow = classifyChange({ text: "slower" }, DOC).edits![0] as any;
  assert.equal(slow.tool, "project_patch");
  assert.deepEqual(
    slow.input.ops.map((o: any) => [o.path, o.value]),
    [
      ["/script/timing/wps", 2.1],
      ["/script/timing/pause", 0.3],
    ],
  );
  const end = classifyChange({ text: "hold the end longer" }, DOC).edits![0] as any;
  assert.deepEqual(end.input.ops, [{ op: "replace", path: "/composition/endHold", value: 6 }]);
  // a narrated video's pace is the voice's: "slower" isn't a free edit there
  const aligned = { ...DOC, script: { ...DOC.script, timing: { ...DOC.script.timing, mode: "aligned" } } };
  assert.notEqual(classifyChange({ text: "slower" }, aligned).tier, "edit");
  // a code scene without named constants can't be moved by an edit: a patch
  assert.equal(
    classifyChange({ text: "move the hero up a bit", target: { scene: "stars" } }, DOC, { source: src }).tier,
    "code_patch",
  );
});

test("named constants: read the literals, set them as text, refuse an unknown name or another kind", () => {
  const cs = constantsOf(SRC.board);
  assert.deepEqual(
    cs.map((c) => [c.name, c.value]),
    [
      ["LOGO_X", 144],
      ["LOGO_Y", 40],
      ["HOLD_END", 1.5],
    ],
  );
  const r = setConstants(SRC.board, { LOGO_Y: 28 });
  assert.ok("source" in r);
  assert.match(r.source, /^export const LOGO_Y = 28;$/m);
  assert.equal(r.source.split("\n").length, SRC.board.split("\n").length, "only the one literal changes");
  const bad = setConstants(SRC.board, { LOGO_Z: 1 });
  assert.ok("error" in bad);
  assert.match(bad.fix, /use one of: LOGO_X = 144, LOGO_Y = 40, HOLD_END = 1\.5/);
  const kind = setConstants(SRC.board, { LOGO_Y: "up" });
  assert.ok("error" in kind && /a number/.test(kind.fix));
  const list = setConstants('export const CAST = ["hero", "gamer"];\nexport function draw() {}', { CAST: ["hero"] });
  assert.ok("source" in list);
  assert.match(list.source, /^export const CAST = \["hero"\];$/m);
});
