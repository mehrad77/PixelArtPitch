// Code scenes (docs/PIP-ORCHESTRATION.md §1.13): the stub bundle the storyboard writes, the engine API sheet the Scene
// Coder reads (generated from the exports a bundle really gets, so it can't drift), and the trial render that loads a
// candidate bundle in the sandbox, probes what it draws and renders its stills, without touching the project.
import { readFileSync } from "node:fs";
import { createEngine, ENGINE_EXPORTS } from "@pap/engine/core";
import { type CodeProbe, type Lint, lintBundleSource, lintCodeProbes } from "@pap/engine/lints";
import { encodePng, type LoadedProject, openRenderer, png, type Renderer } from "@pap/render";
import { type ProjectT, resolveTimeline, SfxType } from "@pap/schema";

/** a bundle id the crew owns: the scene's own id, used by that scene only (an imported `legacy` bundle is the person's) */
export function crewBundle(doc: Pick<ProjectT, "scenes" | "code">, sceneId: string) {
  const s = doc.scenes.find((x) => x.id === sceneId);
  if (s?.kind !== "code" || s.bundle !== s.id) return null;
  if (doc.scenes.some((x) => x.id !== s.id && x.kind === "code" && x.bundle === s.bundle)) return null;
  return doc.code.find((b) => b.id === s.bundle) ?? null;
}

/** the closing card: a recipe scene with end_card_loop, or a code scene marked endCard */
export const isEndCard = (sc: { kind: string; recipes?: { id: string }[]; endCard?: boolean }) =>
  sc.kind === "decl" ? !!sc.recipes?.some((r) => r.id === "end_card_loop") : !!sc.endCard;

/** how Pip's state lines name a scene's make-up: its recipes, or "code" with the start of its beat */
export function sceneMakeup(
  sc: { kind: string; recipes?: { id: string }[]; beat?: string; bundle?: string },
  doc?: Pick<ProjectT, "code">,
) {
  if (sc.kind === "decl") return (sc.recipes ?? []).map((r) => r.id).join("+");
  const stub = doc?.code.find((c) => c.id === sc.bundle)?.stub;
  const beat = sc.beat?.trim() ? `: ${sc.beat.trim().slice(0, 60)}${sc.beat.trim().length > 60 ? "…" : ""}` : "";
  return `code${stub ? " (sketch)" : ""}${beat}`;
}

/** a scene is a code scene still drawn by its storyboard stub */
export const isStub = (doc: Pick<ProjectT, "scenes" | "code">, sceneId: string) => !!crewBundle(doc, sceneId)?.stub;

/**
 * The stub a code scene starts with: the night sky with a few stars, the ground, its title and the assets it names
 * standing on the ground (only those the project has, so there is never a placeholder box). Deterministic, and the
 * same for the same scene. The Scene Coder replaces it.
 */
export function stubSource(s: { id: string; title: string; assets: string[] }) {
  return `// The storyboard's sketch of scene "${s.id}": the night, its title and its assets. The Scene Coder replaces it.
import { asset, clear, px, rect, rnd, RGB, sprite, text } from "pap:engine";

const TITLE = ${JSON.stringify(s.title.slice(0, 40))};
const ASSETS = ${JSON.stringify(s.assets.slice(0, 8))};

export function draw(t) {
  clear();
  for (let i = 0; i < 40; i++) px(Math.floor(rnd(i * 2 + 1) * 320), Math.floor(rnd(i * 2 + 2) * 120), RGB.q);
  rect(0, 148, 320, 32, "K");
  rect(0, 148, 320, 1, "l");
  text(TITLE, 160, 24, { align: "center", colour: "T" });
  const have = ASSETS.filter((a) => asset(a));
  const gap = Math.floor(320 / (have.length + 1));
  have.forEach((a, i) => {
    const rows = Object.values(asset(a))[0];
    if (rows && rows.length) sprite(rows, gap * (i + 1) - Math.floor(rows[0].length / 2), 148 - rows.length);
  });
}
`;
}

