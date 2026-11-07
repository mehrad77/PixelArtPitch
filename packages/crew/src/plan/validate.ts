// The plan validator (docs/PIP-ORCHESTRATION.md §1.5). It runs on every revision, whoever wrote it. Errors carry a `fix`
// a small model can follow; warnings go onto the card. A rules or code plan is never rejected for its cost (V6).
import type { ProjectT, RoleT } from "@pap/schema";
import { CATALOGUE, CATALOGUE_KINDS, PIP_ADDABLE, type PlanKind } from "./catalogue.ts";
import { isLive, type PlanEnv, resolveTier } from "./estimate.ts";
import { jobKey } from "./rules.ts";
import type { PlanTaskT } from "./schema.ts";

export type PlanIssue = { code: string; rule: string; message: string; fix?: string; task?: string };
export type ValidateCtx = {
  doc: ProjectT;
  /** public library ids */
  library: Set<string>;
  env: PlanEnv;
  /** who wrote the revision being checked */
  by: "rules" | "pip" | "person" | "code";
  spentUsd: number;
  /** the tasks before this revision (V8: drop and retier apply only to pending or ready tasks) */
  before?: PlanTaskT[];
  /** the revision's ops, when Pip wrote it (V1, V5, V7, V8, V12) */
  ops?: { op: string; kind?: string; task?: string }[];
  /** scenes per request a redo has already used (V14) */
  redos?: Map<string, number>;
};

export const MAX_TASKS = 80;
export const MAX_OPS = 8;
export const MAX_NEW_ASSETS = 4;
export const MAX_REDO_ROUNDS = 2;

const VISION_KINDS = new Set<PlanKind>(["asset.draw", "asset.judge", "scene.tune", "review.final"]);

