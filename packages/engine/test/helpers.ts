// Shared test fixtures: the public library, a small project builder and an engine with library assets.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Project, type ProjectT, resolveTimeline } from "@pap/schema";
import { createEngine, type Frames } from "../src/core.ts";

export const ROOT = new URL("../../../", import.meta.url).pathname;
export const LIB = join(ROOT, "library");
const pal = JSON.parse(readFileSync(join(LIB, "palettes/pap-night.json"), "utf8"));
export const COLOURS: Record<string, string> = Object.fromEntries(
  Object.entries(pal.colours).map(([k, v]: [string, any]) => [k, v.hex]),
);
export const SKY: string = pal.sky;
export const libIndex: { id: string; kind: string }[] = JSON.parse(
  readFileSync(join(LIB, "index.json"), "utf8"),
).assets;
export const libAsset = (id: string) => JSON.parse(readFileSync(join(LIB, id, "asset.json"), "utf8"));

/** project asset id -> library id, as the example uses them */
export const ASSET_IDS: Record<string, string> = {
  font: "font-5x8",
  hero: "mentor-ai",
  friend: "mentor-gtm",
  crowd: "gamers",
  moon: "moon",
  skyline: "skyline",
  tiles: "tiles",
  props: "props",
  qblock: "qblock",
  items: "items",
  castle: "castle",
};
export const ASSETS: [string, Frames][] = Object.entries(ASSET_IDS).map(([id, lib]) => [id, libAsset(lib).grid]);

export function engine() {
  return createEngine({ colours: COLOURS, sky: SKY, assets: new Map(ASSETS), fontAssets: ["font"] });
}

/** a project with the given cues and scenes, every asset the recipes use, validated by the schema */
export function project(
  scenes: unknown[],
  cues = ["Your list feels like a grind today.", "Every task becomes a quest."],
  extra: Record<string, unknown> = {},
): ProjectT {
  return Project.parse({
    pap: 1,
    rev: 0,
    id: "t",
    title: "t",
    canvas: { w: 320, h: 180, fps: 30, palette: "pap-night@1" },
    brief: { idea: "test", lengthSec: 10 },
    script: { cues: cues.map((text, i) => ({ id: `c0${i + 1}`, text })), timing: { mode: "estimate", minCue: 1.6 } },
    composition: { hold: 0.5, endHold: 2, duration: `E(c0${cues.length})+endHold` },
    scenes,
    audio: { sfx: {} },
    assets: Object.entries(ASSET_IDS).map(([id, lib]) => ({ id, src: `lib:${lib}@1` })),
    budget: { capUsd: 0 },
    ...extra,
  });
}

export const oneScene = (scene: Record<string, unknown>, cues?: string[]) =>
  project([{ id: "s", kind: "decl", from: 0, to: "duration", cues: ["c01"], ...scene }], cues);

export const timeline = (doc: ProjectT) => resolveTimeline(doc);
