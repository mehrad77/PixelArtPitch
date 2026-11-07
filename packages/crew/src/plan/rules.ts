// The rules planner (docs/PIP-ORCHESTRATION.md §1.3): today's stage machine written out as a production plan, free and
// deterministic. It is the skeleton every plan starts from, the fallback when Pip's revision fails, and the preview on
// the brief card. Also here: rev 0 for a project that has no plan yet (from what it already has), the expansion after
// the storyboard, and the revisions a run from a stage, a change request, a redo or a re-board make.
import type { ProjectT, RoleT } from "@pap/schema";
import { type RuntimeState, STAGES, type Stage } from "@pap/tools";
import type { AssetKindT, MotionT } from "../outputs.ts";
import { CATALOGUE, idPart, instanceKey, type PlanGateId, type PlanKind, stageOf } from "./catalogue.ts";
import { estimatePlanTask, isLive, type PlanEnv } from "./estimate.ts";
import type { PlanOpT, PlanTaskT } from "./schema.ts";

export type NewAsset = {
  name: string;
  kind: AssetKindT;
  description: string;
  /** a creature's size and motion (its template: size and frames) */
  size?: "16x16" | "16x24";
  motion?: MotionT;
  /** drawings for this asset (1-3); absent: the project's or Settings' count */
  variants?: number;
  fromRef?: string;
  /** a likeness or a brand: private, never published, the person's OK before a scene uses it */
  rights?: "likeness" | "brand";
};
export type RulesCtx = {
  env: PlanEnv;
  rev: number;
  /** asset ids a decl scene's recipes use (params and their defaults); without it every scene waits for all new art */
  assetsOf?: (sceneId: string) => string[];
  /** drawings per new asset (the project's `crew.variants`, else Settings' `defaults.variants`); absent means 2 */
  variants?: number;
};

/** drawings per new asset: the asset's own count, then the plan's (project, then Settings), then 2; always 1-3 */
export const variantsOf = (a: { variants?: number } | undefined, ctx: { variants?: number }) =>
  Math.min(3, Math.max(1, Math.round(a?.variants ?? ctx.variants ?? 2)));
type Spec = Partial<PlanTaskT> & { id: string; kind: PlanKind; dependsOn: string[] };

/** the judge's stand-in when no variant passed (§1.8): a library asset cast in the drawing's place, not the drawing */
export const isStandIn = (ref: { standIn?: boolean }) => !!ref.standIn;
/** the asset is in the project as itself (drawn, imported or cast), not as a stand-in a retry may redraw */
export const hasArt = (doc: Pick<ProjectT, "assets">, name: string) =>
  doc.assets.some((a) => a.id === name && !isStandIn(a));

export const PLACEHOLDER_SCRIPT = /^Placeholder: the Writer replaces this/;

/** a plan task with the catalogue's role, instance and estimate filled in */
export function mkTask(s: Spec, ctx: Pick<RulesCtx, "env" | "rev">): PlanTaskT {
  const role = CATALOGUE[s.kind].role;
  const base = {
    role,
    tier: "role" as const,
    conditional: false,
    status: "pending" as const,
    taskIds: [],
    addedIn: ctx.rev,
    ...s,
  };
  const est = estimatePlanTask(base as PlanTaskT, ctx.env);
  return {
    ...base,
    instance: s.instance ?? instanceKey(base),
    estUsd: s.estUsd ?? est.usd,
    estSec: s.estSec ?? est.sec,
  } as PlanTaskT;
}

/** E[scenes] = clamp(round(lengthSec / 8), 2, 6) */
export const expectedScenes = (lengthSec: number) => Math.min(6, Math.max(2, Math.round(lengthSec / 8)));

/** the asset id a reference becomes: "Founder Photo.jpg" -> "founder-photo" */
export function refAssetName(file: string, taken: Set<string>) {
  const stem = (file.split("/").pop() ?? file).replace(/\.[a-z0-9]+$/i, "");
  let name =
    stem
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 32) || "ref";
  if (!/^[a-z]/.test(name)) name = `ref-${name}`;
  let out = name;
  for (let k = 2; taken.has(out); k++) out = `${name}-${k}`;
  taken.add(out);
  return out;
}

/** the brief's references that become art: logos are imported, likenesses drawn; `unsure` rights block both */
export function refAssets(doc: ProjectT) {
  const taken = new Set(doc.assets.map((a) => a.id));
  const logos: NewAsset[] = [];
  const likeness: NewAsset[] = [];
  const blocked: string[] = [];
  for (const r of doc.brief.references) {
    if (r.type !== "logo" && r.type !== "likeness") continue;
    if (r.rights === "unsure") {
      blocked.push(r.file);
      continue;
    }
    const name = refAssetName(r.file, taken);
    if (r.type === "logo")
      logos.push({
        name,
        kind: "icon",
        description: `The person's logo, imported as is.`,
        fromRef: r.file,
        rights: "brand",
      });
    else
      likeness.push({
        name,
        kind: "character",
        description:
          r.note.length >= 10
            ? r.note.slice(0, 400)
            : "A character drawn from the person's reference: two or three traits, never traced.",
        fromRef: r.file,
        rights: "likeness",
      });
  }
  return { logos, likeness, blocked };
}

