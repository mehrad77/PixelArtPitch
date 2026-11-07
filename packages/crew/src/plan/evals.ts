// Plan evals (docs/PIP-ORCHESTRATION.md §5): an item is a fictional brief with what its plan must hold and must not;
// each item is scored for the rules plan and for rules + Pip: valid (first try, after repair), missing (`must`
// entries with no match), extra (`mustNot` matches, plus tasks Pip added that no `must` asked for) and estErr
// (|p50 − mid(estUsd)| / mid(estUsd)). The runner is evals/plan.ts; plan.test.ts checks the scorer on fixed items.
import { Project, type ProjectT } from "@pap/schema";
import { z } from "zod";
import { isLive } from "./estimate.ts";
import type { PlanTaskT } from "./schema.ts";

const Match = z.object({
  kind: z.string(),
  gate: z.string().optional(),
  /** the reference type the task comes from (logo, likeness) */
  fromRef: z.string().optional(),
  tier: z.enum(["role", "strong", "light"]).optional(),
  variant: z.number().int().min(1).max(3).optional(),
  status: z.string().optional(),
  /** added by Pip's revision (not by the rules) */
  added: z.boolean().optional(),
});
export type MatchT = z.infer<typeof Match>;
const Must = z.union([Match, z.object({ anyOf: z.array(Match).min(1) })]);

export const PlanEvalItem = z.object({
  id: z.string(),
  brief: z.object({
    idea: z.string(),
    lengthSec: z.number(),
    narration: z.enum(["none", "user", "tts"]).default("none"),
    purpose: z.enum(["pitch", "application", "launch", "social", "other"]).default("pitch"),
    involvement: z.enum(["every", "key", "auto"]).default("key"),
    tone: z.array(z.string()).default([]),
  }),
  budgetUsd: z.number(),
  profile: z.enum(["best", "balanced", "local"]).default("best"),
  refs: z
    .array(
      z.object({
        type: z.enum(["likeness", "logo", "style", "as-is", "sound", "voice"]),
        rights: z.enum(["mine", "licensed", "unsure"]),
        note: z.string().default(""),
      }),
    )
    .default([]),
  library: z.literal("default").default("default"),
  must: z.array(Must).default([]),
  mustNot: z.array(Match).default([]),
  estUsd: z.tuple([z.number(), z.number()]),
});
export type PlanEvalItemT = z.infer<typeof PlanEvalItem>;

/** the item's project document: a fresh project (placeholder script), its references as private files */
export function evalDoc(item: PlanEvalItemT): ProjectT {
  return Project.parse({
    pap: 1,
    rev: 0,
    id: item.id.replace(/[^a-z0-9_]/g, "_"),
    title: item.id,
    canvas: { w: 320, h: 180, fps: 30 },
    brief: {
      ...item.brief,
      references: item.refs.map((r, i) => ({
        file: `private/refs/${r.type}-${i + 1}.png`,
        type: r.type,
        rights: r.rights,
        note: r.note,
      })),
    },
    script: { cues: [{ id: "c01", text: "Placeholder: the Writer replaces this." }], timing: { mode: "estimate" } },
    composition: { hold: 1, endHold: 3, duration: "E(c01)+endHold" },
    scenes: [
      { id: "s01", title: "Placeholder", kind: "decl", from: 0, to: "duration", recipes: [{ id: "backdrop_night" }] },
    ],
    audio: { sfx: {} },
    assets: [{ id: "font", src: "lib:font-5x8@1" }],
    budget: { capUsd: item.budgetUsd },
  });
}

const refType = (doc: ProjectT, file?: string) => doc.brief.references.find((r) => r.file === file)?.type;
function matches(m: MatchT, t: PlanTaskT, doc: ProjectT, rulesIds: Set<string>) {
  if (t.kind !== m.kind) return false;
  if (m.gate && t.gate !== m.gate) return false;
  if (m.fromRef && refType(doc, t.fromRef) !== m.fromRef) {
    // a rights gate or a publish names the asset, not the reference: follow it to its chain
    return false;
  }
  if (m.tier && t.tier !== m.tier) return false;
  if (m.variant && t.variant !== m.variant) return false;
  if (m.status ? t.status !== m.status : t.status === "dropped") return false;
  if (m.added !== undefined && m.added !== !rulesIds.has(t.id)) return false;
  return true;
}
/** a task's reference, through its asset's chain (a gate or a publish names only the asset) */
function withRef(tasks: PlanTaskT[]): PlanTaskT[] {
  const refOf = new Map(tasks.filter((t) => t.fromRef && t.asset).map((t) => [t.asset!, t.fromRef!]));
  return tasks.map((t) => (!t.fromRef && t.asset && refOf.has(t.asset) ? { ...t, fromRef: refOf.get(t.asset) } : t));
}

