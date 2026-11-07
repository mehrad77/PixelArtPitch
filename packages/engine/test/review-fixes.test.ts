// Fixes for what a crew run's Reviewer found on a real project: typographic text, twin heroes, items over the face,
// banners off the frame, the all-black cut frame and assets a recipe draws but nobody cast.
import assert from "node:assert/strict";
import { test } from "node:test";
import type { DeclSceneT } from "@pap/schema";
import { transitions } from "../src/compose.ts";
import { plainText } from "../src/core.ts";
import { compileDecl, drawDecl, inspectDecl } from "../src/decl.ts";
import { darkShare, type Lint, lintFrames, lintProject, missingAssets } from "../src/lints.ts";
import { ASSETS, COLOURS, engine, oneScene, project, SKY, timeline } from "./helpers.ts";

const opts = { assets: ASSETS, colours: COLOURS, sky: SKY };
const lint = (doc: ReturnType<typeof project>) => lintProject(doc, timeline(doc), opts);
const rules = (ls: Lint[]) => ls.map((l) => l.rule);
const compile = (scene: Record<string, unknown>, cues?: string[]) => {
  const doc = oneScene(scene, cues);
  return compileDecl(doc.scenes[0] as DeclSceneT, timeline(doc).at);
};
const actorsOf = (cs: ReturnType<typeof compile>) => cs.layers.filter((l) => l.kind === "actor");

// ---------------------------------------------------------------- 1. typographic characters
test("typographic dashes, quotes, ellipsis and odd spaces draw as the glyphs the font has", () => {
  const pairs: [string, string][] = [
    ["Tired of boring to‑do lists?", "Tired of boring to-do lists?"],
    ["A — B – C − 1 ‐ 2", "A - B - C - 1 - 2"],
    ["“Quest” isn’t ‘done’", "\"Quest\" isn't 'done'"],
    ["Wait…", "Wait..."],
    ["NO BREAK", "NO BREAK"],
  ];
  for (const [fancy, plain] of pairs) {
    const a = engine();
    const b = engine();
    a.clear();
    b.clear();
    assert.equal(a.measure(fancy, 2), b.measure(plain, 2), fancy);
    a.text(fancy, 10, 10, { scale: 2 });
    b.text(plain, 10, 10, { scale: 2 });
    assert.ok(Buffer.from(a.buf).equals(Buffer.from(b.buf)), `${fancy} draws like ${plain}`);
    assert.equal(plainText(fancy), plain);
  }
});

test("text the font already draws is untouched, and an unknown character still shows the missing-glyph box", () => {
  const a = engine();
  a.clear();
  a.text("to-do ... 'x' \"y\"", 4, 4);
  const b = engine();
  b.clear();
  b.text("to-do ... 'x' \"y\"", 4, 4);
  assert.ok(Buffer.from(a.buf).equals(Buffer.from(b.buf)));
  const box = engine();
  box.clear();
  box.text("☃", 4, 4);
  const plain = engine();
  plain.clear();
  assert.ok(!Buffer.from(box.buf).equals(Buffer.from(plain.buf)), "a snowman is still a box");
});

test("recipe text params are stored plain after compile", () => {
  const cs = compile({ recipes: [{ id: "banner", params: { text: "to‑do…" } }] });
  const banner = cs.layers.find((l) => l.props.widget === "banner")!;
  assert.equal(banner.props.text, "to-do...");
});

// ---------------------------------------------------------------- 2. one hero, not two
test("item_collect reuses the hero walk_in drew with the same asset", () => {
  const scene = {
    recipes: [
      { id: "walk_in", params: { hero: "hero", at: "S(c01)+0.4", arrive: "S(c01)+0.9" } },
      { id: "item_collect", params: { hero: "hero", at: "S(c01)+1.0", x: 120 } },
    ],
  };
  const cs = compile(scene);
  assert.equal(actorsOf(cs).length, 1);
  const hero = actorsOf(cs)[0];
  assert.ok(hero.behaviors.some((b) => b.kind === "walk"));
  assert.ok(hero.behaviors.some((b) => b.kind === "jumpArc"));
  // the items pop over where the hero stopped
  const item = cs.layers.find((l) => l.id.includes("item0"))!;
  assert.equal(item.props.x, 120 - 6);
  assert.ok(!rules(lint(oneScene(scene))).includes("duplicate-actor"));
});

test("flag_raise and end_card_loop reuse the scene's hero too; second: true asks for a twin", () => {
  const walk = { id: "walk_in", params: { hero: "hero", at: "S(c01)+0.2", arrive: "S(c01)+0.8" } };
  assert.equal(actorsOf(compile({ recipes: [walk, { id: "flag_raise", params: { hero: "hero" } }] })).length, 1);
  assert.equal(
    actorsOf(compile({ recipes: [walk, { id: "end_card_loop", params: { title: "QD", hero: "hero" } }] })).length,
    1,
  );
  const twins = {
    recipes: [walk, { id: "item_collect", params: { hero: "hero", second: true } }],
  };
  assert.equal(actorsOf(compile(twins)).length, 2);
  assert.ok(!rules(lint(oneScene(twins))).includes("duplicate-actor"), "asked for, so not flagged");
  // a different character is not a twin
  assert.equal(actorsOf(compile({ recipes: [walk, { id: "item_collect", params: { hero: "friend" } }] })).length, 2);
});