export function validate(tasks: PlanTaskT[], ctx: ValidateCtx): { errors: PlanIssue[]; warnings: PlanIssue[] } {
  const errors: PlanIssue[] = [];
  const warnings: PlanIssue[] = [];
  const err = (rule: string, code: string, message: string, fix?: string, task?: string) =>
    errors.push({ rule, code, message, ...(fix ? { fix } : {}), ...(task ? { task } : {}) });
  const ids = new Map(tasks.map((t) => [t.id, t]));
  const ops = ctx.ops ?? [];
  const pip = ctx.by === "pip";

  // V1 unknown_kind
  for (const t of tasks)
    if (!(CATALOGUE_KINDS as readonly string[]).includes(t.kind))
      err(
        "V1",
        "unknown_kind",
        `${t.id}: "${t.kind}" is not a catalogue kind`,
        `use one of: ${CATALOGUE_KINDS.join(", ")}`,
        t.id,
      );
  for (const o of ops)
    if (o.op === "add" && o.kind && !(PIP_ADDABLE as readonly string[]).includes(o.kind))
      err("V1", "unknown_kind", `Pip can't add a ${o.kind}`, `use one of: ${PIP_ADDABLE.join(", ")}`);
  // V2 role_scope
  for (const t of tasks) {
    const row = CATALOGUE[t.kind as PlanKind];
    if (row && t.role !== row.role)
      err(
        "V2",
        "role_scope",
        `${t.id}: ${t.kind} is the ${row.role}'s, not the ${t.role}'s`,
        `${t.kind} is the ${row.role}'s`,
        t.id,
      );
  }
  // V3 missing_dep, cycle (Kahn)
  for (const t of tasks)
    for (const d of t.dependsOn)
      if (!ids.has(d))
        err("V3", "missing_dep", `${t.id} depends on unknown ${d}`, `depend only on task ids in the plan`, t.id);
  {
    const indeg = new Map(tasks.map((t) => [t.id, t.dependsOn.filter((d) => ids.has(d)).length]));
    const q = tasks.filter((t) => indeg.get(t.id) === 0).map((t) => t.id);
    let seen = 0;
    while (q.length) {
      const id = q.shift()!;
      seen++;
      for (const t of tasks)
        if (t.dependsOn.includes(id)) {
          indeg.set(t.id, indeg.get(t.id)! - 1);
          if (indeg.get(t.id) === 0) q.push(t.id);
        }
    }
    if (seen < tasks.length)
      err("V3", "cycle", "the plan's dependencies form a cycle", "remove the dependency that loops back");
  }
  // V4 unknown_subject
  const scenes = new Set(ctx.doc.scenes.map((s) => s.id));
  const boarding = tasks.some((t) => t.kind === "director.storyboard" && isLive(t) && !t.scenes);
  const assets = new Set([
    ...ctx.doc.assets.map((a) => a.id),
    ...ctx.library,
    ...tasks.filter((t) => t.asset && (t.kind === "asset.spec" || t.kind === "asset.import")).map((t) => t.asset!),
  ]);
  const refs = new Set(ctx.doc.brief.references.map((r) => r.file));
  for (const t of tasks.filter(isLive)) {
    for (const s of [t.scene, ...(t.scenes ?? [])].filter((x): x is string => !!x))
      if (!scenes.has(s) && !boarding)
        err("V4", "unknown_subject", `${t.id}: no scene ${s}`, `use a scene id: ${[...scenes].join(", ")}`, t.id);
    if (t.asset && !assets.has(t.asset))
      err(
        "V4",
        "unknown_subject",
        `${t.id}: no asset ${t.asset}`,
        "name an asset in the project or the library, or add its chain",
        t.id,
      );
    if (t.fromRef && !refs.has(t.fromRef))
      err(
        "V4",
        "unknown_subject",
        `${t.id}: ${t.fromRef} is not a brief reference`,
        `use one of: ${[...refs].join(", ") || "(none)"}`,
        t.id,
      );
  }
  // V5 gate_missing, gate_touched
  const live = tasks.filter((t) => t.status !== "dropped");
  for (const g of ["g0_brief", "g1_script", "g2_animatic", "g3_rough", "g4_final"])
    if (!live.some((t) => t.kind === "gate" && t.gate === g))
      err("V5", "gate_missing", `the plan has no ${g}`, "gates are inserted by code: start from the rules plan");
  for (const t of live.filter((x) => (x.kind === "asset.spec" || x.kind === "asset.import") && x.fromRef)) {
    const ref = ctx.doc.brief.references.find((r) => r.file === t.fromRef);
    if (
      ref &&
      (ref.type === "likeness" || ref.type === "logo") &&
      !live.some((x) => x.kind === "gate" && x.gate === "rights" && x.asset === t.asset)
    )
      err(
        "V5",
        "gate_missing",
        `${t.asset} comes from a ${ref.type} reference and has no rights OK`,
        "code adds the rights gate with the chain",
      );
  }
  if (pip)
    for (const o of ops)
      if ((o.op === "drop" || o.op === "retier") && o.task && ids.get(o.task)?.kind === "gate")
        err("V5", "gate_touched", `${o.task} is a gate`, "gates aren't yours to change");
  // V6 over_cap (Pip only; rules and code plans become a card instead)
  const cap = ctx.doc.budget.capUsd - ctx.doc.budget.reserveUsd;
  const p50 = ctx.spentUsd + tasks.filter((t) => isLive(t) && !t.conditional).reduce((s, t) => s + t.estUsd[0], 0);
  if (pip && p50 > cap)
    err(
      "V6",
      "over_cap",
      `est $${p50.toFixed(2)} > $${cap.toFixed(2)} available`,
      `drop or lighten: est $${p50.toFixed(2)} > $${cap.toFixed(2)} available`,
    );
  const p90 = ctx.spentUsd + tasks.filter(isLive).reduce((s, t) => s + t.estUsd[1], 0);
  if (p90 > cap)
    warnings.push({
      rule: "V6",
      code: "over_cap_p90",
      message: `at worst $${p90.toFixed(2)}, over the $${cap.toFixed(2)} available`,
    });
  // V7 required_dropped, V8 not_pending
  for (const o of ops) {
    const before = ctx.before?.find((t) => t.id === o.task);
    if (o.op === "drop" && before && !CATALOGUE[before.kind].droppable)
      err(
        "V7",
        "required_dropped",
        `${before.kind} can't be dropped`,
        `drop only: ${CATALOGUE_KINDS.filter((k) => CATALOGUE[k].droppable).join(", ")}`,
        before.id,
      );
    if ((o.op === "drop" || o.op === "retier") && before && before.status !== "pending" && before.status !== "ready")
      err(
        "V8",
        "not_pending",
        `${before.id} is ${before.status}`,
        "drop or retier only pending or ready tasks",
        before.id,
      );
    if ((o.op === "drop" || o.op === "retier") && o.task && !before && !ids.has(o.task))
      err("V3", "missing_dep", `no task ${o.task}`, "use a task id from the plan", o.task);
  }
  // V9 private_publish
  for (const t of live.filter((x) => x.kind === "lib.publish" && x.asset)) {
    const ref = ctx.doc.assets.find((a) => a.id === t.asset);
    const chain = tasks.find((x) => x.asset === t.asset && (x.kind === "asset.spec" || x.kind === "asset.import"));
    if (
      ref?.flags.private ||
      ref?.flags.likeness ||
      ref?.flags.brand ||
      chain?.fromRef ||
      chain?.kind === "asset.import"
    )
      err(
        "V9",
        "private_publish",
        `${t.asset} is private: it never goes into the public library`,
        "drop the publish",
        t.id,
      );
  }
  // V10 tier_caps
  for (const t of tasks.filter((x) => isLive(x) && VISION_KINDS.has(x.kind) && x.tier !== "role")) {
    const model = resolveTier(t.role as RoleT, t.tier, ctx.env);
    if (ctx.env.caps(model)?.vision === "failed")
      err(
        "V10",
        "tier_caps",
        `${t.tier} has no vision for the ${t.role}`,
        `${t.tier} has no vision for the ${t.role}; keep role`,
        t.id,
      );
  }
  // V11 subject_shape
  for (const t of tasks.filter((x) => isLive(x) && !x.expand)) {
    if (t.kind === "scene.tune" && !t.scene)
      err("V11", "subject_shape", `${t.id}: scene.tune needs a scene`, "set scene", t.id);
    if (t.kind.startsWith("asset.") && !t.asset)
      err("V11", "subject_shape", `${t.id}: ${t.kind} needs an asset`, "set asset", t.id);
    if (t.kind === "gate" && !t.gate) err("V11", "subject_shape", `${t.id}: a gate needs its id`, "set gate", t.id);
  }
  if (pip)
    for (const o of ops as { op: string; kind?: string; description?: string; assetKind?: string }[])
      if (o.op === "add" && o.kind === "asset.spec" && (!o.description || !o.assetKind))
        err(
          "V11",
          "subject_shape",
          "an added asset.spec needs a description and an assetKind",
          "give description (10-400 chars) and assetKind",
        );
  // V12 too_big
  if (ops.length > MAX_OPS)
    err("V12", "too_big", `${ops.length} ops; at most ${MAX_OPS}`, `send at most ${MAX_OPS} ops`);
  if (tasks.length > MAX_TASKS)
    err("V12", "too_big", `${tasks.length} tasks; at most ${MAX_TASKS}`, "drop work or split the request");
  const newChains = new Set(live.filter((t) => t.kind === "asset.spec" && !t.expand && isLive(t)).map((t) => t.asset));
  if (newChains.size > MAX_NEW_ASSETS)
    err("V12", "too_big", `${newChains.size} new assets; at most ${MAX_NEW_ASSETS}`, "use library art for the rest");
  for (const t of tasks)
    if ((t.round ?? 1) > 3) err("V12", "too_big", `${t.id}: round ${t.round}; at most 3`, "", t.id);
  // V13 duplicate
  const seenJob = new Map<string, string>();
  for (const t of tasks.filter(isLive)) {
    const k = `${jobKey(t)}|${t.round ?? ""}`;
    if (seenJob.has(k)) err("V13", "duplicate", `${t.id} repeats ${seenJob.get(k)}`, "drop one of them", t.id);
    else seenJob.set(k, t.id);
  }
  // V14 redo_limit
  for (const [scene, n] of ctx.redos ?? [])
    if (n > MAX_REDO_ROUNDS)
      err(
        "V14",
        "redo_limit",
        `${scene} had ${n} redo rounds in this request; at most ${MAX_REDO_ROUNDS}`,
        "hold and tell the person",
      );
  // warnings: rough estimates, the deadline
  return { errors, warnings };
}