/** the subject fields a chain's tasks share */
export function chainSubject(a: NewAsset, n: number, extra: Partial<PlanTaskT> = {}): Partial<PlanTaskT> {
  return {
    asset: a.name,
    assetKind: a.kind,
    description: a.description,
    ...(a.size ? { assetSize: a.size } : {}),
    ...(a.motion ? { motion: a.motion } : {}),
    ...(n !== 2 ? { variants: n } : {}),
    ...(a.fromRef ? { fromRef: a.fromRef } : {}),
    ...extra,
  };
}

/**
 * An asset's chain: spec -> draw v1..vN -> judge (+ rights). With one drawing there is no judge: the draw is the pick,
 * and it writes and casts the asset itself (its critique and repair rounds stay as they are).
 */
function chain(a: NewAsset, after: string[], ctx: RulesCtx, extra: Partial<PlanTaskT> = {}): PlanTaskT[] {
  const k = idPart(a.name);
  const n = variantsOf(a, ctx);
  const subj = chainSubject(a, n, extra);
  const draws = Array.from({ length: n }, (_, i) =>
    mkTask(
      { id: `t_draw_${k}_v${i + 1}`, kind: "asset.draw", variant: i + 1, dependsOn: [`t_spec_${k}`], ...subj },
      ctx,
    ),
  );
  const out = [mkTask({ id: `t_spec_${k}`, kind: "asset.spec", dependsOn: after, ...subj }, ctx), ...draws];
  if (n > 1)
    out.push(mkTask({ id: `t_judge_${k}`, kind: "asset.judge", dependsOn: draws.map((d) => d.id), ...subj }, ctx));
  if (a.rights)
    out.push(
      mkTask(
        { id: `t_rights_${k}`, kind: "gate", gate: "rights", asset: a.name, dependsOn: [out.at(-1)!.id], ...extra },
        ctx,
      ),
    );
  return out;
}
function importChain(a: NewAsset, after: string[], ctx: RulesCtx): PlanTaskT[] {
  const k = idPart(a.name);
  return [
    mkTask(
      {
        id: `t_import_${k}`,
        kind: "asset.import",
        asset: a.name,
        assetKind: "icon",
        fromRef: a.fromRef,
        dependsOn: after,
      },
      ctx,
    ),
    mkTask({ id: `t_rights_${k}`, kind: "gate", gate: "rights", asset: a.name, dependsOn: [`t_import_${k}`] }, ctx),
  ];
}
/** the task a scene using this asset waits for: its rights OK, or its judge */
function lastOf(tasks: PlanTaskT[], asset: string) {
  const mine = tasks.filter((t) => t.asset === asset && isLiveOrDone(t));
  return (
    mine.find((t) => t.kind === "gate" && t.gate === "rights") ??
    mine.find((t) => t.kind === "asset.judge") ??
    mine.find((t) => t.kind === "asset.import") ??
    // one drawing: no judge, the draw is the pick
    mine.find((t) => t.kind === "asset.draw")
  )?.id;
}
const isLiveOrDone = (t: PlanTaskT) => isLive(t) || t.status === "done";

export type Expanded = { scenes: string[]; newAssets: NewAsset[] };

/**
 * The rules plan for a document. Before the storyboard the scenes and new art are placeholders (per_scene,
 * per_new_asset); `expanded` gives them (rev 0 of a boarded project, and tests).
 */
