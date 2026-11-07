// Deterministic checks over a project document and its timeline, for agents and the studio. Every finding names a
// rule, a severity, where and when, what is wrong and how to fix it. Host-side (may use zod and the painter checks).
import { type ProjectT, refsOf, type Timeline } from "@pap/schema";
import { captions, transitions } from "./compose.ts";
import { createEngine, type Engine, type Frames, hexToRgb } from "./core.ts";
import { type CompiledScene, compileDecl, DeclError, drawDecl, type Inspected, inspectDecl } from "./decl.ts";
import { CAPTION_TOP } from "./decl-spec.ts";
import { checkRecipeParams, RECIPE_MAP } from "./recipes.ts";
import { silhouetteContrast } from "./standard.ts";

export type Lint = {
  rule: string;
  severity: "error" | "warn";
  scene?: string;
  t?: number;
  message: string;
  fix: string;
};
export type LintOpts = {
  /** resolved asset frames ([id, frames] as the renderer gets them); enables exact text widths and contrast checks */
  assets?: Map<string, Frames> | [string, Frames][];
  colours?: Record<string, string>;
  sky?: string;
  /** seconds between samples for the on-screen checks (default 0.1) */
  every?: number;
};

/** asset ids recipes and lints know a library default for */
const LIB_DEFAULTS: Record<string, string> = {
  hero: "lib:mentor-ai@1",
  friend: "lib:mentor-gtm@1",
  crowd: "lib:gamers@1",
  font: "lib:font-5x8@1",
};
const LIB_IDS = ["castle", "moon", "skyline", "tiles", "qblock", "powerups", "props", "items", "map", "gamers"];

/** the library asset a project asset id usually points at, or null */
export function libraryIdFor(id: string, library?: Set<string>): string | null {
  const src = LIB_DEFAULTS[id] ?? (LIB_IDS.includes(id) ? `lib:${id}@1` : null);
  const lib = src ? src.slice(4).split("@")[0] : library?.has(id) ? id : null;
  return lib && (!library || library.has(lib)) ? lib : null;
}

/** every asset a decl scene draws (after its recipes expand) that the project has no asset for, with the library
 * asset that fills it (null when the library has none). Scenes that do not compile are skipped. */
export function missingAssets(
  doc: ProjectT,
  at: Timeline["at"],
  library?: Set<string>,
): { scene: string; id: string; libraryId: string | null }[] {
  const known = new Set(doc.assets.map((a) => a.id));
  const out: { scene: string; id: string; libraryId: string | null }[] = [];
  doc.scenes.forEach((s, si) => {
    if (s.kind !== "decl") return;
    let cs: CompiledScene;
    try {
      cs = compileDecl(s, at, { path: `scenes[${si}]` });
    } catch {
      return;
    }
    for (const id of cs.assets) if (!known.has(id)) out.push({ scene: s.id, id, libraryId: libraryIdFor(id, library) });
  });
  return out;
}

const words = (s: string) => s.trim().split(/\s+/).filter(Boolean).length;
const lum = (c: number[]) => c[0] + c[1] + c[2];
const overlap = (a: Inspected, b: { x: number; y: number; w: number; h: number }) =>
  Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x)) *
  Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y));

/** share of the frame above the caption zone darker than halfway from the sky to black (a dissolve's blocks) */
export function darkShare(f: Uint8Array, sky: string, black = "#090c0a", w = 320) {
  const cut = (lum(hexToRgb(sky)) + lum(hexToRgb(black))) / 2;
  let dark = 0;
  const n = w * CAPTION_TOP;
  for (let i = 0; i < n; i++) if (f[i * 3] + f[i * 3 + 1] + f[i * 3 + 2] <= cut) dark++;
  return dark / n;
}
const r2 = (t: number) => Math.round(t * 100) / 100;