test("duplicate actors of one asset are a lint error", () => {
  const doc = oneScene({
    layers: [
      { id: "a", kind: "actor", props: { asset: "hero", x: 100 } },
      { id: "b", kind: "actor", props: { asset: "hero", x: 104 } },
    ],
  });
  const found = lint(doc).find((l) => l.rule === "duplicate-actor");
  assert.ok(found && found.severity === "error" && /second: true/.test(found.fix));
});

// ---------------------------------------------------------------- 3. items clear the head
test("item_collect items never cover the hero's head", () => {
  for (const params of [{}, { hero: "hero", x: 160 }]) {
    const doc = oneScene({ recipes: [{ id: "item_collect", params }] });
    const cs = compileDecl(doc.scenes[0] as DeclSceneT, timeline(doc).at);
    const e = engine();
    for (let t = cs.from; t < cs.to; t += 1 / 30) {
      const seen = inspectDecl(e, cs, t);
      const hero = seen.find((x) => x.kind === "actor")!;
      for (const it of seen.filter((x) => x.id.includes("_item"))) {
        const below = it.y + it.h;
        const sideBySide = it.x + it.w <= hero.x || it.x >= hero.x + hero.w;
        assert.ok(sideBySide || below <= hero.y || it.y >= hero.y + hero.h * 0.4, `${it.id} over the head at ${t}`);
      }
    }
    assert.ok(!rules(lint(doc)).includes("covers-face"));
  }
});

test("a prop held over a face is a lint error", () => {
  const doc = oneScene({
    layers: [
      { id: "hero", kind: "actor", props: { asset: "hero", x: 120 } },
      { id: "star", kind: "sprite", props: { asset: "items", frame: "star", x: 114, y: 126 }, z: 12 },
    ],
  });
  const found = lint(doc).find((l) => l.rule === "covers-face");
  assert.ok(found && found.severity === "error", JSON.stringify(rules(lint(doc))));
});

test("a toast drawn over a character's body is a lint error; one above it is fine", () => {
  const over = oneScene({
    layers: [{ id: "hero", kind: "actor", props: { asset: "hero", x: 200 } }],
    recipes: [{ id: "toast", params: { title: "Todo App", at: "S(c01)", dur: 3 } }],
  });
  const found = lint(over).find((l) => l.rule === "covers-actor");
  assert.ok(found && found.severity === "error", JSON.stringify(rules(lint(over))));
  const clear = oneScene({
    layers: [{ id: "hero", kind: "actor", props: { asset: "hero", x: 30 } }],
    recipes: [{ id: "toast", params: { title: "Todo App", at: "S(c01)", dur: 3 } }],
  });
  assert.ok(!rules(lint(clear)).includes("covers-actor"));
});

// ---------------------------------------------------------------- 4. banners, toasts and titles fit
test("a long banner wraps or shrinks inside the frame instead of running off it", () => {
  const texts = ["QuestDay turns chores into quests.", "Supercalifragilisticexpialidocious-and-then-some-more-words"];
  for (const text of texts) {
    const doc = oneScene({ recipes: [{ id: "banner", params: { text, at: "S(c01)", dur: 3 } }] });
    const cs = compileDecl(doc.scenes[0] as DeclSceneT, timeline(doc).at);
    const box = inspectDecl(engine(), cs, cs.from + 1).find((x) => x.widget === "banner")!;
    assert.ok(box.x >= 0 && box.x + box.w <= 320, `${text}: ${JSON.stringify(box)}`);
    assert.ok(!rules(lint(doc)).includes("text-clipped"), text);
  }
  // a short one is drawn as before: one line at scale 2
  const doc = oneScene({ recipes: [{ id: "banner", params: { text: "GO", at: "S(c01)", dur: 3 } }] });
  const cs = compileDecl(doc.scenes[0] as DeclSceneT, timeline(doc).at);
  assert.equal(inspectDecl(engine(), cs, cs.from + 1).find((x) => x.widget === "banner")!.h, 8 * 2 + 6 + 2);
});