export function rulesPlan(doc: ProjectT, ctx: RulesCtx, expanded?: Expanded): PlanTaskT[] {
  const T: PlanTaskT[] = [];
  const add = (...ts: PlanTaskT[]) => T.push(...ts);
  const gate = (g: PlanGateId, id: string, deps: string[], extra: Partial<PlanTaskT> = {}) =>
    mkTask({ id, kind: "gate", gate: g, dependsOn: deps, ...extra }, ctx);
  const fromPip = (doc.brief as { source?: string }).source === "pip";
  if (!fromPip) add(mkTask({ id: "t_producer", kind: "producer.plan", dependsOn: [] }, ctx));
  add(
    gate("g0_brief", "t_g0", fromPip ? [] : ["t_producer"], fromPip ? { status: "done", note: "passed by Start" } : {}),
  );
  add(mkTask({ id: "t_angles", kind: "writer.angles", dependsOn: ["t_g0"] }, ctx));
  const refs = refAssets(doc);
  for (const a of refs.logos) add(...importChain(a, ["t_g0"], ctx));
  add(gate("g1_script", "t_g1", ["t_angles"]));
  add(
    mkTask(
      {
        id: "t_storyboard",
        kind: "director.storyboard",
        dependsOn: ["t_g1", ...refs.logos.map((a) => `t_import_${idPart(a.name)}`)],
      },
      ctx,
    ),
  );
  add(mkTask({ id: "t_cast", kind: "art.cast", dependsOn: ["t_storyboard"] }, ctx));
  add(gate("g2_animatic", "t_g2", ["t_cast"]));
  for (const a of refs.likeness) add(...chain(a, ["t_g2"], ctx));
  const assetNames = [...refs.logos, ...refs.likeness].map((a) => a.name);
  let tunes: string[];
  if (!expanded) {
    // the hero baselineBoard assumes, unless the references are the new art
    const nNew = refs.likeness.length ? 0 : 1;
    const nv = variantsOf(undefined, ctx);
    if (nNew) {
      add(
        mkTask(
          { id: "t_spec_new", kind: "asset.spec", expand: "per_new_asset", count: nNew, dependsOn: ["t_g2"] },
          ctx,
        ),
      );
      add(
        mkTask(
          {
            id: "t_draw_new",
            kind: "asset.draw",
            expand: "per_new_asset",
            count: nv * nNew,
            dependsOn: ["t_spec_new"],
          },
          ctx,
        ),
      );
      if (nv > 1)
        add(
          mkTask(
            { id: "t_judge_new", kind: "asset.judge", expand: "per_new_asset", count: nNew, dependsOn: ["t_draw_new"] },
            ctx,
          ),
        );
    }
    const waits = [
      "t_g2",
      ...(nNew ? [nv > 1 ? "t_judge_new" : "t_draw_new"] : []),
      ...assetNames.map((n) => lastOf(T, n)).filter((x): x is string => !!x),
    ];
    add(
      mkTask(
        {
          id: "t_tune_scenes",
          kind: "scene.tune",
          expand: "per_scene",
          count: expectedScenes(doc.brief.lengthSec),
          round: 1,
          dependsOn: waits,
        },
        ctx,
      ),
    );
    tunes = ["t_tune_scenes"];
  } else {
    for (const a of expanded.newAssets) if (!assetNames.includes(a.name)) add(...chain(a, ["t_g2"], ctx));
    const fresh = [...assetNames, ...expanded.newAssets.map((a) => a.name)];
    tunes = expanded.scenes.map((s) => {
      const uses = ctx.assetsOf ? ctx.assetsOf(s).filter((n) => fresh.includes(n)) : fresh;
      const deps = ["t_g2", ...uses.map((n) => lastOf(T, n)).filter((x): x is string => !!x)];
      add(
        mkTask(
          { id: `t_tune_${idPart(s)}_r1`, kind: "scene.tune", scene: s, round: 1, dependsOn: [...new Set(deps)] },
          ctx,
        ),
      );
      return `t_tune_${idPart(s)}_r1`;
    });
  }
  const voice = doc.brief.narration === "user";
  if (voice) add(mkTask({ id: "t_vo", kind: "vo.align", dependsOn: tunes }, ctx));
  add(mkTask({ id: "t_mix", kind: "sound.mix", dependsOn: [...tunes, ...(voice ? ["t_vo"] : [])] }, ctx));
  add(mkTask({ id: "t_review_r1", kind: "review.final", round: 1, dependsOn: ["t_mix"] }, ctx));
  add(gate("g3_rough", "t_g3", ["t_review_r1"]));
  add(mkTask({ id: "t_export", kind: "deliver.export", dependsOn: ["t_g3"] }, ctx));
  add(gate("g4_final", "t_g4", ["t_export"]));
  if (!expanded) {
    if (T.some((t) => t.id === "t_spec_new"))
      add(
        mkTask(
          {
            id: "t_publish_new",
            kind: "lib.publish",
            expand: "per_new_asset",
            count: 1,
            conditional: true,
            dependsOn: ["t_g4"],
          },
          ctx,
        ),
      );
  } else
    for (const a of expanded.newAssets)
      if (!a.fromRef && !a.rights)
        add(
          mkTask(
            {
              id: `t_publish_${idPart(a.name)}`,
              kind: "lib.publish",
              asset: a.name,
              conditional: true,
              dependsOn: ["t_g4"],
            },
            ctx,
          ),
        );
  return T;
}

const ROW_KINDS: PlanKind[] = [
  "producer.plan",
  "writer.angles",
  "director.storyboard",
  "sound.mix",
  "review.final",
  "deliver.export",
  "vo.align",
];

/**
 * Rev 0 for a project with no runs/plan.json (every project made before the plan, a crew that was running at the
 * upgrade, a copy of examples/questday): the rules plan with what the project already has marked done.
 */