/** time-typed fields of a decl scene as written in the doc: [path, value] */
function timeFields(s: Extract<ProjectT["scenes"][number], { kind: "decl" }>): [string, string | number][] {
  const out: [string, string | number][] = [
    [`${s.id}.from`, s.from],
    [`${s.id}.to`, s.to],
  ];
  const layer = (l: any, path: string) => {
    if (!l || typeof l !== "object") return;
    if (Array.isArray(l.show)) l.show.forEach((v: any, i: number) => void out.push([`${path}.show[${i}]`, v]));
    for (const [k, ks] of Object.entries(l.keys ?? {}))
      if (Array.isArray(ks)) ks.forEach((key: any, i: number) => void out.push([`${path}.keys.${k}[${i}].t`, key?.t]));
    (l.behaviors ?? []).forEach((b: any, i: number) => {
      if (b?.at !== undefined) out.push([`${path}.behaviors[${i}].at`, b.at]);
      if (b?.until !== undefined) out.push([`${path}.behaviors[${i}].until`, b.until]);
    });
    for (const k of ["at", "hit", "raise"])
      if (l.props?.[k] !== undefined) out.push([`${path}.props.${k}`, l.props[k]]);
    (l.children ?? []).forEach((c: any, i: number) => void layer(c, `${path}.children[${i}]`));
  };
  (s.layers ?? []).forEach((l, i) => void layer(l, `${s.id}.layers[${i}]`));
  for (const [k, ks] of Object.entries(s.camera?.keys ?? {}))
    ks.forEach((key, i) => void out.push([`${s.id}.camera.keys.${k}[${i}].t`, key.t]));
  (s.camera?.shakes ?? []).forEach((sh, i) => void out.push([`${s.id}.camera.shakes[${i}].at`, sh.at]));
  (s.recipes ?? []).forEach((r, i) => {
    const spec = RECIPE_MAP[r.id]?.params ?? {};
    for (const [k, v] of Object.entries(r.params ?? {}))
      if (spec[k]?.t === "time" && (typeof v === "string" || typeof v === "number"))
        out.push([`${s.id}.recipes[${i}].params.${k}`, v]);
  });
  return out;
}

function isRaw(v: string | number) {
  if (typeof v === "number") return v !== 0;
  try {
    return refsOf(v).length === 0 && Number(v) !== 0;
  } catch {
    return false;
  }
}

