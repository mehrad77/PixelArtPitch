// The crew's stage machine. Code runs the pipeline; models make small, schema-bound choices inside it:
//   brief (Producer plan, questions, G0) -> script (Writer's 3 angles, G1) -> storyboard (Director picks recipes) ->
//   animatic (rendered at once, G2) -> art (Art Director spec, Pixel Artists draw, critique, judge) -> animate
//   (Animators tune recipe params from stills) -> narrate -> sound + mix (tools) -> review (lints, Reviewer, one fix
//   round) -> rough cut (G3) -> deliver (export, G4) -> publish (opt-in, never private assets).
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { checkAsset } from "@pap/engine/standard";
import { contactSheet, LIBRARY_DIR, renderSheet } from "@pap/render";
import type { RoleT } from "@pap/schema";
import type { GateId, OpenProject, Registry, Stage, Task, ToolContext, Workspace } from "@pap/tools";
import { z } from "zod";
import type { Gateway } from "./gateway.ts";
import type { ChatMessage, ContentPart } from "./llm/types.ts";
import {
  AnglesOut,
  DrawOut,
  type DrawOutT,
  JudgeOut,
  KIND_TEMPLATES,
  PlanOut,
  ReviewOut,
  type ReviewOutT,
  SpecOut,
  StoryboardOut,
  TuneOut,
} from "./outputs.ts";
import { card, fill } from "./prompts.ts";

const js = (s: z.ZodType) => z.toJSONSchema(s, { io: "input", unrepresentable: "any" }) as Record<string, unknown>;
const img = (data: Uint8Array): ContentPart => ({
  type: "image",
  mediaType: "image/png",
  data: Buffer.from(data).toString("base64"),
});
const words = (s: string) => s.trim().split(/\s+/).filter(Boolean).length;

class Paused extends Error {}

const ROLE_WORD: Record<string, string> = {
  producer: "producer",
  writer: "writer",
  director: "director",
  "art-director": "art director",
  "pixel-artist": "artist",
  animator: "animator",
  "sound-designer": "sound designer",
  mixer: "mixer",
  editor: "editor",
  reviewer: "reviewer",
  librarian: "librarian",
};
/** a failure in plain words, and the one thing the person can do about it */
export function humanize(e: any, role = "crew"): { text: string; action: "retry" | "change_model" | "add_budget" } {
  const who = `The ${ROLE_WORD[role] ?? role}`;
  const msg = String(e?.message ?? e);
  if (e?.code === "budget" || /budget:/.test(msg))
    return { text: "The crew reached your budget.", action: "add_budget" };
  if (/schema-valid|max_tokens|garbled|JSON/i.test(msg))
    return { text: `${who}'s answer came back garbled.`, action: "change_model" };
  if (/ECONNREFUSED|fetch failed|unreachable|no provider|turned off/i.test(msg))
    return { text: "The crew can't reach its model. Is the model server running?", action: "retry" };
  if (/missing required prop|unknown prop|invalid_recipe|scene_set_recipes/i.test(msg))
    return { text: `${who} got stuck on a scene setting.`, action: "retry" };
  return { text: `${who} got stuck.`, action: "retry" };
}
const PHASE: Record<string, number> = {
  brief: 0,
  script: 1,
  storyboard: 1,
  art: 2,
  animate: 2,
  narrate: 3,
  sound: 3,
  review: 4,
  deliver: 4,
};
const STAGE_LINE: Record<string, string> = {
  brief: "Reading your idea",
  script: "Writing the script",
  storyboard: "Planning the scenes",
  art: "Drawing the art",
  animate: "Animating the scenes",
  narrate: "Waiting for the narration",
  sound: "Adding sound and music",
  review: "Checking for mistakes",
  deliver: "Exporting your video",
};
const MILESTONE: Record<string, string> = {
  "producer.plan": "Plan ready",
  "writer.angles": "Script written",
  "director.storyboard": "Storyboard ready",
  "asset.judge": "Hero drawn",
  "sound.mix": "Sound mixed",
  "review.final": "Checked for mistakes",
  "deliver.export": "Your video is ready",
};

/**
 * The storyboard a weak Director falls back to: the hook on a walk-in with a block bump, the middle cues as item
 * collection, a flag raise for the payoff, and the end card. Every recipe with only its required params.
 */
export function baselineBoard(cueIds: string[], card: { title: string; url?: string } = { title: "PRESS START" }) {
  const n = cueIds.length;
  type Sc = { id: string; title: string; cues: string[]; recipes: { id: string; params: Record<string, unknown> }[] };
  const scenes: Sc[] = [];
  const take = (a: number, b: number) => cueIds.slice(a, b);
  const R = (...ids: string[]) => ids.map((id) => ({ id, params: {} }));
  const endCard = {
    id: "end_card_loop",
    params: { title: card.title.slice(0, 24), ...(card.url ? { url: card.url } : {}) },
  };
  if (n === 1) scenes.push({ id: "end", title: "End card", cues: take(0, 1), recipes: [endCard] });
  else {
    const mid = Math.max(1, n - 2);
    scenes.push({
      id: "hook",
      title: "The hook",
      cues: take(0, 1),
      recipes: R("backdrop_night", "walk_in", "block_bump"),
    });
    if (mid > 1)
      scenes.push({
        id: "quest",
        title: "The quest",
        cues: take(1, mid),
        recipes: R("backdrop_night", "walk_in", "item_collect"),
      });
    if (n > 2)
      scenes.push({
        id: "payoff",
        title: "The payoff",
        cues: take(mid, n - 1),
        recipes: R("backdrop_night", "flag_raise", "crowd_cheer"),
      });
    scenes.push({ id: "end", title: "End card", cues: take(n - 1, n), recipes: [endCard] });
  }
  // walk_in and block_bump default to an actor named "hero", which the art stage draws
  const newAssets: { name: string; kind: "character" | "prop" | "icon" | "decor"; description: string }[] =
    n > 1
      ? [
          {
            name: "hero",
            kind: "character",
            description:
              "The friendly hero of the video: a small adventurer with a scarf and a backpack, bright readable colours against the night sky.",
          },
        ]
      : [];
  return { scenes, newAssets };
}

/** a word sequence repeated 3+ times: the run-away loop small models fall into */
const loops = (s: string) => /(\b\w+(?:\s+\w+){0,3}\b)(?:[\s,.]+\1\b){2,}/i.test(s);
/** keep the usable angles of a weak model's answer: at most 3, no loops, short cues */
function saneAngles(raw: unknown) {
  const r = raw as { angles?: { name?: unknown; approach?: unknown; cues?: unknown }[]; recommended?: unknown };
  const angles = (Array.isArray(r?.angles) ? r.angles : [])
    .filter((a) => typeof a?.name === "string" && Array.isArray(a.cues) && a.cues.length >= 2)
    .map((a) => ({
      name: String(a.name).slice(0, 60),
      approach: String(a.approach ?? "").slice(0, 200),
      cues: (a.cues as unknown[]).map(String).map((c) => c.trim()),
    }))
    .filter(
      (a) =>
        !loops(`${a.approach} ${a.cues.join(" ")}`) &&
        a.cues.every((c) => c.length >= 2 && c.length <= 120 && words(c) <= 14) &&
        a.name.toLowerCase() !== "recommended",
    )
    .slice(0, 3);
  if (!angles.length) return null;
  const rec = typeof r.recommended === "number" && r.recommended < angles.length ? r.recommended : 0;
  return { angles, recommended: rec };
}

