// Believable transcripts for the mock crew, in the server's own formats (packages/crew/src/orchestrator.ts and
// packages/tools/src/store.ts): "Asked <model> (<card>)", "<tool> → ok|<code>", "Changed the project: …",
// "Answered in N s · T tokens · $x". The mock emits them as `activity` events when a task starts, while it works,
// and when it ends; nothing here touches state.
import type { ActivityEntry, Task } from "../lib/types.ts";

export type Beat = Omit<ActivityEntry, "at">;

type ToolBeat = { name: string; input: unknown; result: unknown; image?: boolean };
type Script = {
  card: string;
  prompt: string;
  tools: ToolBeat[];
  patch?: { reason: string; ops: unknown[] };
  answer: unknown;
  thinking?: string;
};

const SCRIPTS: Record<string, Script> = {
  "producer.plan": {
    card: "producer/plan",
    prompt:
      "You are the Producer of a small pixel-art pitch crew.\n\nBrief:\n- product: Lantern, a night-market finder\n- audience: demo night, investors\n- length: 30 s\n- cap: $6.00\n\nSplit the budget across the departments and list the tasks in order. Keep one retry in reserve.",
    tools: [
      { name: "read_project", input: { fields: ["brief", "budget"] }, result: { rev: 2, lengthSec: 30, capUsd: 6 } },
      {
        name: "estimate_cost",
        input: { tasks: ["script", "board", "art", "animate", "sound"] },
        result: { lowUsd: 3.3, highUsd: 5.1 },
      },
    ],
    patch: {
      reason: "Set a 30 s cut for the demo-night slot",
      ops: [{ op: "replace", path: "/brief/lengthSec", value: 30 }],
    },
    answer: { split: { story: 0.2, art: 0.45, animation: 0.2, soundAndEdit: 0.15 }, reserveUsd: 0.6 },
  },
  "writer.angles": {
    card: "writer/angles",
    prompt:
      "You are the Writer. Write three short script angles for a 30 s pitch.\nEach angle: a one-line hook, 6 to 8 cues, under 75 words in all.\nThe audience is tired investors at 9 pm: open on a feeling, not a feature.",
    tools: [
      { name: "read_brief", input: {}, result: { product: "Lantern", tone: "warm, a little funny", lengthSec: 30 } },
      {
        name: "count_words",
        input: { text: "Every night market has a secret…" },
        result: { words: 68, readSec: 27.4 },
      },
      { name: "check_timing", input: { cues: 8, wpm: 150 }, result: { fits: true, slackSec: 2.6 } },
    ],
    patch: {
      reason: "Drafted eight cues from the brief",
      ops: [{ op: "replace", path: "/script/cues", value: ["c1", "c2", "c3", "c4", "c5", "c6", "c7", "c8"] }],
    },
    answer: {
      angles: [
        { id: "a1", hook: "Every night market has a secret.", cues: 8 },
        { id: "a2", hook: "Lost at 9 pm? Follow the lanterns.", cues: 7 },
        { id: "a3", hook: "The best noodles in town don't have a website.", cues: 8 },
      ],
      recommended: "a1",
    },
    thinking:
      "The brief says investors at demo night, so the first line has to land in two seconds. A question feels weaker than a claim. Angle 1 opens on mystery, angle 2 on a problem, angle 3 on a joke. 68 words reads in about 27 s at 150 wpm, which leaves room for the logo hold. I'll recommend angle 1 because it gives the Artist the strongest first picture.",
  },
  "director.storyboard": {
    card: "director/storyboard",
    prompt:
      "You are the Director. Turn the chosen script into one storyboard frame per scene.\nEach frame: what we see, where the hero stands, and the one motion that matters.",
    tools: [
      { name: "read_script", input: { angle: "a1" }, result: { cues: 8, scenes: 5 } },
      {
        name: "render_frame",
        input: { scene: "s1_open", version: "board" },
        result: { ok: true, w: 320, h: 180 },
        image: true,
      },
      { name: "place_scene", input: { scene: "s2_problem", beats: 1 }, result: { from: 5.2, to: 11.0 } },
      {
        name: "render_frame",
        input: { scene: "s3_product", version: "board" },
        result: { ok: true, w: 320, h: 180 },
        image: true,
      },
    ],
    patch: {
      reason: "Boarded five scenes, one beat each",
      ops: [{ op: "replace", path: "/scenes/1/beats", value: 1 }],
    },
    answer: { scenes: 5, note: "The long walk is cut to one beat, as you asked." },
    thinking:
      "The note on scene 2 says the walk drags. One beat is enough if the lanterns turn on as she arrives, so the motion carries the cut instead of the walk.",
  },
  "lib.match": {
    card: "librarian/match",
    prompt: "Match the needed sprites against the shared library. Prefer exact palette matches; never publish a logo.",
    tools: [
      { name: "search_library", input: { tags: ["moon", "lantern", "stall"] }, result: { hits: 7 } },
      {
        name: "match_sprite",
        input: { need: "moon", candidates: 3 },
        result: { pick: "moon_16", score: 0.92 },
        image: true,
      },
    ],
    answer: { matched: ["moon_16", "stall_props", "tiles_market"], private: ["lantern_logo"] },
  },
  "asset.draw": {
    card: "pixel-artist/draw",
    prompt: "Draw the hero, 32×32, in the project palette. Light from the upper left. Two variants.",
    tools: [
      { name: "draw_sprite", input: { id: "hero", w: 32, h: 32, variant: 1 }, result: { cells: 412 }, image: true },
      { name: "check_palette", input: { id: "hero" }, result: { offPalette: 0, contrastMin: 1.9 } },
      { name: "draw_sprite", input: { id: "hero", w: 32, h: 32, variant: 2 }, result: { cells: 398 }, image: true },
    ],
    patch: { reason: "Added two hero variants", ops: [{ op: "add", path: "/assets/hero/variants/-", value: "v2" }] },
    answer: { variants: 2, best: "v1" },
  },
  "asset.judge": {
    card: "art-director/judge",
    prompt: "Judge the hero variants against the brief. Score readability at 1× and the silhouette.",
    tools: [
      {
        name: "compare_variants",
        input: { id: "hero", variants: ["v1", "v2"] },
        result: { v1: 0.81, v2: 0.74 },
        image: true,
      },
    ],
    answer: { chosen: "v1", reason: "Reads at 1×; the lantern glow separates her from the stalls." },
  },
  "sound.sfx": {
    card: "sound-designer/sfx",
    prompt: "Pick one SFX hit for each beat from the library. Keep the hits under the narration.",
    tools: [
      { name: "search_sfx", input: { tags: ["lantern", "crowd", "chime"] }, result: { hits: 14 } },
      { name: "place_sfx", input: { cue: "c3", sfx: "chime_soft" }, result: { at: 6.1 } },
    ],
    patch: { reason: "Placed six SFX hits", ops: [{ op: "add", path: "/sound/sfx/-", value: { at: 6.1 } }] },
    answer: { hits: 6 },
  },
  "scene.tune": {
    card: "animator/tune",
    prompt: "Animate the scene: ease the hero in, hold on the lanterns, keep motion on whole pixels.",
    tools: [
      { name: "set_keyframes", input: { scene: "s1_open", keys: 4 }, result: { ok: true } },
      { name: "render_frame", input: { scene: "s1_open", version: "animatic" }, result: { ok: true }, image: true },
      { name: "check_motion", input: { scene: "s1_open" }, result: { subPixel: 0, jitter: "none" } },
    ],
    patch: { reason: "Animated the opening", ops: [{ op: "replace", path: "/scenes/0/motion", value: "ease-in" }] },
    answer: { scenes: 5 },
  },
  "vo.align": {
    card: "editor/align",
    prompt: "Line up the narration take with the cues.",
    tools: [{ name: "align_vo", input: { take: "take-1" }, result: { cues: 8, driftMs: 40 } }],
    answer: { aligned: true },
  },
  "sound.mix": {
    card: "mixer/mix",
    prompt: "Mix music, SFX and narration to −15 LUFS. Duck the music under the voice.",
    tools: [
      { name: "measure_loudness", input: { track: "mix" }, result: { lufs: -17.2, peak: -1.4 } },
      { name: "set_gain", input: { track: "music", db: -14 }, result: { ok: true } },
    ],
    answer: { music: -14, sfx: -15, limiter: 0.84 },
  },
  "review.final": {
    card: "reviewer/final",
    prompt: "Watch the cut and list what's wrong: text off-screen, sound clipping, a scene that drags.",
    tools: [
      { name: "render_frame", input: { t: 12.4 }, result: { ok: true }, image: true },
      { name: "check_text_safe", input: {}, result: { offscreen: ["c6"] } },
      { name: "check_loudness", input: {}, result: { lufs: -15.1 } },
    ],
    answer: { findings: 3, errors: 1 },
  },
  "deliver.export": {
    card: "editor/export",
    prompt: "Export the final video and its subtitles.",
    tools: [
      { name: "render_video", input: { fps: 30, scale: 4 }, result: { file: "final.mp4", sec: 30 } },
      { name: "write_subtitles", input: { format: "vtt" }, result: { file: "final.vtt" } },
    ],
    answer: { files: ["final.mp4", "final.vtt"] },
  },
};
const FALLBACK: Script = {
  card: "crew/step",
  prompt: "Do the next step of the plan.",
  tools: [{ name: "read_project", input: {}, result: { ok: true } }],
  answer: { ok: true },
};