export function startPlan(
  doc: ProjectT,
  state: Pick<RuntimeState, "tasks" | "gates" | "sceneStatus">,
  ctx: RulesCtx,
  pendingNew: NewAsset[] = [],
): PlanTaskT[] {
  const rows = state.tasks.filter((t) => t.status === "done" && !t.supersededBy);
  const placeholderScript = doc.script.cues.length === 1 && PLACEHOLDER_SCRIPT.test(doc.script.cues[0].text);
  const decl = doc.scenes.filter((s) => s.kind === "decl");
  const boarded =
    !placeholderScript &&
    (rows.some((t) => t.kind === "director.storyboard") || (!rows.length && decl.some((s) => s.recipes.length > 0)));
  const drawn: NewAsset[] = doc.assets
    .filter((a) => a.src.startsWith("file:"))
    .map((a) => ({
      name: a.id,
      kind: "character",
      description: "already in the project",
      ...(a.flags.likeness ? { rights: "likeness" as const } : a.flags.brand ? { rights: "brand" as const } : {}),
    }));
  const tasks = rulesPlan(
    doc,
    ctx,
    boarded
      ? {
          scenes: decl.map((s) => s.id),
          newAssets: [...drawn, ...pendingNew.filter((a) => !drawn.some((d) => d.name === a.name))],
        }
      : undefined,
  );
  const done = (t: PlanTaskT, note?: string, ids: string[] = []) => {
    t.status = "done";
    if (note) t.note = note;
    t.taskIds = ids;
  };
  for (const kind of ROW_KINDS) {
    const r = rows.filter((x) => x.kind === kind);
    const t = tasks.find((x) => x.kind === kind && !x.expand);
    if (r.length && t)
      done(
        t,
        undefined,
        r.map((x) => x.id),
      );
  }
  const gateOf: Record<string, string> = {
    g0_brief: "t_g0",
    g1_script: "t_g1",
    g2_animatic: "t_g2",
    g3_rough: "t_g3",
    g4_final: "t_g4",
  };
  for (const g of state.gates)
    if (g.status === "passed") {
      const t = tasks.find((x) => x.id === gateOf[g.id]);
      if (t) done(t);
    }
  if (boarded && !rows.length) {
    for (const t of tasks)
      if (["producer.plan", "writer.angles", "director.storyboard", "art.cast"].includes(t.kind)) {
        t.status = "skipped";
        t.note = "already in the project";
      } else if (t.kind === "gate" && ["g0_brief", "g1_script", "g2_animatic"].includes(t.gate!)) done(t);
  }
  if (tasks.find((t) => t.kind === "director.storyboard")?.status === "done")
    for (const t of tasks) if (t.kind === "art.cast") done(t);
  for (const t of tasks) {
    if (t.kind === "scene.tune" && t.scene) {
      const s = state.sceneStatus[t.scene];
      if (s?.version === "render" && s.state === "ready") done(t);
    }
    if (t.asset && hasArt(doc, t.asset) && t.kind !== "lib.publish")
      if (t.kind !== "gate" || t.status !== "done") done(t, "already in the project");
    if (t.kind === "lib.publish" && tasks.find((x) => x.id === "t_g4")?.status === "done")
      done(t, "asked at the last export");
    else if (t.kind === "lib.publish" && doc.assets.some((a) => a.id === t.asset && a.publish))
      done(t, "already answered");
  }
  return tasks;
}

// ---------------------------------------------------------------- revisions

/** what makes two tasks the same job (V13 ignores the round: one live task per job) */
export const jobKey = (t: PlanTaskT) =>
  [t.kind, t.gate ?? "", t.scene ?? "", t.asset ?? "", t.variant ?? "", (t.scenes ?? []).join(",")].join("|");

/**
 * A fresh id for a copy made in revision `rev`: the base without its earlier revision suffix, then `_v<rev>`. A
 * variant's own suffix stays (`t_draw_owl_v1` at rev 4 is `t_draw_owl_v1_v4`, never `t_draw_owl_v4_2`).
 */
export function freshId(base: string, rev: number, taken: Set<string>, variant?: number) {
  const own = variant !== undefined ? `_v${variant}` : "";
  const root =
    own && base.includes(`${own}_v`)
      ? base.slice(0, base.lastIndexOf(`${own}_v`) + own.length)
      : own && base.endsWith(own)
        ? base
        : base.replace(/_v\d+(_\d+)?$/, "");
  let id = taken.has(root) ? `${root}_v${rev}` : root;
  for (let k = 2; taken.has(id); k++) id = `${root}_v${rev}_${k}`;
  taken.add(id);
  return id;
}

/**
 * Fresh copies of finished tasks for a rerun (nothing is ever deleted: the originals stay done). Copies depend on each
 * other's copies; any live task that waited on an original waits on its copy too.
 */
export function rerun(
  tasks: PlanTaskT[],
  ids: string[],
  rev: number,
  o: { reason: string; round?: (t: PlanTaskT) => number | undefined },
): { tasks: PlanTaskT[]; map: Map<string, string>; ops: PlanOpT[] } {
  const taken = new Set(tasks.map((t) => t.id));
  const map = new Map<string, string>();
  for (const id of ids) map.set(id, freshId(id, rev, taken, tasks.find((t) => t.id === id)?.variant));
  const copies: PlanTaskT[] = [];
  for (const id of ids) {
    const t = tasks.find((x) => x.id === id)!;
    const round = o.round ? o.round(t) : t.round;
    // a copy is a fresh start: "Finish within" trims stay with the run that made them
    const { critiques: _c, lastRound: _l, ...base } = t;
    copies.push({
      ...base,
      id: map.get(id)!,
      status: "pending",
      taskIds: [],
      addedIn: rev,
      reason: o.reason,
      note: undefined,
      ...(round !== undefined ? { round } : {}),
      dependsOn: t.dependsOn.map((d) => map.get(d) ?? d),
    });
  }
  const out = tasks.map((t) =>
    isLive(t) && t.dependsOn.some((d) => map.has(d))
      ? {
          ...t,
          dependsOn: [...new Set([...t.dependsOn, ...t.dependsOn.flatMap((d) => (map.has(d) ? [map.get(d)!] : []))])],
        }
      : t,
  );
  out.push(...copies);
  return {
    tasks: out,
    map,
    ops: copies.map((c) => ({ op: "add" as const, task: c.id, reason: o.reason })),
  };
}

const stageIdx = (s: Stage) => STAGES.indexOf(s);
const sceneReady = (st: RuntimeState["sceneStatus"], s?: string) =>
  !!s && st[s]?.version === "render" && st[s]?.state === "ready";

