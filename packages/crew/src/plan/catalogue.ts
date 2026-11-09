// The task catalogue (docs/PIP-ORCHESTRATION.md §1.1): every kind a production plan can hold. Code only: a model never
// adds a kind. Each row says who does it, at which stage, how many model calls one run makes, what Pip's revisions may
// do to it, and what a resume does with it.
import type { RoleT } from "@pap/schema";
import type { Stage } from "@pap/tools";

export const CATALOGUE_KINDS = [
  "producer.plan",
  "writer.angles",
  "director.storyboard",
  "art.cast",
  "asset.import",
  "asset.spec",
  "asset.draw",
  "asset.judge",
  "scene.tune",
  "scene.code",
  "look.time",
  "vo.align",
  "sound.mix",
  "review.final",
  "deliver.export",
  "lib.publish",
  "gate",
] as const;
export type PlanKind = (typeof CATALOGUE_KINDS)[number];

export const PLAN_GATES = ["g0_brief", "g1_script", "g2_animatic", "rights", "g3_rough", "g4_final"] as const;
export type PlanGateId = (typeof PLAN_GATES)[number];

/** the kinds Pip's `add` op may use (code expands an asset into its chain) */
export const PIP_ADDABLE = ["asset.spec", "asset.import", "scene.tune"] as const;

export type CatalogueRow = {
  kind: PlanKind;
  role: RoleT | "person";
  /** the stage view groups tasks by this; a gate's stage is per gate (GATE_STAGE) */
  stage: Stage;
  /** model calls in one run of the task: [usual, most] */
  calls: [number, number];
  /** the ledger kinds one run is priced from: [kind, calls at p50, calls at p90] */
  prices: [string, number, number][];
  /** what Pip's revisions may do to the kind */
  pipMay: ("add" | "drop" | "retier")[];
  /** a drop of this kind is allowed (V7) */
  droppable: boolean;
  /** the handler's failure ends the run (writer, director, export...); others end done with a partial report */
  fatal: boolean;
  /** shares the one render slot (the animatic, the review's contact sheet, the export) */
  render: boolean;
  /** the role's model needs vision for this kind (V10) */
  vision: boolean;
  /** what a resume does: rerun it, skip it when its scene is already rendered, or wait for the person again */
  onResume: "rerun" | "skip_ready" | "wait";
  /** seconds a tool-only run takes, for the makespan (model kinds use the estimator) */
  toolSec: number;
  /** what it does, in one line (Pip's prompt) */
  what: string;
};

const row = (r: Omit<CatalogueRow, "prices"> & { prices?: CatalogueRow["prices"] }): CatalogueRow => ({
  prices: r.calls[1] ? [[r.kind, 1, 1]] : [],
  ...r,
});

