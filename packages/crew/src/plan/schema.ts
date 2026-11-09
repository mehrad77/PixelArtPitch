// The production plan's schemas (docs/PIP-ORCHESTRATION.md §1.2): runs/plan.json holds the latest revision with live
// statuses; runs/plan.jsonl gets one PlanRevision per revision (never a status-only change).
import { Role } from "@pap/schema";
import { z } from "zod";
import { ASSET_KINDS, CREATURE_SIZES, MOTIONS } from "../outputs.ts";
import { CATALOGUE_KINDS, PIP_ADDABLE, PLAN_GATES } from "./catalogue.ts";

export const PlanGate = z.enum(PLAN_GATES);
/** resolved to a model by code (resolveTier); the model never names a model */
export const Tier = z.enum(["role", "strong", "light"]);
export type TierT = z.infer<typeof Tier>;
export const PlanTaskStatus = z.enum([
  "pending",
  "ready",
  "running",
  "waiting_person",
  "done",
  "skipped",
  "failed",
  "dropped",
]);
export type PlanTaskStatusT = z.infer<typeof PlanTaskStatus>;

export const PlanTask = z.object({
  /** set by code and stable: "t_tune_s03_r2", "t_draw_founder_v1" (a rerun in a later revision adds "_v<rev>") */
  id: z.string().regex(/^t_[a-z0-9_]+$/),
  kind: z.enum(CATALOGUE_KINDS),
  role: z.union([Role, z.literal("person")]),
  gate: PlanGate.optional(),
  scene: z.string().optional(),
  /** a reboard or a scoped cast */
  scenes: z.array(z.string()).max(8).optional(),
  asset: z
    .string()
    .regex(/^[a-z0-9][a-z0-9_-]*$/)
    .optional(),
  /** the asset's kind, for a chain Pip or a reference added (the Director's newAssets carry their own) */
  assetKind: z.enum(ASSET_KINDS).optional(),
  /** a creature's size ("16x16" or "16x24") and motion (walk, fly, sit): its template's size and frames */
  assetSize: z.enum(CREATURE_SIZES).optional(),
  motion: z.enum(MOTIONS).optional(),
  /** what the asset shows, for a chain not from the storyboard */
  description: z.string().max(400).optional(),
  /** which drawing of the asset an asset.draw is (1-3) */
  variant: z.number().int().min(1).max(3).optional(),
  /** a chain's drawings per asset (1: no judge, the drawing is cast); absent means 2 */
  variants: z.number().int().min(1).max(3).optional(),
  /** asset.draw: critique rounds against the rendered sheet (absent: 1; "Finish within" sets 0) */
  critiques: z.number().int().min(0).max(1).optional(),
  /** review.final: no further review round after this one ("Finish within") */
  lastRound: z.boolean().optional(),
  /** a round within one crew run (a request): a redo is round + 1 */
  round: z.number().int().min(1).max(3).optional(),
  /** a brief reference file the asset comes from */
  fromRef: z.string().optional(),
  /** a placeholder until the storyboard is done */
  expand: z.enum(["per_scene", "per_new_asset"]).optional(),
  /** a placeholder's expected count */
  count: z.number().int().min(0).max(8).optional(),
  /** "animator:s03" (§2) */
  instance: z.string(),
  dependsOn: z.array(z.string()),
  tier: Tier.default("role"),
  /** [p50, p90] for this task */
  estUsd: z.tuple([z.number(), z.number()]),
  estSec: z.tuple([z.number(), z.number()]),
  conditional: z.boolean().default(false),
  status: PlanTaskStatus,
  /** state.tasks rows (the attempts) that ran it */
  taskIds: z.array(z.string()).default([]),
  /** the revision that added it */
  addedIn: z.number().int(),
  /** why it is in the plan, in Pip's words */
  reason: z.string().max(200).optional(),
  /** why it ended the way it did (skipped, dropped, partial) */
  note: z.string().max(200).optional(),
  /**
   * scene.code on a scene that already has its code: a patch of the current module (priced as scene.patch, no
   * critique round unless the trial finds something)
   */
  patch: z.boolean().optional(),
  /** done on a stand-in (kept as built, lints only, a library asset): `POST /crew/retry` redoes it */
  outcome: z.enum(["fallback"]).optional(),
});
export type PlanTaskT = z.infer<typeof PlanTask>;

export const PlanOp = z.discriminatedUnion("op", [
  z.object({ op: z.literal("add"), task: z.string(), reason: z.string() }),
  z.object({ op: z.literal("drop"), task: z.string(), reason: z.string() }),
  z.object({ op: z.literal("retier"), task: z.string(), from: Tier, to: Tier, reason: z.string() }),
  z.object({ op: z.literal("expand"), placeholder: z.string(), into: z.array(z.string()), reason: z.string() }),
  /** "Finish within": a task stays but does less (a draw without its critique, a review with no round after it) */
  z.object({ op: z.literal("trim"), task: z.string(), what: z.enum(["critique", "review_round"]), reason: z.string() }),
]);
export type PlanOpT = z.infer<typeof PlanOp>;

