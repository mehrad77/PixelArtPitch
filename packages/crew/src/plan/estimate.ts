// Tiers and estimates for plan tasks (docs/PIP-ORCHESTRATION.md §1.1 "Estimates", §1.2 "The tier resolves to a model").
// A task's cost is the catalogue's priced kinds × calls on the model its tier resolves to; tool-only kinds cost $0 and
// never fall back to the generic prior. The plan's time is a makespan over its dependencies and the endpoint lanes.
import type { RoleT } from "@pap/schema";
import { estimateTask as estimateCall } from "../llm/estimator.ts";
import type { Ledger } from "../llm/ledger.ts";
import { priorFor } from "../llm/ledger.ts";
import { priceFor } from "../llm/prices.ts";
import type { Caps } from "../llm/types.ts";
import { KIND_TEMPLATES } from "../outputs.ts";
import { CATALOGUE, type PlanKind } from "./catalogue.ts";
import type { PlanEstimateT, PlanTaskT, TierT } from "./schema.ts";

/** what planning needs from the model layer (the Gateway gives it; tests give a table) */
export type PlanEnv = {
  modelFor(role: RoleT): string;
  fallbackFor(role: RoleT): string | undefined;
  caps(model: string): Caps | null;
  /** concurrent calls per endpoint (Gateway lanes: local 1, else defaults.concurrency) */
  laneSize(providerId: string): number;
  /** a local endpoint: every tier is `role`, every call $0 */
  local(model: string): boolean;
  ledger?: Ledger;
};

/** the plan's view of a gateway, with a project's own model choices */
export function envOf(
  gw: Pick<import("../gateway.ts").Gateway, "modelFor" | "fallbackFor" | "caps" | "laneSize" | "isLocal" | "ledgerRef">,
  models: Record<string, string> = {},
): PlanEnv {
  return {
    modelFor: (role) => gw.modelFor(role, models),
    fallbackFor: (role) => gw.fallbackFor(role),
    caps: (m) => gw.caps(m),
    laneSize: (ep) => gw.laneSize?.(ep) ?? 4,
    local: (m) => gw.caps(m)?.local ?? gw.isLocal?.(m) ?? /^(lmstudio|ollama|llamacpp)\//.test(m),
    ledger: gw.ledgerRef?.(),
  };
}

const providerOf = (model: string) => (model.includes("/") ? model.slice(0, model.indexOf("/")) : model);
const out = (model: string) => priceFor(model)?.outPerMTok ?? 0;

/** strong = the role's fallback when it costs more; light = one step down Opus → Sonnet → Haiku on the same provider */
export function resolveTier(role: RoleT, tier: TierT, env: PlanEnv): string {
  const model = env.modelFor(role);
  if (tier === "role" || env.local(model)) return model;
  if (tier === "strong") {
    const fb = env.fallbackFor(role);
    return fb && out(fb) > out(model) ? fb : model;
  }
  const down = model.includes("opus")
    ? model.replace("opus", "sonnet")
    : model.includes("sonnet")
      ? model.replace("sonnet", "haiku")
      : null;
  return down && priceFor(down) && providerOf(down) === providerOf(model) ? down : model;
}

export type TaskEst = { usd: [number, number]; sec: [number, number]; rough: boolean };

/** a sprite task's size for the priors' `sizeFactor`: its kind template's cells (w × h × frames), else none */
export function sizeParams(t: { kind: string; assetKind?: string }) {
  if (!t.kind.startsWith("asset.") || t.kind === "asset.import") return undefined;
  const tpl = KIND_TEMPLATES[t.assetKind ?? "character"];
  return tpl ? { w: tpl.w, h: tpl.h, frames: tpl.frames.length } : undefined;
}

/**
 * one task's estimate on its resolved model; a placeholder counts `count` runs, a conditional one $0 at p50. Sprite
 * work is scaled by the sprite's size (a 16x16 icon costs less than an 8-frame 16x24 hero).
 */