export type ItemScore = {
  id: string;
  valid: "first" | "repair" | "no";
  missing: number;
  extra: number;
  estErr: number;
  p50: number;
  usd: number;
  sec: number;
};

/** score one plan for an item; `rules` is the rules plan (what Pip added is what isn't in it) */
export function scorePlan(
  item: PlanEvalItemT,
  tasks: PlanTaskT[],
  o: { rules: PlanTaskT[]; p50: number; valid?: ItemScore["valid"]; usd?: number; sec?: number },
): ItemScore {
  const doc = evalDoc(item);
  const ts = withRef(tasks);
  const rulesIds = new Set(o.rules.map((t) => t.id));
  const any = (m: MatchT) => ts.some((t) => matches(m, t, doc, rulesIds));
  let missing = 0;
  const justified = new Set<string>();
  for (const m of item.must) {
    const alts = "anyOf" in m ? m.anyOf : [m];
    const hit = alts.find(any);
    if (!hit) missing++;
    else for (const t of ts) if (matches(hit, t, doc, rulesIds)) justified.add(t.id);
  }
  let extra = item.mustNot.filter(any).length;
  // a task Pip added that no `must` asked for (a chain counts once, by its spec or import)
  const added = ts.filter(
    (t) =>
      !rulesIds.has(t.id) &&
      isLive(t) &&
      (t.kind === "asset.spec" || t.kind === "asset.import" || t.kind === "scene.tune"),
  );
  for (const t of added)
    if (!justified.has(t.id) && !ts.some((x) => justified.has(x.id) && x.asset && x.asset === t.asset)) extra++;
  const mid = (item.estUsd[0] + item.estUsd[1]) / 2;
  return {
    id: item.id,
    valid: o.valid ?? "first",
    missing,
    extra,
    estErr: mid > 0 ? Math.abs(o.p50 - mid) / mid : o.p50 > 0 ? 1 : 0,
    p50: o.p50,
    usd: o.usd ?? 0,
    sec: o.sec ?? 0,
  };
}

export type Aggregate = {
  n: number;
  validity: number;
  missing: number;
  extra: number;
  medianEstErr: number;
  usdPerCall: number;
  secPerCall: number;
};
export function aggregate(scores: ItemScore[], calls = scores.length): Aggregate {
  const n = scores.length || 1;
  const errs = scores.map((s) => s.estErr).sort((a, b) => a - b);
  const median = errs.length
    ? errs.length % 2
      ? errs[(errs.length - 1) / 2]
      : (errs[errs.length / 2 - 1] + errs[errs.length / 2]) / 2
    : 0;
  const r = (x: number) => Math.round(x * 10000) / 10000;
  return {
    n: scores.length,
    validity: r(scores.filter((s) => s.valid !== "no").length / n),
    missing: r(scores.reduce((s, x) => s + x.missing, 0) / n),
    extra: r(scores.reduce((s, x) => s + x.extra, 0) / n),
    medianEstErr: r(median),
    usdPerCall: r(scores.reduce((s, x) => s + x.usd, 0) / Math.max(1, calls)),
    secPerCall: r(scores.reduce((s, x) => s + x.sec, 0) / Math.max(1, calls)),
  };
}

/** Pip beats the rules plan when validity ≥ 95%, missing + extra is strictly lower, and estErr is ≤ 5 points worse */
export function pipWins(rules: Aggregate, pip: Aggregate) {
  return (
    pip.validity >= 0.95 &&
    pip.missing + pip.extra < rules.missing + rules.extra &&
    pip.medianEstErr <= rules.medianEstErr + 0.05
  );
}