// ---------------------------------------------------------------- the API sheet

/** one line per name a bundle can import from "pap:engine"; a test keeps it equal to ENGINE_EXPORTS */
export const ENGINE_DOC: Record<(typeof ENGINE_EXPORTS)[number], string> = {
  W: "the frame width, 320",
  H: "the frame height, 180",
  buf: "the frame: a Uint8Array of 320*180*3 RGB bytes (rarely needed: draw with the functions below)",
  COLOURS: 'palette letter -> "#rrggbb"',
  RGB: "palette letter -> [r, g, b]; px() takes these triples (RGB.P), not letters",
  SKY: 'the night sky "#0f1411"; clear() paints it',
  clear: "paint the whole frame one colour (default the sky); call it first in every draw(t)",
  px: "one pixel; c is an RGB triple such as RGB.P (a letter here writes black), a is 0..1",
  rect: 'a filled rectangle; c is a palette letter ("K") or "#rrggbb", a is 0..1',
  box: "a 1 px rectangle outline in colour c",
  panel: 'a dark panel with a 1 px border and a shadow; opts { border = "G", fill = "k", alpha = 0.88 }',
  sprite:
    "draw letter rows (an asset frame) at x, y (top-left); opts { flip, outline, alpha, colour, scale } (scale is a whole number)",
  asset: "an asset's frames { frameName: rows } by its project id, or null when the project has none",
  frame: "one frame's rows of an asset (frame(id, name)); an unknown id draws an orange placeholder box: never do that",
  measure: "the pixel width of a text at a scale",
  text: 'text at x, y (top-left of the first line); opts { colour = "P", scale = 1, align = "left"|"center"|"right", shadow = true, alpha }; glyphs are 8 px tall at scale 1; returns the width',
  wrap: "split a text into lines that fit maxW pixels",
  clamp: "clamp v to a..b (default 0..1)",
  lerp: "a + (b - a) * t",
  ease: "an ease-out curve on 0..1",
  step: "round v to a multiple of n (whole pixels: step(x))",
  prog: "0..1 progress of t through [a, b], clamped",
  rnd: "deterministic noise in 0..1 from an integer i (the only randomness allowed)",
};

/** one line per name in "pap:timeline" (timelineModule's keys plus S and E); a test keeps it equal */
export const TIMELINE_DOC: Record<string, string> = {
  S: 'S("c05") is when cue c05 starts, in seconds (S(4) by index works too)',
  E: 'E("c05") is when cue c05 ends',
  CUES: "the cue texts in order (the captions; never draw them)",
  CUE_IDS: 'the cue ids in order ("c01", "c02"...)',
  TIMES: "[start, end] seconds per cue, in order",
  HOLD: "seconds of hold before the first frame",
  END_CARD_HOLD: "seconds the end card holds after the last cue",
  DURATION: "the video's length in seconds",
  SCENES: "[{ id, from, to }] per scene in seconds; your scene's window is SCENES.find((s) => s.id === <id>)",
  EVENTS: "named events in seconds",
};

/** "text(str, x, y, opts = {})": a function's parameter list as written (type stripping leaves spaces for types) */
function signature(name: string, v: unknown) {
  if (typeof v !== "function") return name;
  const src = Function.prototype.toString.call(v);
  const m = /^[^(]*\(([\s\S]*?)\)\s*(=>|\{)/.exec(src);
  const params = (m?.[1] ?? "")
    .replace(/:\s*[^,=)]+(?=[,=)]|$)/g, "")
    .replace(/\s+/g, " ")
    .replace(/\s*,\s*/g, ", ")
    .replace(/\s*=\s*/g, " = ")
    .trim();
  return `${name}(${params.length > 90 ? `${params.slice(0, 90)}…` : params})`;
}

