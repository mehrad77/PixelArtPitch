// Characters walk (v0.5.1): a walking hero shows its run cycle until it arrives, and turns to face where it goes.
import assert from "node:assert/strict";
import { test } from "node:test";
import type { DeclSceneT } from "@pap/schema";
import { assetFacing } from "@pap/schema";
import { createEngine } from "../src/core.ts";
import { compileDecl, drawDecl } from "../src/decl.ts";
import { ASSETS, COLOURS, libAsset, oneScene, SKY, timeline } from "./helpers.ts";

const compile = (scene: Record<string, unknown>) => {
  const doc = oneScene(scene, ["Your list feels like a grind today, every day.", "Every task becomes a quest."]);
  return compileDecl(doc.scenes[0] as DeclSceneT, timeline(doc).at);
};

/** an engine with the gamer hero, recording every frame an actor draws */
function recording(facing: Record<string, "left" | "right"> = {}) {
  const e = createEngine({
    colours: COLOURS,
    sky: SKY,
    assets: new Map([...ASSETS, ["runner", libAsset("gamer").grid]]),
    fontAssets: ["font"],
    facing,
  });
  const drawn: { asset: string; frame: string }[] = [];
  const frame = e.frame;
  e.frame = (n, f, fb) => {
    drawn.push({ asset: n, frame: f });
    return frame(n, f, fb);
  };
  return { e, drawn };
}

test("walk_in shows run0-run3 between the start and the arrival, then waves", () => {
  const cs = compile({ recipes: [{ id: "walk_in", params: { hero: "runner", at: 0.2, arrive: 2.2, x: 160 } }] });
  const seen = new Set<string>();
  for (let t = 0.3; t < 2.1; t += 1 / 30) {
    const { e, drawn } = recording();
    drawDecl(e, cs, t);
    for (const d of drawn) if (d.asset === "runner") seen.add(d.frame);
  }
  assert.deepEqual([...seen].sort(), ["run0", "run1", "run2", "run3"]);
  const { e, drawn } = recording();
  drawDecl(e, cs, 2.8);
  assert.ok(
    drawn.some((d) => d.asset === "runner" && d.frame === "wave"),
    "it waves after arriving",
  );
});

test("a walking actor faces the way it travels, by its asset's facing", () => {
  // the gamer's art looks right; walking in from the right it turns left, from the left it stays as drawn
  const from = (side: string) => ({
    recipes: [{ id: "walk_in", params: { hero: "runner", at: 0.2, arrive: 2.2, x: 160, from: side, wave: false } }],
  });
  const flipped = (side: string, facing: Record<string, "left" | "right">) => {
    const { e, drawn } = recording(facing);
    const calls: boolean[] = [];
    const sprite = e.sprite;
    e.sprite = (rows, x, y, o = {}) => {
      if (drawn.at(-1)?.asset === "runner") calls.push(!!o.flip);
      return sprite(rows, x, y, o);
    };
    drawDecl(e, compile(from(side)), 1);
    return calls[0];
  };
  assert.equal(flipped("left", { runner: "right" }), false, "right-facing art walking right is drawn as is");
  assert.equal(flipped("right", { runner: "right" }), true, "right-facing art walking left is mirrored");
  assert.equal(flipped("left", {}), true, "art that doesn't say is taken to look left (the old library)");
  assert.equal(flipped("left", { runner: "left" }), true);
  // faces: overrides the asset
  const over = {
    recipes: [{ id: "walk_in", params: { hero: "runner", at: 0.2, arrive: 2.2, x: 160, faces: "left" } }],
  };
  const { e, drawn } = recording({ runner: "right" });
  const calls: boolean[] = [];
  const sprite = e.sprite;
  e.sprite = (rows, x, y, o = {}) => {
    if (drawn.at(-1)?.asset === "runner") calls.push(!!o.flip);
    return sprite(rows, x, y, o);
  };
  drawDecl(e, compile(over), 1);
  assert.equal(calls[0], true);
});

test("assetFacing: the field, else the description, else nothing", () => {
  assert.equal(assetFacing({ facing: "right", description: "facing LEFT" }), "right");
  assert.equal(assetFacing({ description: "a run cycle facing RIGHT; wave facing the viewer" }), "right");
  assert.equal(assetFacing({ description: "A mentor NPC facing LEFT (toward the player)" }), "left");
  assert.equal(assetFacing({ description: "wave facing the viewer" }), undefined);
  assert.equal(assetFacing({}), undefined);
  assert.equal(assetFacing(libAsset("gamer")), "right");
  for (const id of ["cast-founder", "mentor-ai", "owl", "moth"]) assert.equal(assetFacing(libAsset(id)), "left", id);
});

test("faceTo gives the flip that turns an asset toward a side", () => {
  const { e } = recording({ runner: "right" });
  assert.equal(e.faceTo("runner", "right"), false);
  assert.equal(e.faceTo("runner", "left"), true);
  assert.equal(e.faceTo("hero", "left"), false, "unknown art looks left");
});
