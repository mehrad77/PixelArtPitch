// The plan on disk and on the wire (docs/PIP-ORCHESTRATION.md §1.2 "Storage", §4.3): runs/plan.json is written
// atomically on every revision and status change; runs/plan.jsonl gets one line per revision. A revision is a stored
// SSE `plan` event (with its summary) and, when it has ops, a "Plan changed: …" milestone; a status change is a
// stored `plan_status` line (just the tasks that moved, so the crew instances replay from events.jsonl, §2) and a
// transient `plan` event (id 0) with the whole view.
import { appendFileSync, existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { RoleT } from "@pap/schema";
import type { OpenProject } from "@pap/tools";
import { stageOf, taskLabel } from "./catalogue.ts";
import { isLive, type PlanEnv, planEstimate, resolveTier } from "./estimate.ts";
import {
  type PlanOpT,
  type PlanRevisionSummary,
  type PlanRevisionT,
  type PlanTaskT,
  type PlanView,
  ProductionPlan,
  type ProductionPlanT,
} from "./schema.ts";

/** a safety stop: more revisions than this in one run holds the crew (§1.6) */
export const MAX_REVISIONS_PER_RUN = 40;
/** Pip's proposals per run (§1.6) */
export const MAX_PIP_PROPOSALS = 6;

const file = (p: OpenProject) => join(p.dir, "runs", "plan.json");
const log = (p: OpenProject) => join(p.dir, "runs", "plan.jsonl");

export function loadPlan(p: OpenProject): ProductionPlanT | null {
  if (!existsSync(file(p))) return null;
  try {
    return ProductionPlan.parse(JSON.parse(readFileSync(file(p), "utf8")));
  } catch (e: any) {
    p.emit("log", {
      level: "warn",
      text: `runs/plan.json is unreadable (${String(e?.message ?? e).slice(0, 120)}); planning again`,
    });
    return null;
  }
}
export function savePlan(p: OpenProject, plan: ProductionPlanT) {
  const tmp = `${file(p)}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(plan, null, 1));
  renameSync(tmp, file(p));
}
export function readRevisions(p: OpenProject): PlanRevisionT[] {
  if (!existsSync(log(p))) return [];
  return readFileSync(log(p), "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l) as PlanRevisionT);
}

const sceneIds = (p: OpenProject) => p.doc().scenes.map((s) => s.id);

export function viewOf(
  p: OpenProject,
  plan: ProductionPlanT,
  env: PlanEnv,
  pip: PlanView["pip"] = { mode: "off", proposals: 0, max: MAX_PIP_PROPOSALS },
): PlanView {
  const ids = sceneIds(p);
  return {
    rev: plan.rev,
    at: plan.at,
    by: plan.by,
    reason: plan.reason,
    tasks: plan.tasks.map((t) => ({
      id: t.id,
      kind: t.kind,
      role: t.role,
      ...(t.gate ? { gate: t.gate } : {}),
      ...(t.scene ? { scene: t.scene } : {}),
      ...(t.asset ? { asset: t.asset } : {}),
      ...(t.round ? { round: t.round } : {}),
      instance: t.instance,
      label: taskLabel(t, ids),
      stage: stageOf(t),
      dependsOn: t.dependsOn,
      tier: t.tier,
      model: t.role === "person" ? null : resolveTier(t.role as RoleT, t.tier, env),
      estUsd: t.estUsd,
      conditional: t.conditional,
      status: t.status,
      taskIds: t.taskIds,
      addedIn: t.addedIn,
      ...(t.reason ? { reason: t.reason } : {}),
      ...(t.outcome ? { outcome: t.outcome } : {}),
      ...(t.note ? { note: t.note } : {}),
    })),
    estimate: plan.estimate,
    approvedUsd: plan.approvedUsd,
    pip,
    ...(plan.pending ? { pending: plan.pending } : {}),
  };
}

export function summaryOf(
  p: OpenProject,
  r: PlanRevisionT,
  prev: { usd: [number, number] } | null,
): PlanRevisionSummary {
  const ids = sceneIds(p);
  const label = (id: string) => {
    const t = r.tasks.find((x) => x.id === id);
    return t ? taskLabel(t, ids) : id;
  };
  return {
    rev: r.rev,
    at: r.at,
    by: r.by,
    trigger: r.trigger,
    reason: r.reason,
    ops: r.ops.map((o) =>
      o.op === "expand"
        ? {
            op: "expand",
            task: o.placeholder,
            label: o.into.map(label).join(", ") || label(o.placeholder),
            reason: o.reason,
          }
        : { op: o.op, task: o.task, label: label(o.task), reason: o.reason },
    ),
    deltaUsd: prev
      ? [+(r.estimate.usd[0] - prev.usd[0]).toFixed(4), +(r.estimate.usd[1] - prev.usd[1]).toFixed(4)]
      : r.estimate.usd,
  };
}

/** every revision, as summaries (GET /api/p/:id/plan/revisions) */
export function revisionSummaries(p: OpenProject): PlanRevisionSummary[] {
  const all = readRevisions(p);
  return all.map((r, i) => summaryOf(p, r, i ? all[i - 1].estimate : null));
}

/** the statuses events.jsonl last recorded, per project (seeded from runs/plan.json, which every change saves) */
const recorded = new WeakMap<OpenProject, Map<string, string>>();
function recordedOf(p: OpenProject) {
  let m = recorded.get(p);
  if (!m) {
    m = new Map((loadPlan(p)?.tasks ?? []).map((t) => [t.id, `${t.status}|${t.note ?? ""}`]));
    recorded.set(p, m);
  }
  return m;
}

/** the stable fields of a status change: re-estimate the plan and send it as a transient event */
export function touch(p: OpenProject, plan: ProductionPlanT, env: PlanEnv, spentUsd: number, pip?: PlanView["pip"]) {
  // what moved goes into the log first (stored), so a replay of events.jsonl sees every status, `ready` included
  const was = recordedOf(p);
  const moved = plan.tasks.filter((t) => was.get(t.id) !== `${t.status}|${t.note ?? ""}`);
  for (const t of moved) was.set(t.id, `${t.status}|${t.note ?? ""}`);
  if (moved.length)
    p.emit("plan_status", {
      rev: plan.rev,
      tasks: moved.map((t) => ({
        id: t.id,
        status: t.status,
        ...(t.note ? { note: t.note } : {}),
        ...(t.taskIds.length ? { taskIds: t.taskIds } : {}),
      })),
    });
  plan.estimate = planEstimate(plan.tasks, spentUsd, env);
  savePlan(p, plan);
  const ts = new Date().toISOString();
  p.events.emit("event", { seq: 0, event: "plan", data: { view: viewOf(p, plan, env, pip) }, ts });
}

/**
 * Write a revision: the new snapshot becomes runs/plan.json, a line goes into runs/plan.jsonl, a stored `plan` event
 * carries the view and the summary, and a revision with ops earns a "Plan changed: <reason>" milestone.
 */
export function revise(
  p: OpenProject,
  plan: ProductionPlanT | null,
  r: {
    by: PlanRevisionT["by"];
    trigger: PlanRevisionT["trigger"];
    reason: string;
    ops: PlanOpT[];
    tasks: PlanTaskT[];
    run: string;
  },
  env: PlanEnv,
  spentUsd: number,
  pip?: PlanView["pip"],
): ProductionPlanT {
  const rev = plan ? plan.rev + 1 : 0;
  const revision: PlanRevisionT = {
    rev,
    at: new Date().toISOString(),
    by: r.by,
    trigger: r.trigger,
    reason: r.reason.slice(0, 200),
    ops: r.ops,
    tasks: r.tasks,
    estimate: planEstimate(r.tasks, spentUsd, env),
    run: r.run,
  };
  const next: ProductionPlanT = {
    ...revision,
    approvedUsd: plan?.approvedUsd ?? null,
    runs: plan?.runs ?? [],
    ...(plan?.pending ? { pending: plan.pending } : {}),
  };
  appendFileSync(log(p), `${JSON.stringify(revision)}\n`);
  savePlan(p, next);
  recorded.set(p, new Map(next.tasks.map((t) => [t.id, `${t.status}|${t.note ?? ""}`])));
  const summary = summaryOf(p, revision, plan?.estimate ?? null);
  p.emit("plan", { view: viewOf(p, next, env, pip), revision: summary });
  if (r.ops.length) p.milestone(`plan.r${rev}`, `Plan changed: ${revision.reason}`);
  return next;
}

/** the non-gate, non-conditional tasks still to do ("Plan ready · N tasks to start") */
export const tasksToStart = (tasks: PlanTaskT[]) =>
  tasks.filter((t) => isLive(t) && t.kind !== "gate" && !t.conditional && !t.expand).length +
  tasks.filter((t) => isLive(t) && t.expand && !t.conditional).reduce((s, t) => s + (t.count ?? 0), 0);