/** Lint a project. Sync; pass opts.assets for exact text widths and the sprite contrast check. */
export function lintProject(doc: ProjectT, tl: Timeline, opts: LintOpts = {}): Lint[] {
  const out: Lint[] = [];
  const add = (l: Lint) => out.push(l);
  const assets = opts.assets ? new Map(opts.assets) : new Map<string, Frames>();
  const colours = opts.colours ?? { P: "#e6e4da", k: "#090c0a" };
  const engine = createEngine({
    colours,
    sky: opts.sky ?? "#0f1411",
    assets,
    fontAssets: assets.has("font") ? ["font"] : undefined,
  });
  const every = opts.every ?? 0.1;

  // ---- cues
  for (const c of tl.cues) {
    const n = words(c.text);
    if (n > 12)
      add({
        rule: "cue-long",
        severity: "warn",
        t: r2(c.start),
        message: `cue ${c.id} has ${n} words`,
        fix: "split it in two or cut it to 12 words or fewer",
      });
    if (c.end - c.start < 1.5)
      add({
        rule: "cue-short",
        severity: "warn",
        t: r2(c.start),
        message: `cue ${c.id} is on screen for ${r2(c.end - c.start)} s`,
        fix: "give it at least 1.5 s (raise script.timing.minCue, or add words)",
      });
  }

  // ---- scene windows: no overlap, no gap, cover 0..duration
  const wins = [...tl.scenes].sort((a, b) => a.from - b.from);
  if (wins.length && Math.abs(wins[0].from) > 1e-6)
    add({
      rule: "scene-gap",
      severity: "error",
      scene: wins[0].id,
      t: 0,
      message: `nothing is on screen before ${r2(wins[0].from)} s`,
      fix: `start ${wins[0].id} at 0`,
    });
  for (let i = 1; i < wins.length; i++) {
    const a = wins[i - 1];
    const b = wins[i];
    if (b.from < a.to - 1e-6)
      add({
        rule: "scene-overlap",
        severity: "error",
        scene: b.id,
        t: r2(b.from),
        message: `${b.id} starts ${r2(a.to - b.from)} s before ${a.id} ends`,
        fix: `set ${b.id}.from to "${a.id}.to"`,
      });
    else if (b.from > a.to + 1e-6)
      add({
        rule: "scene-gap",
        severity: "error",
        scene: b.id,
        t: r2(a.to),
        message: `${r2(b.from - a.to)} s gap between ${a.id} and ${b.id}`,
        fix: `set ${b.id}.from to "${a.id}.to"`,
      });
  }
  const last = wins[wins.length - 1];
  if (last && last.to < tl.duration - 1e-6)
    add({
      rule: "scene-gap",
      severity: "error",
      scene: last.id,
      t: r2(last.to),
      message: `nothing is on screen after ${r2(last.to)} s (duration ${r2(tl.duration)} s)`,
      fix: `set ${last.id}.to to "duration"`,
    });

  const known = new Set(doc.assets.map((a) => a.id));
  const contrastDone = new Set<string>();
  const compiled: (CompiledScene | null)[] = doc.scenes.map(() => null);
  doc.scenes.forEach((s, si) => {
    if (s.kind !== "decl") return;
    // ---- raw seconds
    for (const [path, v] of timeFields(s))
      if (isRaw(v))
        add({
          rule: "raw-seconds",
          severity: "error",
          scene: s.id,
          message: `${path} is a raw time (${JSON.stringify(v)})`,
          fix: 'anchor it to the script, e.g. "S(c01)+0.4", "E(c02)" or "<scene>.from+0.5", so it follows the voice',
        });
    // ---- recipe params
    (s.recipes ?? []).forEach((r, i) => {
      for (const iss of checkRecipeParams(
        r.id,
        (r.params ?? {}) as Record<string, unknown>,
        tl.at,
        `${s.id}.recipes[${i}]`,
      ))
        add({
          rule: "recipe-params",
          severity: "error",
          scene: s.id,
          message: `${iss.path}: ${iss.message}`,
          fix: iss.fix,
        });
      const rec = RECIPE_MAP[r.id];
      const win = tl.scenes[si];
      if (rec && win && win.to - win.from < rec.minDurationSec)
        add({
          rule: "recipe-time",
          severity: "warn",
          scene: s.id,
          message: `${r.id} needs ${rec.minDurationSec} s, the scene is ${r2(win.to - win.from)} s`,
          fix: "give the scene more time or pick a shorter recipe",
        });
    });
    // ---- compile
    let cs: CompiledScene;
    try {
      cs = compileDecl(s, tl.at, { path: `scenes[${si}]` });
    } catch (e) {
      if (e instanceof DeclError)
        for (const iss of e.issues)
          add({
            rule: "compile",
            severity: "error",
            scene: s.id,
            message: `${iss.path}: ${iss.message}`,
            fix: iss.fix,
          });
      else
        add({
          rule: "compile",
          severity: "error",
          scene: s.id,
          message: String((e as Error)?.message ?? e),
          fix: "check the scene against docs/RECIPES.md",
        });
      return;
    }
    compiled[si] = cs;
    // ---- assets the scene draws must be in the project
    for (const id of cs.assets)
      if (!known.has(id)) {
        const lib = libraryIdFor(id);
        add({
          rule: "missing-asset",
          severity: "error",
          scene: s.id,
          message: `the scene draws asset "${id}" but the project has no asset with that id (it renders as a placeholder box)`,
          fix: lib
            ? `cast it: cast_asset { "name": "${id}", "libraryId": "${lib}" } (adds { "id": "${id}", "src": "lib:${lib}@1" } to assets)`
            : `add an asset with id "${id}" or change the layer to an asset the project has`,
        });
      }
    // ---- one character, drawn twice
    const actors = new Map<string, string[]>();
    const walkA = (ls: CompiledScene["layers"]) => {
      for (const l of ls) {
        if (l.kind === "actor" && typeof l.props.asset === "string")
          actors.set(l.props.asset, [...(actors.get(l.props.asset) ?? []), l.id]);
        walkA(l.children);
      }
    };
    walkA(cs.layers);
    const twinsMeant = (s.recipes ?? []).some(
      (r) => (r.params as Record<string, unknown> | undefined)?.second === true,
    );
    for (const [a, ids] of actors)
      if (ids.length > 1 && !twinsMeant)
        add({
          rule: "duplicate-actor",
          severity: "error",
          scene: s.id,
          message: `${ids.length} copies of "${a}" in one scene (${ids.join(", ")})`,
          fix: "let the later recipe reuse the scene's hero (drop its own hero layer), or pass second: true if two are meant",
        });
    // ---- sprite edge contrast against the sky
    const drawn = new Set<string>();
    const walkL = (ls: CompiledScene["layers"]) => {
      for (const l of ls) {
        if ((l.kind === "actor" || l.kind === "sprite") && typeof l.props.asset === "string") drawn.add(l.props.asset);
        walkL(l.children);
      }
    };
    walkL(cs.layers);
    if (opts.colours && opts.sky)
      for (const id of drawn) {
        const fr = assets.get(id);
        if (!fr || contrastDone.has(id)) continue;
        contrastDone.add(id);
        for (const [f, rows] of Object.entries(fr)) {
          const c = silhouetteContrast(rows, opts.colours, opts.sky);
          if (c.edges && c.ratio < 0.4)
            add({
              rule: "edge-contrast",
              severity: "warn",
              scene: s.id,
              message: `${id}/${f}: only ${Math.round(c.ratio * 100)}% of its edge reaches 1.7:1 against the sky`,
              fix: "lighten the ring just inside the outline, or add a light outline on the layer",
            });
        }
      }
    // ---- on-screen checks, sampled
    const crowded = new Set<string>();
    const clipRun = new Map<string, number>();
    const clipped = new Set<string>();
    const lowSeen = new Set<string>();
    const faceRun = new Map<string, number>();
    const faced = new Set<string>();
    for (let t = cs.from + 0.001; t < cs.to; t += every) {
      let seen: Inspected[];
      try {
        seen = inspectDecl(engine, cs, t);
      } catch (e) {
        add({
          rule: "draw",
          severity: "error",
          scene: s.id,
          t: r2(t),
          message: `drawing failed: ${(e as Error).message}`,
          fix: "check the layer props",
        });
        break;
      }
      const long = seen.filter((x) => x.text && words(x.text) >= 4 && x.widget !== "toast");
      if (long.length > 1 && !crowded.size) {
        crowded.add(s.id);
        add({
          rule: "text-crowding",
          severity: "warn",
          scene: s.id,
          t: r2(t),
          message: `${long.length} texts of 4+ words on screen at once (${long.map((x) => x.id).join(", ")}) besides the caption`,
          fix: "keep one short line per scene; the caption already carries the words",
        });
      }
      for (const x of seen) {
        const isText =
          x.kind === "text" ||
          x.widget === "counter" ||
          x.widget === "nameTag" ||
          x.widget === "banner" ||
          x.widget === "toast";
        if (isText) {
          const off = x.x < 0 || x.y < 0 || x.x + x.w > 320 || x.y + x.h > 180;
          const run = off ? (clipRun.get(x.id) ?? 0) + every : 0;
          clipRun.set(x.id, run);
          if (run >= 0.5 && !clipped.has(x.id)) {
            clipped.add(x.id);
            add({
              rule: "text-clipped",
              severity: "error",
              scene: s.id,
              t: r2(t),
              message: `${x.id} ("${x.text}") runs off the frame (${x.x},${x.y} ${x.w}x${x.h})`,
              fix: "shorten it, lower its scale, set fit: true, or move it inside 0..320 x 0..180",
            });
          }
        }
        // a prop drawn over a character's face (the top 40% of its box)
        if (x.kind === "actor") {
          const head = { x: x.x, y: x.y, w: x.w, h: Math.ceil(x.h * 0.4) };
          for (const o of seen.slice(seen.indexOf(x) + 1)) {
            if (o.kind !== "sprite" || o.w > 40 || o.h > 40) continue;
            const key = `${o.id}>${x.id}`;
            const hit = overlap(o, head) >= 4;
            const run = hit ? (faceRun.get(key) ?? 0) + every : 0;
            faceRun.set(key, run);
            if (run >= 0.2 - 1e-9 && !faced.has(key)) {
              faced.add(key);
              add({
                rule: "covers-face",
                severity: "error",
                scene: s.id,
                t: r2(t),
                message: `${o.id} is drawn over the head of ${x.id} for ${r2(run)} s`,
                fix: "pop it above the head with a gap, or hold it at the hand",
              });
            }
          }
        }
        const important =
          x.kind === "text" ||
          x.kind === "panel" ||
          (x.kind === "widget" && x.widget !== "qblock" && x.widget !== "flagpole");
        const low = important
          ? x.y + x.h > CAPTION_TOP
          : (x.kind === "actor" || x.kind === "sprite") && x.y >= CAPTION_TOP;
        if (low && !lowSeen.has(x.id) && doc.composition.captions.enabled) {
          lowSeen.add(x.id);
          add({
            rule: "caption-zone",
            severity: "warn",
            scene: s.id,
            t: r2(t),
            message: `${x.id} reaches y=${x.y + x.h}, into the caption zone (below y=${CAPTION_TOP})`,
            fix: `move it up so it ends above y=${CAPTION_TOP}`,
          });
        }
      }
    }
  });
  out.push(...emptyFrames(doc, tl, engine, compiled, opts.sky ?? "#0f1411", colours.k ?? "#090c0a"));
  return out;
}