test("a toast widens to its words and a fit title wraps", () => {
  const doc = oneScene({
    recipes: [
      { id: "toast", params: { title: "A MUCH LONGER TITLE THAN IT SHOULD BE", at: "S(c01)", dur: 3 } },
      { id: "title_card", params: { title: "QUESTDAY TURNS EVERY CHORE INTO A QUEST TODAY" } },
    ],
  });
  const cs = compileDecl(doc.scenes[0] as DeclSceneT, timeline(doc).at);
  const seen = inspectDecl(engine(), cs, cs.from + 1.5);
  const toast = seen.find((x) => x.widget === "toast")!;
  assert.ok(toast.w > 152 && toast.x >= 0 && toast.x + toast.w <= 320, JSON.stringify(toast));
  const title = seen.find((x) => x.kind === "text")!;
  assert.ok(title.x >= 0 && title.x + title.w <= 320 && title.h > 8, JSON.stringify(title));
  assert.ok(!rules(lint(doc)).includes("text-clipped"));
});

// ---------------------------------------------------------------- 5. no all-black cut frame
const twoScenes = () =>
  project([
    { id: "a", kind: "decl", from: 0, to: "E(c01)+0.1", cues: ["c01"], recipes: [{ id: "walk_in" }] },
    { id: "b", kind: "decl", from: "a.to", to: "duration", cues: ["c02"], recipes: [{ id: "item_collect" }] },
  ]);

test("the dissolve reveals the new scene over the outgoing one, so the cut frame is not black", () => {
  const doc = twoScenes();
  const tl = timeline(doc);
  const [a, b] = doc.scenes.map((s) => compileDecl(s as DeclSceneT, tl.at));
  const cc = { ...doc.composition, cues: tl.cues, scenes: tl.scenes, duration: tl.duration };
  const e = engine();
  drawDecl(e, a, a.to - 1e-4);
  const prev = Uint8Array.from(e.buf);
  drawDecl(e, b, b.from);
  transitions(e, cc, b.from, prev);
  // at the cut every block but the first still shows the outgoing scene
  let same = 0;
  for (let i = 0; i < prev.length; i++) if (e.buf[i] === prev[i]) same++;
  assert.ok(same / prev.length > 0.99, `${same / prev.length}`);
  assert.ok(darkShare(e.buf, SKY) < 0.5);
  // without the outgoing frame it is the old black frame
  drawDecl(e, b, b.from);
  transitions(e, cc, b.from);
  assert.ok(darkShare(e.buf, SKY) > 0.95);
  assert.ok(!rules(lint(doc)).includes("empty-frame"));
});

test("empty frames are lint errors, from the scene sampler and from a frame source", async () => {
  const doc = project([
    { id: "a", kind: "decl", from: 0, to: "E(c01)+0.1", cues: ["c01"] },
    {
      id: "b",
      kind: "decl",
      from: "a.to",
      to: "duration",
      cues: ["c02"],
      layers: [
        { id: "void", kind: "shape", z: 50, space: "screen", props: { shape: "rect", w: 320, h: 180, colour: "k" } },
      ],
    },
  ]);
  const found = lint(doc).find((l) => l.rule === "empty-frame");
  assert.ok(found && found.scene === "b" && found.severity === "error", JSON.stringify(rules(lint(doc))));
  // a renderer whose cut frames are black (sampled at every cut, even with a coarse step)
  const tl = timeline(doc);
  const black = new Uint8Array(320 * 180 * 3).fill(9);
  const sky = new Uint8Array(320 * 180 * 3);
  for (let i = 0; i < sky.length; i += 3) sky.set([0x0f, 0x14, 0x11], i);
  const cut = tl.scenes[1].from;
  const frames = await lintFrames(tl, (t) => (Math.abs(t - cut) < 1e-6 ? black : sky), 5, { sky: SKY });
  assert.ok(frames.some((l) => l.rule === "empty-frame" && l.scene === "b"));
});

// ---------------------------------------------------------------- 6. assets a recipe draws but nobody cast
test("missingAssets lists the fixed-id assets compiled scenes draw, with the library asset to cast", () => {
  const doc = oneScene({ recipes: [{ id: "backdrop_night" }, { id: "flag_raise" }] });
  doc.assets = doc.assets.filter((a) => !["castle", "moon", "tiles"].includes(a.id));
  const lib = new Set(["castle", "moon", "tiles", "skyline", "props"]);
  const miss = missingAssets(doc, timeline(doc).at, lib);
  assert.deepEqual(miss.map((m) => m.id).sort(), ["castle", "moon", "tiles"]);
  assert.ok(miss.every((m) => m.libraryId === m.id));
  const lints = lint(doc).filter((l) => l.rule === "missing-asset");
  assert.ok(lints.some((l) => /cast_asset \{ "name": "castle", "libraryId": "castle" \}/.test(l.fix)));
  // a name the library lacks has nothing to cast
  doc.scenes[0] = { ...(doc.scenes[0] as any), recipes: [{ id: "walk_in", params: { hero: "nobody" } }] };
  assert.deepEqual(
    missingAssets(doc, timeline(doc).at, lib).filter((m) => m.id === "nobody"),
    [{ scene: "s", id: "nobody", libraryId: null }],
  );
});