/**
 * A run from a stage (`crew_run {stage}`, a resume, a change): what comes before the stage and is unfinished is
 * skipped, finished work from the stage on runs again as fresh copies (a scene already rendered keeps its tune), and
 * failed tasks go back to pending. `keep` names finished work that stays as it is (the caller builds it from the
 * project: art already drawn, a publish already answered); `exclude` also keeps a failed task failed.
 */
export function reopenFrom(
  tasks: PlanTaskT[],
  from: Stage,
  rev: number,
  o: {
    sceneStatus: RuntimeState["sceneStatus"];
    exclude?: (t: PlanTaskT) => boolean;
    keep?: (t: PlanTaskT) => boolean;
    reason?: string;
  },
) {
  const at = stageIdx(from);
  const reason = o.reason ?? `the crew runs again from the ${from} stage`;
  let ts = tasks.map((t) => {
    if (stageIdx(stageOf(t)) < at && (isLive(t) || t.status === "failed"))
      return { ...t, status: "skipped" as const, note: `the run starts at ${from}` };
    if (stageIdx(stageOf(t)) >= at && t.status === "failed" && !o.exclude?.(t))
      return { ...t, status: "pending" as const, note: undefined };
    return t;
  });
  const live = new Set(ts.filter(isLive).map(jobKey));
  const ids = ts
    .filter(
      (t) =>
        stageIdx(stageOf(t)) >= at &&
        (t.status === "done" || (t.status === "skipped" && !t.expand)) &&
        !o.exclude?.(t) &&
        !o.keep?.(t) &&
        !(t.kind === "scene.tune" && sceneReady(o.sceneStatus, t.scene)) &&
        !live.has(jobKey(t)),
    )
    // one copy per job: the latest
    .filter((t, i, all) => all.findLastIndex((x) => jobKey(x) === jobKey(t)) === i)
    .map((t) => t.id);
  const r = rerun(ts, ids, rev, { reason, round: (t) => (t.round ? 1 : undefined) });
  ts = r.tasks;
  return { tasks: ts, ops: r.ops, map: r.map };
}

/** the latest task of a job */
const latest = (tasks: PlanTaskT[], f: (t: PlanTaskT) => boolean) => tasks.filter(f).at(-1);

/** what `ids` wait on, directly or not */
function upstream(tasks: PlanTaskT[], ids: string[]) {
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const seen = new Set<string>();
  const stack = [...ids];
  while (stack.length) {
    const id = stack.pop()!;
    for (const d of byId.get(id)?.dependsOn ?? [])
      if (!seen.has(d)) {
        seen.add(d);
        stack.push(d);
      }
  }
  return seen;
}
/** make every live task that waits on `from` also wait on `extra` (never one `extra` itself waits on: no cycles) */
function waitAlsoOn(tasks: PlanTaskT[], from: string[], extra: string[]) {
  const set = new Set(from);
  const before = upstream(tasks, extra);
  return tasks.map((t) =>
    isLive(t) && t.dependsOn.some((d) => set.has(d)) && !extra.includes(t.id) && !before.has(t.id)
      ? { ...t, dependsOn: [...new Set([...t.dependsOn, ...extra])] }
      : t,
  );
}

/**
 * A redo (the conductor's crew_redo, a review's blockers, a blocked report): scene.tune(s, round + 1) on the same
 * instance, after `after` (the task that found the problem). Whatever waited on the scene's last tune waits on the redo.
 */
export function addRedo(
  tasks: PlanTaskT[],
  scenes: string[],
  ctx: RulesCtx,
  o: { after?: string[]; reason: string },
): { tasks: PlanTaskT[]; added: string[]; ops: PlanOpT[] } {
  let ts = tasks;
  const taken = new Set(ts.map((t) => t.id));
  const added: string[] = [];
  for (const s of scenes) {
    const prev = latest(ts, (t) => t.kind === "scene.tune" && t.scene === s && t.status !== "dropped");
    const round = Math.min(3, (prev?.round ?? 1) + 1);
    const id = freshId(`t_tune_${idPart(s)}_r${round}`, ctx.rev, taken);
    ts = [...ts, mkTask({ id, kind: "scene.tune", scene: s, round, dependsOn: o.after ?? [], reason: o.reason }, ctx)];
    if (prev) ts = waitAlsoOn(ts, [prev.id], [id]);
    added.push(id);
  }
  return { tasks: ts, added, ops: added.map((task) => ({ op: "add" as const, task, reason: o.reason })) };
}

/** review round + 1 after the redone scenes; the rough cut waits for it */
export function addReviewRound(tasks: PlanTaskT[], prevReview: string, after: string[], ctx: RulesCtx, reason: string) {
  const prev = tasks.find((t) => t.id === prevReview)!;
  const round = Math.min(3, (prev.round ?? 1) + 1);
  const taken = new Set(tasks.map((t) => t.id));
  const id = freshId(`t_review_r${round}`, ctx.rev, taken);
  let ts = [...tasks, mkTask({ id, kind: "review.final", round, dependsOn: after, reason }, ctx)];
  ts = waitAlsoOn(ts, [prevReview], [id]);
  return { tasks: ts, id, ops: [{ op: "add" as const, task: id, reason }] };
}

