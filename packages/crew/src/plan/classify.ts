// The change router's tiers (docs/PIP-ORCHESTRATION.md §1.12): how much a person's note costs to make. One pure
// function, read by Pip's card and estimate and by the crew's plan, so what Pip shows is what runs.
//   edit        free: Pip makes it in the same turn with a write tool (the time of day, a caption, a recipe's
//               params, a code scene's named constants, the pacing)
//   tune        a recipe scene that needs the Animator's judgement
//   code_patch  a code scene change beyond its constants: the Scene Coder patches the current code
//   replan      a story change (add, cut or reorder scenes, a new beat, new art): the Director re-plans
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { ProjectT } from "@pap/schema";
import { type ChangeCategory, constantsOf, type OpenProject } from "@pap/tools";
import { DIRECTOR, timeAsked } from "./route.ts";

export type ChangeTier = "edit" | "tune" | "code_patch" | "replan";
/** the write tool an edit uses, and its ready input when a rule decides it (the time, the pacing) */
export type EditHow =
  | { tool: "look_set_time"; input: { time: "night" | "dusk" | "day"; scenes?: string[] } }
  | { tool: "project_patch"; input: { ops: { op: "replace"; path: string; value: number }[]; reason: string } }
  | { tool: "script_set_cues"; cues: string[] }
  | { tool: "scene_set_recipes"; scene: string }
  | { tool: "code_set_constants"; scene: string; names: string[] };
export type Classified = {
  tier: ChangeTier;
  /** the scenes it touches (empty: the whole video follows by itself, or the re-plan is the whole video's) */
  scenes: string[];
  /** one plain sentence: what is done and by whom */
  how: string;
  /** an edit's tools, one per scene or one for the video */
  edits?: EditHow[];
  /** the time of day it sets (look.time) */
  time?: "night" | "dusk" | "day";
  /** each scene's own tier (the note's tier is the costliest) */
  per?: Record<string, ChangeTier>;
};
export type ClassifyNote = {
  text: string;
  target?: { scene?: string; cue?: string; asset?: string };
  category?: ChangeCategory;
};
export type ClassifyDoc = Pick<ProjectT, "scenes" | "script" | "composition" | "code"> & {
  assets?: { id: string }[];
};
/** a code scene's current bundle text (null: none, or unknown) */
export type SourceOf = (scene: string) => string | null;

/** a project's code scenes' current bundle text, read from disk */
export const sourceIn =
  (p: Pick<OpenProject, "dir" | "doc">): SourceOf =>
  (scene) => {
    const d = p.doc();
    const s = d.scenes.find((x) => x.id === scene);
    const e = s?.kind === "code" ? d.code.find((c) => c.id === s.bundle) : undefined;
    if (!e) return null;
    try {
      return readFileSync(join(p.dir, e.file), "utf8");
    } catch {
      return null;
    }
  };
/** classifyChange on an open project, its code read from disk */
export const classifyIn = (p: Pick<OpenProject, "dir" | "doc">, note: ClassifyNote) =>
  classifyChange(note, p.doc(), { source: sourceIn(p) });
/** the edit Pip makes without words of its own: the time of day or the pace (a rule decided the input) */
export const ruleEdit = (c: Classified) =>
  c.tier === "edit" ? c.edits?.find((e) => e.tool === "look_set_time" || e.tool === "project_patch") : undefined;

const RANK: ChangeTier[] = ["edit", "tune", "code_patch", "replan"];
const worst = (a: ChangeTier, b: ChangeTier) => (RANK.indexOf(b) > RANK.indexOf(a) ? b : a);