/** the engine and timeline API a bundle gets, one line each, from the real exports */
export function apiSheet() {
  const e = createEngine({ colours: { P: "#ffffff" }, sky: "#000000", assets: new Map() }) as Record<string, unknown>;
  const missing = ENGINE_EXPORTS.filter((k) => !(k in ENGINE_DOC));
  if (missing.length) throw new Error(`ENGINE_DOC lacks ${missing.join(", ")}`);
  const eng = ENGINE_EXPORTS.map((k) => `- ${signature(k, e[k])}: ${ENGINE_DOC[k]}`);
  const tl = Object.entries(TIMELINE_DOC).map(([k, v]) => `- ${k === "S" || k === "E" ? `${k}(cue)` : k}: ${v}`);
  return `import { … } from "pap:engine":\n${eng.join("\n")}\n\nimport { … } from "pap:timeline":\n${tl.join("\n")}`;
}

/** the public example bundle the prompt shows (written for PAP; it uses only library assets) */
export const exampleBundle = () => readFileSync(new URL("../prompts/scene-coder/example.mjs", import.meta.url), "utf8");

// ---------------------------------------------------------------- the trial render

export type Trial = {
  ok: boolean;
  /** errors to repair: a load or draw error, or error-level lints */
  errors: string[];
  warnings: string[];
  /** start, middle and end, PNG at scale 2 */
  stills: { caption: string; data: Uint8Array }[];
  /** six frames of the scene, 3 x 2 at scale 1, PNG */
  strip?: Uint8Array;
  /** the bundle exports sfxEvents() and every event is valid */
  sfx: boolean;
};

const lintLine = (l: Lint) => `${l.severity}: ${l.message}${l.t !== undefined ? ` (t=${l.t})` : ""} (fix: ${l.fix})`;

/** a copy of the loaded project where `sceneId` is drawn by `source` (its bundle entry made or replaced), probed */
export function trialProject(lp: LoadedProject, sceneId: string, source: string, sfx: boolean): LoadedProject {
  const k = lp.doc.scenes.findIndex((s) => s.id === sceneId);
  const old = lp.doc.scenes[k];
  const bundle = old.kind === "code" ? old.bundle : sceneId;
  const entry = { id: bundle, file: `code/${bundle}.mjs`, fullFrame: false, sfx };
  const doc: ProjectT = {
    ...lp.doc,
    scenes: lp.doc.scenes.map((s, i) => (i === k ? ({ ...s, kind: "code", bundle } as ProjectT["scenes"][number]) : s)),
    code: [...lp.doc.code.filter((b) => b.id !== bundle), entry],
  };
  const others = lp.bundles.filter((b) => b.id !== bundle);
  return {
    ...lp,
    doc,
    timeline: resolveTimeline(doc),
    bundles: [...others, { ...entry, source, initArg: undefined }],
    probe: true,
  };
}

/**
 * Load `source` as the scene's bundle in a fresh sandbox and check it: the source lints, a probe at 12 times across
 * the scene (caption zone, off-frame text, placeholder boxes, draw time), its sfxEvents(), the stills and the strip.
 * Never throws for the bundle's own faults: they come back in `errors` for the repair.
 */
