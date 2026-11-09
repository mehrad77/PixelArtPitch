// The project document (pitch.json): one JSON file that describes a whole video. Agents and the user only change it
// through validated patches (see patch.ts); every time in it is an expression anchored to script cues (see time.ts).
import { z } from "zod";

export const Id = z
  .string()
  .regex(/^[a-z][a-z0-9_]*$/, "lower-case id: letters, digits and _, starting with a letter")
  .max(48);
/** "E(c03)+0.1", "min(140, E(c17)+32)", "@join_land", or a plain number of seconds where a lint allows it */
export const TimeExpr = z.union([z.string().min(1).max(200), z.number()]);

export const TimeOfDay = z.enum(["night", "dusk", "day"]);
export type TimeOfDayT = z.infer<typeof TimeOfDay>;
export const Canvas = z.object({
  w: z.literal(320),
  h: z.literal(180),
  fps: z.literal(30),
  palette: z.string().default("pap-night@1"),
  /** the time of day the video is set in (absent: night); the palette follows it (paletteFor) */
  time: TimeOfDay.optional(),
});

/** the built-in palette of each time of day; they share every pap-night letter and hex */
export const TIME_PALETTES: Record<TimeOfDayT, string> = {
  night: "pap-night@1",
  dusk: "pap-dusk@1",
  day: "pap-day@1",
};
/**
 * The palette a canvas renders with: a built-in pap-night/dusk/day palette follows `time` (so a "make it day" that
 * sets only the time still turns the sky), any other palette is kept as it is.
 */
export function paletteFor(canvas: { palette?: string; time?: TimeOfDayT }): string {
  const p = canvas.palette ?? "pap-night@1";
  if (!canvas.time) return p;
  return Object.values(TIME_PALETTES).includes(p) ? TIME_PALETTES[canvas.time] : p;
}

export const Brief = z.object({
  idea: z.string().min(1).max(4000),
  purpose: z.enum(["pitch", "application", "launch", "social", "other"]).default("pitch"),
  audience: z.string().max(400).default(""),
  ask: z.string().max(400).default(""),
  lengthSec: z.number().min(5).max(180),
  tone: z.array(z.string().max(40)).max(8).default([]),
  mustSay: z.array(z.string().max(200)).max(20).default([]),
  mustAvoid: z.array(z.string().max(200)).max(20).default([]),
  narration: z.enum(["user", "tts", "none"]).default("user"),
  involvement: z.enum(["every", "key", "auto"]).default("key"),
  deadline: z.string().datetime().optional(),
  /** how the brief was made: Pip's /new conversation, the composer, or a fork (docs/PIP-ORCHESTRATION.md §1.3) */
  source: z.enum(["pip", "composer", "fork"]).optional(),
  references: z
    .array(
      z.object({
        file: z.string(),
        type: z.enum(["likeness", "logo", "style", "as-is", "sound", "voice"]),
        rights: z.enum(["mine", "licensed", "unsure"]).default("unsure"),
        note: z.string().max(400).default(""),
      }),
    )
    .default([]),
});

export const Cue = z.object({
  id: Id,
  text: z.string().min(1).max(300),
});

export const Script = z.object({
  cues: z.array(Cue).max(80),
  timing: z.object({
    mode: z.enum(["estimate", "aligned"]),
    /** words per second, pause between cues, silence before the first word, shortest cue */
    wps: z.number().min(1).max(5).default(2.5),
    pause: z.number().min(0).max(3).default(0.2),
    lead: z.number().min(0).max(5).default(0.6),
    minCue: z.number().min(0.3).max(5).default(1.1),
    /** cue id -> [start, end] seconds of the narration, set by the Editor after alignment */
    aligned: z.record(z.string(), z.tuple([z.number(), z.number()])).optional(),
  }),
});

export const Captions = z.object({
  enabled: z.boolean().default(true),
  /** "host": PAP draws them; "bundle": a code bundle draws its own */
  by: z.enum(["host", "bundle"]).default("host"),
  wrapW: z.number().int().default(296),
  pre: z.number().default(0.05),
  post: z.number().default(0.3),
  safeBottom: z.number().int().default(26),
});

