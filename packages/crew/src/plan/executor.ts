// The executor (docs/PIP-ORCHESTRATION.md §1.7): runs a production plan's tasks as their dependencies finish. A ready
// task takes a slot on its model's endpoint (the gateway's lane size: local 1, else defaults.concurrency) and render
// work shares one render slot, so `running` always means working, never waiting in a lane. It starts nothing while the
// run is paused or held or the budget can't cover a task's p90. Stages are a view: the stage of the earliest
// unfinished required task; when it advances, the stages it passed are drained (Pip's triggers) before anything new
// starts. Ticks are serialized: one loop per run.
import { STAGES, type Stage } from "@pap/tools";
import { CATALOGUE, stageOf } from "./catalogue.ts";
import { isLive } from "./estimate.ts";
import type { PlanTaskT } from "./schema.ts";

/** `fallback`: the task ended done on a stand-in (kept as built, lints only, a library asset); a retry redoes it */
export type Outcome = { status: "done" | "skipped"; note?: string; outcome?: "fallback" };

export interface ExecHost {
  /** the live plan (a revision replaces the object) */
  tasks(): PlanTaskT[];
  /** tasks waiting on a card (plan.pending) never start */
  held(id: string): boolean;
  /** run the task's handler; throws on failure */
  handle(t: PlanTaskT): Promise<Outcome>;
  /** a task's status changed (save + transient event) */
  setStatus(t: PlanTaskT, status: PlanTaskT["status"], note?: string, outcome?: "fallback"): void;
  /** the endpoint a task's model calls go to, or null for tool-only kinds */
  endpoint(t: PlanTaskT): string | null;
  laneSize(endpoint: string): number;
  /** the budget covers this task's p90 (and the overrun question isn't open) */
  affordable(t: PlanTaskT): boolean;
  /** nothing can start for the budget: ask the person (once per cap) */
  overrun(t: PlanTaskT): void;
  /** the run is paused (after_step) or held: start nothing */
  stopped(): boolean;
  aborted(): boolean;
  /** wait until resume (after a pause or hold) or abort */
  waitResume(): Promise<void>;
  /** the stage view moved */
  stageChanged(stage: Stage): void;
  /** the end of a stage: Pip's triggers */
  drain(stage: Stage): Promise<void>;
  /** the handler failed: ends the run (writer, director, export) or ends the task done with a partial report */
  fatal(t: PlanTaskT, e: unknown): boolean;
  /**
   * the handler failed in a way the person must fix (a rejected key, no credit, no connection): the run holds. True
   * puts the task back to pending and records no failure; `stopped()` is then true until the hold lifts.
   */
  hold?(t: PlanTaskT, e: unknown): boolean;
  /** nothing runs and everything left waits on held tasks (a card): the run waits for the person */
  waiting?(held: PlanTaskT[]): void;
}

/** a stuck plan names the task it waits on, so the run's failure blames that task (not an older failed row) */
export type StuckError = Error & { fix: string; blocking: string; waiting: string };

const SATISFIED = new Set(["done", "skipped", "dropped"]);
const at = (s: Stage) => STAGES.indexOf(s);

/** the stage view: the catalogue stage of the earliest unfinished required task (gates included), else the last */
/** the held tasks and every live task whose unfinished dependencies reach one */
export function heldClosure(
  live: PlanTaskT[],
  byId: Map<string, PlanTaskT>,
  isHeld: (id: string) => boolean,
): Set<string> {
  const memo = new Map<string, boolean>();
  const visit = (t: PlanTaskT, seen: Set<string>): boolean => {
    const hit = memo.get(t.id);
    if (hit !== undefined) return hit;
    if (seen.has(t.id)) return false;
    seen.add(t.id);
    const v =
      isHeld(t.id) ||
      t.dependsOn.some((d) => {
        const x = byId.get(d);
        return !!x && isLive(x) && visit(x, seen);
      });
    memo.set(t.id, v);
    return v;
  };
  return new Set(live.filter((t) => visit(t, new Set())).map((t) => t.id));
}

