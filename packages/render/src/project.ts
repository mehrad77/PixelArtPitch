// Open a project folder: validate pitch.json, resolve its assets (public library + the project's own), its palette and
// its code bundles, and compute the timeline. Everything the renderer needs, as plain data.
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { Frames } from "@pap/engine";
import { AssetFile, Project, type ProjectT, resolveTimeline, type Timeline } from "@pap/schema";
import { libraryAssetDir, libraryFile } from "./library.ts";

export type Palette = { id: string; sky: string; colours: Record<string, string> };

export function loadPalette(ref: string): Palette {
  const [id] = ref.split("@");
  const p = JSON.parse(readFileSync(libraryFile("palettes", `${id}.json`), "utf8"));
  return { id, sky: p.sky, colours: Object.fromEntries(Object.entries(p.colours).map(([k, v]: any) => [k, v.hex])) };
}

/** a library asset from either layer (the user library first, then the seed: library.ts) */
export function loadLibraryAsset(id: string, version?: number) {
  const dir = libraryAssetDir(id);
  if (!dir) throw new Error(`library asset ${id} not found`);
  const file = join(dir, "asset.json");
  const a = AssetFile.parse(JSON.parse(readFileSync(file, "utf8")));
  if (version !== undefined && a.version !== version)
    throw new Error(`library asset ${id} is v${a.version}, the project pins v${version}`);
  return a;
}

/** frames in source order, with names renamed by alias ({ projectName: sourceName }) */
function aliased(grid: Frames, alias?: Record<string, string>): Frames {
  if (!alias) return grid;
  const back = Object.fromEntries(Object.entries(alias).map(([mine, theirs]) => [theirs, mine]));
  return Object.fromEntries(Object.entries(grid).map(([k, v]) => [back[k] ?? k, v]));
}

export function resolveAssets(dir: string, doc: ProjectT): [string, Frames][] {
  return doc.assets.map((ref) => {
    let grid: Frames;
    if (ref.src.startsWith("lib:")) {
      const [id, v] = ref.src.slice(4).split("@");
      grid = loadLibraryAsset(id, Number(v)).grid;
    } else {
      const raw = JSON.parse(readFileSync(join(dir, ref.src.slice(5)), "utf8"));
      grid = raw.grid ?? raw.frames;
    }
    return [ref.id, aliased(grid, ref.frameAlias)];
  });
}

export type LoadedProject = {
  dir: string;
  doc: ProjectT;
  timeline: Timeline;
  palette: Palette;
  assets: [string, Frames][];
  bundles: { id: string; file: string; source: string; fullFrame: boolean; sfx: boolean; initArg: unknown }[];
  /** a trial render: the sandbox records what bundles draw (Renderer.probe) */
  probe?: boolean;
};

export function readDoc(dir: string): ProjectT {
  return Project.parse(JSON.parse(readFileSync(join(dir, "pitch.json"), "utf8")));
}

export function loadProject(dir: string): LoadedProject {
  dir = resolve(dir);
  const doc = readDoc(dir);
  return openDoc(dir, doc);
}

export function openDoc(dir: string, doc: ProjectT): LoadedProject {
  const timeline = resolveTimeline(doc);
  const palette = loadPalette(doc.canvas.palette);
  const assets = resolveAssets(dir, doc);
  const bundles = doc.code.map((b) => ({
    id: b.id,
    file: b.file,
    source: readFileSync(join(dir, b.file), "utf8"),
    fullFrame: b.fullFrame,
    sfx: b.sfx,
    initArg: b.initAsset ? JSON.parse(readFileSync(join(dir, b.initAsset), "utf8")) : undefined,
  }));
  return { dir, doc, timeline, palette, assets, bundles };
}

/** The values a code bundle sees in "pap:timeline" (the same names as the first video's timeline.mjs). */
export function timelineModule(p: Pick<LoadedProject, "doc" | "timeline">) {
  const { timeline } = p;
  return {
    CUES: timeline.cues.map((c) => c.text),
    CUE_IDS: timeline.cues.map((c) => c.id),
    TIMES: timeline.cues.map((c) => [c.start, c.end]),
    HOLD: timeline.hold,
    END_CARD_HOLD: timeline.endHold,
    DURATION: timeline.duration,
    SCENES: timeline.scenes.map((s) => ({ id: s.id, from: s.from, to: s.to })),
    EVENTS: timeline.events,
  };
}