/**
 * A re-board (a person's story change, the conductor's crew_reboard): the Director re-plans these scenes, the Art
 * Director casts for them, then each is tuned again. Live work at the art stage or later waits for the cast.
 */
export function addReboard(
  tasks: PlanTaskT[],
  scenes: string[],
  ctx: RulesCtx,
  o: { after?: string[]; reason: string },
) {
  const taken = new Set(tasks.map((t) => t.id));
  const sb = freshId("t_reboard", ctx.rev, taken);
  const cast = freshId("t_cast_scenes", ctx.rev, taken);
  let ts: PlanTaskT[] = [
    ...tasks,
    mkTask({ id: sb, kind: "director.storyboard", scenes, dependsOn: o.after ?? [], reason: o.reason }, ctx),
    mkTask({ id: cast, kind: "art.cast", scenes, dependsOn: [sb], reason: o.reason }, ctx),
  ];
  ts = ts.map((t) =>
    isLive(t) && t.id !== sb && t.id !== cast && stageIdx(stageOf(t)) >= stageIdx("art")
      ? { ...t, dependsOn: [...new Set([...t.dependsOn, cast])] }
      : t,
  );
  // a scene the change touches is tuned again after the cast, unless a live tune is already planned
  const live = new Set(ts.filter((t) => isLive(t) && t.kind === "scene.tune").map((t) => t.scene));
  const r = addRedo(
    ts,
    scenes.filter((s) => !live.has(s)),
    ctx,
    { after: [cast], reason: o.reason },
  );
  return {
    tasks: r.tasks,
    ops: [
      { op: "add" as const, task: sb, reason: o.reason },
      { op: "add" as const, task: cast, reason: o.reason },
      ...r.ops,
    ],
  };
}

/**
 * A person's change on an idle crew (after reopen()): the rules tasks from its stage on, the re-board in place of the
 * full storyboard when the Director re-plans, then the review, the rough cut, the export and the final. Only what the
 * change touches comes back: a tune outside `change.scope` stays done, and so does whatever `keep` says the project
 * already has (art drawn, a publish answered; the orchestrator's `keepOf`).
 */
export function changeRevision(
  tasks: PlanTaskT[],
  change: { reboard?: string[]; scope?: string[] },
  from: Stage,
  ctx: RulesCtx,
  sceneStatus: RuntimeState["sceneStatus"],
  keep?: (t: PlanTaskT) => boolean,
) {
  const reboard = change.reboard?.length ? change.reboard : null;
  const exclude = reboard
    ? (t: PlanTaskT) =>
        (t.kind === "director.storyboard" && !t.scenes) ||
        (t.kind === "art.cast" && !t.scenes) ||
        (t.kind === "gate" && t.gate === "g2_animatic")
    : undefined;
  const scope = change.scope ? new Set(change.scope) : null;
  const keeps = (t: PlanTaskT) =>
    !!keep?.(t) || (!!scope && t.kind === "scene.tune" && !!t.scene && !scope.has(t.scene));
  const r = reopenFrom(tasks, from, ctx.rev, { sceneStatus, exclude, keep: keeps, reason: "your change" });
  if (!reboard) return { tasks: r.tasks, ops: r.ops };
  const b = addReboard(r.tasks, reboard, ctx, { reason: "your change" });
  return { tasks: b.tasks, ops: [...r.ops, ...b.ops] };
}

/**
 * After a full storyboard: the scene and new-art placeholders become one scene.tune per decl scene and one chain per
 * new asset; tunes of scenes the board no longer has are dropped. Each tune waits only for the new art it uses.
 */