export const CATALOGUE: Record<PlanKind, CatalogueRow> = {
  "producer.plan": row({
    kind: "producer.plan",
    role: "producer",
    stage: "brief",
    calls: [1, 1],
    pipMay: [],
    droppable: false,
    fatal: true,
    render: false,
    vision: false,
    onResume: "rerun",
    toolSec: 0,
    what: "reads the brief, writes the digest and assumptions, asks what only the person knows",
  }),
  "writer.angles": row({
    kind: "writer.angles",
    role: "writer",
    stage: "script",
    calls: [1, 2],
    prices: [
      ["writer.angles", 1, 1],
      ["writer.repair", 0, 1],
    ],
    pipMay: ["retier"],
    droppable: false,
    fatal: true,
    render: false,
    vision: false,
    onResume: "rerun",
    toolSec: 0,
    what: "writes three script angles; the person picks one at the script gate",
  }),
  "director.storyboard": row({
    kind: "director.storyboard",
    role: "director",
    stage: "storyboard",
    calls: [1, 3],
    prices: [
      ["director.storyboard", 1, 1],
      ["director.repair", 0, 2],
    ],
    pipMay: ["retier"],
    droppable: false,
    fatal: true,
    render: false,
    vision: false,
    onResume: "rerun",
    toolSec: 0,
    what: "turns the script into scenes (from the recipe menu, or a code scene's beat) and lists the new art it needs",
  }),
  "art.cast": row({
    kind: "art.cast",
    role: "art-director",
    stage: "storyboard",
    calls: [0, 0],
    pipMay: [],
    droppable: false,
    fatal: true,
    render: false,
    vision: false,
    onResume: "rerun",
    toolSec: 1,
    what: "casts the library art the recipes name (code)",
  }),
  "asset.import": row({
    kind: "asset.import",
    role: "art-director",
    stage: "storyboard",
    calls: [0, 0],
    pipMay: ["add", "drop"],
    droppable: true,
    fatal: false,
    render: false,
    vision: false,
    onResume: "rerun",
    toolSec: 1,
    what: "quantizes a logo reference to the palette as a private 16x16 icon (code, never drawn)",
  }),
  "asset.spec": row({
    kind: "asset.spec",
    role: "art-director",
    stage: "art",
    calls: [1, 1],
    pipMay: ["add", "drop", "retier"],
    droppable: true,
    fatal: true,
    render: false,
    vision: false,
    onResume: "rerun",
    toolSec: 0,
    what: "writes the drawing spec for one new sprite (with the reference image when it comes from one)",
  }),
  "asset.draw": row({
    kind: "asset.draw",
    role: "pixel-artist",
    stage: "art",
    calls: [2, 4],
    prices: [
      ["asset.draw", 1, 1],
      ["asset.critique", 1, 1],
      ["asset.repair", 0, 2],
    ],
    pipMay: ["drop", "retier"],
    droppable: true,
    fatal: false,
    render: false,
    vision: true,
    onResume: "rerun",
    toolSec: 0,
    what: "draws one variant of a sprite, then one critique round against the rendered sheet",
  }),
  "asset.judge": row({
    kind: "asset.judge",
    role: "art-director",
    stage: "art",
    calls: [0, 1],
    prices: [["asset.judge", 1, 1]],
    pipMay: [],
    droppable: false,
    fatal: true,
    render: false,
    vision: true,
    onResume: "rerun",
    toolSec: 1,
    what: "picks the better variant, writes the asset and casts it (the library stands in if neither passed)",
  }),
  "scene.tune": row({
    kind: "scene.tune",
    role: "animator",
    stage: "animate",
    calls: [1, 1],
    pipMay: ["add", "retier"],
    droppable: false,
    fatal: false,
    render: false,
    vision: true,
    onResume: "skip_ready",
    toolSec: 0,
    what: "tunes one scene's recipe params from three stills and the lints",
  }),
  "scene.code": row({
    kind: "scene.code",
    role: "scene-coder",
    stage: "animate",
    calls: [2, 4],
    // the write, then one repair or critique at p50, three at p90 (P7's code scenes used about one of the two repairs
    // and two critique rounds a run may take); past MIN_LEDGER_SAMPLES the ledger's own rows price each call
    prices: [
      ["scene.code", 1, 1],
      ["scene.patch", 1, 3],
    ],
    pipMay: ["retier"],
    droppable: false,
    fatal: false,
    // its trial sandbox is its own: code scenes are written side by side, not one at a time in the render slot
    render: false,
    vision: true,
    onResume: "skip_ready",
    toolSec: 10,
    what: "writes one code scene's bundle from the Director's beat, loads it in a trial sandbox, repairs it, then critiques it on a 6-frame strip",
  }),
  "look.time": row({
    kind: "look.time",
    role: "director",
    stage: "animate",
    calls: [0, 0],
    pipMay: [],
    droppable: false,
    fatal: true,
    render: false,
    vision: false,
    onResume: "rerun",
    toolSec: 1,
    what: "sets the video's time of day (night, dusk or day; the palette follows); recipe scenes follow, code scenes are re-coded (code)",
  }),
  "vo.align": row({
    kind: "vo.align",
    role: "editor",
    stage: "narrate",
    calls: [0, 0],
    pipMay: [],
    droppable: false,
    fatal: true,
    render: false,
    vision: false,
    onResume: "rerun",
    toolSec: 5,
    what: "asks for the person's narration take and re-times the scenes to it (code)",
  }),
  "sound.mix": row({
    kind: "sound.mix",
    role: "mixer",
    stage: "sound",
    calls: [0, 0],
    pipMay: [],
    droppable: false,
    fatal: true,
    render: false,
    vision: false,
    onResume: "rerun",
    toolSec: 5,
    what: "sets the sound effects and music and renders the mix (code)",
  }),
  "review.final": row({
    kind: "review.final",
    role: "reviewer",
    stage: "review",
    calls: [1, 1],
    pipMay: ["drop", "retier"],
    droppable: true,
    fatal: false,
    render: true,
    vision: true,
    onResume: "rerun",
    toolSec: 3,
    what: "one review round of the cut from the contact sheet and stills; blockers become notes",
  }),
  "deliver.export": row({
    kind: "deliver.export",
    role: "editor",
    stage: "deliver",
    calls: [0, 0],
    pipMay: [],
    droppable: false,
    fatal: true,
    render: true,
    vision: false,
    onResume: "rerun",
    toolSec: 20,
    what: "exports the video and subtitles (code)",
  }),
  "lib.publish": row({
    kind: "lib.publish",
    role: "librarian",
    stage: "deliver",
    calls: [0, 0],
    pipMay: ["drop"],
    droppable: true,
    fatal: false,
    render: false,
    vision: false,
    onResume: "rerun",
    toolSec: 1,
    what: "asks the person whether a new public asset goes into the library, and publishes it on a yes",
  }),
  gate: row({
    kind: "gate",
    role: "person",
    stage: "brief",
    calls: [0, 0],
    pipMay: [],
    droppable: false,
    fatal: false,
    render: false,
    vision: false,
    onResume: "wait",
    toolSec: 0,
    what: "the person's pick or OK",
  }),
};