/** frames worth sampling for emptiness: each scene's cut and the two frames after it, then every half second,
 * leaving out the final fade to black */
function emptySamples(tl: Timeline, fadeOut: number, fps = 30) {
  const ts: { t: number; scene: string }[] = [];
  for (const w of tl.scenes) {
    for (const t of [w.from, w.from + 1 / fps, w.from + 2 / fps]) ts.push({ t, scene: w.id });
    for (let t = w.from + 0.25; t < w.to; t += 0.5) ts.push({ t, scene: w.id });
  }
  return ts.filter((x) => x.t < tl.duration - fadeOut - 1e-6);
}

/** decl scenes drawn like the renderer draws them (dissolve and captions included), flagging frames that are almost
 * all black: a dissolve over nothing, a scene drawing nothing yet */
function emptyFrames(
  doc: ProjectT,
  tl: Timeline,
  e: Engine,
  compiled: (CompiledScene | null)[],
  sky: string,
  black: string,
): Lint[] {
  const out: Lint[] = [];
  const cc = {
    cues: tl.cues,
    scenes: tl.scenes,
    duration: tl.duration,
    captions: doc.composition.captions,
    dissolveIn: doc.composition.dissolveIn,
    fadeOut: doc.composition.fadeOut,
  };
  const last = new Map<number, Uint8Array>();
  const done = new Set<string>();
  for (const { t, scene } of emptySamples(tl, doc.composition.fadeOut)) {
    const k = tl.scenes.findIndex((w) => w.id === scene);
    const cs = compiled[k];
    if (!cs || done.has(scene)) continue;
    let prev: Uint8Array | undefined;
    const inDissolve = k > 0 && t - cs.from < cc.dissolveIn;
    // a code scene goes out under this dissolve: only real frames (lintFrames) can tell
    if (inDissolve && !compiled[k - 1]) continue;
    if (inDissolve && compiled[k - 1]) {
      prev = last.get(k - 1);
      if (!prev) {
        drawDecl(e, compiled[k - 1]!, compiled[k - 1]!.to - 1e-4);
        prev = Uint8Array.from(e.buf);
        last.set(k - 1, prev);
      }
    }
    try {
      drawDecl(e, cs, t);
    } catch {
      continue;
    }
    transitions(e, cc, t, prev);
    if (doc.composition.captions.by === "host") captions(e, cc, t);
    const d = darkShare(e.buf, sky, black, e.W);
    if (d >= 0.9) {
      done.add(scene);
      out.push({
        rule: "empty-frame",
        severity: "error",
        scene,
        t: r2(t),
        message: `the frame is ${Math.round(d * 100)}% black: nothing but the caption shows`,
        fix: "start the scene's recipes inside its window and check the dissolve has the outgoing scene under it",
      });
    }
  }
  return out;
}

