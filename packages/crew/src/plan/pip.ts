// Pip's revision of the rules plan (docs/PIP-ORCHESTRATION.md §1.4, D1): Pip proposes a small diff (PlanDiffOut) on
// the plan code wrote; code expands each op into catalogue tasks, the validator checks it, one repair turn follows a
// bad answer, and a second bad answer (or any failure) keeps the rules plan at no further cost. One metered call,
// `assistant.plan`, on Pip's own model, never escalated to a fallback model.
import { z } from "zod";
import type { Gateway } from "../gateway.ts";
import type { ChatMessage } from "../llm/types.ts";
import { card, fill } from "../prompts.ts";
import { CATALOGUE, CATALOGUE_KINDS, idPart, type PlanKind, stageOf } from "./catalogue.ts";
import { estimatePlanTask, isLive } from "./estimate.ts";
import { addRedo, chainSubject, mkTask, type RulesCtx, variantsOf } from "./rules.ts";
import { PlanDiffOut, type PlanDiffOutT, type PlanOpT, type PlanTaskT } from "./schema.ts";
import { type PlanIssue, type ValidateCtx, validate } from "./validate.ts";

const latest = (ts: PlanTaskT[], f: (t: PlanTaskT) => boolean) => ts.filter(f).at(-1);

/**
 * Code expands Pip's ops into plan tasks: an asset becomes its chain (spec, its drawings, the judge when there are two
 * or more, and the person's OK when it comes from a likeness), a logo its import and OK, a scene.tune a redo on the
 * same instance. Drop and retier change the named task. Ops that can't apply come back as issues for the validator's list.
 */
export function applyDiff(
  tasks: PlanTaskT[],
  diff: PlanDiffOutT,
  ctx: RulesCtx & { refs: { file: string; type: string }[] },
): { tasks: PlanTaskT[]; ops: PlanOpT[]; issues: PlanIssue[] } {
  let ts = tasks.map((t) => ({ ...t, dependsOn: [...t.dependsOn] }));
  const ops: PlanOpT[] = [];
  const issues: PlanIssue[] = [];
  const taken = new Set(ts.map((t) => t.id));
  const fresh = (id: string) => {
    let out = id;
    for (let k = 2; taken.has(out); k++) out = `${id}_${k}`;
    taken.add(out);
    return out;
  };
  const g = (gate: string) => latest(ts, (t) => t.kind === "gate" && t.gate === gate && t.status !== "dropped")?.id;
  for (const o of diff.ops) {
    if (o.op === "drop" || o.op === "retier") {
      const t = ts.find((x) => x.id === o.task);
      if (!t) {
        issues.push({
          rule: "V3",
          code: "missing_dep",
          message: `no task ${o.task}`,
          fix: "use a task id from the plan",
        });
        continue;
      }
      if (o.op === "drop") {
        t.status = "dropped";
        t.note = o.reason.slice(0, 200);
        for (const x of ts) x.dependsOn = x.dependsOn.filter((d) => d !== t.id || !isLive(x));
        ops.push({ op: "drop", task: t.id, reason: o.reason });
      } else {
        ops.push({ op: "retier", task: t.id, from: t.tier, to: o.tier, reason: o.reason });
        t.tier = o.tier;
        const e = estimatePlanTask(t, ctx.env);
        t.estUsd = e.usd;
        t.estSec = e.sec;
      }
      continue;
    }
    // add
    if (o.kind === "scene.tune") {
      if (!o.scene) {
        issues.push({ rule: "V11", code: "subject_shape", message: "scene.tune needs a scene", fix: "set scene" });
        continue;
      }
      const r = addRedo(ts, [o.scene], ctx, { after: o.after, reason: o.reason });
      ts = r.tasks;
      for (const id of r.added) {
        const t = ts.find((x) => x.id === id)!;
        if (o.tier) t.tier = o.tier;
        ops.push({ op: "add", task: id, reason: o.reason });
      }
      continue;
    }
    if (!o.asset) {
      issues.push({ rule: "V11", code: "subject_shape", message: `${o.kind} needs an asset`, fix: "set asset" });
      continue;
    }
    const ref = o.fromRef ? ctx.refs.find((r) => r.file === o.fromRef) : undefined;
    const k = idPart(o.asset);
    const added: PlanTaskT[] = [];
    if (o.kind === "asset.import") {
      const g0 = g("g0_brief") ?? "t_g0";
      const imp = mkTask(
        {
          id: fresh(`t_import_${k}`),
          kind: "asset.import",
          asset: o.asset,
          assetKind: "icon",
          fromRef: o.fromRef,
          dependsOn: [g0, ...o.after],
          reason: o.reason,
        },
        ctx,
      );
      added.push(
        imp,
        mkTask(
          {
            id: fresh(`t_rights_${k}`),
            kind: "gate",
            gate: "rights",
            asset: o.asset,
            dependsOn: [imp.id],
            reason: o.reason,
          },
          ctx,
        ),
      );
      // the Director must see it in its list
      for (const t of ts) if (t.kind === "director.storyboard" && isLive(t)) t.dependsOn.push(imp.id);
    } else {
      const g2 = g("g2_animatic") ?? "t_g2";
      // the op's own count wins, then the project's, then Settings'; one drawing has no judge
      const n = variantsOf(o, ctx);
      const subj = chainSubject(
        {
          name: o.asset,
          kind: o.assetKind ?? "character",
          description: o.description ?? o.asset,
          ...(o.size ? { size: o.size } : {}),
          ...(o.motion ? { motion: o.motion } : {}),
          ...(o.fromRef ? { fromRef: o.fromRef } : {}),
        },
        n,
        { reason: o.reason, ...(o.tier ? { tier: o.tier } : {}) },
      );
      if (!o.assetKind) delete subj.assetKind;
      if (!o.description) delete subj.description;
      const spec = mkTask({ id: fresh(`t_spec_${k}`), kind: "asset.spec", dependsOn: [g2, ...o.after], ...subj }, ctx);
      const draws = Array.from({ length: n }, (_, i) =>
        mkTask(
          { id: fresh(`t_draw_${k}_v${i + 1}`), kind: "asset.draw", variant: i + 1, dependsOn: [spec.id], ...subj },
          ctx,
        ),
      );
      added.push(spec, ...draws);
      if (n > 1)
        added.push(
          mkTask({ id: fresh(`t_judge_${k}`), kind: "asset.judge", dependsOn: draws.map((d) => d.id), ...subj }, ctx),
        );
      const j = added.at(-1)!;
      if (ref && (ref.type === "likeness" || ref.type === "logo"))
        added.push(
          mkTask(
            {
              id: fresh(`t_rights_${k}`),
              kind: "gate",
              gate: "rights",
              asset: o.asset,
              dependsOn: [j.id],
              reason: o.reason,
            },
            ctx,
          ),
        );
    }
    const last = added.at(-1)!.id;
    // the scenes that use it wait for it (before the storyboard: the scene placeholder)
    for (const t of ts)
      if (
        (t.kind === "scene.tune" || t.kind === "scene.code") &&
        isLive(t) &&
        (t.expand || (t.scene && ctx.assetsOf?.(t.scene).includes(o.asset)))
      )
        t.dependsOn.push(last);
    ts.push(...added);
    for (const t of added) ops.push({ op: "add", task: t.id, reason: o.reason });
  }
  return { tasks: ts, ops, issues };
}

