// The rooftop backdrop, the fly and sit behaviours, the glow fx and the label sign.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { Behavior, type DeclSceneT, Project, resolveTimeline } from "@pap/schema";
import { createEngine, type Frames } from "../src/core.ts";
import { actorFrame, compileDecl, DeclError, drawDecl, inspectDecl, motionFrames } from "../src/decl.ts";
import { BEHAVIOR_SPECS, GROUND } from "../src/decl-spec.ts";
import { lintProject } from "../src/lints.ts";
import { ASSETS, COLOURS, libAsset, oneScene, ROOT, SKY, timeline } from "./helpers.ts";

/** a creature drawn the way the creature kind draws one; each frame family has its own size so a box tells them apart */
const grid = (w: number, h: number, c: string) => Array.from({ length: h }, () => c.repeat(w));
const CREATURE: Frames = {
  idle0: grid(5, 5, "P"),
  idle1: grid(5, 5, "p"),
  // the move frames carry a "G" column on their right (front) edge, so a mirrored draw shows
  move0: grid(6, 4, "T").map((r) => `${r}G`),
  move1: grid(6, 4, "T").map((r) => `${r}G`),
  move2: grid(6, 4, "T").map((r) => `${r}G`),
  move3: grid(6, 4, "T").map((r) => `${r}G`),
  perch0: grid(4, 6, "B"),
  perch1: grid(4, 6, "h"),
};
const OWL: Frames = libAsset("owl").grid;
const EXTRA: [string, Frames][] = [
  ["bug", CREATURE],
  ["owl", OWL],
  ["moth", libAsset("moth").grid],
];
const eng = () =>
  createEngine({ colours: COLOURS, sky: SKY, assets: new Map([...ASSETS, ...EXTRA]), fontAssets: ["font"] });
const compile = (scene: Record<string, unknown>) => {
  const doc = oneScene(scene);
  return compileDecl(doc.scenes[0] as DeclSceneT, timeline(doc).at);
};
const issuesOf = (scene: Record<string, unknown>) => {
  try {
    compile(scene);
  } catch (e) {
    assert.ok(e instanceof DeclError, String(e));
    for (const i of e.issues) assert.ok(i.fix.length > 3, `issue without a fix: ${i.message}`);
    return e.issues;
  }
  assert.fail("expected a DeclError");
};
const PALETTE = new Set(Object.values(COLOURS).map((h) => h.toLowerCase()));
const hexAt = (buf: Uint8Array, x: number, y: number) => {
  const i = (y * 320 + x) * 3;
  return `#${[buf[i], buf[i + 1], buf[i + 2]].map((v) => v.toString(16).padStart(2, "0")).join("")}`;
};
const box = (cs: ReturnType<typeof compile>, id: string, t: number) =>
  inspectDecl(eng(), cs, t).find((x) => x.id === id);
/** centre x of a layer's box */
const cx = (b: { x: number; w: number }) => b.x + Math.floor(b.w / 2);

test("the behaviour menu and the schema's behaviour kinds agree", () => {
  assert.deepEqual(Object.keys(BEHAVIOR_SPECS).sort(), [...Behavior.shape.kind.options].sort());
});

test("older backdrops and effects compile exactly as before (the new props have no defaults)", () => {
  const cs = compile({
    layers: [
      { id: "sky", kind: "backdrop", props: {} },
      { id: "spark", kind: "fx", props: { fx: "sparkle" } },
    ],
  });
  assert.ok(!("chimneys" in cs.layers[0].props));
  for (const k of ["tones", "pulse", "period"]) assert.ok(!(k in cs.layers[1].props), k);
});

