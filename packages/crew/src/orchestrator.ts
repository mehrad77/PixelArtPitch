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
import {
  type ChannelMsg,
  type GateId,
  type Note,
  type OpenProject,
  OWNER_STAGE,
  type Registry,
  STAGES,
  type Stage,
  type Task,
  type ToolContext,
  type Workspace,
} from "@pap/tools";
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
  ReboardOut,
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
  assistant: "assistant",
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
export const PHASE: Record<string, number> = {
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
export const STAGE_LINE: Record<string, string> = {
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
  /** a person's change run: only these scenes may be redone (a Reviewer's blockers elsewhere stay as notes) */
  scope?: Set<string>;
  /** the person's change this run makes, if any */
  change?: ChangePlan;
  /** what this run did, for the card that started it */
  done: { redone: Set<string>; reboarded: string[]; approximated: string[]; exported: boolean };
  /** triggers waiting for Pip (handled at the end of the stage) */
  triggers: Trigger[];
  /** redo rounds per scene in this run (the request) */
  redos: Map<string, number>;
  /** Pip put the crew on hold */
  held?: string;
  /** Pip decision rounds in this run */
  thinks?: number;
  /** Pip already asked the person something in this run */
  escalated?: boolean;
};
/** a change run: its notes, the scenes it may redo, the scenes the Director re-plans, and asks no scene carries */
export type ChangePlan = { notes: string[]; scope?: string[]; reboard?: string[] };
/** what a run did, reported when it ends or stops at a gate for the person */
export type RunReport = {
  status: "done" | "failed" | "stopped" | "waiting";
  error?: string;
  /** the change notes this run made (empty when it was a plain run) */
  notes: string[];
  redone: string[];
  reboarded: string[];
  approximated: string[];
  /** Reviewer blockers still open on the scenes the change touched */
  openBlockers: { scene: string; text: string }[];
  exported: boolean;
};
const isEndCard = (sc: { kind: string; recipes?: { id: string }[] }) =>
  sc.kind === "decl" && !!sc.recipes?.some((r) => r.id === "end_card_loop");
/** which scenes a set of change notes touches and which the Director re-plans */
function planChange(p: OpenProject, notes: Note[]): ChangePlan {
  const d = p.doc();
  const all = d.scenes.filter((s) => s.kind === "decl").map((s) => s.id);
  const reboard = new Set<string>();
  const scope = new Set<string>();
  let everywhere = false;
  for (const n of notes) {
    if (n.assignee === "director") {
      // a change for the whole video re-plans every scene but the end card
      const ids = n.target.scene ? [n.target.scene] : d.scenes.filter((s) => !isEndCard(s as any)).map((s) => s.id);
      for (const id of ids) {
        reboard.add(id);
        scope.add(id);
      }
    } else if (n.target.scene) scope.add(n.target.scene);
    else everywhere = true;
  }
  return {
    notes: notes.map((n) => n.id),
    ...(everywhere ? {} : { scope: [...scope] }),
    ...(reboard.size ? { reboard: all.filter((id) => reboard.has(id)) } : {}),
  };
}

/** the gate a stage's work passes through first: reopening a stage reopens this gate and every later one */
const STAGE_GATE: Record<Stage, GateId> = {
  brief: "g0_brief",
  script: "g1_script",
  storyboard: "g2_animatic",
  art: "g3_rough",
  animate: "g3_rough",
  narrate: "g3_rough",
  sound: "g3_rough",
  review: "g3_rough",
  deliver: "g4_final",
};
const GATES: GateId[] = ["g0_brief", "g1_script", "g2_animatic", "g3_rough", "g4_final"];
/** milestones a reopened stage earns again */
const STAGE_MILESTONES: [Stage, string][] = [
  ["script", "writer.angles"],
  ["storyboard", "director.storyboard"],
  ["animate", "scenes.animated"],
  ["sound", "sound.mix"],
  ["review", "review.final"],
  ["deliver", "deliver.export"],
];
/** open change requests for a role, as prompt lines */
const noteLines = (p: OpenProject, role: string) =>
  p.state.notes.filter((n) => n.assignee === role && n.status === "open").map((n) => `${n.id}: ${n.text}`);

/** every crew task ends with a report to Pip (tiny, so weak models fill it; missing means done) */
export const TaskReport = z.object({
  status: z.enum(["done", "partial", "blocked"]).default("done"),
  did: z.string().max(300).default(""),
  couldnt: z.string().max(300).optional(),
  needs: z.string().max(300).optional(),
});
export type TaskReportT = z.infer<typeof TaskReport>;
const REPORT_NOTE =
  'Also return "report": {"status": "done" | "partial" | "blocked", "did": one short line, "couldnt"?: what you could not do and why, "needs"?: what would unblock you}. Use partial or blocked only when you could not do what was asked.';
/** the task's own output plus the optional report */
function withReport<T>(schema: z.ZodType<T>): z.ZodType<T> {
  return schema instanceof z.ZodObject ? (schema.extend({ report: TaskReport.optional() }) as any) : schema;
}

/** what makes Pip think: the only triggers, so cost stays bounded (routine "done" reports are not one) */
export type Trigger =
  | {
      kind: "ask";
      from: RoleT;
      askId: string;
      question: string;
      options: { id: string; label: string }[];
      recommendedId: string;
    }
  | { kind: "report"; from: RoleT; task: string; report: TaskReportT; ref?: string }
  | { kind: "blocker"; scenes: string[]; text: string[]; round: number }
  | { kind: "stage"; stage: Stage; notes: string[] };
/** what Pip can do on a trigger (crew_brief, crew_answer, crew_redo, crew_reboard, crew_next, crew_hold, crew_escalate) */
export type Decision =
  | { kind: "brief"; role: RoleT; text: string; ref?: string }
  | { kind: "answer"; askId: string; text: string; optionId?: string }
  | { kind: "redo"; scenes: string[]; why: string }
  | { kind: "reboard"; scenes: string[]; direction: string }
  | { kind: "next"; why?: string }
  | { kind: "hold"; why: string }
  | { kind: "escalate"; question: string; options?: string[] };
export interface Conductor {
  think(
    p: OpenProject,
    trigger: Trigger,
    ctx: { change?: ChangePlan; redos: Map<string, number> },
  ): Promise<Decision[]>;
}
/** at most this many redo rounds per scene per request */
export const MAX_REDO = 2;

export type CrewDeps = { workspace: Workspace; registry: Registry; gateway: Gateway };

export class Crew {
  private deps: CrewDeps;
  private runs = new Map<string, Run>();
  /** external tools a confirmed card lent to the next task of a role: "<project>:<role>" -> tool names */
  private lendPending = new Map<string, string[]>();
  /** task id -> the external tools it holds; the grant ends with the task */
  private grants = new Map<string, string[]>();
  /** Pip as the orchestrator: thinks on triggers; without it the stage machine's fixed rules apply */
  conductor?: Conductor;
  /** Pip's briefs waiting for a role's next task: "<project>:<role>" */
  private briefs = new Map<string, ChannelMsg[]>();
  /** the last report each task gave */
  private reports = new Map<string, TaskReportT>();
  /** scene.tune task id -> its scene, for report refs */
  private taskScenes = new Map<string, string>();
  private sceneTask(scene: string, t: Task) {
    this.taskScenes.set(t.id, scene);
    return t;
  }

  // ---------------------------------------------------------------- Pip as the orchestrator
  /** ask_pip from outside a run (the tool): Pip answers, or returns null when only the person can */
  async askPipNow(
    p: OpenProject,
    from: RoleT,
    q: { question: string; options: { id: string; label: string }[]; recommendedId: string },
  ) {
    const r =
      this.runs.get(p.id) ??
      ({
        redos: new Map(),
        triggers: [],
        done: { redone: new Set(), reboarded: [], approximated: [], exported: false },
      } as unknown as Run);
    return this.askPip(p, r, from, q);
  }

  /** a member's question goes to Pip first; returns Pip's answer, or null when only the person can answer */
  private async askPip(
    p: OpenProject,
    r: Run,
    from: RoleT,
    q: { question: string; options: { id: string; label: string }[]; recommendedId: string },
  ): Promise<string | null> {
    if (!this.conductor) return null;
    const ask = p.say({ from, to: "pip", kind: "ask", text: q.question });
    const ds = await this.think(p, r, {
      kind: "ask",
      from,
      askId: ask.id,
      question: q.question,
      options: q.options.map((o) => ({ id: o.id, label: o.label })),
      recommendedId: q.recommendedId,
    });
    const a = ds.find((d): d is Extract<Decision, { kind: "answer" }> => d.kind === "answer");
    if (!a) {
      p.say({
        from: "pip",
        to: from,
        kind: "answer",
        text: "Only the person can answer that: I've asked them.",
        replyTo: ask.id,
      });
      return null;
    }
    const label = q.options.find((o) => o.id === a.optionId)?.label;
    p.say({ from: "pip", to: from, kind: "answer", text: a.text || label || "", replyTo: ask.id });
    return label ? `${label}${a.text ? ` (${a.text})` : ""}` : a.text;
  }

  /** one Pip decision round on a trigger; bounded per run, and the fixed rules when there is no conductor */
  private async think(p: OpenProject, r: Run, tr: Trigger): Promise<Decision[]> {
    if (!this.conductor) return [];
    r.thinks = (r.thinks ?? 0) + 1;
    if (r.thinks > 12) return [{ kind: "hold", why: "the crew needed Pip more than 12 times in one run" }];
    try {
      return await this.conductor.think(p, tr, { change: r.change, redos: r.redos });
    } catch (e: any) {
      p.emit("log", { level: "warn", text: `Pip couldn't decide (${String(e?.message ?? e).slice(0, 120)}); holding` });
      return [{ kind: "hold", why: "Pip couldn't reach its model to decide what to do next" }];
    }
  }

  /** apply Pip's decisions; returns whether any scene was redone */
  private async apply(p: OpenProject, r: Run, ds: Decision[]): Promise<{ redid: boolean }> {
    let redid = false;
    const redoable = (ids: string[]) => {
      const ok = ids.filter((id) => (r.redos.get(id) ?? 0) < MAX_REDO && p.doc().scenes.some((s) => s.id === id));
      for (const id of ok) r.redos.set(id, (r.redos.get(id) ?? 0) + 1);
      return { ok, over: ids.filter((id) => !ok.includes(id)) };
    };
    for (const d of ds) {
      if (d.kind === "brief") {
        const m = p.say({ from: "pip", to: d.role, kind: "brief", text: d.text, ref: d.ref });
        const key = `${p.id}:${d.role}`;
        this.briefs.set(key, [...(this.briefs.get(key) ?? []), m]);
      } else if (d.kind === "redo" || d.kind === "reboard") {
        const { ok, over } = redoable(d.scenes);
        if (over.length)
          ds.push({ kind: "hold", why: `${over.join(", ")} already had ${MAX_REDO} redo rounds for this request` });
        if (!ok.length) continue;
        if (d.kind === "reboard") {
          const m = p.say({
            from: "pip",
            to: "director",
            kind: "brief",
            text: `Re-plan ${ok.join(", ")}: ${d.direction}`,
            ref: ok[0],
          });
          this.briefs.set(`${p.id}:director`, [...(this.briefs.get(`${p.id}:director`) ?? []), m]);
          await this.reboard(p, r, ok);
        } else {
          const m = p.say({
            from: "pip",
            to: "animator",
            kind: "brief",
            text: `Redo ${ok.join(", ")}: ${d.why}`,
            ref: ok[0],
          });
          this.briefs.set(`${p.id}:animator`, [...(this.briefs.get(`${p.id}:animator`) ?? []), m]);
        }
        for (const id of ok) if (p.state.sceneStatus[id]) p.setSceneStatus(id, { version: "animatic", state: "stale" });
        await this.animate(p, r);
        redid = true;
      } else if (d.kind === "next") {
        if (d.why) p.say({ from: "pip", to: "crew", kind: "brief", text: `On track: ${d.why}` });
      } else if (d.kind === "escalate") {
        // one question to the person per run: a second trigger about the same trouble doesn't ask again
        if (r.escalated) continue;
        r.escalated = true;
        const opts = (d.options?.length ? d.options : ["Yes", "No"]).slice(0, 6);
        p.ask(
          {
            kind: "single",
            question: d.question.slice(0, 200),
            why: "The crew asked Pip, and only you can answer this.",
            options: opts.map((o, i) => ({ id: `o${i + 1}`, label: o.slice(0, 80), detail: "" })),
            recommendedId: "o1",
            from: "pip",
          },
          "pip",
        );
        p.say({ from: "pip", to: "crew", kind: "brief", text: `Asked the person: ${d.question}` });
      } else if (d.kind === "hold" && !r.held) {
        r.held = d.why;
        p.say({ from: "pip", to: "crew", kind: "brief", text: `Hold: ${d.why}` });
      }
    }
    if (r.held && !r.paused) {
      // stop and tell the person; the cards that handed work to this run settle now
      p.setStatus({ line: `Waiting for you: ${r.held}` });
      try {
        this.onRunEnd?.(p, this.report(p, r, "waiting"));
      } catch {}
      r.paused = true;
      p.state.paused = true;
      p.saveState();
    }
    return { redid };
  }

  /** the end of a stage: Pip's triggers, and one "on track?" check only when something needs judgment */
  private async drain(p: OpenProject, r: Run, stage: Stage) {
    if (!this.conductor) {
      r.triggers = [];
      return;
    }
    // a person's note this stage owns that is still open: the stage didn't do it
    const open = p.state.notes.filter(
      (n) => n.by === "user" && n.status === "open" && OWNER_STAGE[n.assignee] === stage && n.createdAt >= r.startedAt,
    );
    if (!r.triggers.length && open.length) r.triggers.push({ kind: "stage", stage, notes: open.map((n) => n.text) });
    while (r.triggers.length && !r.held) await this.apply(p, r, await this.think(p, r, r.triggers.shift()!));
    r.triggers = [];
  }
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
      /** whether a crew is working on this project in this process right now, and what it waits on */
      crew: {
        running: this.runs.has(p.id),
        paused: p.state.paused,
        stage: p.state.stage,
        lastActiveAt:
          p.state.tasks
            .map((t) => t.endedAt ?? t.startedAt ?? "")
            .sort()
            .at(-1) || null,
        queued: p.state.tasks.filter((t) => t.status === "queued").length,
      },
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

  /**
   * A person's change (crew_request_change). The note is already added. While a crew works on the project nothing
   * is touched: the note waits for the next review, and once that run ends any change still open reopens its stage.
   * When idle, the owner's stage is reopened (its scene marked stale, later gates reopened, the old export marked
   * superseded) and the crew runs from there, unless the person paused it.
   */
  requestChange(p: OpenProject, note: Note, extra: Note[] = []): { queued: boolean; stage: Stage; started: boolean } {
    const stage = OWNER_STAGE[note.assignee] ?? "review";
    if (this.runs.has(p.id)) {
      p.emit("log", { level: "info", text: `${note.id} waits for the next review: the crew is working` });
      return { queued: true, stage, started: false };
    }
    const notes = [note, ...extra];
    // the change goes to its owner as a brief from Pip (the note itself reaches the owner's prompt)
    p.say({
      from: "pip",
      to: note.assignee,
      kind: "brief",
      text: `The person asked: ${note.text}`,
      ref: note.target.scene ?? note.id,
    });
    for (const n of extra)
      p.say({
        from: "pip",
        to: n.assignee,
        kind: "brief",
        text: `Also fix: ${n.text.slice(0, 240)}`,
        ref: n.target.scene ?? n.id,
      });
    const from = this.reopen(p, notes);
    const change = planChange(p, notes);
    p.state.change = { ...change, startedAt: new Date().toISOString() };
    p.saveState();
    if (p.state.paused) return { queued: false, stage: from, started: false };
    this.run(p, { stage: from, change }).catch(() => {});
    return { queued: false, stage: from, started: true };
  }

  /** called when a run ends, or stops at a gate for the person, with what it did (Pip settles its cards) */
  onRunEnd?: (p: OpenProject, report: RunReport) => void;

  private report(p: OpenProject, r: Run, status: RunReport["status"], error?: string): RunReport {
    const scope = r.scope;
    return {
      status,
      ...(error ? { error } : {}),
      notes: r.change?.notes ?? [],
      redone: [...r.done.redone],
      reboarded: r.done.reboarded,
      approximated: r.done.approximated,
      openBlockers: p.state.notes
        .filter(
          (n) =>
            n.by === "reviewer" &&
            n.status === "open" &&
            n.createdAt >= r.startedAt &&
            (!scope || (n.target.scene && scope.has(n.target.scene))),
        )
        .map((n) => ({ scene: n.target.scene ?? "", text: n.text })),
      exported: r.done.exported,
    };
  }

  /** reopen the earliest stage the open notes need; returns the stage the crew should run from */
  private reopen(p: OpenProject, notes: Note[]): Stage {
    const order = STAGES;
    const owners = notes.map((n) => OWNER_STAGE[n.assignee] ?? "review");
    let from = owners.reduce((a, b) => (order.indexOf(b) < order.indexOf(a) ? b : a));
    // a project that never got this far just carries on; the note is read when the stage comes
    if (order.indexOf(p.state.stage) < order.indexOf(from)) from = p.state.stage;
    for (const n of notes)
      for (const id of n.target.scene
        ? [n.target.scene]
        : n.assignee === "animator"
          ? Object.keys(p.state.sceneStatus)
          : [])
        if (p.state.sceneStatus[id]) p.setSceneStatus(id, { version: "animatic", state: "stale" });
    for (const g of GATES.slice(GATES.indexOf(STAGE_GATE[from])))
      if (p.state.gates.find((x) => x.id === g)?.status !== "locked")
        p.setGate(g, { status: "locked", verdict: undefined });
    for (const t of p.state.tasks)
      if (t.kind === "deliver.export" && t.status === "done" && !t.supersededBy)
        p.upsertTask({ ...t, supersededBy: `change:${notes.map((n) => n.id).join(",")}` });
    const again = new Set(STAGE_MILESTONES.filter(([s]) => order.indexOf(s) >= order.indexOf(from)).map(([, m]) => m));
    if (p.state.milestones.some((m) => again.has(m.id))) {
      p.state.milestones = p.state.milestones.filter((m) => !again.has(m.id));
      p.saveState();
    }
    p.setStage(from);
    p.setStatus({ phase: PHASE[from] ?? 0, line: "The crew is making your change", problem: undefined });
    return from;
  }

  /** lend external tools to the next task of `role` on this project (from a confirmed Pip card) */
  lend(p: OpenProject, role: string, tools: string[]) {
    if (tools.length) this.lendPending.set(`${p.id}:${role}`, [...tools]);
  }
  /** the external tools a task may use: only what was lent to it, never a role's default */
  lentTools(taskId: string): string[] {
    return this.grants.get(taskId) ?? [];
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
        const { startedAt: _s, ...change } = p.state.change ?? ({} as any);
        this.run(p, { stage: p.state.stage, ...(p.state.change ? { change } : {}) }).catch(() => {});
        out.push(id);
      } catch {}
    }
    return out;
  }

  async run(p: OpenProject, opts: { stage?: string; change?: ChangePlan } = {}) {
    if (this.runs.has(p.id)) throw new Error("the crew is already working on this project");
    const r: Run = {
      abort: new AbortController(),
      paused: false,
      startedAt: p.state.change?.startedAt && opts.change ? p.state.change.startedAt : new Date().toISOString(),
      ...(opts.change ? { change: opts.change } : {}),
      ...(opts.change?.scope ? { scope: new Set(opts.change.scope) } : {}),
      done: { redone: new Set(), reboarded: [], approximated: [], exported: false },
      triggers: [],
      redos: new Map(),
    };
    this.runs.set(p.id, r);
    p.state.startedAt ??= r.startedAt;
    p.state.paused = false;
    p.state.running = true;
    p.saveState();
    p.setDigest("The crew is working.");
    p.setStatus({ line: "The crew is working", problem: undefined });
    let finished = false;
    let outcome: { status: RunReport["status"]; error?: string } = { status: "stopped" };
    try {
      await this.pipeline(p, r, (opts.stage as Stage) ?? p.state.stage);
      finished = true;
      outcome = { status: "done" };
    } catch (e: any) {
      if (e instanceof Paused || r.abort.signal.aborted) p.emit("log", { level: "info", text: "crew stopped" });
      else {
        outcome = {
          status: "failed",
          error: `${String(e?.message ?? e).slice(0, 300)}${e?.fix ? ` Fix: ${e.fix}` : ""}`,
        };
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
      if (outcome.status !== "stopped") delete p.state.change;
      p.saveState();
      try {
        this.onRunEnd?.(p, this.report(p, r, outcome.status, outcome.error));
      } catch {}
      // changes the person asked for while this run worked, and that no review picked up: their stage reopens now
      // (only notes made during this run, so a change no stage can read never loops)
      const left = p.state.notes.filter((n) => n.status === "open" && n.by === "user" && n.createdAt >= r.startedAt);
      if (finished && left.length && !p.state.paused) {
        const from = this.reopen(p, left);
        const change = planChange(p, left);
        p.state.change = { ...change, startedAt: new Date().toISOString() };
        p.saveState();
        setTimeout(() => this.run(p, { stage: from, change }).catch(() => {}), 0);
      }
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
    const made = p.upsertTask({
      id: randomUUID().slice(0, 8),
      usd: 0,
      status: "working",
      startedAt: new Date().toISOString(),
      ...t,
    });
    const key = `${p.id}:${made.role}`;
    const lent = this.lendPending.get(key);
    if (lent) {
      this.lendPending.delete(key);
      this.grants.set(made.id, lent);
      p.log(made.id, { kind: "step", title: `Lent for this task only: ${lent.join(", ")}` });
    }
    return made;
  }
  private done(p: OpenProject, t: Task, patch: Partial<Task> = {}) {
    this.grants.delete(t.id);
    const rep = this.reports.get(t.id);
    if (rep) {
      this.reports.delete(t.id);
      const did = rep.did || patch.summary || t.summary || t.title;
      const ref = this.taskScenes.get(t.id) ?? t.id;
      p.say({
        from: t.role,
        to: "pip",
        kind: "report",
        text: `${rep.status}: ${did.slice(0, 240)}${rep.couldnt ? ` Couldn't: ${rep.couldnt}` : ""}${rep.needs ? ` Needs: ${rep.needs}` : ""}`,
        ref,
      });
      // routine "done" reports are not triggers
      if (rep.status !== "done")
        this.runs
          .get(p.id)
          ?.triggers.push({ kind: "report", from: t.role as RoleT, task: t.id, report: { ...rep, did }, ref });
    }
    const m = MILESTONE[t.kind];
    if (m) p.milestone(t.kind, m, patch.lastImage ?? t.lastImage);
    return p.upsertTask({ ...t, status: "done", endedAt: new Date().toISOString(), ...patch });
  }
  private failTask(p: OpenProject, t: Task, e: any) {
    this.grants.delete(t.id);
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
    // Pip's briefs for this role go on this task card, as high priority as the person's notes
    const key = `${p.id}:${o.role}`;
    const briefs = this.briefs.get(key) ?? [];
    this.briefs.delete(key);
    for (const b of briefs) p.log(t.id, { kind: "step", title: `Brief from Pip: ${b.text.slice(0, 200)}` });
    const userText =
      fill(c.user, o.vars) +
      (briefs.length
        ? `\n\nDirection from Pip (as important as the person's notes):\n${briefs.map((b) => `- ${b.text}`).join("\n")}`
        : "");
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
        system: `${fill(c.system, o.vars)}\n${REPORT_NOTE}`,
        messages,
        schema: withReport(o.schema),
        jsonSchema: js(withReport(o.schema)),
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
    const { report, ...rest } = (out.data ?? {}) as T & { report?: unknown };
    const rep = TaskReport.safeParse(report ?? {});
    this.reports.set(t.id, rep.success ? rep.data : { status: "done", did: "" });
    return {
      data: (o.schema instanceof z.ZodObject ? rest : out.data) as T,
      messages: [...messages, { role: "assistant", content: JSON.stringify(out.data) }],
    };
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
      if (stage === "storyboard") {
        // a person's change re-plans only its scenes; the rest of the board stays
        if (r.change?.reboard?.length) await this.reboard(p, r, r.change.reboard);
        else await this.storyboard(p, r, auto);
      }
      if (stage === "art") await this.art(p, r);
      if (stage === "animate") {
        await this.animate(p, r);
        await this.narrateMilestone(p);
      }
      if (stage === "narrate") await this.narrate(p, r);
      if (stage === "sound") await this.sound(p);
      if (stage === "review") await this.review(p, r, auto);
      if (stage === "deliver") await this.deliver(p, r, auto);
      await this.drain(p, r, stage);
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
        // members never ask the person directly: Pip answers what it can, and escalates what only the person knows
        const fromPip = await this.askPip(p, r, "producer", q);
        if (fromPip) {
          notes.push({ by: "pip", text: `${q.question} → ${fromPip}` });
          continue;
        }
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
            notes: [...d.notes.map((n) => n.text), ...noteLines(p, "writer").map((l) => `change requested: ${l}`)],
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
      for (const n of p.state.notes.filter((x) => x.assignee === "writer" && x.status === "open"))
        p.updateNote(n.id, { status: "done", reason: "the Writer rewrote the script with it" });
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
      const asks = noteLines(p, "director");
      const vars = {
        idea: asks.length ? `${d.brief.idea}\n\nChanges the person asked for:\n- ${asks.join("\n- ")}` : d.brief.idea,
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
      for (const n of p.state.notes.filter((x) => x.assignee === "director" && x.status === "open"))
        p.updateNote(n.id, { status: "done", reason: "the Director re-planned the scenes with it" });
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
    const planned = new Set(b.newAssets.map((a) => a.name));
    await this.castFor(p, t, b.scenes, planned, async () => {
      for (const s of b.scenes)
        await this.tool(p, "director", t.id, "scene_set_recipes", {
          scene: s.id,
          recipes: s.recipes,
          reason: `recipes for ${s.title}`,
        });
    });
    // remember what needs drawing
    const pending = b.newAssets.filter((a) => !p.doc().assets.some((x) => x.id === a.name));
    writeFileSync(join(p.dir, "runs", "new-assets.json"), JSON.stringify(pending, null, 1));
    for (const sc of b.scenes) p.setSceneStatus(sc.id, { version: "board", state: "ready" });
  }

  /** cast the library assets the recipes name (and the font), set the recipes, then the fixed ids they draw */
  private async castFor(
    p: OpenProject,
    t: Task,
    scenes: { recipes: { id: string; params: Record<string, unknown> }[] }[],
    planned: Set<string>,
    setRecipes: () => Promise<void>,
  ) {
    // cast library assets the recipes use, and the font
    const d = p.doc();
    const b = { scenes };
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
    await setRecipes();
    // the compiled scenes draw fixed-id assets no param names (flag_raise's castle, the backdrop's moon, skyline and
    // tiles): cast every one the library has, or frame() draws a placeholder box
    const { missingAssets } = await import("@pap/engine/lints");
    for (const m of missingAssets(p.doc(), p.timeline().at, lib))
      if (m.libraryId && !planned.has(m.id) && !p.doc().assets.some((a) => a.id === m.id))
        await this.tool(p, "art-director", t.id, "cast_asset", { name: m.id, libraryId: m.libraryId });
  }

  /**
   * A person's change that adds beats (characters, actors, a new moment): the Director re-plans only these scenes
   * from the recipe menu and the library, with the change in its prompt; the rest of the board stays. Missing
   * library assets are cast. What the menu can only approximate is reported back to the person.
   */
  private async reboard(p: OpenProject, r: Run, ids: string[]) {
    const t = this.task(p, {
      kind: "director.storyboard",
      role: "director",
      title: `Re-planning ${ids.length === 1 ? "a scene" : `${ids.length} scenes`} for your change`,
    });
    try {
      const { recipeCatalog, checkRecipeParams } = await import("@pap/engine/recipes");
      const d = p.doc();
      const notes = p.state.notes.filter(
        (n) => n.assignee === "director" && n.status === "open" && (!n.target.scene || ids.includes(n.target.scene)),
      );
      const recipes = recipeCatalog()
        .map((x: any) => {
          const ps = Object.entries<any>(x.params.properties).map(
            ([k, v]) =>
              `${k}${x.params.required.includes(k) ? "*" : ""}: ${v.type}${v.default !== undefined ? ` = ${JSON.stringify(v.default)}` : ""}`,
          );
          return `- ${x.id} (min ${x.minDurationSec}s): ${x.description} Params: ${ps.join("; ")}`;
        })
        .join("\n");
      const board = d.scenes
        .map(
          (sc) =>
            `${sc.id}${ids.includes(sc.id) ? " (re-plan)" : ""}: ${sc.cues.join(", ")}; ${
              sc.kind === "decl" ? sc.recipes.map((x) => `${x.id} ${JSON.stringify(x.params)}`).join(", ") : "code"
            }`,
        )
        .join("\n");
      const cueText = d.script.cues.map((c) => `${c.id}: ${c.text}`).join("\n");
      const lib = this.libraryList();
      const known = new Set([...lib.map((l) => l.split(":")[0]), ...d.assets.map((a) => a.id), "font"]);
      const vars = {
        change: notes.map((n) => n.text).join("\n") || "(see the notes)",
        targets: ids.join(", "),
        board: `${board}\n\nCues:\n${cueText}`,
        recipes,
        assets: lib.join("\n"),
      };
      const tl = p.timeline();
      const check = (o: z.infer<typeof ReboardOut>) => {
        const issues: string[] = [];
        for (const sc of o.scenes) {
          if (!ids.includes(sc.id)) issues.push(`${sc.id} is not one of the scenes to re-plan (${ids.join(", ")})`);
          sc.recipes.forEach((rc, k) => {
            for (const x of checkRecipeParams(rc.id, rc.params, tl.at, `${sc.id}.recipes[${k}]`))
              issues.push(`${x.path}: ${x.message} (fix: ${x.fix})`);
            for (const [key, v] of Object.entries(rc.params))
              if (
                typeof v === "string" &&
                /^(asset|actor|hero|who|sprite|item|prop|crowd)/i.test(key) &&
                /^[a-z][a-z0-9_-]*$/.test(v) &&
                !known.has(v)
              )
                issues.push(
                  `${sc.id}.recipes[${k}].params.${key}: "${v}" is not in the asset list (fix: use a listed asset)`,
                );
          });
        }
        for (const id of ids) if (!o.scenes.some((x) => x.id === id)) issues.push(`scene ${id} is missing`);
        return issues;
      };
      let out = await this.ask(p, r, t, {
        role: "director",
        kind: "director.storyboard",
        prompt: "director/reboard",
        vars,
        schema: ReboardOut,
      });
      let issues = check(out.data);
      if (issues.length) {
        out = await this.ask(p, r, t, {
          role: "director",
          kind: "director.repair",
          prompt: "director/reboard",
          vars: {
            ...vars,
            change: `${vars.change}\n\nYour last answer had these problems; fix them:\n- ${issues.join("\n- ")}`,
          },
          schema: ReboardOut,
          history: out.messages,
        });
        issues = check(out.data);
      }
      // scenes still wrong keep their recipes; the rest are applied
      const bad = new Set(issues.map((i) => i.split(/[.: ]/)[0]));
      const good = out.data.scenes.filter((sc) => ids.includes(sc.id) && !bad.has(sc.id));
      await this.castFor(p, t, good, new Set(), async () => {
        for (const sc of good)
          await this.tool(p, "director", t.id, "scene_set_recipes", {
            scene: sc.id,
            recipes: sc.recipes,
            reason: `re-planned for the person's change: ${vars.change.slice(0, 200)}`,
          });
      });
      for (const sc of good) p.setSceneStatus(sc.id, { version: "board", state: "ready" });
      r.done.reboarded.push(...good.map((x) => x.id));
      const approx = out.data.approximated.trim();
      if (approx) r.done.approximated.push(approx);
      if (good.length < ids.length)
        r.done.approximated.push(
          `The Director's plan for ${ids.filter((x) => !good.some((g) => g.id === x)).join(", ")} didn't fit the menu, so those scenes stayed as they were.`,
        );
      // a note with no scene is done here; a scene's note goes on to that scene's Animator
      for (const n of notes)
        if (!n.target.scene)
          p.updateNote(n.id, { status: "done", reason: approx || `re-planned ${good.map((x) => x.id).join(", ")}` });
      p.setGate("g2_animatic", {
        status: "passed",
        verdict: { by: "producer", verdict: "approve", note: "a person's change", at: new Date().toISOString() } as any,
      });
      this.done(p, t, {
        summary: `${good.map((x) => `${x.id}: ${p.doc().scenes.find((s) => s.id === x.id)?.kind === "decl" ? x.recipes.map((y) => y.id).join("+") : ""}`).join("; ")}${approx ? `. Approximated: ${approx}` : ""}`,
      });
    } catch (e) {
      this.failTask(p, t, e);
      throw e;
    }
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
    const { lintFrames, lintProject } = await import("@pap/engine/lints");
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
        this.sceneTask(
          s.id,
          this.task(p, {
            kind: "scene.tune",
            role: "animator",
            title: `Animating ${s.title || s.id}`,
            status: "queued",
          }),
        ),
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
        // exact text widths, real actor boxes and drawn frames need the project's assets and palette
        const lp = p.project();
        const ren = await p.renderer_();
        const lints = [
          ...lintProject(d, tl, { assets: lp.assets, colours: lp.palette.colours, sky: lp.palette.sky }),
          ...(await lintFrames(tl, (x) => ren.frame(x), 1, { sky: lp.palette.sky, fadeOut: d.composition.fadeOut })),
        ]
          .filter((l: any) => l.scene === s.id)
          .filter(
            (l: any, i: number, all: any[]) => all.findIndex((o) => o.rule === l.rule && o.message === l.message) === i,
          )
          .map((l: any) => `${l.severity}: ${l.message} (fix: ${l.fix})`);
        const notes = p.state.notes.filter((n) => n.target.scene === s.id && n.status === "open");
        // a change for the whole video (a note with no scene) reaches every scene it re-plans
        const asks = (r.change?.notes ?? [])
          .map((id) => p.state.notes.find((n) => n.id === id))
          .filter((n): n is Note => !!n && !n.target.scene && (!r.scope || r.scope.has(s.id)));
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
            notes:
              notes.length || asks.length
                ? [...notes, ...asks].map((n) => `${n.id} (${n.category}): ${n.text}`).join("\n")
                : "(none)",
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
        r.done.redone.add(s.id);
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
    // changes the person asked for while the crew worked: their scenes are redone before the review looks
    const asked = [
      ...new Set(
        p.state.notes
          .filter((n) => n.assignee === "animator" && n.status === "open" && n.by === "user" && n.target.scene)
          .map((n) => n.target.scene!),
      ),
    ];
    if (asked.length) {
      for (const s of asked) if (p.state.sceneStatus[s]) p.setSceneStatus(s, { version: "animatic", state: "stale" });
      await this.animate(p, r);
    }
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
              idea: noteLines(p, "producer").length
                ? `${d.brief.idea}\n\nThe person asked for these changes; check the cut does them:\n- ${noteLines(p, "producer").join("\n- ")}`
                : d.brief.idea,
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
      for (const n of p.state.notes.filter((x) => x.assignee === "producer" && x.status === "open" && x.by === "user"))
        p.updateNote(n.id, { status: "picked_up", reason: "the Reviewer checked the cut against it" });
      // in a person's change run, only the changed scenes are redone; other blockers wait as notes
      const redo = rev.blockers.filter((b) => !r.scope || r.scope.has(b.scene));
      if (rev.verdict === "ship" || !redo.length || round === 1) break;
      // a blocker on a scene the person asked to change: Pip decides (redo, re-board, or hold)
      if (this.conductor && r.change) {
        const ds = await this.think(p, r, {
          kind: "blocker",
          scenes: [...new Set(redo.map((b) => b.scene))],
          text: redo.map((b) => `${b.scene}: ${b.issue}`),
          round,
        });
        const { redid } = await this.apply(p, r, ds);
        if (!redid || r.held) break;
        continue;
      }
      // the blockers' scenes are redone (animate skips scenes that are ready)
      for (const b of redo)
        if (p.state.sceneStatus[b.scene]) p.setSceneStatus(b.scene, { version: "animatic", state: "stale" });
      await this.animate(p, r);
    }
    // a person's change: blockers left on its scenes after the one fix round stop the crew here for the person
    const left = r.change ? this.report(p, r, "waiting").openBlockers : [];
    if (left.length) {
      const g = "g3_rough";
      p.setGate(g, {
        status: "open",
        items: [
          { label: "Rough cut", ref: "out/contact.png" },
          ...left.slice(0, 4).map((b) => ({ label: `Still wrong in ${b.scene}: ${b.text.slice(0, 120)}` })),
        ],
      });
      p.setStatus({
        line: `Waiting for you: the Reviewer still sees ${left.length} problem${left.length === 1 ? "" : "s"} in the scenes you changed`,
      });
      try {
        this.onRunEnd?.(p, this.report(p, r, "waiting"));
      } catch {}
      await new Promise<unknown>((res) => this.gateWaiters.set(`${p.id}:${g}`, res));
      return;
    }
    await this.atGate(p, "g3_rough", [{ label: "Rough cut", ref: "out/contact.png" }], auto);
  }

  private async deliver(p: OpenProject, r: Run, auto: boolean) {
    await this.checkpoint(p, r);
    const t = this.task(p, { kind: "deliver.export", role: "editor", title: "Exporting the video" });
    try {
      const res = await this.tool(p, "editor", t.id, "export_video", {});
      r.done.exported = true;
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