export type PipRevisionResult = {
  /** the plan after Pip's ops, when they validated (null: keep the rules plan) */
  tasks: PlanTaskT[] | null;
  ops: PlanOpT[];
  summary: string;
  /** why the rules plan stands (the first validator error, or the call's failure) */
  kept?: string;
  /** validated on the first answer, after the repair, or not at all */
  valid: "first" | "repair" | "no";
  calls: number;
  usd: number;
  sec: number;
  diff: PlanDiffOutT | null;
};

/** the prompt's inputs, in plain lines (§1.4 "user") */
export function planPromptVars(o: {
  brief: Record<string, unknown>;
  refs: { file: string; type: string; rights: string }[];
  library: { id: string; kind: string; tags?: string[] }[];
  budget: { capUsd: number; reserveUsd: number; spentUsd: number; estUsd: [number, number] };
  tasks: PlanTaskT[];
  ctx: RulesCtx;
}) {
  const byKind = new Map<string, string[]>();
  for (const a of o.library)
    byKind.set(a.kind, [
      ...(byKind.get(a.kind) ?? []),
      a.tags?.length ? `${a.id} (${a.tags.slice(0, 3).join(", ")})` : a.id,
    ]);
  const price = (kind: PlanKind, tier: "role" | "light" | "strong") => {
    const role = CATALOGUE[kind].role;
    if (role === "person" || !CATALOGUE[kind].prices.length) return "$0";
    const e = estimatePlanTask({ kind, role, tier, conditional: false } as PlanTaskT, o.ctx.env);
    return `$${e.usd[0].toFixed(2)}/$${e.usd[1].toFixed(2)}`;
  };
  return {
    brief: JSON.stringify(o.brief),
    refs: o.refs.length
      ? o.refs.map((r) => `${r.file} · ${r.type} · rights ${r.rights} · private`).join("\n")
      : "(none)",
    library: [...byKind.entries()].map(([k, ids]) => `${k}: ${ids.join(", ")}`).join("\n"),
    budget: `cap $${o.budget.capUsd.toFixed(2)}, reserve $${o.budget.reserveUsd.toFixed(2)}, spent $${o.budget.spentUsd.toFixed(2)}, the rules plan's estimate $${o.budget.estUsd[0].toFixed(2)} (p50) to $${o.budget.estUsd[1].toFixed(2)} (p90)`,
    catalogue: CATALOGUE_KINDS.map((k) => {
      const r = CATALOGUE[k];
      return `${k} · ${r.role} · ${r.what} · may: ${r.pipMay.join(", ") || "nothing"} · ${price(k, "role")} / ${price(k, "light")} / ${price(k, "strong")}`;
    }).join("\n"),
    plan: o.tasks
      .filter((t) => isLive(t) || t.status === "done")
      .map(
        (t) =>
          `${t.id} · ${t.kind}${t.gate ? ` ${t.gate}` : ""} · ${[t.scene, t.asset, t.variant ? `v${t.variant}` : "", t.expand ? `${t.count} expected` : ""].filter(Boolean).join(" ") || "-"} · ${t.dependsOn.join(", ") || "-"} · $${t.estUsd[0].toFixed(2)}/$${t.estUsd[1].toFixed(2)} · ${t.status} · ${stageOf(t)}`,
      )
      .join("\n"),
    schema: JSON.stringify(z.toJSONSchema(PlanDiffOut, { io: "input" })),
  };
}