const scriptOf = (t: Task) => SCRIPTS[t.kind] ?? FALLBACK;
const short = (model?: string) => (model ?? "a model").split("/").pop() ?? "a model";

function tool(b: ToolBeat, image?: string): Beat {
  return {
    kind: "tool",
    title: `${b.name} → ok`,
    detail: { input: b.input, result: b.result },
    ...(b.image && image ? { image } : {}),
  };
}

/** a task starts: the step, then the model call */
export function opening(t: Task): Beat[] {
  const s = scriptOf(t);
  return [
    { kind: "step", title: t.title },
    { kind: "model", title: `Asked ${short(t.model)} (${s.card})`, detail: { prompt: s.prompt, images: [] } },
  ];
}

/** the n-th thing it does while working; cycles through its tools */
export function middle(t: Task, n: number): Beat {
  const s = scriptOf(t);
  return tool(s.tools[n % s.tools.length], t.lastImage);
}

/** a task ends well: the change it made, then its answer */
export function closing(t: Task): Beat[] {
  const s = scriptOf(t);
  const tokens = 400 + ((t.title.length * 37) % 900);
  const out: Beat[] = [];
  if (s.patch) out.push({ kind: "patch", title: `Changed the project: ${s.patch.reason}`, detail: s.patch.ops });
  out.push({
    kind: "answer",
    title: `Answered in ${4 + (tokens % 11)} s · ${tokens} tokens${t.usd ? ` · $${t.usd.toFixed(3)}` : ""}`,
    detail: s.answer,
    ...(s.thinking ? { thinking: s.thinking } : {}),
  });
  return out;
}

/** a task stops: what broke, in the raw */
export function failure(t: Task): Beat[] {
  const msg = t.error?.message ?? "The model stopped without an answer.";
  return [
    {
      kind: "tool",
      title: "call_model → timeout",
      detail: { input: { model: t.model, timeoutMs: 30000 }, result: { code: "timeout", message: msg } },
    },
    { kind: "error", title: msg.slice(0, 200) },
  ];
}

/** a whole transcript, for a task that ran before the mock started (timestamps spread across its run) */
export function wholeRun(t: Task): ActivityEntry[] {
  const beats = [...opening(t), ...scriptOf(t).tools.map((b) => tool(b, t.lastImage)), ...closing(t)];
  const from = Date.parse(t.startedAt ?? "") || Date.now() - 60000;
  const to = Date.parse(t.endedAt ?? "") || from + 60000;
  const stepMs = (to - from) / Math.max(1, beats.length - 1);
  return beats.map((b, i) => ({ at: new Date(from + i * stepMs).toISOString(), ...b }));
}