export const Composition = z.object({
  /** seconds of still first frame before anything moves; render, audio and subtitles are shifted by it */
  hold: z.number().min(0).max(10).default(3),
  /** seconds the end card stays on screen after the last cue */
  endHold: z.number().min(0).max(60).default(4),
  duration: TimeExpr,
  captions: Captions.default({ enabled: true, by: "host", wrapW: 296, pre: 0.05, post: 0.3, safeBottom: 26 }),
  dissolveIn: z.number().min(0).max(2).default(0.3),
  fadeOut: z.number().min(0).max(3).default(0.4),
});

// ---- declarative scenes ----
export const Ease = z.enum(["linear", "in", "out", "inOut", "outCubic", "backOut", "step"]);
export const Key = z.object({ t: TimeExpr, v: z.union([z.number(), z.string(), z.boolean()]), ease: Ease.optional() });
export const Behavior = z.object({
  kind: z.enum([
    "walk",
    "jumpArc",
    "arc",
    "bob",
    "blink",
    "pulse",
    "shake",
    "squash",
    "appear",
    "disappear",
    "attach",
    "dissolve",
    "dust",
    "sparkle",
    "fly",
    "sit",
  ]),
  at: TimeExpr.optional(),
  until: TimeExpr.optional(),
  params: z.record(z.string(), z.unknown()).default({}),
});
export const LayerKind = z.enum([
  "backdrop",
  "tiled",
  "sprite",
  "actor",
  "text",
  "panel",
  "group",
  "shape",
  "fx",
  "widget",
  "code",
]);
export const Layer: z.ZodType<LayerT> = z.lazy(() =>
  z.object({
    id: Id,
    kind: LayerKind,
    z: z.number().int().default(0),
    space: z.enum(["world", "screen"]).default("world"),
    show: z.tuple([TimeExpr, TimeExpr]).optional(),
    props: z.record(z.string(), z.unknown()).default({}),
    keys: z.record(z.string(), z.array(Key)).optional(),
    behaviors: z.array(Behavior).optional(),
    children: z.array(Layer).optional(),
  }),
);
export type LayerT = {
  id: string;
  kind: z.infer<typeof LayerKind>;
  z: number;
  space: "world" | "screen";
  show?: [string | number, string | number];
  props: Record<string, unknown>;
  keys?: Record<string, z.infer<typeof Key>[]>;
  behaviors?: z.infer<typeof Behavior>[];
  children?: LayerT[];
};
export const Camera = z.object({
  keys: z.record(z.string(), z.array(Key)).default({}),
  shakes: z.array(z.object({ at: TimeExpr, amp: z.number(), dur: z.number() })).default([]),
});
export const RecipeUse = z.object({ id: Id, params: z.record(z.string(), z.unknown()).default({}) });

const SceneBase = z.object({
  id: Id,
  title: z.string().max(80).default(""),
  from: TimeExpr,
  to: TimeExpr,
  /** cue ids this scene carries, for the storyboard and lints */
  cues: z.array(Id).default([]),
  notes: z.string().max(2000).default(""),
});
export const DeclScene = SceneBase.extend({
  kind: z.literal("decl"),
  recipes: z.array(RecipeUse).default([]),
  camera: Camera.optional(),
  layers: z.array(Layer).default([]),
});
export const CodeScene = SceneBase.extend({
  kind: z.literal("code"),
  /** id of an entry in `code` */
  bundle: Id,
  /** the Director's beat: what the scene shows, second by second, in plain words (the Scene Coder writes it) */
  beat: z.string().max(2000).optional(),
  /** the asset ids the scene draws (cast before it is coded; the plan waits for any new art among them) */
  assets: z.array(z.string()).max(16).optional(),
  /** the closing card that holds while the music plays out (a recipe scene marks it with end_card_loop) */
  endCard: z.boolean().optional(),
});
export const Scene = z.discriminatedUnion("kind", [DeclScene, CodeScene]);