export function expandPlan(
  tasks: PlanTaskT[],
  doc: ProjectT,
  newAssets: NewAsset[],
  ctx: RulesCtx,
): { tasks: PlanTaskT[]; ops: PlanOpT[]; reason: string } | null {
  let ts = tasks.map((t) => ({ ...t }));
  const ops: PlanOpT[] = [];
  const decl = doc.scenes.filter((s) => s.kind === "decl").map((s) => s.id);
  const g2 = latest(ts, (t) => t.kind === "gate" && t.gate === "g2_animatic" && t.status !== "dropped")?.id ?? "t_g2";
  const taken = new Set(ts.map((t) => t.id));
  // new art: one chain per asset the board lists that has no chain yet
  const chained = new Set(ts.filter((t) => t.asset && (isLive(t) || t.status === "done")).map((t) => t.asset));
  const fresh = newAssets.filter((a) => !chained.has(a.name) && !doc.assets.some((x) => x.id === a.name));
  const chainIds: string[] = [];
  for (const a of fresh) {
    const c = chain(a, [g2], ctx).map((t) => {
      const id = taken.has(t.id) ? freshId(t.id, ctx.rev, taken, t.variant) : t.id;
      taken.add(id);
      return { ...t, id };
    });
    // the chain's own ids may have moved: point its deps at the renamed tasks
    const rename = new Map(chain(a, [g2], ctx).map((t, i) => [t.id, c[i].id]));
    for (const t of c) t.dependsOn = t.dependsOn.map((d) => rename.get(d) ?? d);
    ts.push(...c);
    chainIds.push(...c.map((t) => t.id));
  }
  const placeholders = ts.filter((t) => t.expand && isLive(t));
  for (const ph of placeholders.filter((t) => t.expand === "per_new_asset")) {
    ph.status = "skipped";
    ph.note = "expanded";
    const into =
      ph.kind === "lib.publish" ? [] : chainIds.filter((id) => ts.find((t) => t.id === id)?.kind === ph.kind);
    ops.push({ op: "expand", placeholder: ph.id, into, reason: "the storyboard is done" });
  }
  // new art no placeholder stood for (a later board, a re-run) is an add
  const covered = new Set(ops.flatMap((o) => (o.op === "expand" ? o.into : [])));
  for (const id of chainIds) if (!covered.has(id)) ops.push({ op: "add", task: id, reason: "the storyboard needs it" });
  // a publish question for each new public asset
  for (const a of fresh.filter((x) => !x.fromRef && !x.rights)) {
    const id = freshId(`t_publish_${idPart(a.name)}`, ctx.rev, taken);
    const g4 = latest(ts, (t) => t.kind === "gate" && t.gate === "g4_final" && isLive(t))?.id ?? "t_g4";
    ts.push(mkTask({ id, kind: "lib.publish", asset: a.name, conditional: true, dependsOn: [g4] }, ctx));
    const ph = ops.find((o) => o.op === "expand" && o.placeholder === "t_publish_new");
    if (ph && ph.op === "expand") ph.into.push(id);
  }
  const newNames = new Set([
    ...fresh.map((a) => a.name),
    ...ts
      .filter((t) => t.asset && isLive(t) && (t.kind === "asset.spec" || t.kind === "asset.import"))
      .map((t) => t.asset!),
  ]);
  const waitsFor = (s: string) => {
    const uses = ctx.assetsOf ? ctx.assetsOf(s).filter((n) => newNames.has(n)) : [...newNames];
    return uses.map((n) => lastOf(ts, n)).filter((x): x is string => !!x);
  };
  // scenes: one live tune per decl scene
  const tunePh = placeholders.find((t) => t.expand === "per_scene");
  const tuneIds: string[] = [];
  const dropped: string[] = [];
  for (const t of ts)
    if (
      t.kind === "scene.tune" &&
      !t.expand &&
      isLive(t) &&
      t.status === "pending" &&
      t.scene &&
      !decl.includes(t.scene)
    ) {
      t.status = "dropped";
      t.note = "no longer in the storyboard";
      dropped.push(t.id);
      ops.push({ op: "drop", task: t.id, reason: "the storyboard no longer has this scene" });
    }
  for (const s of decl) {
    const have = ts.find((t) => t.kind === "scene.tune" && t.scene === s && isLive(t));
    if (have) {
      have.dependsOn = [...new Set([...have.dependsOn, ...waitsFor(s)])];
      tuneIds.push(have.id);
      continue;
    }
    const id = freshId(`t_tune_${idPart(s)}_r1`, ctx.rev, taken);
    ts.push(mkTask({ id, kind: "scene.tune", scene: s, round: 1, dependsOn: [...new Set([g2, ...waitsFor(s)])] }, ctx));
    tuneIds.push(id);
  }
  if (tunePh) {
    tunePh.status = "skipped";
    tunePh.note = "expanded";
    ops.push({
      op: "expand",
      placeholder: tunePh.id,
      into: tuneIds.filter((id) => !tasks.some((t) => t.id === id)),
      reason: "the storyboard is done",
    });
  }
  // whatever waited on the placeholders or a dropped tune waits on the real tasks
  const gone = new Set([...placeholders.map((t) => t.id), ...dropped]);
  ts = ts.map((t) => {
    if (!isLive(t) || !t.dependsOn.some((d) => gone.has(d))) return t;
    const tune = t.dependsOn.some((d) => d === tunePh?.id || dropped.includes(d));
    const deps = t.dependsOn.filter((d) => !gone.has(d));
    return { ...t, dependsOn: [...new Set([...deps, ...(tune ? tuneIds : [])])] };
  });
  if (!ops.length && !fresh.length) return null;
  const n = decl.length;
  const art = fresh.length
    ? `The library had no ${fresh.map((a) => a.name).join(" or ")} sprite, so I added ${fresh.length === 1 ? "one drawing" : `${fresh.length} drawings`}.`
    : "The library had all the art it needs.";
  return { tasks: ts, ops, reason: `The storyboard has ${n} scene${n === 1 ? "" : "s"}. ${art}` };
}

/** the roles a plan's live tasks need, for the brief card's preview */
export const liveRoles = (tasks: PlanTaskT[]) => [
  ...new Set(tasks.filter((t) => isLive(t) && t.role !== "person").map((t) => t.role as RoleT)),
];

// ---------------------------------------------------------------- finish within the budget (§1.6)

/** the live tasks that will really run: none the project already satisfies (art it has, a publish met, a scene done) */
export function realRemaining(tasks: PlanTaskT[], satisfied: (t: PlanTaskT) => boolean = () => false) {
  return tasks.filter((t) => isLive(t) && !satisfied(t));
}
/** what the rest may cost at the top of its range: p50 + sqrt(Σ(p90 − p50)²), as planEstimate sums it */
export function restP90(tasks: PlanTaskT[]) {
  let p50 = 0;
  let spread = 0;
  for (const t of tasks) {
    p50 += t.estUsd[0];
    spread += (t.estUsd[1] - t.estUsd[0]) ** 2;
  }
  return p50 + Math.sqrt(spread);
}
/** the cap that finishes the rest: spent + the real remaining work's p90, rounded up to $0.50 */
export const suggestCap = (spentUsd: number, rest: PlanTaskT[]) => Math.ceil((spentUsd + restP90(rest)) * 2 - 1e-9) / 2;