test("the rooftop backdrop: a palette roof on the feet line, lit from the upper left, with chimneys", () => {
  const e = eng();
  const cs = compile({ recipes: [{ id: "backdrop_rooftop" }] });
  assert.deepEqual(cs.assets, ["moon", "skyline"]);
  assert.ok(!cs.layers.some((l) => l.kind === "tiled"), "no street tiles under a roof");
  drawDecl(e, cs, 1);
  // every cell from the ridge down is an exact palette colour
  for (let y = GROUND; y < 180; y++)
    for (let x = 0; x < 320; x++) assert.ok(PALETTE.has(hexAt(e.buf, x, y)), `${x},${y} ${hexAt(e.buf, x, y)}`);
  const lum = (h: string) => Number.parseInt(h.slice(1, 3), 16) + Number.parseInt(h.slice(3, 5), 16);
  // the ridge's lit top is brighter than its shaded underside
  assert.ok(lum(hexAt(e.buf, 4, GROUND)) > lum(hexAt(e.buf, 4, GROUND + 2)));
  // the default chimney at x=252: a lit left column of brick, a dark right edge
  assert.equal(hexAt(e.buf, 253, GROUND - 10), COLOURS.r);
  assert.equal(hexAt(e.buf, 265, GROUND - 10), COLOURS.k);
  // and none with chimneys: []
  drawDecl(e, compile({ recipes: [{ id: "backdrop_rooftop", params: { chimneys: [] } }] }), 1);
  assert.notEqual(hexAt(e.buf, 253, GROUND - 10), COLOURS.r);
  const bad = issuesOf({ layers: [{ id: "a", kind: "backdrop", props: { style: "rooftop", chimneys: ["x"] } }] });
  assert.match(bad[0].path, /chimneys\[0\]/);
});

test("glow: palette bands only, brightest at the core, never darkening, breathing with pulse", () => {
  const base = { layers: [{ id: "sky", kind: "backdrop", z: -100, props: { style: "plain" } }] };
  const glow = (props: Record<string, unknown>) => ({
    layers: [...base.layers, { id: "g", kind: "fx", props: { fx: "glow", x: 160, y: 80, size: 20, ...props } }],
  });
  const e = eng();
  const cs = compile(glow({ pulse: 3, period: 1 }));
  const lit: number[] = [];
  for (const t of [0.5, 0.75, 1, 1.25]) {
    drawDecl(e, cs, t);
    let n = 0;
    for (let y = 0; y < 180; y++)
      for (let x = 0; x < 320; x++) {
        const h = hexAt(e.buf, x, y);
        if (h === SKY) continue;
        assert.ok(PALETTE.has(h), `t=${t} ${x},${y}: ${h} is not a palette colour`);
        n++;
      }
    lit.push(n);
  }
  assert.ok(new Set(lit).size > 1, `the pulse changes the size: ${lit}`);
  drawDecl(e, compile(glow({})), 1);
  assert.equal(hexAt(e.buf, 160, 80), COLOURS.H, "core");
  assert.equal(hexAt(e.buf, 160 + 19, 80), COLOURS.A, "outer band");
  assert.equal(hexAt(e.buf, 160 + 25, 80), SKY, "nothing past the radius");
  // a brighter thing under the glow keeps its colour
  const over = compile({
    layers: [
      ...base.layers,
      { id: "card", kind: "shape", z: -1, props: { x: 170, y: 70, w: 6, h: 6, colour: "P" } },
      { id: "g", kind: "fx", props: { fx: "glow", x: 160, y: 80, size: 20, tones: ["A", "n"] } },
    ],
  });
  drawDecl(e, over, 1);
  assert.equal(hexAt(e.buf, 172, 72), COLOURS.P);
  const bad = issuesOf(glow({ tones: ["#ff6b3d"] }));
  assert.match(bad[0].fix, /palette letters/);
});

test("glow lints: tones outside the palette, brass or orange outside the core", () => {
  const doc = oneScene({
    layers: [
      { id: "g", kind: "fx", props: { fx: "glow", x: 60, y: 60, tones: ["A", "Z"] } },
      { id: "h", kind: "fx", props: { fx: "glow", x: 200, y: 60, tones: ["O", "n", "H"] } },
    ],
  });
  const found = lintProject(doc, timeline(doc), { assets: ASSETS, colours: COLOURS, sky: SKY }).filter(
    (l) => l.rule === "glow-tones",
  );
  assert.deepEqual(
    found.map((l) => l.severity),
    ["error", "warn"],
  );
});