export function estimatePlanTask(
  t: Pick<PlanTaskT, "kind" | "role" | "tier" | "conditional" | "expand" | "count"> & { assetKind?: string },
  env: PlanEnv,
): TaskEst {
  const row = CATALOGUE[t.kind as PlanKind];
  const n = t.expand ? (t.count ?? 0) : 1;
  if (!row.prices.length || t.role === "person") {
    return { usd: [0, 0], sec: [row.toolSec * n, row.toolSec * n * 1.5], rough: false };
  }
  const model = resolveTier(t.role as RoleT, t.tier ?? "role", env);
  const local = env.local(model);
  let u50 = 0;
  let u90 = 0;
  let s50 = 0;
  let s90 = 0;
  let rough = false;
  const params = sizeParams(t);
  for (const [kind, c50, c90] of row.prices) {
    const e = estimateCall(
      { kind, model: { id: model, price: priceFor(model), caps: { local } }, ...(params ? { params } : {}) },
      { ledger: env.ledger },
    );
    u50 += c50 * e.usd[0];
    u90 += c90 * e.usd[1];
    s50 += c50 * e.sec[0];
    s90 += c90 * e.sec[1];
    if (c50 > 0 && !local && (e.source === "default" || (e.source === "prior" && (priorFor(kind)?.n ?? 0) < 5)))
      rough = true;
  }
  const usd: [number, number] = t.conditional ? [0, u90 * n] : [u50 * n, u90 * n];
  return { usd, sec: [s50 * n + row.toolSec * n, s90 * n + row.toolSec * n], rough };
}

const LIVE = new Set(["pending", "ready", "running", "waiting_person"]);
export const isLive = (t: { status: string }) => LIVE.has(t.status);

/**
 * The plan's estimate: spent + the remaining tasks. $ p50 is the sum of p50s, p90 is p50 + sqrt(Σ(p90 − p50)²) (as
 * estimatePlan). Time is list scheduling in plan order over each endpoint's lanes (one render slot), person gates 0 s.
 */
export function planEstimate(tasks: PlanTaskT[], spentUsd: number, env: PlanEnv): PlanEstimateT {
  const rest = tasks.filter(isLive);
  let p50 = 0;
  let spread = 0;
  let rough = false;
  for (const t of rest) {
    p50 += t.estUsd[0];
    spread += (t.estUsd[1] - t.estUsd[0]) ** 2;
    if (!t.expand && CATALOGUE[t.kind].prices.length && t.role !== "person") {
      const e = estimatePlanTask(t, env);
      rough ||= e.rough;
    } else if (t.expand) rough ||= estimatePlanTask(t, env).rough;
  }
  const makespan = (q: 0 | 1) => {
    const lanes = new Map<string, number[]>();
    const finish = new Map<string, number>();
    let end = 0;
    for (const t of rest) {
      const row = CATALOGUE[t.kind];
      const ep = row.render
        ? "render"
        : row.prices.length && t.role !== "person"
          ? providerOf(resolveTier(t.role as RoleT, t.tier, env))
          : "code";
      if (!lanes.has(ep))
        lanes.set(ep, new Array(ep === "render" ? 1 : ep === "code" ? 8 : Math.max(1, env.laneSize(ep))).fill(0));
      const free = lanes.get(ep)!;
      const ready = Math.max(0, ...t.dependsOn.map((d) => finish.get(d) ?? 0));
      let k = 0;
      for (let j = 1; j < free.length; j++) if (free[j] < free[k]) k = j;
      const done = Math.max(free[k], ready) + t.estSec[q];
      free[k] = done;
      finish.set(t.id, done);
      end = Math.max(end, done);
    }
    return Math.round(end);
  };
  const r = (x: number) => Math.round(x * 10000) / 10000;
  return { usd: [r(spentUsd + p50), r(spentUsd + p50 + Math.sqrt(spread))], sec: [makespan(0), makespan(1)], rough };
}
