// What each crew call must return. Kept small and generic (lists of {name, rows} rather than one property per frame)
// so structured-output grammars stay small and weak models can fill them.
import { z } from "zod";

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

export const StoryboardOut = z.object({
  scenes: z
    .array(
      z.object({
        id: z.string().regex(/^[a-z][a-z0-9_]*$/),
        title: z.string().min(1).max(60),
        cues: z.array(z.string()).min(1),
        recipes: z
          .array(z.object({ id: z.string(), params: z.record(z.string(), z.unknown()) }))
          .min(1)
          .max(8),
      }),
    )
    .min(1)
    .max(8),
  newAssets: z
    .array(
      z.object({
        name: z.string().regex(/^[a-z][a-z0-9_-]*$/),
        kind: z.enum(["character", "prop", "icon", "decor"]),
        description: z.string().min(10).max(400),
      }),
    )
    .max(4),
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

export const ReviewOut = z.object({
  verdict: z.enum(["ship", "fix"]),
  summary: z.string().max(400),
  blockers: z
    .array(z.object({ t: z.number(), scene: z.string(), issue: z.string().max(300), fix: z.string().max(300) }))
    .max(12),
  polish: z.array(z.object({ t: z.number(), scene: z.string(), issue: z.string().max(300) })).max(12),
});

export type PlanOutT = z.infer<typeof PlanOut>;
export type AnglesOutT = z.infer<typeof AnglesOut>;
export type StoryboardOutT = z.infer<typeof StoryboardOut>;
export type DrawOutT = z.infer<typeof DrawOut>;
export type ReviewOutT = z.infer<typeof ReviewOut>;

/** size and frames per asset kind (the PAP standard's size classes) */
export const KIND_TEMPLATES: Record<string, { w: number; h: number; frames: string[]; note: string }> = {
  character: {
    w: 16,
    h: 24,
    frames: ["idle0", "idle1", "run0", "run1", "run2", "run3", "jump", "wave"],
    note: "A playable hero, chibi proportions (head about 9-10 rows). idle0/idle1 breathe (body shifts 1 px); run0-run3 a 4-frame run cycle facing RIGHT, arms and legs alternating; jump knees tucked, one arm up; wave facing the viewer, right hand raised. Feet on the bottom row except jump.",
  },
  prop: { w: 24, h: 32, frames: ["prop"], note: "A level prop standing on the bottom row, transparent background." },
  icon: { w: 16, h: 16, frames: ["icon"], note: "A centred icon with a 1 px dark outline, readable at 1x." },
  decor: { w: 24, h: 24, frames: ["decor"], note: "A small decoration, transparent background." },
};