test("frames for fly and sit: move, then run, then idle; perch, then idle", () => {
  assert.deepEqual(motionFrames(CREATURE, "fly", []), ["move0", "move1", "move2", "move3"]);
  assert.deepEqual(motionFrames(CREATURE, "perch", []), ["perch0", "perch1"]);
  assert.deepEqual(motionFrames(OWL, "fly", []), ["run0", "run1", "run2", "run3"]);
  assert.deepEqual(motionFrames(OWL, "perch", []), ["idle0", "idle1"]);
  assert.deepEqual(motionFrames({ only: ["P"] }, "fly", ["only"]), ["only"]);
  const props = { runFps: 10, idleFps: 2.5, frames: {} };
  const fly = (t: number) => actorFrame(CREATURE, props, { motion: "fly", motionT0: 0, mfps: 8 }, t).name;
  assert.deepEqual([0, 0.13, 0.26, 0.38, 0.5].map(fly), ["move0", "move1", "move2", "move3", "move0"]);
  assert.equal(actorFrame(CREATURE, props, { motion: "perch", motionT0: 0, mfps: 1 }, 1.2).name, "perch1");
  // an actor's own frame lists win
  const own = { ...props, frames: { fly: ["idle1"] } };
  assert.equal(actorFrame(CREATURE, own, { motion: "fly", motionT0: 0 }, 0.3).name, "idle1");
});

test("fly: drifts through its path, turns to face it, bobs, cycles move frames and holds after until", () => {
  const cs = compile({
    layers: [
      {
        id: "bug",
        kind: "sprite",
        props: { asset: "bug", x: 40, y: 60, anchor: "center" },
        behaviors: [
          {
            kind: "fly",
            at: "S(c01)",
            until: "S(c01)+3",
            params: {
              path: [
                [160, 60],
                [100, 60],
              ],
              speed: 90,
              bob: 0,
            },
          },
        ],
      },
    ],
  });
  const t0 = cs.layers.find((l) => l.id === "bug")!.behaviors[0].at;
  const at = (s: number) => box(cs, "bug", t0 + s)!;
  assert.equal(at(-0.1).w, 5, "idle before take-off");
  assert.equal(at(0.5).w, 7, "move frames in flight");
  assert.ok(at(0.5).x > at(0.1).x && at(1).x > at(0.5).x, "heads right");
  assert.ok(at(1.8).x < at(1.5).x, "then back left");
  assert.equal(cx(at(2.9)), 100, "arrives at the last point");
  assert.equal(cx(at(3.5)), 100, "holds there after until");
  assert.equal(at(3.5).w, 5, "and goes back to idle frames");
  // it turns to face where it flies: the front column is on the right going right, on the left coming back
  const e = eng();
  const front = (s: number) => {
    drawDecl(e, cs, t0 + s);
    const b = at(s);
    return [hexAt(e.buf, b.x, b.y + 1), hexAt(e.buf, b.x + b.w - 1, b.y + 1)];
  };
  assert.deepEqual(front(0.5), [COLOURS.T, COLOURS.G]);
  assert.deepEqual(front(1.8), [COLOURS.G, COLOURS.T]);
  // a looping flight comes back round to where it started
  const loop = compile({
    layers: [
      {
        id: "bug",
        kind: "sprite",
        props: { asset: "bug", x: 100, y: 60, anchor: "center" },
        behaviors: [{ kind: "fly", at: "S(c01)", params: { path: [[130, 60]], speed: 30, loop: true, bob: 0 } }],
      },
    ],
  });
  const l0 = loop.layers.find((l) => l.id === "bug")!.behaviors[0].at;
  const lx = (s: number) => cx(box(loop, "bug", l0 + s)!);
  assert.deepEqual([lx(0.01), lx(1), lx(2), lx(3)], [100, 130, 100, 130]);
  // bob moves it up and down while it flies
  const bob = compile({
    layers: [
      {
        id: "bug",
        kind: "sprite",
        props: { asset: "bug", x: 100, y: 60 },
        behaviors: [{ kind: "fly", at: "S(c01)", params: { path: [[100, 60]], bob: 3, bobPeriod: 1 } }],
      },
    ],
  });
  const b0 = bob.layers.find((l) => l.id === "bug")!.behaviors[0].at;
  assert.deepEqual(
    [0.25, 0.75].map((s) => box(bob, "bug", b0 + s)!.y),
    [63, 57],
  );
  const bad = issuesOf({
    layers: [
      {
        id: "bug",
        kind: "sprite",
        props: { asset: "bug" },
        behaviors: [{ kind: "fly", at: "S(c01)", params: { path: [[10, "high"]] } }],
      },
    ],
  });
  assert.match(bad[0].fix, /\[x, y\]/);
  assert.match(
    issuesOf({
      layers: [
        {
          id: "a",
          kind: "sprite",
          props: { asset: "bug" },
          behaviors: [{ kind: "fly", at: "S(c01)", params: { path: [] } }],
        },
      ],
    })[0].message,
    /at least one point/,
  );
});