export type TrimT = { task: string; what: "variant" | "critique" | "review_round" | "publish"; asset?: string };
/** a trim in the person's words, for the card: "the second drawing of the moth" */
export function trimWords(t: TrimT, tasks: PlanTaskT[]) {
  const x = tasks.find((y) => y.id === t.task);
  const nth = ["first", "second", "third"][(x?.variant ?? 2) - 1] ?? "extra";
  switch (t.what) {
    case "variant":
      return `the ${nth} drawing of ${t.asset ?? "the asset"}`;
    case "critique":
      return `the critique round on ${t.asset ?? "a drawing"}${x?.variant ? ` (drawing ${x.variant})` : ""}`;
    case "review_round":
      return "the second review round";
    case "publish":
      return `the library question for ${t.asset ?? "the new art"}`;
  }
}

/**
 * "Finish within $X": a rules-made trim of droppable work, in a fixed order, until the real remaining work's p90 fits
 * what is left of the cap: second (and third) drawings first, then critique rounds, then the second review round,
 * then the library questions. Only pending or ready work is trimmed (a running draw finishes), a judge left with one
 * drawing makes no call (its estimate goes to $0), and nothing the project already satisfies counts. Pure.
 */
export function finishWithin(
  tasks: PlanTaskT[],
  o: {
    /** cap − spent */
    leftUsd: number;
    satisfied?: (t: PlanTaskT) => boolean;
    ctx: Pick<RulesCtx, "env" | "rev">;
    /** review rounds the run would make (settings): the second one can go only when there is one */
    reviewRounds?: number;
    /** trim only these tasks (the card's list, applied as shown) */
    only?: Set<string>;
  },
): { tasks: PlanTaskT[]; ops: PlanOpT[]; trims: TrimT[]; fits: boolean; restUsd: number } {
  const ts = tasks.map((t) => ({ ...t }));
  const ops: PlanOpT[] = [];
  const trims: TrimT[] = [];
  const sat = o.satisfied ?? (() => false);
  const rest = () => restP90(realRemaining(ts, sat));
  const fits = () => rest() <= o.leftUsd + 1e-9;
  const open = (t: PlanTaskT) =>
    (t.status === "pending" || t.status === "ready") && !sat(t) && (!o.only || o.only.has(t.id));
  const reason = "to finish within the budget";
  const drop = (t: PlanTaskT, what: TrimT["what"]) => {
    t.status = "dropped";
    t.note = "trimmed to finish within the budget";
    ops.push({ op: "drop", task: t.id, reason });
    trims.push({ task: t.id, what, ...(t.asset ? { asset: t.asset } : {}) });
  };
  // 1. second and third drawings (the highest first), while the asset keeps one
  const extra = ts
    .filter((t) => t.kind === "asset.draw" && !t.expand && (t.variant ?? 1) >= 2 && open(t))
    .sort((a, b) => (b.variant ?? 1) - (a.variant ?? 1));
  for (const t of extra) {
    if (fits()) break;
    drop(t, "variant");
    // a judge with one drawing left only casts it: no model call
    for (const j of ts)
      if (j.kind === "asset.judge" && isLive(j) && j.dependsOn.includes(t.id)) {
        const left = j.dependsOn.filter((d) => {
          const x = ts.find((y) => y.id === d);
          return x?.kind === "asset.draw" && x.status !== "dropped";
        });
        if (left.length <= 1) j.estUsd = [0, 0];
      }
  }
  // 2. critique rounds
  for (const t of ts.filter((x) => x.kind === "asset.draw" && !x.expand && open(x) && x.critiques !== 0)) {
    if (fits()) break;
    t.critiques = 0;
    const e = estimatePlanTask(t, o.ctx.env);
    t.estUsd = e.usd;
    t.estSec = e.sec;
    ops.push({ op: "trim", task: t.id, what: "critique", reason });
    trims.push({ task: t.id, what: "critique", ...(t.asset ? { asset: t.asset } : {}) });
  }
  // 3. the second review round: a planned one is dropped; else the live first round is the last
  if (!fits() && (o.reviewRounds ?? 2) >= 2) {
    const second = ts.filter((t) => t.kind === "review.final" && (t.round ?? 1) >= 2 && open(t));
    for (const t of second) drop(t, "review_round");
    const first = ts.find(
      (t) =>
        t.kind === "review.final" && isLive(t) && (t.round ?? 1) === 1 && !t.lastRound && (!o.only || o.only.has(t.id)),
    );
    if (!second.length && first) {
      first.lastRound = true;
      ops.push({ op: "trim", task: first.id, what: "review_round", reason });
      trims.push({ task: first.id, what: "review_round" });
    }
  }
  // 4. the library questions
  if (!fits()) for (const t of ts.filter((x) => x.kind === "lib.publish" && !x.expand && open(x))) drop(t, "publish");
  return { tasks: ts, ops, trims, fits: fits(), restUsd: Math.round(rest() * 10000) / 10000 };
}