export const PlanEstimate = z.object({
  usd: z.tuple([z.number(), z.number()]),
  sec: z.tuple([z.number(), z.number()]),
  rough: z.boolean(),
});
export type PlanEstimateT = z.infer<typeof PlanEstimate>;

export const PlanBy = z.enum(["rules", "pip", "person", "code"]);
export const PlanTrigger = z.enum([
  "start",
  "pip_revision",
  "expand",
  "change",
  "conductor",
  "retry",
  "decline",
  /** "Finish within $X": the rules trim droppable work until the rest fits the cap (§1.6) */
  "budget",
]);

/** one line of runs/plan.jsonl */
export const PlanRevision = z.object({
  rev: z.number().int().min(0),
  at: z.string().datetime(),
  /** code = expansion, a redo by the fixed rules, a retry, a run from a stage */
  by: PlanBy,
  trigger: PlanTrigger,
  /** shown as "Plan changed: <reason>" */
  reason: z.string().max(200),
  ops: z.array(PlanOp),
  /** the full snapshot after this revision */
  tasks: z.array(PlanTask),
  estimate: PlanEstimate,
  /** the crew run it belongs to */
  run: z.string(),
  /** the person's notes this revision applies: they close when its tasks finish (§1.12) */
  noteIds: z.array(z.string()).optional(),
});
export type PlanRevisionT = z.infer<typeof PlanRevision>;

/** runs/plan.json: the latest revision with live statuses */
export const ProductionPlan = PlanRevision.extend({
  /** the p50 total the person last saw and approved (§1.6) */
  approvedUsd: z.number().nullable(),
  runs: z.array(z.object({ id: z.string(), startedAt: z.string(), pipProposals: z.number().int() })),
  pending: z.object({ rev: z.number(), cardId: z.string(), tasks: z.array(z.string()) }).optional(),
  /** notes a revision took on and the tasks it added: when they all finish, the notes are done (§1.12) */
  claims: z.array(z.object({ rev: z.number(), notes: z.array(z.string()), tasks: z.array(z.string()) })).optional(),
});
export type ProductionPlanT = z.infer<typeof ProductionPlan>;

/** Pip's proposal (§1.4): a diff on the rules plan, expanded by code */
export const PlanDiffOp = z.discriminatedUnion("op", [
  z.object({
    op: z.literal("add"),
    kind: z.enum(PIP_ADDABLE),
    scene: z.string().optional(),
    asset: z
      .string()
      .regex(/^[a-z][a-z0-9_-]*$/)
      .optional(),
    assetKind: z.enum(ASSET_KINDS).optional(),
    /** a creature's size and motion */
    size: z.enum(CREATURE_SIZES).optional(),
    motion: z.enum(MOTIONS).optional(),
    /** drawings for this asset (1-3); absent: the project's setting */
    variants: z.number().int().min(1).max(3).optional(),
    /** required with asset.spec */
    description: z.string().min(10).max(400).optional(),
    fromRef: z.string().optional(),
    tier: Tier.optional(),
    /** extra deps on existing task ids */
    after: z.array(z.string()).max(4).default([]),
    reason: z.string().min(3).max(90),
  }),
  z.object({ op: z.literal("drop"), task: z.string(), reason: z.string().min(3).max(90) }),
  z.object({ op: z.literal("retier"), task: z.string(), tier: Tier, reason: z.string().min(3).max(90) }),
]);
export const PlanDiffOut = z.object({
  ops: z.array(PlanDiffOp).max(8),
  /** the milestone line; "" when ops is [] */
  summary: z.string().max(200),
});
export type PlanDiffOutT = z.infer<typeof PlanDiffOut>;

/** what the wire carries (§4.2) */
export type PlanTaskView = {
  id: string;
  kind: string;
  role: string;
  gate?: string;
  scene?: string;
  asset?: string;
  round?: number;
  instance: string;
  label: string;
  stage: string;
  dependsOn: string[];
  tier: TierT;
  model: string | null;
  estUsd: [number, number];
  conditional: boolean;
  status: PlanTaskStatusT;
  taskIds: string[];
  addedIn: number;
  reason?: string;
  outcome?: "fallback";
  note?: string;
};
export type PlanView = {
  rev: number;
  at: string;
  by: z.infer<typeof PlanBy>;
  reason: string;
  tasks: PlanTaskView[];
  estimate: PlanEstimateT;
  approvedUsd: number | null;
  pip: { mode: "on" | "shadow" | "off"; proposals: number; max: number };
  pending?: { rev: number; cardId: string; tasks: string[] };
};
export type PlanRevisionSummary = {
  rev: number;
  at: string;
  by: z.infer<typeof PlanBy>;
  trigger: string;
  reason: string;
  ops: { op: "add" | "drop" | "retier" | "expand" | "trim"; task: string; label: string; reason: string }[];
  deltaUsd: [number, number];
};