/** Sampled-frame checks with a frame source (e.g. the renderer): flags frames that are a single flat colour, and
 * (given the sky) frames that are almost all black, sampling every cut too. */
export async function lintFrames(
  tl: Timeline,
  sample: (t: number) => Uint8Array | Promise<Uint8Array>,
  every = 1,
  opts: { sky?: string; black?: string; fadeOut?: number } = {},
): Promise<Lint[]> {
  const out: Lint[] = [];
  if (opts.sky) {
    const done = new Set<string>();
    for (const { t, scene } of emptySamples(tl, opts.fadeOut ?? 0)) {
      if (done.has(scene)) continue;
      const d = darkShare(await sample(t), opts.sky, opts.black);
      if (d < 0.9) continue;
      done.add(scene);
      out.push({
        rule: "empty-frame",
        severity: "error",
        scene,
        t: r2(t),
        message: `the frame is ${Math.round(d * 100)}% black: nothing but the caption shows`,
        fix: "start the scene's recipes inside its window and check the dissolve has the outgoing scene under it",
      });
    }
  }
  for (let t = every / 2; t < tl.duration; t += every) {
    const f = await sample(t);
    const first = (f[0] << 16) | (f[1] << 8) | f[2];
    let flat = true;
    for (let i = 3; i < f.length && flat; i += 3 * 7)
      if (((f[i] << 16) | (f[i + 1] << 8) | f[i + 2]) !== first) flat = false;
    if (flat) {
      const sc = tl.scenes.find((s) => t >= s.from && t < s.to);
      out.push({
        rule: "blank-frame",
        severity: "warn",
        scene: sc?.id,
        t: r2(t),
        message: "the frame is one flat colour",
        fix: "check the scene has layers and its assets resolve",
      });
    }
  }
  return out;
}