export const CodeBundle = z.object({
  id: Id,
  file: z.string().regex(/^code\/[a-z0-9_.-]+\.m?js$/),
  /** the bundle's own draw(t) paints the whole frame (dissolves, captions) for every scene that uses it */
  fullFrame: z.boolean().default(true),
  /** an asset whose JSON is passed to the bundle's init() after it loads */
  initAsset: z.string().optional(),
  /** the bundle exports sfxEvents() */
  sfx: z.boolean().default(false),
  /** a placeholder the storyboard wrote (backdrop, title, assets): not a finished picture until the Scene Coder's */
  stub: z.boolean().optional(),
});

// ---- audio, mix, delivery ----
export const SfxType = z.enum([
  "select",
  "confirm",
  "whoosh",
  "coin",
  "jump",
  "bump",
  "sign",
  "pipe",
  "land",
  "fall",
  "join",
  "powerup",
  "cheer",
  "block",
  "fanfare-short",
  "achieve",
  "quest",
  "flag",
  "alarm",
  "brick",
  "flagpole",
  "fanfare",
  "start",
]);
export const Audio = z.object({
  sfx: z.object({
    /** "doc": events below plus those emitted by layers and recipes; or a bundle id whose sfxEvents() is used */
    source: z.string().default("doc"),
    events: z.array(z.object({ t: TimeExpr, type: SfxType })).default([]),
    /** with a voice, keep at most N of each type and never two within minGap seconds; null keeps all */
    keep: z.record(z.string(), z.number().int().min(0)).nullable().default(null),
    minGap: z.number().default(0.6),
  }),
  music: z
    .object({
      generator: z.literal("chip-bed"),
      /** scene ids: the bed lifts during `lift` and settles from `settle` */
      lift: Id.optional(),
      settle: Id.optional(),
    })
    .nullable()
    .default(null),
  vo: z.array(z.object({ file: z.string(), offset: z.number().default(0) })).default([]),
});
export const Mix = z.object({
  voHighpass: z.number().default(80),
  sfxDb: z.number().default(-15),
  musicDb: z.number().default(-14),
  lufs: z.number().min(-30).max(-9).default(-16),
  limiter: z.number().min(0.1).max(1).default(0.84),
});
export const Delivery = z.object({
  id: Id,
  scale: z.union([z.literal(4), z.literal(6), z.literal(12)]),
  crf: z.number().int().min(0).max(51).default(16),
  out: z.string().regex(/^[a-zA-Z0-9_.-]+\.mp4$/),
});

// ---- assets ----
export const AssetFlags = z.object({
  private: z.boolean().default(false),
  likeness: z.object({ person: z.string(), refs: z.array(z.string()).default([]) }).optional(),
  brand: z.object({ owner: z.string(), trademark: z.boolean().default(true) }).optional(),
});
export const AssetRef = z.object({
  /** the name scenes use: frame("<id>", ...) */
  id: z.string().regex(/^[a-z0-9][a-z0-9_-]*$/),
  /** "lib:<id>@<version>" (public library) or "file:assets/<name>.json" (this project) */
  src: z.string().regex(/^(lib:[a-z0-9-]+@\d+|file:assets\/[a-zA-Z0-9_.-]+\.json)$/),
  /** frame names this project uses that the source calls differently: { "sign-divan": "signpost" } */
  frameAlias: z.record(z.string(), z.string()).optional(),
  flags: AssetFlags.default({ private: false }),
  /** the person's answer to "Add it to the asset library?" (lib.publish asks once per asset, never again) */
  publish: z.enum(["yes", "no"]).optional(),
  /** a library asset standing in for art the crew couldn't draw (the judge's fallback): a retry draws it */
  standIn: z.boolean().optional(),
  /**
   * the project this asset was cast from (studio art, docs/RIGHTS.md): it keeps its flags, and a likeness or a brand
   * asks its rights again here, never carried over
   */
  copiedFrom: z.string().optional(),
});