type Run = {
  abort: AbortController;
  paused: boolean;
  pauseMode?: "after_step" | "now";
  resume?: () => void;
  startedAt: string;
};

export type CrewDeps = { workspace: Workspace; registry: Registry; gateway: Gateway };

export class Crew {
  private deps: CrewDeps;
  private runs = new Map<string, Run>();
  private gateWaiters = new Map<
    string,
    (v: { verdict: string; reasons?: string[]; items?: string[]; by: string }) => void
  >();
  constructor(deps: CrewDeps) {
    this.deps = deps;
  }

  // ---------------------------------------------------------------- the CrewApi the server uses
  status(p: OpenProject) {
    const { spentUsd, reservedUsd } = this.deps.gateway.spent(p.id);
    const doc = p.doc();
    const est = this.deps.gateway.estimate(p.id, this.remaining(p));
    return {
      budget: {
        capUsd: doc.budget.capUsd,
        spentUsd,
        reservedUsd,
        estTotalUsd: est ? ([spentUsd + est.usd[0], spentUsd + est.usd[1]] as [number, number]) : null,
      },
      time: { startedAt: p.state.startedAt, etaSec: est ? est.sec : null, deadline: doc.brief.deadline ?? null },
    };
  }
  pause(p: OpenProject, mode: "after_step" | "now") {
    const r = this.runs.get(p.id);
    p.state.paused = true;
    p.saveState();
    p.emit("log", { level: "info", text: mode === "now" ? "crew paused now" : "crew pauses after the current step" });
    if (!r) return;
    r.paused = true;
    r.pauseMode = mode;
    if (mode === "now") r.abort.abort(new Paused("paused"));
  }
  resume(p: OpenProject) {
    p.state.paused = false;
    p.saveState();
    const r = this.runs.get(p.id);
    if (r) {
      r.paused = false;
      r.resume?.();
    }
  }
  gate(p: OpenProject, gate: string, v: { verdict: string; items?: string[]; reasons?: string[]; by: string }) {
    const g = p.setGate(gate as GateId, {
      status: v.verdict === "changes" ? "changes" : "passed",
      verdict: { by: v.by, verdict: v.verdict, reasons: v.reasons, at: new Date().toISOString() },
    });
    this.gateWaiters.get(`${p.id}:${gate}`)?.(v);
    this.gateWaiters.delete(`${p.id}:${gate}`);
    return g;
  }

  /** after a crash or restart: continue every crew that was working (not ones the person paused) */
  resumeInterrupted() {
    const out: string[] = [];
    for (const { id } of this.deps.workspace.list()) {
      try {
        const p = this.deps.workspace.get(id);
        if (!p.state.running || p.state.paused) continue;
        p.emit("log", { level: "info", text: `resuming the crew at ${p.state.stage} after a restart` });
        p.setStatus({ line: "Picking up where the crew left off" });
        this.run(p, { stage: p.state.stage }).catch(() => {});
        out.push(id);
      } catch {}
    }
    return out;
  }

  async run(p: OpenProject, opts: { stage?: string } = {}) {
    if (this.runs.has(p.id)) throw new Error("the crew is already working on this project");
    const r: Run = { abort: new AbortController(), paused: false, startedAt: new Date().toISOString() };
    this.runs.set(p.id, r);
    p.state.startedAt ??= r.startedAt;
    p.state.paused = false;
    p.state.running = true;
    p.saveState();
    p.setDigest("The crew is working.");
    p.setStatus({ line: "The crew is working", problem: undefined });
    try {
      await this.pipeline(p, r, (opts.stage as Stage) ?? p.state.stage);
    } catch (e: any) {
      if (e instanceof Paused || r.abort.signal.aborted) p.emit("log", { level: "info", text: "crew stopped" });
      else {
        p.emit("log", { level: "error", text: String(e?.message ?? e) });
        const failed = [...p.state.tasks].reverse().find((x) => x.status === "failed" && !x.supersededBy);
        const h = humanize(e, failed?.role);
        p.setStatus({ line: h.text, problem: { ...h, taskId: failed?.id } });
        p.setDigest(`The crew stopped: ${String(e?.message ?? e).slice(0, 200)}${e?.fix ? ` Fix: ${e.fix}` : ""}`);
      }
      throw e;
    } finally {
      this.runs.delete(p.id);
      // a finished, failed or deliberately stopped run is not resumed; only a crash leaves `running` set
      p.state.running = false;
      p.saveState();
    }
  }

  // ---------------------------------------------------------------- helpers
  private remaining(p: OpenProject): { kind: string; role: RoleT; count?: number }[] {
    const order: Stage[] = ["brief", "script", "storyboard", "art", "animate", "narrate", "sound", "review", "deliver"];
    const at = order.indexOf(p.state.stage);
    const all: [Stage, string, RoleT, number][] = [
      ["brief", "producer.plan", "producer", 1],
      ["script", "writer.angles", "writer", 1],
      ["storyboard", "director.storyboard", "director", 1],
      ["art", "asset.draw", "pixel-artist", 3],
      ["art", "asset.critique", "pixel-artist", 3],
      ["art", "asset.judge", "art-director", 1],
      ["animate", "scene.tune", "animator", Math.max(1, p.doc().scenes.length)],
      ["review", "review.final", "reviewer", 2],
    ];
    return all.filter(([s]) => order.indexOf(s) >= at).map(([, kind, role, count]) => ({ kind, role, count }));
  }

  private async checkpoint(p: OpenProject, r: Run) {
    if (r.abort.signal.aborted) throw new Paused("stopped");
    if (!r.paused) return;
    p.emit("log", { level: "info", text: "crew paused" });
    await new Promise<void>((res) => {
      r.resume = res;
    });
    if (r.abort.signal.aborted) r.abort = new AbortController();
  }

  private task(p: OpenProject, t: Omit<Task, "id" | "usd" | "status"> & { status?: Task["status"] }): Task {
    return p.upsertTask({
      id: randomUUID().slice(0, 8),
      usd: 0,
      status: "working",
      startedAt: new Date().toISOString(),
      ...t,
    });
  }
  private done(p: OpenProject, t: Task, patch: Partial<Task> = {}) {
    const m = MILESTONE[t.kind];
    if (m) p.milestone(t.kind, m, patch.lastImage ?? t.lastImage);
    return p.upsertTask({ ...t, status: "done", endedAt: new Date().toISOString(), ...patch });
  }
  private failTask(p: OpenProject, t: Task, e: any) {
    return p.upsertTask({
      ...t,
      status: "failed",
      endedAt: new Date().toISOString(),
      error: { message: String(e?.message ?? e).slice(0, 400), fix: e?.fix },
    });
  }

  private ctx(p: OpenProject, role: RoleT, task: string): ToolContext {
    return {
      author: { kind: "agent", role, task },
      project: p,
      workspace: this.deps.workspace,
      emit: (e) => p.emit(e.type, e),
    };
  }
  private async tool(p: OpenProject, role: RoleT, task: string, name: string, input: unknown) {
    const res = await this.deps.registry.call(name, input, this.ctx(p, role, task));
    p.log(task, {
      kind: "tool",
      title: `${name} → ${res.ok ? "ok" : res.error.code}`,
      detail: { input, result: res.ok ? res.data : res.error },
      ...(res.ok && res.images?.[0]
        ? { image: `data:image/png;base64,${Buffer.from(res.images[0].data).toString("base64")}` }
        : {}),
    });
    if (!res.ok) {
      const err: any = new Error(`${name}: ${res.error.message}`);
      err.fix = res.error.fix;
      err.code = res.error.code;
      throw err;
    }
    return res;
  }