/** story words: add, cut or reorder scenes, a new beat, new art */
const STORY =
  /\b(add|insert|include)\s+(a|an|one|another|two|three|some|more)?\s*(new\s+|short\s+|extra\s+)?(\w+\s+)?(scenes?|beats?|shots?)\b|\b(a|an|another|one more)\s+new\s+(scene|beat|shot)\b|\bnew\s+(scenes?|beats?|shots?)\b|\b(cut|remove|drop|delete|lose)\s+(the\s+)?(\w+\s+)?(scene|beat|shot)s?\b(?!\s+\d)|\b(cut|remove|drop|delete)\s+scene\s+\d+\b|\b(re-?order|reshuffle)\b|\b(swap|switch)\s+(the\s+)?(order|scenes)\b|\border of the scenes\b|\bmove scene\s+\d+\s+(before|after|to)\b|\bnew art\b|\b(draw|paint|design)\s+(a|an|some)?\s*(new\s+)?(character|sprite|creature|asset|mascot)s?\b|\bnew (character|sprite|creature|mascot)s?\b/i;
/** a caption or the script's words */
const CAPTION =
  /\b(typo|typos|spelling|spelt|spelled|misspel\w*|caption|captions|subtitle|subtitles|reword|rephrase|wording|grammar|cue\s*\d+|line\s*\d+)\b/i;
/** the whole video's pace, by rule */
const SLOWER = /\b(slower|slow (it )?down|too fast|too quick|rushed|less rushed|more time to read)\b/i;
const FASTER = /\b(faster|quicker|speed (it )?up|too slow|drags|snappier|tighter)\b/i;
const END_LONGER =
  /\bhold\b[^.!?]{0,30}\b(end|ending|end card|last|final|finale)\b[^.!?]{0,20}\blonger\b|\b(end|ending|end card|finale|last shot)\b[^.!?]{0,20}\b(hold|stay|last|linger)s?\b[^.!?]{0,12}\blonger\b|\blonger (end|ending|end card|final hold|hold at the end)\b/i;
/** where and how big: a named constant or a recipe param decides it */
const PLACE =
  /\b(up|down|left|right|higher|lower|raise|bigger|smaller|larger|move|moves|shift|nudge|closer|further|farther|longer|shorter|earlier|later|sooner|hold|centre|center|size|position|place)\b/i;
/** a scene's own pace ("too fast", "slower"): its hold or duration constants, else a patch */
const PACE = /\b(fast|faster|slow|slower|quick|quicker|rushed|speed|pace|longer|shorter|linger)\b/i;
const TIMING_PARTS = new Set([
  "hold",
  "dur",
  "duration",
  "speed",
  "pace",
  "fps",
  "delay",
  "gap",
  "beat",
  "step",
  "wait",
]);
/** taste, which needs the Animator's eye on a recipe scene */
const JUDGE =
  /\b(feel|feels|lively|livelier|smoother|choppy|jumpy|dynamic|energy|energetic|boring|flat|awkward|natural|nicer|polish|exciting|punchier|fun)\b/i;
/** take something out, or put another in its place */
const REMOVE = /\b(remove|take\b[^.!?]{0,30}\bout|get rid of|drop|without|no more|only)\b/i;
const SWAP = /\b(swap|replace|instead of|change\b[^.!?]{0,30}\bto)\b/i;
/** every scene, said in words */
export const EVERY =
  /\b(every|each|all)\s+(the\s+)?scenes?\b|\ball of (the|them)\b|\beverywhere\b|\bthroughout\b|\bwhole (video|thing)\b|\bin all of it\b/i;