export async function trialRender(
  lp: LoadedProject,
  sceneId: string,
  source: string,
  o: { signal?: AbortSignal } = {},
): Promise<Trial> {
  const assets = new Map(lp.assets.map(([id, f]) => [id, Object.keys(f ?? {})]));
  const errors: string[] = [];
  const warnings: string[] = [];
  for (const l of lintBundleSource(sceneId, source, assets))
    (l.severity === "error" ? errors : warnings).push(lintLine(l));
  const empty: Trial = { ok: false, errors, warnings, stills: [], sfx: false };
  if (errors.some((e) => /bundle-shape|imports|uses /.test(e))) return empty;
  const wantsSfx = /export\s+(function\s+sfxEvents\b|const\s+sfxEvents\b|\{[^}]*\bsfxEvents\b)/.test(source);
  const tp = trialProject(lp, sceneId, source, wantsSfx);
  const w = tp.timeline.scenes.find((s) => s.id === sceneId)!;
  let r: Renderer | null = null;
  try {
    try {
      r = await openRenderer(tp);
    } catch (e: any) {
      errors.push(`the module failed to load: ${String(e?.message ?? e).slice(0, 400)}`);
      return empty;
    }
    const span = Math.max(0.1, w.to - w.from);
    const times = Array.from({ length: 12 }, (_, i) => +(w.from + 0.05 + (span - 0.1) * (i / 11)).toFixed(2));
    const probes: CodeProbe[] = [];
    for (const t of times) {
      if (o.signal?.aborted) throw new Error("stopped");
      try {
        const pr = await r.probe(t);
        if (pr.scene === sceneId) probes.push({ t, ms: pr.ms, boxes: pr.boxes as CodeProbe["boxes"] });
      } catch (e: any) {
        const msg = String(e?.message ?? e);
        errors.push(
          /timed out/i.test(msg)
            ? `draw(${t}) took over 250 ms and was stopped (the sandbox's limit per frame): ${msg.slice(0, 200)}`
            : `draw(${t}) threw: ${msg.slice(0, 400)}`,
        );
        return { ...empty, errors };
      }
    }
    for (const l of lintCodeProbes(sceneId, probes, { captions: lp.doc.composition.captions.enabled }))
      (l.severity === "error" ? errors : warnings).push(lintLine(l));
    let sfx = false;
    if (wantsSfx)
      try {
        const evs = await r.sfxEvents();
        const bad = evs.filter((e) => !SfxType.safeParse(e.type).success || !(e.t >= 0 && e.t <= tp.timeline.duration));
        if (bad.length)
          errors.push(
            `sfxEvents() returned ${bad.length} bad event(s), e.g. ${JSON.stringify(bad[0])}: each is { t: seconds inside the video, type: one of ${SfxType.options.join(", ")} }`,
          );
        else sfx = true;
      } catch (e: any) {
        errors.push(`sfxEvents() threw: ${String(e?.message ?? e).slice(0, 300)}`);
      }
    const at = [w.from + 0.5, (w.from + w.to) / 2, Math.max(w.from, w.to - 0.3)].map((x) => +x.toFixed(2));
    const stills = [];
    for (const t of at) stills.push({ caption: `t=${t}s`, data: png(await r.frame(t), 2) as Uint8Array });
    // six frames across the scene, 3 x 2
    const W = 320;
    const H = 180;
    const sheet = Buffer.alloc(W * 3 * H * 2 * 3);
    for (let i = 0; i < 6; i++) {
      const f = await r.frame(+(w.from + 0.1 + (span - 0.2) * (i / 5)).toFixed(2));
      const ox = (i % 3) * W;
      const oy = Math.floor(i / 3) * H;
      for (let y = 0; y < H; y++) f.copy(sheet, ((oy + y) * W * 3 + ox) * 3, y * W * 3, (y + 1) * W * 3);
    }
    const strip = encodePng(W * 3, H * 2, sheet) as Uint8Array;
    return { ok: !errors.length, errors, warnings, stills, strip, sfx };
  } finally {
    r?.close();
  }
}

/** the cue lines a coder times against: id, its S()/E() seconds, its text */
export function cueLines(lp: Pick<LoadedProject, "timeline">, cues: string[]) {
  return lp.timeline.cues
    .filter((c) => cues.includes(c.id))
    .map((c) => `${c.id}: S("${c.id}") = ${c.start.toFixed(2)} s, E("${c.id}") = ${c.end.toFixed(2)} s: ${c.text}`);
}

/** the assets a scene may draw, with frame names and sizes: "founder (16x24): idle0, idle1, run0…" */
export function assetLines(lp: Pick<LoadedProject, "assets">, names: string[]) {
  const by = new Map(lp.assets);
  return names
    .filter((n) => by.has(n))
    .map((n) => {
      const f = by.get(n) ?? {};
      const first = Object.values(f)[0] ?? [];
      const names = Object.keys(f);
      return `${n} (${first[0]?.length ?? 0}x${first.length}): ${names.slice(0, 24).join(", ")}${names.length > 24 ? `, … (${names.length} frames)` : ""}`;
    });
}