  /** one schema-bound model call, recorded on the task */
  private async ask<T>(
    p: OpenProject,
    r: Run,
    t: Task,
    o: {
      role: RoleT;
      kind: string;
      prompt: string;
      vars: Record<string, unknown>;
      schema: z.ZodType<T>;
      images?: { caption: string; data: Uint8Array }[];
      history?: ChatMessage[];
      extra?: ContentPart[];
      normalize?: (raw: unknown) => T | null;
    },
  ): Promise<{ data: T; messages: ChatMessage[] }> {
    const [role, name] = o.prompt.split("/");
    const c = card(role, name);
    const userText = fill(c.user, o.vars);
    const content: ContentPart[] = [{ type: "text", text: userText }];
    for (const im of o.images ?? []) content.push({ type: "text", text: im.caption }, img(im.data));
    content.push(...(o.extra ?? []));
    const messages: ChatMessage[] = [...(o.history ?? []), { role: "user", content }];
    const doc = p.doc();
    const model = this.deps.gateway.modelFor(o.role, doc.crew.models);
    p.log(t.id, {
      kind: "model",
      title: `Asked ${model.split("/").pop()} (${c.id})`,
      detail: { prompt: userText.slice(0, 6000), images: (o.images ?? []).map((i) => i.caption) },
    });
    let thinking = "";
    const started = Date.now();
    const out = await this.deps.gateway
      .json({
        project: p.id,
        capUsd: doc.budget.capUsd,
        task: t.id,
        taskKind: o.kind,
        role: o.role,
        promptVersion: c.version,
        system: fill(c.system, o.vars),
        messages,
        schema: o.schema,
        jsonSchema: js(o.schema),
        maxOut: c.maxOut,
        effort: c.effort,
        model: this.deps.gateway.modelFor(o.role, doc.crew.models),
        signal: r.abort.signal,
        normalize: o.normalize,
        onEvent: (e) => {
          if (e.type === "thinking" && e.text && thinking.length < 20000) thinking += e.text;
        },
      })
      .catch((e: any) => {
        p.log(t.id, { kind: "error", title: String(e?.message ?? e).slice(0, 200), thinking: thinking || undefined });
        throw e;
      });
    p.log(t.id, {
      kind: "answer",
      title: `Answered in ${((Date.now() - started) / 1000).toFixed(0)} s · ${out.result.usage.outputTokens} tokens${out.result.usd ? ` · $${out.result.usd.toFixed(3)}` : ""}`,
      detail: out.data,
      thinking: thinking || undefined,
    });
    t.usd += out.result.usd;
    t.model = out.model;
    p.upsertTask(t);
    p.emit("ledger", { usd: out.result.usd, role: o.role, model: out.model, ...this.deps.gateway.spent(p.id) });
    return { data: out.data, messages: [...messages, { role: "assistant", content: JSON.stringify(out.data) }] };
  }

  /** wait at a gate unless the involvement level lets it pass */
  private async atGate(p: OpenProject, gate: GateId, items: { label: string; ref?: string }[], auto: boolean) {
    const inv = p.doc().brief.involvement;
    const userGate =
      inv === "every" ||
      (inv === "key" && ["g0_brief", "g1_script", "g2_animatic", "g3_rough", "g4_final"].includes(gate));
    if (!userGate || auto) {
      p.setGate(gate, {
        status: "passed",
        items,
        verdict: { by: "producer", verdict: "approve", at: new Date().toISOString(), note: "auto" } as any,
      });
      return { verdict: "approve" };
    }
    p.setGate(gate, { status: "open", items });
    p.setDigest(`Waiting for you: ${items.map((i) => i.label).join(", ")}.`);
    return new Promise<{ verdict: string; reasons?: string[] }>((res) => this.gateWaiters.set(`${p.id}:${gate}`, res));
  }

  // ---------------------------------------------------------------- the pipeline
  private async pipeline(p: OpenProject, r: Run, from: Stage) {
    const order: Stage[] = ["brief", "script", "storyboard", "art", "animate", "narrate", "sound", "review", "deliver"];
    const auto = p.doc().brief.involvement === "auto";
    for (const stage of order.slice(order.indexOf(from))) {
      await this.checkpoint(p, r);
      p.setStage(stage);
      p.setStatus({ phase: PHASE[stage] ?? 0, line: STAGE_LINE[stage] ?? "Working" });
      if (stage === "brief") await this.brief(p, r, auto);
      if (stage === "script") await this.script(p, r, auto);
      if (stage === "storyboard") await this.storyboard(p, r, auto);
      if (stage === "art") await this.art(p, r);
      if (stage === "animate") {
        await this.animate(p, r);
        await this.narrateMilestone(p);
      }
      if (stage === "narrate") await this.narrate(p, r);
      if (stage === "sound") await this.sound(p);
      if (stage === "review") await this.review(p, r, auto);
      if (stage === "deliver") await this.deliver(p, r, auto);
    }
    p.setStatus({ phase: 4, line: "Your video is ready" });
    p.setDigest(
      `Done: ${
        p
          .files()
          .filter((f) => f.kind === "video")
          .map((f) => f.name)
          .join(", ") || "no video"
      } in out/.`,
    );
  }

  private async brief(p: OpenProject, r: Run, auto: boolean) {
    const d = p.doc();
    const t = this.task(p, { kind: "producer.plan", role: "producer", title: "Reading the brief" });
    try {
      const { data } = await this.ask(p, r, t, {
        role: "producer",
        kind: "producer.plan",
        prompt: "producer/plan",
        vars: { brief: d.brief, lengthSec: d.brief.lengthSec, narration: d.brief.narration, capUsd: d.budget.capUsd },
        schema: PlanOut,
      });
      const notes = [...d.notes, ...data.assumptions.map((a) => ({ by: "producer", text: `assumption: ${a}` }))];
      await p.patch([{ op: "replace", path: "/notes", value: notes }], {
        reason: "record the Producer's assumptions",
        author: { kind: "agent", role: "producer", task: t.id },
      });
      for (const q of data.questions) {
        if (!q.options.some((o) => o.id === q.recommendedId)) q.recommendedId = q.options[0].id;
        if (auto) continue;
        const asked = p.ask({ ...q, kind: "single", blocks: ["script"], from: "producer" }, "producer");
        p.upsertTask({ ...t, status: "waiting_user", title: "Waiting for your answers" });
        const a = await p.waitAnswer(asked.id, r.abort.signal);
        const opt = q.options.find((o) => o.id === a.answer?.optionId);
        notes.push({
          by: "user",
          text: `${q.question} → ${opt?.label ?? a.answer?.optionId}${a.answer?.note ? ` (${a.answer.note})` : ""}`,
        });
      }
      if (data.questions.length && !auto)
        await p.patch([{ op: "replace", path: "/notes", value: notes }], {
          reason: "record your answers",
          author: { kind: "agent", role: "producer", task: t.id },
        });
      p.setDigest(data.digest);
      this.done(p, t, { summary: data.digest });
    } catch (e) {
      this.failTask(p, t, e);
      throw e;
    }
    await this.atGate(p, "g0_brief", [{ label: "Brief and budget" }], auto);
  }