/**
 * One `assistant.plan` call (and at most one repair turn) on Pip's model, metered on the project's guard. Never
 * throws for a bad answer: the result says whether to keep the rules plan, and why.
 */
export async function pipRevision(o: {
  gateway: Gateway;
  project: string;
  capUsd: number;
  model: string;
  vars: ReturnType<typeof planPromptVars>;
  tasks: PlanTaskT[];
  ctx: RulesCtx & { refs: { file: string; type: string }[] };
  validate: Omit<ValidateCtx, "by" | "ops" | "before">;
  signal?: AbortSignal;
}): Promise<PipRevisionResult> {
  const c = card("assistant", "plan");
  const out: PipRevisionResult = {
    tasks: null,
    ops: [],
    summary: "",
    valid: "no",
    calls: 0,
    usd: 0,
    sec: 0,
    diff: null,
  };
  const started = Date.now();
  let messages: ChatMessage[] = [{ role: "user", content: fill(c.user, o.vars) }];
  const js = z.toJSONSchema(PlanDiffOut, { io: "input" }) as Record<string, unknown>;
  for (let turn = 0; turn < 2; turn++) {
    let diff: PlanDiffOutT;
    try {
      out.calls++;
      const res = await o.gateway.json({
        project: o.project,
        capUsd: o.capUsd,
        task: "plan-revision",
        taskKind: "assistant.plan",
        role: "assistant",
        promptVersion: c.version,
        system: c.system,
        messages,
        schema: PlanDiffOut,
        jsonSchema: js,
        maxOut: c.maxOut,
        effort: c.effort,
        model: o.model,
        noFallback: true,
        signal: o.signal,
      });
      out.usd += res.result.usd;
      diff = res.data;
      messages = [...messages, { role: "assistant", content: JSON.stringify(diff) }];
    } catch (e: any) {
      out.kept = `Pip's plan call failed (${String(e?.message ?? e).slice(0, 120)})`;
      break;
    }
    out.diff = diff;
    const applied = applyDiff(o.tasks, diff, o.ctx);
    const v = validate(applied.tasks, {
      ...o.validate,
      by: "pip",
      before: o.tasks,
      ops: diff.ops.map((x) => ({ ...x, task: "task" in x ? x.task : undefined })) as any,
    });
    const errors = [...applied.issues, ...v.errors];
    if (!errors.length) {
      out.tasks = applied.tasks;
      out.ops = applied.ops;
      out.summary = diff.summary || (applied.ops.length ? "Pip changed the plan." : "");
      out.valid = turn === 0 ? "first" : "repair";
      out.kept = undefined;
      break;
    }
    out.kept = `${errors[0].message}${errors[0].fix ? ` (${errors[0].fix})` : ""}`;
    messages = [
      ...messages,
      {
        role: "user",
        content: `Your ops have these problems. Fix them, or return {"ops": [], "summary": ""}:\n- ${errors
          .slice(0, 8)
          .map((e) => `${e.code}: ${e.message}${e.fix ? ` Fix: ${e.fix}` : ""}`)
          .join("\n- ")}`,
      },
    ];
  }
  out.sec = (Date.now() - started) / 1000;
  return out;
}
