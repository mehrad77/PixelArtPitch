// The type of `@pap/tools/parts` as the web sees it (tsconfig `paths`): the module itself is pure and bundles fine,
// but its type imports reach store.ts and the renderer, which need node's types. Vite resolves the real module.
import type { Parts, ProjectT, SceneStatus, Version } from "./types.ts";

export declare const PART_IDS: Parts["parts"][number]["id"][];
export declare function partsOf(i: {
  doc: ProjectT;
  sceneStatus?: Record<string, { version: SceneStatus["version"]; state: string }>;
  history?: { seq: number; baseRev: number; ops: { path: string }[] }[];
  versions?: Omit<Version, "url">[];
  resolves?: (src: string) => boolean;
}): Parts;
