// Characters walk (v0.5.1): a walking hero shows its run cycle until it arrives, and turns to face where it goes.
import assert from "node:assert/strict";
import { test } from "node:test";
import type { DeclSceneT } from "@pap/schema";
import { createEngine } from "../src/core.ts";
import { compileDecl, drawDecl } from "../src/decl.ts";
import { ASSETS, COLOURS, libAsset, oneScene, SKY, timeline } from "./helpers.ts";

const compile = (scene: Record<string, unknown>) => {
  const doc = oneScene(scene, ["Your list feels like a grind today, every day.", "Every task becomes a quest."]);
  return compileDecl(doc.scenes[0] as DeclSceneT, timeline(doc).at);
};

/** an engine with the gamer hero, recording every frame an actor draws */
function recording() {
  const e = createEngine({
    colours: COLOURS,
    sky: SKY,
    assets: new Map([...ASSETS, ["runner", libAsset("gamer").grid]]),
    fontAssets: ["font"],
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