/** "the plan is stuck": names the task at the root of the wait (a failed one, when there is one) */
export function stuckError(t: PlanTaskT, byId: Map<string, PlanTaskT>): StuckError {
  const open = (x: PlanTaskT) =>
    x.dependsOn.map((d) => byId.get(d)).filter((d): d is PlanTaskT => !!d && !SATISFIED.has(d.status));
  // walk down the unfinished dependencies to the one that waits on nothing (prefer a failed one)
  let root = t;
  const seen = new Set<string>();
  for (;;) {
    seen.add(root.id);
    const deps = open(root).filter((d) => !seen.has(d.id));
    if (!deps.length) break;
    root = deps.find((d) => d.status === "failed") ?? deps[0];
  }
  const why = root === t ? "nothing it can get" : `${root.id}${root.status === "failed" ? ", which failed" : ""}`;
  return Object.assign(new Error(`the plan is stuck: ${t.id} waits on ${why}`), {
    fix:
      root.status === "failed"
        ? `retry ${root.id}, or ask Pip to change the plan`
        : "retry the failed task, or ask Pip to change the plan",
    blocking: root.id,
    waiting: t.id,
  });
}

export function viewStage(tasks: PlanTaskT[]): Stage {
  let best: Stage | null = null;
  for (const t of tasks)
    if (isLive(t) && !t.conditional) {
      const s = stageOf(t);
      if (!best || at(s) < at(best)) best = s;
    }
  return best ?? "deliver";
}

export class Executor {
  private host: ExecHost;
  private running = new Map<string, Promise<void>>();
  private wakeUp: (() => void) | null = null;
  private failure: { task: PlanTaskT; error: unknown } | null = null;
  constructor(host: ExecHost) {
    this.host = host;
  }
  /** a task ended, the plan changed, a gate was answered, the cap changed: look again */
  wake() {
    const w = this.wakeUp;
    this.wakeUp = null;
    w?.();
  }
  private sleep() {
    return new Promise<void>((res) => {
      this.wakeUp = res;
    });
  }
  /** what is running now, per endpoint (N6: `crew.slots`) */
  slots(): Record<string, { size: number; used: number }> {
    const out: Record<string, { size: number; used: number }> = {};
    for (const t of this.host.tasks().filter((x) => x.status === "running")) {
      const ep = this.host.endpoint(t);
      if (ep) {
        out[ep] ??= { size: this.host.laneSize(ep), used: 0 };
        out[ep].used++;
      }
      if (CATALOGUE[t.kind].render) {
        out.render ??= { size: 1, used: 0 };
        out.render.used++;
      }
    }
    return out;
  }

  private ready(t: PlanTaskT, byId: Map<string, PlanTaskT>) {
    return (
      (t.status === "pending" || t.status === "ready") &&
      !this.host.held(t.id) &&
      t.dependsOn.every((d) => {
        const x = byId.get(d);
        return !x || SATISFIED.has(x.status);
      })
    );
  }

  private start(t: PlanTaskT) {
    this.host.setStatus(t, "running");
    const job = (async () => {
      try {
        const o = await this.host.handle(t);
        this.host.setStatus(t, o.status, o.note, o.outcome);
      } catch (e) {
        if (this.host.aborted()) this.host.setStatus(t, "pending");
        else if (this.host.hold?.(t, e)) this.host.setStatus(t, "pending");
        else if (this.host.fatal(t, e)) {
          this.host.setStatus(t, "failed", String((e as any)?.message ?? e).slice(0, 200));
          this.failure ??= { task: t, error: e };
        } else this.host.setStatus(t, "done", `partial: ${String((e as any)?.message ?? e).slice(0, 180)}`, "fallback");
      } finally {
        this.running.delete(t.id);
        this.wake();
      }
    })();
    this.running.set(t.id, job);
  }