/** a code scene reads the video's time: its sky follows canvas.time with no re-code */
export const readsTime = (src: string) => /\bTIME\b|\bskyGradient\s*\(/.test(src);

const STOP = new Set(
  "the a an and or of in on at to for from with by into onto out up down off over under its it this that these those our your their my we us me you they them he she his her is are be was were make made put take get set keep let please bit little slightly much more less very just only also too still now then than there here own every each all scene scenes video thing things one two three some any extra which what who where when how lower higher left right bigger smaller move shift nudge closer further longer shorter earlier later sooner hold players player".split(
    " ",
  ),
);

const sceneIndex = (doc: ClassifyDoc, text: string) => {
  const m = /\bscene\s*(\d+)\b/i.exec(text);
  return m ? doc.scenes[Number(m[1]) - 1]?.id : undefined;
};
/** a crew code scene: a beat from the board (an imported bundle without one stays the person's) */
const isCrewCode = (s: ClassifyDoc["scenes"][number]) => s.kind === "code" && !!(s as { beat?: string }).beat;
const wordRe = (w: string) => new RegExp(`\\b${w.replace(/[^a-z0-9]/gi, "")}(s|es)?\\b`, "i");

/** what a scene shows, as text: its title, beat, assets, recipe params and code */
function content(s: ClassifyDoc["scenes"][number], src: SourceOf): string {
  const x = s as { title?: string; beat?: string; assets?: string[]; recipes?: unknown[] };
  return [
    x.title ?? "",
    x.beat ?? "",
    (x.assets ?? []).join(" "),
    JSON.stringify(x.recipes ?? []),
    // the code without its import lines (every bundle imports flag, sprite, text…)
    s.kind === "code" ? (src(s.id) ?? "").replace(/^\s*import\b[^;]*;?\s*$/gm, "") : "",
  ].join("\n");
}

/** the words of a note that name something on screen somewhere in the project (an asset, a castle, a flag) */
function subjects(text: string, doc: ClassifyDoc, src: SourceOf): string[] {
  const words = [...new Set((text.toLowerCase().match(/[a-z][a-z0-9_-]{2,}/g) ?? []).map((w) => w.replace(/'s$/, "")))]
    .map((w) => (w.endsWith("s") && !w.endsWith("ss") ? w.slice(0, -1) : w))
    .filter((w) => !STOP.has(w));
  const all = doc.scenes.map((s) => content(s, src)).join("\n");
  return words.filter((w) => wordRe(w).test(all) || (doc.assets ?? []).some((a) => a.id === w));
}

/** the named constants of a code scene that a note's words reach: by name part, or by a value that lists a subject */
function constantsHit(source: string, subj: string[], text: string): string[] {
  const t = text.toLowerCase();
  const holdWords = /\b(hold|end|ending|last|final|longer|shorter|pause)\b/.test(t);
  const pace = PACE.test(t);
  return constantsOf(source)
    .filter((c) => {
      const parts = c.name.toLowerCase().split("_");
      if (subj.some((w) => parts.some((p) => p === w || p === `${w}s` || `${p}s` === w))) return true;
      if (holdWords && parts.some((p) => p === "hold" || p === "end")) return true;
      if (pace && parts.some((p) => TIMING_PARTS.has(p))) return true;
      const vals = Array.isArray(c.value) ? c.value : [c.value];
      return subj.some((w) => vals.some((v) => typeof v === "string" && v.toLowerCase() === w));
    })
    .map((c) => c.name);
}

/** one scene's tier for a note that isn't the time, the pacing, the words or the story */
function sceneTier(
  s: ClassifyDoc["scenes"][number],
  text: string,
  subj: string[],
  src: SourceOf,
): { tier: ChangeTier; edit?: EditHow } {
  const place = PLACE.test(text) || PACE.test(text);
  const takeOut = REMOVE.test(text) || SWAP.test(text);
  if (s.kind === "code") {
    const code = src(s.id);
    if (code && (place || takeOut)) {
      const names = constantsHit(code, subj, text);
      if (names.length) return { tier: "edit", edit: { tool: "code_set_constants", scene: s.id, names } };
    }
    return { tier: "code_patch" };
  }
  if (JUDGE.test(text)) return { tier: "tune" };
  // staging a recipe scene anew (a new cast, a backdrop, a sky, sitting, flying, a sign): the Director re-plans the
  // scene; swapping or taking out what the project already has stays a params edit
  if (DIRECTOR.test(text) && !(takeOut && subj.length)) return { tier: "replan" };
  // a recipe's params decide where, how big, when and who: Pip sets them
  if (place || takeOut) return { tier: "edit", edit: { tool: "scene_set_recipes", scene: s.id } };
  return { tier: "tune" };
}

/**
 * How a person's note is made, and what it costs: `edit` (free, Pip's own write), `tune`, `code_patch` or `replan`,
 * the scenes it touches and one sentence on how. `source` reads a code scene's current bundle (the named constants,
 * whether it reads TIME, what it draws); without it every code scene counts as unknown.
 */
export function classifyChange(note: ClassifyNote, doc: ClassifyDoc, o: { source?: SourceOf } = {}): Classified {
  const src: SourceOf = o.source ?? (() => null);
  const text = (note.text ?? "").trim();
  const target = note.target ?? {};
  const category = note.category ?? "other";
  const sceneId = target.scene ?? sceneIndex(doc, text);
  // 1. the story: new, cut or reordered scenes, a new beat, new art
  if (category === "story" || STORY.test(text) || target.asset)
    return {
      tier: "replan",
      scenes: sceneId ? [sceneId] : [],
      how: target.asset
        ? `The Pixel artist redraws ${target.asset}, then the scenes that use it are redone.`
        : `The Director re-plans ${sceneId ? `scene ${doc.scenes.findIndex((s) => s.id === sceneId) + 1}` : "the video"}, then the scenes are made again.`,
    };
  // 2. the time of day: canvas.time, or the named scene's own; a code scene that draws its sky from TIME follows by
  // itself
  const time = category === "sound" ? null : timeAsked(text);
  if (time) {
    const hard = doc.scenes
      .filter((s) => (!sceneId || s.id === sceneId) && isCrewCode(s) && !readsTime(src(s.id) ?? ""))
      .map((s) => s.id);
    return {
      tier: hard.length ? "code_patch" : "edit",
      scenes: hard,
      time,
      edits: [{ tool: "look_set_time", input: sceneId ? { time, scenes: [sceneId] } : { time } }],
      per: Object.fromEntries(hard.map((id) => [id, "code_patch" as ChangeTier])),
      how: sceneId
        ? hard.length
          ? `Scene ${doc.scenes.findIndex((s) => s.id === sceneId) + 1} is set at ${time}; the Scene Coder patches its fixed sky.`
          : `Scene ${doc.scenes.findIndex((s) => s.id === sceneId) + 1} is set at ${time}: it draws its sky from the time of day, so nothing is re-made.`
        : hard.length
          ? `The video is set at ${time}; the Scene Coder patches ${hard.length === 1 ? "the one code scene" : `${hard.length} code scenes`} that draw${hard.length === 1 ? "s" : ""} a fixed sky.`
          : `The video is set at ${time}: every scene draws its sky from the time of day, so nothing is re-made.`,
    };
  }
  // 3. a caption or the script's words: Pip rewrites the cue, timing follows by rule
  if (
    category !== "sound" &&
    (target.cue || category === "text" || CAPTION.test(text)) &&
    !(sceneId && PLACE.test(text) && !CAPTION.test(text))
  ) {
    const n = /\b(?:cue|line)\s*(\d+)\b/i.exec(text);
    const cues = target.cue ? [target.cue] : n ? [doc.script.cues[Number(n[1]) - 1]?.id].filter(Boolean) : [];
    return {
      tier: "edit",
      scenes: [],
      edits: [{ tool: "script_set_cues", cues: cues as string[] }],
      how: "The cue's words change; its timing follows by rule.",
    };
  }
  // 4. the whole video's pace, by rule (a scene's own pace is that scene's)
  const t = doc.script.timing;
  const c = doc.composition;
  const slower = SLOWER.test(text);
  const faster = !slower && FASTER.test(text);
  const endLonger = END_LONGER.test(text);
  if (!sceneId && category !== "sound" && (endLonger || ((slower || faster) && t.mode !== "aligned"))) {
    const r1 = (x: number) => Math.round(x * 10) / 10;
    const ops: { op: "replace"; path: string; value: number }[] = [];
    if (endLonger) ops.push({ op: "replace", path: "/composition/endHold", value: Math.min(60, r1(c.endHold + 2)) });
    if (slower)
      ops.push(
        { op: "replace", path: "/script/timing/wps", value: Math.max(1, r1((t.wps ?? 2.5) * 0.85)) },
        { op: "replace", path: "/script/timing/pause", value: Math.min(3, r1((t.pause ?? 0.2) + 0.1)) },
      );
    if (faster)
      ops.push(
        { op: "replace", path: "/script/timing/wps", value: Math.min(5, r1((t.wps ?? 2.5) * 1.15)) },
        { op: "replace", path: "/script/timing/pause", value: Math.max(0, r1((t.pause ?? 0.2) - 0.1)) },
      );
    return {
      tier: "edit",
      scenes: [],
      edits: [{ tool: "project_patch", input: { ops, reason: `the pace: ${text.slice(0, 120)}` } }],
      how: endLonger
        ? "The end card holds 2 s longer; every scene follows the script's times."
        : `The script reads ${slower ? "slower" : "faster"}; every scene follows its cue times.`,
    };
  }
  // sound is the Sound designer's, a model call over the mix
  if (category === "sound") return { tier: "tune", scenes: [], how: "The Sound designer redoes the sound." };
  // 5. scene by scene: a named scene, the scenes that show what the note names, or every scene
  const subj = subjects(text, doc, src);
  let ids: string[];
  if (sceneId) ids = [sceneId];
  else {
    const counted = doc.scenes
      .map((s) => {
        const body = content(s, src);
        return { id: s.id, n: subj.filter((w) => wordRe(w).test(body)).length };
      })
      .filter((x) => x.n > 0);
    const most = Math.max(0, ...counted.map((x) => x.n));
    // the scenes that show the most of what the note names ("the castle's own flag": the one with a castle and a
    // flag, not every scene with the logo); "every scene" with a subject: every scene that has it
    ids = counted.length
      ? EVERY.test(text)
        ? counted.map((x) => x.id)
        : counted.filter((x) => x.n === most).map((x) => x.id)
      : doc.scenes.map((s) => s.id);
  }
  const per: Record<string, ChangeTier> = {};
  const edits: EditHow[] = [];
  let tier: ChangeTier = "edit";
  for (const id of ids) {
    const s = doc.scenes.find((x) => x.id === id);
    if (!s) continue;
    const st = sceneTier(s, text, subj, src);
    per[id] = st.tier;
    tier = worst(tier, st.tier);
    if (st.edit) edits.push(st.edit);
  }
  const ns = ids.map((id) => doc.scenes.findIndex((s) => s.id === id) + 1).filter((n) => n > 0);
  const w = `${ns.length === 1 ? "scene" : "scenes"} ${ns.length === 1 ? ns[0] : `${ns.slice(0, -1).join(", ")} and ${ns.at(-1)}`}`;
  const how =
    tier === "edit"
      ? `I change ${w} myself: ${[...new Set(edits.map((e) => (e.tool === "code_set_constants" ? `its constants ${e.names.join(", ")}` : "its recipe settings")))].join(" and ")}.`
      : tier === "tune"
        ? `The Animator tunes ${w}.`
        : `The Scene Coder patches the code of ${w}.`;
  return { tier, scenes: ids, how, ...(edits.length ? { edits } : {}), per };
}

/** the model calls a classified change costs (the gateway's estimate kinds); an edit costs none */
export function changeKinds(c: Classified): { kind: string; role: string; count?: number }[] {
  const per = Object.values(c.per ?? {});
  const code = per.filter((x) => x === "code_patch").length || (c.tier === "code_patch" ? 1 : 0);
  const tune = per.filter((x) => x === "tune").length || (c.tier === "tune" ? 1 : 0);
  // the sound: no model call of its own; the review that checks it
  if (c.tier === "tune" && !c.scenes.length) return [{ kind: "review.final", role: "reviewer", count: 2 }];
  switch (c.tier) {
    case "edit":
      return [];
    case "replan":
      return [
        { kind: "director.storyboard", role: "director" },
        { kind: "scene.tune", role: "animator", count: Math.max(1, c.scenes.length) },
        { kind: "review.final", role: "reviewer", count: 2 },
      ];
    default:
      return [
        // a patch per code scene and its check first (PATCH_PRICES: one call at p50)
        ...(code
          ? [
              { kind: "scene.patch", role: "scene-coder", count: code },
              { kind: "scene.check", role: "editor", count: code },
            ]
          : []),
        ...(tune ? [{ kind: "scene.tune", role: "animator", count: 2 * tune }] : []),
        { kind: "review.final", role: "reviewer", count: 1 },
      ];
  }
}