  private async script(p: OpenProject, r: Run, auto: boolean) {
    const d = p.doc();
    const t = this.task(p, { kind: "writer.angles", role: "writer", title: "Writing three script angles" });
    try {
      const est = await this.tool(p, "writer", t.id, "script_estimate", { lines: ["x"] });
      const budget = (est.data as any).wordBudget as number;
      const speechSec = Math.max(4, d.brief.lengthSec - d.composition.hold - d.composition.endHold);
      let out = await this.ask(p, r, t, {
        role: "writer",
        kind: "writer.angles",
        prompt: "writer/angles",
        vars: {
          brief: {
            idea: d.brief.idea,
            audience: d.brief.audience,
            ask: d.brief.ask,
            tone: d.brief.tone,
            notes: d.notes.map((n) => n.text),
          },
          lengthSec: d.brief.lengthSec,
          speechSec,
          wordBudget: budget,
          mustSay: d.brief.mustSay.length ? `Must say: ${d.brief.mustSay.join("; ")}` : "",
        },
        schema: AnglesOut,
        normalize: saneAngles,
      });
      // one repair turn if any angle breaks the word rules
      const problems = (a: typeof out.data) =>
        a.angles.flatMap((g, i) => [
          ...(g.cues.reduce((s, c) => s + words(c), 0) > budget
            ? [`angle ${i} has ${g.cues.reduce((s, c) => s + words(c), 0)} words; the budget is ${budget}`]
            : []),
          ...g.cues.filter((c) => words(c) > 12).map((c) => `angle ${i} cue "${c}" has ${words(c)} words; at most 12`),
        ]);
      const bad = problems(out.data);
      if (bad.length) {
        out = await this.ask(p, r, t, {
          role: "writer",
          kind: "writer.repair",
          prompt: "writer/angles",
          vars: {
            brief: "(same as above)",
            lengthSec: d.brief.lengthSec,
            speechSec,
            wordBudget: budget,
            mustSay: `Fix these and return all 3 angles: ${bad.join("; ")}`,
          },
          schema: AnglesOut,
          history: out.messages,
        });
      }
      const { angles } = out.data;
      const recommended = Math.min(out.data.recommended, angles.length - 1);
      let pick = recommended;
      this.done(p, t, {
        summary: angles.map((a, i) => `${i === recommended ? "★ " : ""}${a.name}: ${a.cues[0]}`).join(" / "),
      });
      if (!auto && p.doc().brief.involvement !== "auto") {
        const q = p.ask(
          {
            kind: "single",
            question: "Which script should the crew make?",
            why: "The script sets the scenes, the timing and what the art must show.",
            options: angles.map((a, i) => ({
              id: `angle_${i}`,
              label: a.name,
              detail: a.cues.join(" ").slice(0, 280),
            })),
            recommendedId: `angle_${recommended}`,
            blocks: ["storyboard"],
            from: "writer",
          },
          "writer",
        );
        p.setGate("g1_script", { status: "open", items: [{ label: "Pick a script angle", ref: q.id }] });
        const a = await p.waitAnswer(q.id, r.abort.signal);
        pick = Number((a.answer?.optionId ?? `angle_${recommended}`).split("_")[1]);
      }
      const chosen = angles[pick] ?? angles[0];
      await this.tool(p, "writer", t.id, "script_set_cues", {
        cues: chosen.cues.map((text) => ({ text })),
        reason: `script: the "${chosen.name}" angle`,
      });
      p.setGate("g1_script", {
        status: "passed",
        items: [{ label: `Script: ${chosen.name}` }],
        verdict: { by: auto ? "producer" : "user", verdict: "approve", at: new Date().toISOString() } as any,
      });
      // timing: end card holds after the last cue
      const nd = p.doc();
      const last = nd.script.cues.at(-1)!.id;
      await p.patch([{ op: "replace", path: "/composition/duration", value: `E(${last})+endHold` }], {
        reason: "the video ends an end-card hold after the last cue",
        author: { kind: "agent", role: "editor", task: t.id },
      });
    } catch (e) {
      this.failTask(p, t, e);
      throw e;
    }
  }

  private libraryList() {
    const idx = JSON.parse(readFileSync(join(LIBRARY_DIR, "index.json"), "utf8")).assets as {
      id: string;
      kind: string;
      w: number;
      h: number;
    }[];
    return idx.map((a) => {
      const f = JSON.parse(readFileSync(join(LIBRARY_DIR, a.id, "asset.json"), "utf8"));
      return `${a.id}: ${a.kind} ${a.w}x${a.h}, frames ${f.frames.slice(0, 10).join(", ")}${f.frames.length > 10 ? ", …" : ""}`;
    });
  }

  private async storyboard(p: OpenProject, r: Run, auto: boolean) {
    const t = this.task(p, {
      kind: "director.storyboard",
      role: "director",
      title: "Building scenes from the recipe menu",
    });
    try {
      const { recipeCatalog, checkRecipeParams } = await import("@pap/engine/recipes");
      const d = p.doc();
      // one compact line per recipe: small models drown in a full JSON catalogue
      const catalog = recipeCatalog()
        .map((x: any) => {
          const ps = Object.entries<any>(x.params.properties)
            .filter(
              ([k]) =>
                x.params.required.includes(k) ||
                ["text", "title", "url", "word", "items", "actor", "hero", "at"].includes(k),
            )
            .map(
              ([k, v]) =>
                `${k}${x.params.required.includes(k) ? "*" : ""}: ${v.type}${v.default !== undefined ? ` = ${JSON.stringify(v.default)}` : ""}`,
            );
          return `- ${x.id} (min ${x.minDurationSec}s): ${x.description}${ps.length ? ` Params: ${ps.join("; ")}` : ""}`;
        })
        .join("\n");
      const libNames = this.libraryList();
      const vars = {
        idea: d.brief.idea,
        cues: d.script.cues.map((c) => `${c.id}: ${c.text}`).join("\n"),
        recipes: catalog,
        assets: libNames.join("\n"),
      };
      let board: z.infer<typeof StoryboardOut> | null = null;
      let why = "";
      try {
        let out = await this.ask(p, r, t, {
          role: "director",
          kind: "director.storyboard",
          prompt: "director/storyboard",
          vars,
          schema: StoryboardOut,
        });
        for (let attempt = 0; attempt < 2; attempt++) {
          const issues = this.checkBoard(p, out.data, checkRecipeParams);
          if (!issues.length) {
            board = out.data;
            break;
          }
          why = issues.slice(0, 3).join("; ");
          p.emit("log", { level: "warn", role: "director", text: `storyboard needs fixes: ${why}` });
          out = await this.ask(p, r, t, {
            role: "director",
            kind: "director.repair",
            prompt: "director/storyboard",
            vars: {
              ...vars,
              idea: `${d.brief.idea}\n\nYour last answer had these problems; fix them and return the whole storyboard:\n- ${issues.join("\n- ")}`,
            },
            schema: StoryboardOut,
            history: out.messages,
          });
          if (!this.checkBoard(p, out.data, checkRecipeParams).length) board = out.data;
        }
      } catch (e: any) {
        if (r.abort.signal.aborted) throw e;
        why = String(e?.message ?? e).slice(0, 160);
      }
      if (!board) {
        // a weak model could not do it: the baseline storyboard keeps the crew moving, and the user can see why
        const url = /\b[a-z0-9-]+(\.[a-z0-9-]+)+(\/[^\s]*)?/i.exec(
          d.brief.ask || d.brief.idea.split(/call to action:?/i)[1] || "",
        )?.[0];
        const name = /^([A-Z][A-Za-z0-9]+)/.exec(d.brief.idea)?.[1] ?? d.title.split(/\s+/)[0];
        board = baselineBoard(
          d.script.cues.map((c) => c.id),
          { title: name.toUpperCase(), url },
        );
        p.emit("log", { level: "warn", role: "director", text: `using the baseline storyboard (${why})` });
        await p.patch(
          [
            {
              op: "add",
              path: "/notes/-",
              value: {
                by: "producer",
                text: `assumption: the baseline storyboard was used because the Director model's answer was unusable (${why})`,
              },
            },
          ],
          {
            reason: "record the storyboard fallback",
            author: { kind: "agent", role: "producer", task: t.id },
          },
        );
      }
      const out = { data: board };
      await this.applyBoard(p, t, out.data);
      this.done(p, t, {
        summary: out.data.scenes.map((s) => `${s.title} (${s.recipes.map((x) => x.id).join(", ")})`).join(" → "),
      });
      // the animatic: rendered straight away from library assets and placeholder boxes
      const ren = await p.renderer_();
      const sheet = await contactSheet(ren, { every: 1 });
      writeFileSync(join(p.dir, "out", "animatic-contact.png"), sheet);
      p.emit("render", { kind: "still", url: `/api/p/${p.id}/files/animatic-contact.png` });
      for (const sc of p.doc().scenes) p.setSceneStatus(sc.id, { version: "animatic", state: "ready" });
      await this.atGate(
        p,
        "g2_animatic",
        [{ label: "Animatic: pacing before any art is drawn", ref: "out/animatic-contact.png" }],
        auto,
      );
    } catch (e) {
      this.failTask(p, t, e);
      throw e;
    }
  }