  /** run until every task is finished; throws the first fatal failure (after the running tasks settle) */
  async run(): Promise<void> {
    let stage = viewStage(this.host.tasks());
    this.host.stageChanged(stage);
    for (;;) {
      if (this.host.aborted()) break;
      const tasks = this.host.tasks();
      const now = viewStage(tasks);
      if (now !== stage) {
        // the stages the view passed end now (Pip's triggers); a redo can send it back
        if (at(now) > at(stage) && !this.failure) {
          for (const s of STAGES.slice(at(stage), at(now))) await this.host.drain(s);
          if (viewStage(this.host.tasks()) !== now) {
            stage = viewStage(this.host.tasks());
            this.host.stageChanged(stage);
            continue;
          }
        }
        stage = now;
        this.host.stageChanged(stage);
      }
      if (this.failure) {
        // the person's waits (a gate, a pick, a narration take, a publish question) end with the run
        const people = [...this.running.keys()].filter(
          (id) => tasks.find((t) => t.id === id)?.status === "waiting_person",
        );
        const work = [...this.running.entries()].filter(([id]) => !people.includes(id)).map(([, j]) => j);
        await Promise.all(work);
        throw this.failure.error;
      }
      const live = tasks.filter(isLive);
      if (!live.length) break;
      let started = 0;
      let blocked: PlanTaskT | null = null;
      if (!this.host.stopped()) {
        const byId = new Map(tasks.map((t) => [t.id, t]));
        const used = new Map<string, number>();
        let render = 0;
        for (const t of tasks.filter((x) => x.status === "running" || x.status === "waiting_person")) {
          if (t.status !== "running") continue;
          const ep = this.host.endpoint(t);
          if (ep) used.set(ep, (used.get(ep) ?? 0) + 1);
          if (CATALOGUE[t.kind].render) render++;
        }
        for (const t of tasks) {
          if (!this.ready(t, byId)) continue;
          const ep = this.host.endpoint(t);
          const heavy = CATALOGUE[t.kind].render;
          // ready but waiting: for a free slot or the budget (a ghost in the crew row)
          const wait = () => t.status === "pending" && this.host.setStatus(t, "ready");
          if (ep && (used.get(ep) ?? 0) >= this.host.laneSize(ep)) {
            wait();
            continue;
          }
          if (heavy && render >= 1) {
            wait();
            continue;
          }
          if (!this.host.affordable(t)) {
            wait();
            blocked ??= t;
            continue;
          }
          if (ep) used.set(ep, (used.get(ep) ?? 0) + 1);
          if (heavy) render++;
          this.start(t);
          started++;
        }
      }
      if (blocked && !this.running.size && !started) this.host.overrun(blocked);
      if (!this.running.size && !started) {
        if (this.host.stopped() || blocked) {
          await this.host.waitResume();
          continue;
        }
        const byId = new Map(tasks.map((t) => [t.id, t]));
        // held is passed down: a task whose unfinished dependencies reach a held task waits with it
        const held = heldClosure(live, byId, (id) => this.host.held(id));
        const stuck = live.filter((t) => (t.status === "pending" || t.status === "ready") && !held.has(t.id));
        if (!stuck.length || stuck.every((t) => !this.ready(t, byId))) {
          if (live.every((t) => held.has(t.id))) {
            this.host.waiting?.(live.filter((t) => this.host.held(t.id)));
            await this.host.waitResume();
            continue;
          }
          throw stuckError(stuck[0] ?? live.find((t) => !held.has(t.id)) ?? live[0], byId);
        }
        continue;
      }
      await this.sleep();
    }
    // a stop: running work goes back to pending as it settles
    await Promise.all([...this.running.values()]);
    if (!this.host.aborted()) for (const s of STAGES.slice(at(stage))) await this.host.drain(s);
  }
}