test("sit: glides onto its anchor, squashes, perches, follows a layer and sounds on touchdown", () => {
  const cs = compile({
    layers: [
      { id: "post", kind: "sprite", props: { asset: "bug", x: 200, y: 100, anchor: "bottom" } },
      {
        id: "bug",
        kind: "sprite",
        props: { asset: "bug", x: 40, y: 40, anchor: "bottom" },
        behaviors: [{ kind: "sit", at: "S(c01)", params: { x: 120, y: 90, land: 0.5, sfx: "land" } }],
      },
      {
        id: "rider",
        kind: "sprite",
        props: { asset: "bug", x: 0, y: 0, anchor: "bottom" },
        behaviors: [{ kind: "sit", at: "S(c01)", params: { on: "post", dy: -5, land: 0 } }],
      },
    ],
  });
  const t0 = cs.layers.find((l) => l.id === "bug")!.behaviors[0].at;
  const b = (s: number, id = "bug") => box(cs, id, t0 + s)!;
  assert.equal(b(0.2).w, 7, "flaps while it lands");
  assert.ok(b(0.2).x + 3 > 40 && b(0.2).x + 3 < 120);
  assert.equal(b(0.55).h, 5, "squashed just after touchdown");
  assert.deepEqual([b(1).x + 2, b(1).y + b(1).h, b(1).w], [120, 90, 4], "perched on the anchor (perch frame)");
  assert.deepEqual([b(1, "rider").x + 2, b(1, "rider").y + b(1, "rider").h], [200, 95], "sits on the post");
  assert.ok(cs.sfx.some((s) => s.type === "land" && Math.abs(s.t - (t0 + 0.5)) < 1e-9));
  const bad = issuesOf({
    layers: [
      {
        id: "a",
        kind: "sprite",
        props: { asset: "bug" },
        behaviors: [{ kind: "sit", at: "S(c01)", params: { on: "nest" } }],
      },
    ],
  });
  assert.match(bad[0].message, /no layer "nest"/);
});

test("sit keeps facing the way it came in after touchdown", () => {
  const cs = compile({
    layers: [
      {
        id: "bug",
        kind: "sprite",
        props: { asset: "bug", x: 200, y: 60, anchor: "bottom" },
        behaviors: [{ kind: "sit", at: "S(c01)", params: { x: 80, y: 60, land: 0.5, fps: 0.1 } }],
      },
    ],
  });
  const t0 = cs.layers.find((l) => l.id === "bug")!.behaviors[0].at;
  const e = eng();
  const edges = (s: number) => {
    drawDecl(e, cs, t0 + s);
    const b = box(cs, "bug", t0 + s)!;
    return [hexAt(e.buf, b.x, b.y + 1), hexAt(e.buf, b.x + b.w - 1, b.y + 1)];
  };
  assert.deepEqual(edges(0.25), [COLOURS.G, COLOURS.T], "glides in facing left");
  // after touchdown: the perched owl draws exactly like an owl standing there facing left (one frame for both)
  const perch = compile({
    layers: [
      {
        id: "owl",
        kind: "actor",
        props: { asset: "owl", x: 200, y: 100, frames: { perch: ["idle0"] } },
        behaviors: [{ kind: "sit", at: "S(c01)", params: { x: 80, y: 100, land: 0.5 } }],
      },
    ],
  });
  const p0 = perch.layers.find((l) => l.id === "owl")!.behaviors[0].at;
  const draw = (s: number) => {
    drawDecl(e, perch, p0 + s);
    return Buffer.from(e.buf);
  };
  const standing = compile({
    layers: [
      {
        id: "owl",
        kind: "actor",
        props: { asset: "owl", x: 80, y: 100, facing: "left", frames: { idle: ["idle0"] } },
      },
    ],
  });
  drawDecl(e, standing, p0 + 1);
  const want = Buffer.from(e.buf);
  assert.ok(draw(1).equals(want), "after touchdown it still faces left");
});

