// Declarative scenes: layers with keyframes and behaviours, and recipes that expand into layers.
// compileDecl() resolves every time expression to seconds (it runs where the timeline lives); drawDecl() is a pure
// function of t over the compiled, JSON-serialisable result, so it can run in the render sandbox or the browser.
import type { DeclSceneT } from "@pap/schema";
import type { Engine } from "./core.ts";

export type CompiledScene = {
  id: string;
  from: number;
  to: number;
  layers: unknown[];
  camera: unknown;
  sfx: { t: number; type: string }[];
};

export function compileDecl(scene: DeclSceneT, at: (e: string | number) => number): CompiledScene {
  return { id: scene.id, from: at(scene.from), to: at(scene.to), layers: [], camera: null, sfx: [] };
}

export function drawDecl(e: Engine, _cs: CompiledScene, _t: number) {
  e.clear();
}
