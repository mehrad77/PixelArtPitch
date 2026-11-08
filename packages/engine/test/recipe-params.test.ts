// The crew knows its tools (docs/RECIPES.md): walk_in's then/prop, spawn_join's motion/follow, a glowing lantern in
// the backdrops' decor and the sign-style name tag compile to the engine's sit, fly, glow and label pieces, draw, and
// are listed as on-screen params in the catalogue the Director's menu is built from.
import assert from "node:assert/strict";
import { test } from "node:test";
import type { DeclSceneT } from "@pap/schema";
import { createEngine } from "../src/core.ts";
import { compileDecl, DeclError, drawDecl } from "../src/decl.ts";
import { recipeCatalog } from "../src/recipes.ts";
import { ASSETS, COLOURS, libAsset, oneScene, SKY, timeline } from "./helpers.ts";

const compile = (recipes: unknown[]) => {
  const doc = oneScene({ recipes });
  return compileDecl(doc.scenes[0] as DeclSceneT, timeline(doc).at);
};
const issues = (recipes: unknown[]) => {
  try {
    compile(recipes);
  } catch (e) {
    assert.ok(e instanceof DeclError, String(e));
    return e.issues;
  }
  return assert.fail("expected a DeclError");
};
const eng = () =>
  createEngine({
    colours: COLOURS,
    sky: SKY,
    assets: new Map([
      ...ASSETS,
      ...["props-small", "owl", "moth"].map((id) => [id, libAsset(id).grid] as [string, any]),
    ]),
    fontAssets: ["font"],
  });
const draws = (cs: ReturnType<typeof compile>) => {
  const e = eng();
  for (let t = cs.from; t < cs.to; t += 0.25) drawDecl(e, cs, t);
};
const layer = (cs: any, end: string) => cs.layers.find((l: any) => l.id.endsWith(end));

test("walk_in then: sit sits down after the wave; prop stands a glowing lantern beside the hero", () => {
  const cs = compile([
    { id: "backdrop_rooftop" },
    {
      id: "walk_in",
      // biome-ignore lint/suspicious/noThenProperty: a recipe param, never awaited
      params: { hero: "owl", x: 120, then: "sit", prop: { frame: "lantern", glow: true } },
    },
  ]);
  const hero = layer(cs, "_hero");
  assert.deepEqual(
    hero.behaviors.map((b: any) => b.kind),
    ["walk", "sit"],
  );
  const prop = layer(cs, "_prop");
  assert.equal(prop.props.asset, "props-small");
  assert.equal(prop.props.frame, "lantern-lit");
  assert.equal(prop.props.x, 134, "beside the hero, on the side they face");
  assert.equal(layer(cs, "_prop_glow").props.fx, "glow");
  draws(cs);
  assert.match(issues([{ id: "walk_in", params: { prop: { frame: "teapot" } } }])[0].fix, /lantern, candle/);
});

test("spawn_join motion: fly flies in and follows an actor; walk walks in; who is required", () => {
  const cs = compile([
    { id: "walk_in", params: { hero: "owl", x: 120 } },
    { id: "spawn_join", params: { who: "moth", motion: "fly", follow: "owl", x: 160 } },
  ]);
  const moth = layer(cs, "_who");
  const kinds = moth.behaviors.map((b: any) => b.kind);
  assert.deepEqual(kinds, ["fly", "sit"]);
  assert.equal(moth.behaviors[1].p.on, layer(cs, "_hero").id, "it rides along with the owl");
  assert.ok(!cs.layers.some((l: any) => l.id.endsWith("_banner")), "no banner by default");
  draws(cs);
  const walk = compile([{ id: "spawn_join", params: { who: "friend", motion: "walk", banner: "HI" } }]);
  assert.equal(layer(walk, "_who").behaviors[0].kind, "walk");
  assert.ok(layer(walk, "_banner"));
  draws(walk);
  assert.match(issues([{ id: "spawn_join", params: {} }])[0].message, /missing required prop "who"/);
  const lost = issues([{ id: "spawn_join", params: { who: "moth", follow: "owl" } }]);
  assert.match(lost[0].message, /no actor "owl" to follow/);
  assert.match(lost[0].fix, /walk_in first/);
});

test("decor: a lantern with glow: true lights up; a lamp doesn't glow", () => {
  const cs = compile([{ id: "backdrop_rooftop", params: { decor: [{ frame: "lantern", x: 136, glow: true }] } }]);
  assert.equal(layer(cs, "_decor0").props.frame, "lantern-lit");
  assert.equal(layer(cs, "_decor0_glow").props.fx, "glow");
  draws(cs);
  const night = compile([{ id: "backdrop_night", params: { decor: [{ frame: "candle", x: 40, glow: true }] } }]);
  assert.ok(layer(night, "_decor0_glow"));
  assert.match(
    issues([{ id: "backdrop_night", params: { decor: [{ frame: "lamp", x: 24, glow: true }] } }])[0].fix,
    /glow a small prop/,
  );
});

test("nameTag: sign draws the label widget as the name tag; box stays the plain tag", () => {
  const sign = compile([{ id: "walk_in", params: { label: "OWL", nameTag: "sign" } }]);
  assert.equal(layer(sign, "_tag").props.widget, "label");
  assert.equal(layer(sign, "_tag").props.text, "OWL");
  draws(sign);
  const box = compile([{ id: "walk_in", params: { label: "OWL" } }]);
  assert.equal(layer(box, "_tag").props.widget, "nameTag");
});

test("the catalogue marks what changes the screen: who, banner, motion, follow, then, prop, decor", () => {
  const cat = recipeCatalog();
  const on = (id: string) =>
    Object.entries<any>(cat.find((r) => r.id === id)!.params.properties)
      .filter(([, v]) => v.onScreen)
      .map(([k]) => k);
  for (const k of ["hero", "then", "prop", "label", "nameTag"]) assert.ok(on("walk_in").includes(k), k);
  for (const k of ["who", "motion", "follow", "banner"]) assert.ok(on("spawn_join").includes(k), k);
  assert.ok(on("backdrop_rooftop").includes("decor"));
  assert.ok(on("backdrop_night").includes("decor"));
  const sj = cat.find((r) => r.id === "spawn_join")!;
  assert.deepEqual(sj.params.required, ["who"]);
  assert.equal(sj.params.properties.banner.default, "");
  assert.doesNotMatch(cat.find((r) => r.id === "backdrop_rooftop")!.params.properties.decor.description, /lamp/);
});