test("fly then sit on an actor: the owl lands where the flight left it, using its run and idle frames", () => {
  const cs = compile({
    layers: [
      {
        id: "owl",
        kind: "actor",
        props: { asset: "owl", x: -20, y: 60 },
        behaviors: [
          { kind: "fly", at: "S(c01)", until: "S(c01)+1", params: { path: [[80, 60]], speed: 60, bob: 0 } },
          { kind: "sit", at: "S(c01)+1", params: { x: 200, y: 120, land: 0.5 } },
        ],
      },
    ],
  });
  const t0 = cs.layers.find((l) => l.id === "owl")!.behaviors[0].at;
  const at1 = box(cs, "owl", t0 + 0.999)!;
  const at1b = box(cs, "owl", t0 + 1.02)!;
  assert.ok(Math.abs(at1b.x - at1.x) <= 4, `no jump at the hand-over: ${at1.x} -> ${at1b.x}`);
  const end = box(cs, "owl", t0 + 2)!;
  assert.deepEqual([end.x + 8, end.y + end.h], [200, 120]);
});

test("label: a painted board on posts down to the ground, counted as text by the lints", () => {
  const e = eng();
  const cs = compile({
    layers: [{ id: "sign", kind: "widget", props: { widget: "label", text: "OPEN LATE", x: 100, y: 100 } }],
  });
  assert.ok(cs.assets.includes("font"));
  const [x] = inspectDecl(e, cs, 1).filter((i) => i.id === "sign");
  assert.equal(x.text, "OPEN LATE");
  assert.equal(x.h, 18);
  drawDecl(e, cs, 1);
  assert.equal(hexAt(e.buf, x.x + 1, x.y + 1), COLOURS.c, "lit top-left edge");
  assert.equal(hexAt(e.buf, x.x + x.w - 4, x.y + x.h - 4), COLOURS.A, "dark lower-right edge");
  assert.equal(hexAt(e.buf, x.x + 3, x.y + 3), COLOURS.q, "a nail");
  assert.equal(hexAt(e.buf, x.x + 4, GROUND - 1), COLOURS.n, "a post reaches the ground");
  const slate = compile({
    layers: [
      { id: "s", kind: "widget", props: { widget: "label", text: "ROOF", style: "slate", mount: "hang", y: 60 } },
    ],
  });
  drawDecl(e, slate, 1);
  const s = inspectDecl(e, slate, 1).find((i) => i.id === "s")!;
  assert.equal(hexAt(e.buf, s.x + 1, s.y + 1), COLOURS.Y);
  assert.equal(hexAt(e.buf, s.x + 4, s.y - 2), COLOURS.q, "a cord up to the bar");
  // off the frame for long enough, it is clipped text
  const doc = oneScene({
    layers: [{ id: "sign", kind: "widget", props: { widget: "label", text: "FAR AWAY", x: 330, y: 60 } }],
  });
  const lints = lintProject(doc, timeline(doc), { assets: ASSETS, colours: COLOURS, sky: SKY });
  assert.ok(lints.some((l) => l.rule === "text-clipped"));
});

test("the rooftop example uses all four, compiles and lints clean", () => {
  const doc = Project.parse(JSON.parse(readFileSync(join(ROOT, "examples/rooftop/pitch.json"), "utf8")));
  const src = JSON.stringify(doc.scenes);
  for (const want of ['"backdrop_rooftop"', '"fly"', '"sit"', '"glow"', '"label"']) assert.ok(src.includes(want), want);
  const found = lintProject(doc, resolveTimeline(doc), { assets: [...ASSETS, ...EXTRA], colours: COLOURS, sky: SKY });
  assert.deepEqual(found, []);
});