  private checkBoard(
    p: OpenProject,
    b: z.infer<typeof StoryboardOut>,
    check: (id: string, params: Record<string, unknown>, at: any, path: string) => any[],
  ): string[] {
    const d = p.doc();
    const ids = d.script.cues.map((c) => c.id);
    const seen = b.scenes.flatMap((s) => s.cues);
    const issues: string[] = [];
    if (JSON.stringify(seen) !== JSON.stringify(ids))
      issues.push(`scenes must carry every cue exactly once and in order: ${ids.join(", ")}; got ${seen.join(", ")}`);
    if (new Set(b.scenes.map((s) => s.id)).size !== b.scenes.length) issues.push("scene ids must be unique");
    // icon-first: show it, don't write it
    const VISUAL = new Set(["walk_in", "block_bump", "item_collect", "spawn_join", "crowd_cheer", "flag_raise"]);
    const titles = b.scenes.filter((s) => s.recipes.some((r) => r.id === "title_card")).length;
    if (titles > 1)
      issues.push(
        `${titles} scenes use title_card; use it at most once (the opening), and show the other cues with walk_in, item_collect, block_bump, spawn_join, crowd_cheer or flag_raise`,
      );
    b.scenes.forEach((s, k) => {
      const last = k === b.scenes.length - 1;
      if (!last && k > 0 && !s.recipes.some((r) => VISUAL.has(r.id)))
        issues.push(
          `scene ${s.id} shows nothing: add a visual recipe (walk_in, item_collect, block_bump, spawn_join, crowd_cheer or flag_raise)`,
        );
    });
    if (!b.scenes.at(-1)?.recipes.some((r) => r.id === "end_card_loop"))
      issues.push("the last scene must use end_card_loop");
    const norm = (x: string) =>
      x
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, " ")
        .trim();
    const cueTexts = new Set(d.script.cues.map((c) => norm(c.text)));
    for (const s of b.scenes)
      for (const r of s.recipes)
        for (const key of ["title", "text", "subtitle", "word"]) {
          const v = r.params[key];
          if (typeof v === "string" && (cueTexts.has(norm(v)) || v.split(/\s+/).length > 3))
            issues.push(
              `scene ${s.id} ${r.id}.${key} "${v}" repeats or spells out the script; captions already show every cue, so use at most 3 words (or drop it)`,
            );
        }
    const known = new Set([
      ...this.libraryList().map((l) => l.split(":")[0]),
      ...b.newAssets.map((a) => a.name),
      "font",
    ]);
    const tl = p.timeline();
    for (const [k, s] of b.scenes.entries())
      s.recipes.forEach((rc, n) => {
        for (const x of check(rc.id, rc.params, tl.at, `scenes[${k}].recipes[${n}]`))
          issues.push(`${x.path}: ${x.message} (fix: ${x.fix})`);
        for (const [key, v] of Object.entries(rc.params))
          if (
            typeof v === "string" &&
            /^(asset|actor|hero|sprite|item|prop)/i.test(key) &&
            /^[a-z][a-z0-9_-]*$/.test(v) &&
            !known.has(v)
          )
            issues.push(
              `scenes[${k}].recipes[${n}].params.${key}: asset "${v}" is not in the asset list (fix: use a listed asset or add it to newAssets)`,
            );
      });
    return issues;
  }

  private async applyBoard(p: OpenProject, t: Task, b: z.infer<typeof StoryboardOut>) {
    const n = b.scenes.length;
    const windows = b.scenes.map((s, k) => ({
      id: s.id,
      title: s.title,
      cues: s.cues,
      from: k === 0 ? "0" : `E(${b.scenes[k - 1].cues.at(-1)})+0.1`,
      to: k === n - 1 ? "duration" : `E(${s.cues.at(-1)})+0.1`,
    }));
    await this.tool(p, "director", t.id, "storyboard_set", { scenes: windows, reason: "scenes from the storyboard" });
    // cast library assets the recipes use, and the font
    const d = p.doc();
    const want = new Set<string>(["font"]);
    const { RECIPE_MAP } = await import("@pap/engine/recipes");
    for (const s of b.scenes)
      for (const rc of s.recipes) {
        const R = (RECIPE_MAP as any)[rc.id];
        for (const [k, spec] of Object.entries<any>(R?.params ?? {}))
          if (spec.lib) want.add(String(rc.params[k] ?? spec.d ?? spec.lib));
      }
    const lib = new Set(this.libraryList().map((l) => l.split(":")[0]));
    for (const name of want) {
      if (d.assets.some((a) => a.id === name)) continue;
      if (name === "font")
        await this.tool(p, "art-director", t.id, "cast_asset", { name: "font", libraryId: "font-5x8" });
      else if (lib.has(name)) await this.tool(p, "art-director", t.id, "cast_asset", { name, libraryId: name });
    }
    for (const s of b.scenes)
      await this.tool(p, "director", t.id, "scene_set_recipes", {
        scene: s.id,
        recipes: s.recipes,
        reason: `recipes for ${s.title}`,
      });
    // remember what needs drawing
    const pending = b.newAssets.filter((a) => !p.doc().assets.some((x) => x.id === a.name));
    writeFileSync(join(p.dir, "runs", "new-assets.json"), JSON.stringify(pending, null, 1));
    for (const sc of b.scenes) p.setSceneStatus(sc.id, { version: "board", state: "ready" });
  }

  private async art(p: OpenProject, r: Run) {
    const f = join(p.dir, "runs", "new-assets.json");
    const pending: { name: string; kind: string; description: string }[] = existsSync(f)
      ? JSON.parse(readFileSync(f, "utf8"))
      : [];
    const palette = JSON.parse(readFileSync(join(LIBRARY_DIR, "palettes", "pap-night.json"), "utf8"));
    const table = Object.entries<any>(palette.colours)
      .map(([k, v]) => `${k}  ${v.hex}  ${v.use}`)
      .join("\n");
    for (const a of pending) {
      await this.checkpoint(p, r);
      if (p.doc().assets.some((x) => x.id === a.name)) continue;
      const tpl = KIND_TEMPLATES[a.kind] ?? KIND_TEMPLATES.icon;
      const ts = this.task(p, { kind: "asset.spec", role: "art-director", title: `Spec for ${a.name}` });
      const spec = (
        await this.ask(p, r, ts, {
          role: "art-director",
          kind: "asset.spec",
          prompt: "art-director/spec",
          vars: {
            name: a.name,
            description: a.description,
            kind: a.kind,
            template: `${tpl.w}x${tpl.h}, frames ${tpl.frames.join(", ")}. ${tpl.note}`,
            palette: table,
          },
          schema: SpecOut,
        })
      ).data;
      const letters = [...new Set([..."k.", ...spec.letters.replace(/[^A-Za-z]/g, "")])]
        .filter((c) => c !== "." && palette.colours[c])
        .join("");
      this.done(p, ts, { summary: spec.description.slice(0, 200) });
      const nVariants = 2;
      const results = await Promise.all(
        Array.from({ length: nVariants }, (_, v) =>
          this.drawVariant(p, r, a, tpl, spec, letters, table, palette, v + 1).catch((e) => {
            p.emit("log", { level: "warn", role: "pixel-artist", text: `${a.name} v${v + 1} failed: ${e.message}` });
            return null;
          }),
        ),
      );
      const ok = results.filter((x): x is NonNullable<typeof x> => !!x);
      if (!ok.length) {
        const stand = a.kind === "character" ? "mentor-ai" : "items";
        p.emit("log", {
          level: "warn",
          role: "art-director",
          text: `no variant of ${a.name} passed the standard; casting the library's ${stand} instead`,
        });
        await this.tool(p, "art-director", ts.id, "cast_asset", { name: a.name, libraryId: stand });
        continue;
      }
      let best = ok[0];
      if (ok.length > 1) {
        const tj = this.task(p, { kind: "asset.judge", role: "art-director", title: `Choosing the best ${a.name}` });
        const content: ContentPart[] = [];
        for (const [i, x] of ok.entries()) content.push({ type: "text", text: `Variant ${i + 1}:` }, img(x.sheet));
        const j = (
          await this.ask(p, r, tj, {
            role: "art-director",
            kind: "asset.judge",
            prompt: "art-director/judge",
            vars: { name: a.name, description: a.description },
            schema: JudgeOut,
            extra: content,
          })
        ).data;
        best = ok[j.best - 1] ?? ok[0];
        this.done(p, tj, { summary: j.reason });
        best.judge = j.reason;
      }
      // write the asset into the project and cast it
      const grid = Object.fromEntries(best.frames.frames.map((fr) => [fr.name, fr.rows]));
      const file = {
        id: a.name,
        version: 1,
        kind: a.kind,
        w: tpl.w,
        h: tpl.h,
        frames: tpl.frames,
        palette: "pap-night@1",
        tags: [a.kind],
        description: spec.description,
        licence: "LicenseRef-PAP-Library",
        rights: { likeness: false, brand: false, trademark: false, public: true },
        provenance: {
          source: "generated",
          role: "pixel-artist",
          model: best.model,
          provider: best.model.split("/")[0],
          origin: p.id,
          judgeReason: best.judge ?? null,
          promptVersion: "pixel-artist/draw@1",
        },
        hash: randomUUID().slice(0, 16),
        standard: best.std,
        grid,
      };
      mkdirSync(join(p.dir, "assets"), { recursive: true });
      writeFileSync(join(p.dir, "assets", `${a.name}.json`), `${JSON.stringify(file, null, 1)}\n`);
      writeFileSync(join(p.dir, "assets", `${a.name}.png`), best.sheet);
      const d = p.doc();
      await p.patch(
        [
          {
            op: "add",
            path: "/assets/-",
            value: { id: a.name, src: `file:assets/${a.name}.json`, flags: { private: false } },
          },
        ],
        {
          reason: `add the drawn ${a.name}`,
          author: { kind: "agent", role: "art-director" },
          baseRev: d.rev,
        },
      );
    }
  }

  private async drawVariant(
    p: OpenProject,
    r: Run,
    a: { name: string; kind: string; description: string },
    tpl: { w: number; h: number; frames: string[] },
    spec: z.infer<typeof SpecOut>,
    letters: string,
    table: string,
    palette: any,
    v: number,
  ) {
    const t = this.task(p, { kind: "asset.draw", role: "pixel-artist", title: `Drawing ${a.name}, variant ${v}` });
    try {
      const colours = Object.fromEntries(Object.entries<any>(palette.colours).map(([k, x]) => [k, x.hex]));
      const toFile = (fr: DrawOutT) => ({
        id: a.name,
        version: 1,
        kind: a.kind,
        w: tpl.w,
        h: tpl.h,
        frames: tpl.frames,
        palette: "pap-night@1",
        tags: [],
        description: spec.description,
        licence: "LicenseRef-PAP-Library",
        rights: { likeness: false, brand: false, trademark: false, public: true },
        provenance: {},
        hash: "x",
        standard: null,
        grid: Object.fromEntries(fr.frames.map((f) => [f.name, f.rows])),
      });
      const sheetOf = (fr: DrawOutT) =>
        renderSheet(
          tpl.frames.map((n) => fr.frames.find((f) => f.name === n)?.rows ?? []),
          {
            colours,
            gap: 1,
            scale: Math.max(4, Math.min(10, Math.floor(900 / (Math.min(4, tpl.frames.length) * (tpl.w + 2))))),
            columns: Math.min(4, tpl.frames.length),
            bg: palette.sky,
          },
        ) as Uint8Array;
      const shape = (fr: DrawOutT): string[] => {
        const errs: string[] = [];
        for (const n of tpl.frames) {
          const f = fr.frames.find((x) => x.name === n);
          if (!f) errs.push(`frame ${n} missing`);
          else {
            if (f.rows.length !== tpl.h) errs.push(`${n}: ${f.rows.length} rows, need ${tpl.h}`);
            f.rows.forEach((row, y) => {
              if (row.length !== tpl.w) errs.push(`${n} row ${y}: ${row.length} cells, need ${tpl.w}`);
              const bad = [...new Set([...row].filter((c) => c !== "." && !letters.includes(c)))];
              if (bad.length) errs.push(`${n} row ${y}: letters ${bad.join("")} not allowed (use ${letters})`);
            });
          }
        }
        return errs.slice(0, 20);
      };
      let out = await this.ask(p, r, t, {
        role: "pixel-artist",
        kind: "asset.draw",
        prompt: "pixel-artist/draw",
        vars: {
          palette: table,
          name: a.name,
          w: tpl.w,
          h: tpl.h,
          frames: tpl.frames.join(", "),
          letters,
          spec: spec.description,
          example: "",
          variant: v,
        },
        schema: DrawOut,
      });
      for (let fix = 0; fix < 2; fix++) {
        const errs = shape(out.data);
        if (!errs.length) break;
        out = await this.ask(p, r, t, {
          role: "pixel-artist",
          kind: "asset.repair",
          prompt: "pixel-artist/critique",
          vars: {
            name: a.name,
            frames: tpl.frames.join(", "),
            issues: `The grid has errors; fix them first:\n${errs.join("\n")}`,
            reads: spec.reads,
          },
          schema: DrawOut,
          history: out.messages,
        });
      }
      if (shape(out.data).length)
        throw new Error(`grid errors after 2 repairs: ${shape(out.data).slice(0, 3).join("; ")}`);
      // critique rounds against the rendered sheet (vision), stopping when the artist says ship
      const caps = this.deps.gateway.caps(this.deps.gateway.modelFor("pixel-artist", p.doc().crew.models));
      const rounds = caps?.vision === "failed" ? 0 : 1;
      for (let k = 0; k < rounds; k++) {
        await this.checkpoint(p, r);
        p.upsertTask({ ...t, title: `Drawing ${a.name}, variant ${v}, critique ${k + 1}` });
        const std = checkAsset(toFile(out.data), { colours, sky: palette.sky });
        const next = await this.ask(p, r, t, {
          role: "pixel-artist",
          kind: "asset.critique",
          prompt: "pixel-artist/critique",
          vars: {
            name: a.name,
            frames: tpl.frames.join(", "),
            issues: std.hard.length
              ? `The standard checker found:\n${std.hard.map((i) => `${i.frame ?? ""} ${i.message} (fix: ${i.fix})`).join("\n")}`
              : "",
            reads: spec.reads,
          },
          schema: DrawOut,
          history: out.messages,
          images: [{ caption: "Your sprite:", data: sheetOf(out.data) }],
        });
        if (!shape(next.data).length) out = next;
        if (/\bship\b/i.test(next.data.notes)) break;
      }
      const std = checkAsset(toFile(out.data), { colours, sky: palette.sky });
      const sheet = sheetOf(out.data);
      writeFileSync(join(p.dir, "runs", `${a.name}-v${v}.png`), sheet);
      this.done(p, t, {
        summary: `${std.ok ? "passes" : `${std.hard.length} standard issues`}: ${out.data.notes.slice(0, 160)}`,
        lastImage: `/api/p/${p.id}/files/../runs/${a.name}-v${v}.png`,
      });
      if (!std.ok)
        throw new Error(
          `variant ${v} fails the standard: ${std.hard
            .slice(0, 3)
            .map((i) => i.message)
            .join("; ")}`,
        );
      return { frames: out.data, sheet, std, model: t.model ?? "", judge: undefined as string | undefined };
    } catch (e) {
      this.failTask(p, t, e);
      throw e;
    }
  }

  private async sceneStills(p: OpenProject, sceneId: string) {
    const tl = p.timeline();
    const w = tl.scenes.find((s) => s.id === sceneId)!;
    const ts = [w.from + 0.5, (w.from + w.to) / 2, Math.max(w.from, w.to - 0.3)].map((x) => +x.toFixed(2));
    return Promise.all(ts.map(async (t) => ({ caption: `t=${t}s`, data: await p.still(t, 2) })));
  }

  private async animate(p: OpenProject, r: Run) {
    const { recipeCatalog } = await import("@pap/engine/recipes");
    const { lintProject } = await import("@pap/engine/lints");
    const cat = recipeCatalog();
    const d0 = p.doc();
    // on a resume, scenes an animator already finished are not redone
    const scenes = d0.scenes.filter(
      (s) =>
        s.kind === "decl" &&
        !(p.state.sceneStatus[s.id]?.version === "render" && p.state.sceneStatus[s.id]?.state === "ready"),
    );
    // a local vision model takes one request at a time: animate the scenes in turn so the crew shows the truth
    const local =
      this.deps.gateway.caps(this.deps.gateway.modelFor("animator", d0.crew.models))?.local ??
      this.deps.gateway.modelFor("animator", d0.crew.models).startsWith("lmstudio/");
    const queued = new Map(
      scenes.map((s) => [
        s.id,
        this.task(p, { kind: "scene.tune", role: "animator", title: `Animating ${s.title || s.id}`, status: "queued" }),
      ]),
    );
    const one = async (s: (typeof scenes)[number]) => {
      await this.checkpoint(p, r);
      const t = p.upsertTask({ ...queued.get(s.id)!, status: "working", startedAt: new Date().toISOString() });
      p.setSceneStatus(s.id, { version: "animatic", state: "drafting" });
      try {
        const d = p.doc();
        const sc = d.scenes.find((x) => x.id === s.id)!;
        if (sc.kind !== "decl") return this.done(p, t);
        const tl = p.timeline();
        const w = tl.scenes.find((x) => x.id === s.id)!;
        const lints = lintProject(d, tl)
          .filter((l: any) => l.scene === s.id)
          .map((l: any) => `${l.severity}: ${l.message} (fix: ${l.fix})`);
        const notes = p.state.notes.filter((n) => n.target.scene === s.id && n.status === "open");
        const { data } = await this.ask(p, r, t, {
          role: "animator",
          kind: "scene.tune",
          prompt: "animator/tune",
          vars: {
            scene: s.id,
            title: sc.title,
            from: w.from.toFixed(2),
            to: w.to.toFixed(2),
            cues: tl.cues
              .filter((c) => sc.cues.includes(c.id))
              .map((c) => `${c.id} (${c.start.toFixed(2)}-${c.end.toFixed(2)} s): ${c.text}`)
              .join("\n"),
            recipes: sc.recipes.map((x, i) => `${i}: ${x.id} ${JSON.stringify(x.params)}`).join("\n"),
            menu: cat
              .filter((c: any) => sc.recipes.some((x) => x.id === c.id))
              .map((c: any) => ({ id: c.id, params: c.params.properties })),
            notes: notes.length ? notes.map((n) => `${n.id} (${n.category}): ${n.text}`).join("\n") : "(none)",
            lints: lints.length ? lints.join("\n") : "(none)",
          },
          schema: TuneOut,
          images: await this.sceneStills(p, s.id),
        });
        if (data.changes.length) {
          const recipes = sc.recipes.map((x) => ({ ...x, params: { ...x.params } }));
          for (const c of data.changes)
            if (recipes[c.recipe]) recipes[c.recipe].params = { ...recipes[c.recipe].params, ...c.params };
          const res = await this.deps.registry.call(
            "scene_set_recipes",
            {
              scene: s.id,
              recipes,
              reason:
                data.changes
                  .map((c) => c.why)
                  .join("; ")
                  .slice(0, 280) || "tune",
            },
            this.ctx(p, "animator", t.id),
          );
          if (!res.ok)
            p.emit("log", {
              level: "warn",
              role: "animator",
              text: `${s.id}: kept the scene as it was (${res.error.message})`,
            });
        }
        for (const n of notes)
          p.updateNote(n.id, {
            status: "done",
            reason: data.changes.map((c) => c.why).join("; ") || "checked; no change needed",
          });
        this.done(p, t, {
          summary: data.changes.length ? data.changes.map((c) => c.why).join("; ") : "no changes needed",
        });
        p.setSceneStatus(s.id, { version: "render", state: "ready" });
      } catch (e: any) {
        if (r.abort.signal.aborted) throw e;
        // a weak model failing here costs nothing: the scene keeps its recipes as they are
        this.failTask(p, t, e);
        p.emit("log", {
          level: "warn",
          role: "animator",
          text: `${s.id}: kept as built (${String(e?.message ?? e).slice(0, 120)})`,
        });
      }
    };
    if (local) for (const s of scenes) await one(s);
    else await Promise.all(scenes.map(one));
  }

  private async narrateMilestone(p: OpenProject) {
    p.milestone("scenes.animated", "Scenes animated");
  }

  private async narrate(p: OpenProject, r: Run) {
    const d = p.doc();
    if (d.brief.narration !== "user" || d.audio.vo.length) return;
    const q = p.ask(
      {
        kind: "single",
        question: "Record the narration now?",
        why: "Open the Record page: it plays the video with the script as a teleprompter. The crew re-times every scene to your voice.",
        options: [
          { id: "recorded", label: "I recorded it", detail: "Align the newest take and re-time the scenes." },
          { id: "skip", label: "No narration", detail: "Keep captions, sound effects and music only." },
        ],
        recommendedId: "recorded",
        blocks: ["sound"],
        from: "editor",
      },
      "producer",
    );
    const a = await p.waitAnswer(q.id, r.abort.signal);
    if (a.answer?.optionId !== "recorded") return;
    const { readdirSync, statSync } = await import("node:fs");
    const dir = join(p.dir, "private", "vo");
    const takes = existsSync(dir)
      ? readdirSync(dir)
          .map((f) => ({ f, m: statSync(join(dir, f)).mtimeMs }))
          .sort((x, y) => y.m - x.m)
      : [];
    if (!takes.length) return p.emit("log", { level: "warn", text: "no narration take found in private/vo/" });
    const t = this.task(p, { kind: "vo.align", role: "editor", title: "Aligning your narration" });
    await this.tool(p, "editor", t.id, "vo_align", { file: `private/vo/${takes[0].f}`, apply: true });
    this.done(p, t);
  }

  private async sound(p: OpenProject) {
    const d = p.doc();
    const t = this.task(p, { kind: "sound.mix", role: "mixer", title: "Sound effects, music and the mix" });
    try {
      const { VOICE_KEEP } = await import("@pap/engine/audio");
      const keep = d.audio.vo.length ? VOICE_KEEP : null;
      if (JSON.stringify(keep) !== JSON.stringify(d.audio.sfx.keep))
        await this.tool(p, "sound-designer", t.id, "sfx_set", {
          events: d.audio.sfx.events,
          keep,
          reason: keep ? "a voice: keep only key beats" : "no voice: keep every effect",
        });
      if (!p.doc().audio.music)
        await p.patch(
          [{ op: "replace", path: "/audio/music", value: { generator: "chip-bed", settle: d.scenes.at(-1)!.id } }],
          { reason: "a calm chiptune bed", author: { kind: "agent", role: "sound-designer", task: t.id } },
        );
      const res = await this.tool(p, "mixer", t.id, "audio_render", {});
      const m = (res.data as any).mix;
      this.done(p, t, {
        summary: `mix at ${m.lufs.toFixed(1)} LUFS (target ${m.targetLufs}), peak ${m.truePeakDb.toFixed(1)} dB`,
      });
    } catch (e) {
      this.failTask(p, t, e);
      throw e;
    }
  }

  private async review(p: OpenProject, r: Run, auto: boolean) {
    for (let round = 0; round < 2; round++) {
      await this.checkpoint(p, r);
      const t = this.task(p, {
        kind: "review.final",
        role: "reviewer",
        title: round ? "Checking the fixes" : "Reviewing the cut",
      });
      let rev: ReviewOutT;
      try {
        const d = p.doc();
        const tl = p.timeline();
        const ren = await p.renderer_();
        const sheet = await contactSheet(ren, { every: 1 });
        writeFileSync(join(p.dir, "out", "contact.png"), sheet);
        const stills = (await Promise.all(d.scenes.map((s) => this.sceneStills(p, s.id)))).flat();
        rev = (
          await this.ask(p, r, t, {
            role: "reviewer",
            kind: "review.final",
            prompt: "reviewer/final",
            vars: {
              idea: d.brief.idea,
              cues: tl.cues.map((c) => `${c.id} ${c.start.toFixed(1)}-${c.end.toFixed(1)}s: ${c.text}`).join(" | "),
              scenes: tl.scenes.map((s) => `${s.id} ${s.from.toFixed(1)}-${s.to.toFixed(1)}s`).join(", "),
            },
            schema: ReviewOut,
            images: [{ caption: "Contact sheet:", data: sheet }, ...stills],
          })
        ).data;
        this.done(p, t, { summary: `${rev.verdict}: ${rev.summary}` });
      } catch (e: any) {
        if (r.abort.signal.aborted) throw e;
        // no usable review from this model: the lints already passed, so the cut goes on to the gate as it is
        this.failTask(p, t, e);
        p.emit("log", {
          level: "warn",
          role: "reviewer",
          text: `review unavailable (${String(e?.message ?? e).slice(0, 120)}); continuing on lints only`,
        });
        break;
      }
      for (const b of rev.blockers)
        p.addNote({
          target: { scene: b.scene, range: [b.t, b.t] },
          category: "art",
          text: `${b.issue} Fix: ${b.fix}`,
          assignee: "animator",
          by: "reviewer",
        });
      if (rev.verdict === "ship" || !rev.blockers.length || round === 1) break;
      await this.animate(p, r);
    }
    await this.atGate(p, "g3_rough", [{ label: "Rough cut", ref: "out/contact.png" }], auto);
  }

  private async deliver(p: OpenProject, r: Run, auto: boolean) {
    await this.checkpoint(p, r);
    const t = this.task(p, { kind: "deliver.export", role: "editor", title: "Exporting the video" });
    try {
      const res = await this.tool(p, "editor", t.id, "export_video", {});
      this.done(p, t, { summary: `${(res.data as any).file}, ${(res.data as any).seconds.toFixed(1)} s` });
    } catch (e) {
      this.failTask(p, t, e);
      throw e;
    }
    await this.atGate(p, "g4_final", [{ label: "Final video" }], auto);
    // publish new, non-private assets to the public library only with the user's yes
    const fresh = p
      .doc()
      .assets.filter((a) => a.src.startsWith("file:") && !a.flags.private && !a.flags.likeness && !a.flags.brand);
    for (const a of fresh) {
      const file = join(p.dir, a.src.slice(5));
      const asset = JSON.parse(readFileSync(file, "utf8"));
      if (asset.rights?.likeness || asset.rights?.brand || asset.rights?.trademark) continue;
      if (existsSync(join(LIBRARY_DIR, a.id))) continue;
      let yes = auto;
      if (!auto) {
        const q = p.ask(
          {
            kind: "yesno",
            question: `Add "${a.id}" to the public asset library?`,
            why: "Other projects could reuse it. It passed the PAP standard and shows no real person or brand.",
            options: [
              { id: "yes", label: "Yes, publish it", detail: "" },
              { id: "no", label: "Keep it in this project", detail: "" },
            ],
            recommendedId: "yes",
            blocks: [],
            timeoutSec: null,
            from: "librarian",
          },
          "librarian",
        );
        yes = (await p.waitAnswer(q.id, r.abort.signal)).answer?.optionId === "yes";
      }
      if (!yes) continue;
      const t2 = this.task(p, { kind: "lib.publish", role: "librarian", title: `Publishing ${a.id}` });
      mkdirSync(join(LIBRARY_DIR, a.id), { recursive: true });
      writeFileSync(join(LIBRARY_DIR, a.id, "asset.json"), `${JSON.stringify(asset, null, 1)}\n`);
      const png = file.replace(/\.json$/, ".png");
      if (existsSync(png)) writeFileSync(join(LIBRARY_DIR, a.id, "sheet.png"), readFileSync(png));
      const idxF = join(LIBRARY_DIR, "index.json");
      const idx = JSON.parse(readFileSync(idxF, "utf8"));
      idx.assets.push({
        id: a.id,
        kind: asset.kind,
        w: asset.w,
        h: asset.h,
        frames: asset.frames.length,
        tags: asset.tags ?? [],
      });
      writeFileSync(idxF, `${JSON.stringify(idx, null, 1)}\n`);
      this.done(p, t2, { summary: `library/${a.id}` });
    }
  }
}