export const GATE_STAGE: Record<PlanGateId, Stage> = {
  g0_brief: "brief",
  g1_script: "script",
  g2_animatic: "storyboard",
  rights: "art",
  g3_rough: "review",
  g4_final: "deliver",
};

/** the stage a task counts toward in the stage view */
export function stageOf(t: { kind: PlanKind; gate?: PlanGateId }): Stage {
  return t.kind === "gate" && t.gate ? GATE_STAGE[t.gate] : CATALOGUE[t.kind].stage;
}

/** role words in sentence case, as the UI writes them (ROLE_LABEL in apps/web; journey C14, N5) */
export const ROLE_LABEL: Record<string, string> = {
  producer: "Producer",
  writer: "Writer",
  director: "Director",
  "art-director": "Art director",
  "pixel-artist": "Pixel artist",
  animator: "Animator",
  "scene-coder": "Scene coder",
  "sound-designer": "Sound designer",
  mixer: "Mixer",
  editor: "Editor",
  reviewer: "Reviewer",
  librarian: "Librarian",
  assistant: "Pip",
  person: "You",
};

/** the instance key (§2): the role for singletons, role:scene for animators, role:asset for pixel artists */
export function instanceKey(t: { kind: PlanKind; scene?: string; asset?: string }): string {
  const role = CATALOGUE[t.kind].role;
  if (role === "person") return "person";
  if (t.kind === "scene.tune") return t.scene ? `animator:${t.scene}` : "animator";
  if (t.kind === "scene.code") return t.scene ? `scene-coder:${t.scene}` : "scene-coder";
  if (t.kind === "asset.draw") return t.asset ? `pixel-artist:${t.asset}` : "pixel-artist";
  return role;
}

const GATE_LABEL: Record<PlanGateId, string> = {
  g0_brief: "Your OK on the brief",
  g1_script: "Your pick: the script",
  g2_animatic: "Your OK on the pacing",
  rights: "Your OK to use it",
  g3_rough: "Your OK on the rough cut",
  g4_final: "Your OK on the final cut",
};

/** a task's label in plain words: "Animator · scene 3", "Pixel artist · founder", "Your pick: the script" */
export function taskLabel(
  t: { kind: PlanKind; gate?: PlanGateId; scene?: string; asset?: string },
  sceneIds: string[],
) {
  if (t.kind === "gate" && t.gate)
    return t.gate === "rights" && t.asset ? `Your OK to use ${t.asset}` : GATE_LABEL[t.gate];
  const role = ROLE_LABEL[CATALOGUE[t.kind].role] ?? CATALOGUE[t.kind].role;
  if (t.scene) {
    const k = sceneIds.indexOf(t.scene);
    return `${role} · scene ${k >= 0 ? k + 1 : t.scene}`;
  }
  if (t.asset) return `${role} · ${t.asset}`;
  return role;
}

/** id-safe form of a subject ("cast-founder" -> "cast_founder") */
export const idPart = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "") || "x";
