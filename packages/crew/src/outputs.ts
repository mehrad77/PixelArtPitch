// What each crew call must return. Kept small and generic (lists of {name, rows} rather than one property per frame)
// so structured-output grammars stay small and weak models can fill them.
import { z } from "zod";

/** the kinds a new drawing can be: `character` is the 8-frame hero; `creature` follows the brief's size and motion */
export const ASSET_KINDS = ["character", "creature", "prop", "icon", "decor"] as const;
export type AssetKindT = (typeof ASSET_KINDS)[number];
export const CREATURE_SIZES = ["16x16", "16x24"] as const;
export const MOTIONS = ["walk", "fly", "sit"] as const;
export type MotionT = (typeof MOTIONS)[number];

const OptionOut = z.object({
  id: z.string().regex(/^[a-z0-9_-]+$/),
  label: z.string().min(1).max(80),
  detail: z.string().max(300),
});
export const PlanOut = z.object({
  digest: z.string().min(10).max(500),
  assumptions: z.array(z.string().max(300)).max(10),
  questions: z
    .array(
      z.object({
        question: z.string().min(5).max(200),
        why: z.string().max(300),
        options: z.array(OptionOut).min(2).max(6),
        recommendedId: z.string(),
      }),
    )
    .max(3),
});

export const AnglesOut = z.object({
  angles: z
    .array(
      z.object({
        name: z.string().min(2).max(60),
        approach: z.string().max(200),
        cues: z.array(z.string().min(2).max(120)).min(2).max(40),
      }),
    )
    .min(1)
    .max(3),
  /** index of the angle to ship; weak models sometimes leave it out */
  recommended: z.number().int().min(0).max(2).default(0),
});

/**
 * A board scene: built from the recipe menu (`kind` "recipe", the default), or a code scene (`kind` "code") the Scene
 * Coder writes from its `beat`: what it shows, second by second, in plain words, and the `assets` it draws. One object
 * for both (not a union) so a board without `kind` still parses; `checkBoard` checks each form.
 */
export const BoardScene = z.object({
  id: z.string().regex(/^[a-z][a-z0-9_]*$/),
  title: z.string().min(1).max(60),
  cues: z.array(z.string()).min(1),
  kind: z.enum(["recipe", "code"]).default("recipe"),
  recipes: z
    .array(z.object({ id: z.string(), params: z.record(z.string(), z.unknown()).default({}) }))
    .max(8)
    .default([]),
  beat: z.string().max(1500).default(""),
  assets: z.array(z.string()).max(12).default([]),
  /** a code scene that is the closing card (it holds while the music plays out) */
  endCard: z.boolean().default(false),
});
export type BoardSceneT = z.infer<typeof BoardScene>;

export const StoryboardOut = z.object({
  scenes: z.array(BoardScene).min(1).max(8),
  newAssets: z
    .array(
      z.object({
        name: z.string().regex(/^[a-z][a-z0-9_-]*$/),
        kind: z.enum(ASSET_KINDS),
        description: z.string().min(10).max(400),
        /** a creature's size as the brief asks: "16x16" (small: a moth, a bird) or "16x24" */
        size: z.enum(CREATURE_SIZES).optional(),
        /** how a creature moves: walk (move0-3), fly (move0-3 and perch0-1) or sit (perch0-1) */
        motion: z.enum(MOTIONS).optional(),
      }),
    )
    .max(4),
});

/** a change request's re-board: new recipes for some scenes, and what the menu could only approximate */
export const ReboardOut = z.object({
  scenes: z
    .array(
      z.object({
        id: z.string(),
        kind: z.enum(["recipe", "code"]).default("recipe"),
        recipes: z
          .array(z.object({ id: z.string(), params: z.record(z.string(), z.unknown()).default({}) }))
          .max(6)
          .default([]),
        beat: z.string().max(1500).default(""),
        assets: z.array(z.string()).max(12).default([]),
      }),
    )
    .min(1)
    .max(8),
  approximated: z.string().max(300).default(""),
});

export const SpecOut = z.object({
  letters: z.string().min(2).max(10),
  description: z.string().min(20).max(1200),
  reads: z.string().min(2).max(80),
});

export const DrawOut = z.object({
  notes: z.string().max(400),
  frames: z.array(z.object({ name: z.string(), rows: z.array(z.string()) })).min(1),
});

export const JudgeOut = z.object({ best: z.number().int().min(1), reason: z.string().max(600) });

export const TuneOut = z.object({
  changes: z
    .array(
      z.object({
        recipe: z.number().int().min(0),
        params: z.record(z.string(), z.unknown()),
        why: z.string().max(200),
      }),
    )
    .max(3),
});