export const Role = z.enum([
  "producer",
  "writer",
  "director",
  "art-director",
  "pixel-artist",
  "animator",
  "scene-coder",
  "sound-designer",
  "mixer",
  "editor",
  "reviewer",
  "librarian",
  /** Pip, the studio's assistant (docs/ASSISTANT.md) */
  "assistant",
]);
export const Crew = z.object({
  profile: z.enum(["best", "balanced", "local", "custom"]).default("best"),
  /** role -> "provider/model"; empty uses the profile from Settings */
  models: z.record(z.string(), z.string()).default({}),
  /** drawings per new asset for this project (1: no judge; 2-3: the Art Director picks); absent: Settings' default */
  variants: z.number().int().min(1).max(3).optional(),
});
export const Budget = z.object({
  capUsd: z.number().min(0).max(10000),
  askAtFraction: z.number().min(0.1).max(1).default(0.8),
  reserveUsd: z.number().min(0).default(0.5),
});

export const Project = z.object({
  pap: z.literal(1),
  rev: z.number().int().min(0),
  id: Id,
  title: z.string().min(1).max(120),
  canvas: Canvas,
  brief: Brief,
  script: Script,
  events: z.record(z.string(), TimeExpr).default({}),
  composition: Composition,
  code: z.array(CodeBundle).default([]),
  scenes: z.array(Scene),
  audio: Audio,
  mix: Mix.default({ voHighpass: 80, sfxDb: -15, musicDb: -14, lufs: -15, limiter: 0.84 }),
  delivery: z.array(Delivery).default([]),
  subtitles: z
    .object({ srt: z.boolean().default(true), vtt: z.boolean().default(true) })
    .default({ srt: true, vtt: true }),
  assets: z.array(AssetRef).default([]),
  crew: Crew.default({ profile: "best", models: {} }),
  budget: Budget,
  /** free-form project notes the Producer keeps (assumptions it made, open questions) */
  notes: z.array(z.object({ by: z.string(), text: z.string().max(2000) })).default([]),
});

export type ProjectT = z.infer<typeof Project>;
export type SceneT = z.infer<typeof Scene>;
export type DeclSceneT = z.infer<typeof DeclScene>;
export type AssetRefT = z.infer<typeof AssetRef>;
export type RoleT = z.infer<typeof Role>;
export type SfxTypeT = z.infer<typeof SfxType>;

/** A sprite asset as stored in the library or a project: letter-grid frames on a palette. */
export const AssetFile = z.object({
  id: z.string(),
  version: z.number().int().min(1).default(1),
  kind: z.enum([
    "character",
    "creature",
    "crowd",
    "prop",
    "icon",
    "block",
    "tile",
    "map-tile",
    "building",
    "backdrop",
    "decor",
    "font",
    "logo",
  ]),
  w: z.number().int().min(1).max(320),
  h: z.number().int().min(1).max(180),
  frames: z.array(z.string()),
  palette: z.string(),
  tags: z.array(z.string()).default([]),
  description: z.string().default(""),
  /**
   * which way a character's or creature's art looks (its run frames): drawn heroes face right, the library's NPCs
   * left. The engine turns the sprite to the way it walks. Absent: assetFacing reads the description.
   */
  facing: z.enum(["left", "right"]).optional(),
  licence: z.string(),
  rights: z.object({
    likeness: z.boolean(),
    brand: z.boolean(),
    trademark: z.boolean(),
    public: z.boolean(),
  }),
  provenance: z.record(z.string(), z.unknown()),
  hash: z.string(),
  standard: z.unknown().nullable().default(null),
  grid: z.record(z.string(), z.array(z.string())),
});
export type AssetFileT = z.infer<typeof AssetFile>;
export type FacingT = "left" | "right";

/**
 * Which way an asset's art looks: its `facing` field, else the first "facing left|right" (or "faces …") in its
 * description, else undefined (the engine's fallback: an actor's art is taken to look left, as the old library's did).
 */
export function assetFacing(a: { facing?: unknown; description?: unknown }): FacingT | undefined {
  if (a.facing === "left" || a.facing === "right") return a.facing;
  const m = /\bfac(?:es|ing)\s+(left|right)\b/i.exec(typeof a.description === "string" ? a.description : "");
  return m ? (m[1].toLowerCase() as FacingT) : undefined;
}
