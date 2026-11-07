// Cost and time estimates per task, and for a whole plan.
//   $    : observed ledger stats for (kind, model) when there are enough, else the checked-in priors repriced for the
//          target model and scaled by task size (sprite cells = w x h x frames)
//   time : TTFT + output tokens / tok/s, from the ledger's measured speed when available, else a declared default
import { type Ledger, type Prior, priorFor, type Quant, type Speed } from "./ledger.ts";
import { ANTHROPIC_PRICES, costUsd } from "./prices.ts";
import type { ModelInfo, Price, Usage } from "./types.ts";

export type TaskParams = { cells?: number; w?: number; h?: number; frames?: number };
export type EstimateModel = Pick<ModelInfo, "id" | "price"> & { caps?: Pick<ModelInfo["caps"], "local"> };

export type TaskEstimate = {
  usd: [number, number];
  sec: [number, number];
  outTokens: [number, number];
  source: "ledger" | "prior" | "default";
  speed: Speed & { source: "measured" | "default" };
};

/** Defaults when nothing is measured yet: declared, not observed. */
export const DEFAULT_SPEED = {
  cloud: { ttftMs: 2500, tokPerSec: 60 },
  local: { ttftMs: 1000, tokPerSec: 20 },
};
/** Used for kinds with no prior. */
const GENERIC_PRIOR: Prior = {
  n: 0,
  effort: "high",
  tokens: {
    in: { p50: 4000, p90: 12000 },
    cacheWrite: { p50: 0, p90: 0 },
    cacheWrite1h: { p50: 0, p90: 0 },
    cacheRead: { p50: 0, p90: 0 },
    out: { p50: 2000, p90: 8000 },
    thinking: { p50: 0, p90: 0 },
  },
  usd: { p50: 0.056, p90: 0.208 },
};

const MIN_LEDGER_SAMPLES = 5;
const MIN_SPEED_SAMPLES = 3;

const mix = (p: Prior, q: "p50" | "p90"): Usage => ({
  inputTokens: p.tokens.in[q],
  cacheWriteTokens: p.tokens.cacheWrite[q] + p.tokens.cacheWrite1h[q],
  cacheWrite1hTokens: p.tokens.cacheWrite1h[q],
  cacheReadTokens: p.tokens.cacheRead[q],
  outputTokens: p.tokens.out[q],
});

export function sizeFactor(prior: Prior | null, params?: TaskParams): number {
  if (!prior?.size || !params) return 1;
  const cells = params.cells ?? (params.w && params.h ? params.w * params.h * (params.frames ?? 1) : undefined);
  if (!cells) return 1;
  const f = (cells / prior.size.refCells) ** prior.size.exponent;
  return Math.min(8, Math.max(0.125, f));
}

/** How much more (or less) the target model costs than the priors' source model for the same token mix. */
export function priceRatio(
  target: Price | null,
  prior: Prior,
  q: "p50" | "p90",
  sourceModel = "claude-opus-5-5",
): number {
  if (!target) return 0;
  const src = ANTHROPIC_PRICES[sourceModel];
  const u = mix(prior, q);
  const base = costUsd(src, u);
  return base > 0 ? costUsd(target, u) / base : 1;
}

export function estimateTask(
  task: { kind: string; model: EstimateModel; params?: TaskParams },
  ctx: { ledger?: Ledger } = {},
): TaskEstimate {
  const prior = priorFor(task.kind);
  const p = prior ?? GENERIC_PRIOR;
  const local = task.model.caps?.local ?? false;
  const size = sizeFactor(prior, task.params);
  let usd: [number, number];
  let out: [number, number] = [p.tokens.out.p50 * size, p.tokens.out.p90 * size];
  let source: TaskEstimate["source"] = prior ? "prior" : "default";
  const seen = ctx.ledger?.kindStats(task.kind, task.model.id);
  if (seen && seen.n >= MIN_LEDGER_SAMPLES) {
    // observed rows carry the project's own size mix, so no size scaling here
    usd = [seen.usd.p50, seen.usd.p90];
    out = [seen.out.p50, seen.out.p90];
    source = "ledger";
  } else if (local || !task.model.price) {
    usd = [0, 0];
  } else {
    usd = [
      p.usd.p50 * priceRatio(task.model.price, p, "p50") * size,
      p.usd.p90 * priceRatio(task.model.price, p, "p90") * size,
    ];
  }
  const measured = ctx.ledger?.speed(task.model.id);
  const speed: TaskEstimate["speed"] =
    measured && measured.samples >= MIN_SPEED_SAMPLES
      ? { ...measured, source: "measured" }
      : { ...(local ? DEFAULT_SPEED.local : DEFAULT_SPEED.cloud), samples: 0, source: "default" };
  const sec = (tokens: number) => speed.ttftMs / 1000 + tokens / Math.max(0.1, speed.tokPerSec);
  return { usd, sec: [sec(out[0]), sec(out[1])], outTokens: out, source, speed };
}

export type PlanTask = {
  id?: string;
  kind: string;
  model: EstimateModel;
  params?: TaskParams;
  /** ids of tasks that must finish first */
  deps?: string[];
  /** concurrency lane group; defaults to the model's provider id */
  endpoint?: string;
};

export type PlanEstimate = { usd: [number, number]; sec: [number, number]; tasks: TaskEstimate[] };

/**
 * Whole-plan estimate. $: p50 is the sum of p50s; p90 is p50 + sqrt(sum((p90 - p50)^2)) (independent tasks, a normal
 * approximation, tighter than summing p90s). Time: list scheduling in the given order, each task on the earliest free
 * lane of its endpoint after its deps finish, run once with p50 and once with p90 durations.
 */
export function estimatePlan(
  tasks: PlanTask[],
  concurrencyPerEndpoint: number | Record<string, number>,
  ctx: { ledger?: Ledger } = {},
): PlanEstimate {
  const est = tasks.map((t) => estimateTask(t, ctx));
  const p50 = est.reduce((s, e) => s + e.usd[0], 0);
  const spread = Math.sqrt(est.reduce((s, e) => s + (e.usd[1] - e.usd[0]) ** 2, 0));
  const lanesFor = (ep: string) =>
    Math.max(
      1,
      typeof concurrencyPerEndpoint === "number" ? concurrencyPerEndpoint : (concurrencyPerEndpoint[ep] ?? 1),
    );
  const makespan = (q: 0 | 1) => {
    const lanes = new Map<string, number[]>();
    const finish = new Map<string, number>();
    let end = 0;
    tasks.forEach((t, i) => {
      const ep = t.endpoint ?? (t.model.id.includes("/") ? t.model.id.slice(0, t.model.id.indexOf("/")) : t.model.id);
      if (!lanes.has(ep)) lanes.set(ep, new Array(lanesFor(ep)).fill(0));
      const free = lanes.get(ep)!;
      const ready = Math.max(0, ...(t.deps ?? []).map((d) => finish.get(d) ?? 0));
      let k = 0;
      for (let j = 1; j < free.length; j++) if (free[j] < free[k]) k = j;
      const start = Math.max(free[k], ready);
      const done = start + est[i].sec[q];
      free[k] = done;
      if (t.id) finish.set(t.id, done);
      end = Math.max(end, done);
    });
    return end;
  };
  return { usd: [p50, p50 + spread], sec: [makespan(0), makespan(1)], tasks: est };
}

export type { Quant };