/** the Scene Coder's answer: the whole bundle (an ES module) and a line on what it did */
export const CodeOut = z.object({
  code: z.string().min(40).max(60000),
  notes: z.string().max(600).default(""),
});

export const ReviewOut = z.object({
  verdict: z.enum(["ship", "fix"]),
  summary: z.string().max(400),
  blockers: z
    .array(z.object({ t: z.number(), scene: z.string(), issue: z.string().max(300), fix: z.string().max(300) }))
    .max(12),
  polish: z.array(z.object({ t: z.number(), scene: z.string(), issue: z.string().max(300) })).max(12),
  /** after a person's change: does the cut now do it? (absent: no change was asked, or a weak model left it out) */
  change: z.object({ done: z.enum(["yes", "partly", "no"]), why: z.string().max(300).default("") }).optional(),
});

export type PlanOutT = z.infer<typeof PlanOut>;
export type AnglesOutT = z.infer<typeof AnglesOut>;
export type StoryboardOutT = z.infer<typeof StoryboardOut>;
export type DrawOutT = z.infer<typeof DrawOut>;
export type ReviewOutT = z.infer<typeof ReviewOut>;

export type KindTemplate = { w: number; h: number; frames: string[]; note: string };

/**
 * A creature's template: its size from the brief (16x16, or 16x24), its frames from how it moves. The names are the
 * engine's (`motionFrames`): idle0-1 always; move0-3 for walk or fly; perch0-1 for sit or fly.
 */
export function creatureTemplate(o: { size?: string; motion?: string } = {}): KindTemplate {
  const h = o.size === "16x24" ? 24 : 16;
  const motion = (MOTIONS as readonly string[]).includes(o.motion ?? "") ? (o.motion as MotionT) : "walk";
  const move = motion === "walk" || motion === "fly";
  const perch = motion === "sit" || motion === "fly";
  const frames = [
    "idle0",
    "idle1",
    ...(move ? ["move0", "move1", "move2", "move3"] : []),
    ...(perch ? ["perch0", "perch1"] : []),
  ];
  const how =
    motion === "fly"
      ? "move0-move3 a 4-frame flight cycle facing RIGHT (wings up, level, down, level); perch0/perch1 resting on a ledge, wings folded, a 1 px shift between them"
      : motion === "sit"
        ? "perch0/perch1 sitting still, a 1 px shift between them (a blink, a twitch)"
        : "move0-move3 a 4-frame walk cycle facing RIGHT, legs alternating, feet on the bottom row";
  return {
    w: 16,
    h,
    frames,
    note: `A small animal or creature, 16x${h}, true to its own shape (never a chibi biped). idle0/idle1 breathe (1 px shift); ${how}. Never draw frames it doesn't list.`,
  };
}

/** the template for an asset: its kind's, and for a creature its size and motion */
export function templateFor(kind: string, o: { size?: string; motion?: string } = {}): KindTemplate {
  if (kind === "creature") return creatureTemplate(o);
  return KIND_TEMPLATES[kind] ?? KIND_TEMPLATES.icon;
}

/** size and frames per asset kind (the PAP standard's size classes); a creature's come from `creatureTemplate` */
export const KIND_TEMPLATES: Record<string, KindTemplate> = {
  character: {
    w: 16,
    h: 24,
    frames: ["idle0", "idle1", "run0", "run1", "run2", "run3", "jump", "wave"],
    note: "A playable hero, chibi proportions (head about 9-10 rows). idle0/idle1 breathe (body shifts 1 px); run0-run3 a 4-frame run cycle facing RIGHT, arms and legs alternating; jump knees tucked, one arm up; wave facing the viewer, right hand raised. Feet on the bottom row except jump.",
  },
  prop: { w: 24, h: 32, frames: ["prop"], note: "A level prop standing on the bottom row, transparent background." },
  icon: { w: 16, h: 16, frames: ["icon"], note: "A centred icon with a 1 px dark outline, readable at 1x." },
  decor: { w: 24, h: 24, frames: ["decor"], note: "A small decoration, transparent background." },
  /** the default creature (16x16, walking); `templateFor` gives the one its brief asks for */
  creature: creatureTemplate(),
};

/**
 * What the critique shows the Pixel Artist of the standard checker's findings: only what the artist can fix in the
 * grid. Provenance, licence and rights are the system's fields (code writes them), and so are the file's records (id,
 * version, hash, standard, palette, tags): a finding about them is noise in an Opus call (P4: "provenance is empty").
 */
export function artistIssues<T extends { rule: string; message: string }>(hard: T[]): T[] {
  const SYSTEM = /^(provenance|licence|rights|hash|standard|id|version|palette|tags|description)\b/;
  return hard.filter((i) => i.rule !== "rights" && !(i.rule === "shape" && SYSTEM.test(i.message)));
}
