// The crew. Code runs a production plan (docs/PIP-ORCHESTRATION.md): the rules planner writes today's stage machine out
// as plan tasks, the executor (plan/executor.ts) runs them as their dependencies finish, and each task kind's handler
// below wraps what used to be a stage of the pipeline. Models make small, schema-bound choices inside the handlers:
//   brief (Producer plan, questions, G0) -> script (Writer's 3 angles, G1 pick) -> storyboard (Director picks recipes,
//   Art Director casts) -> animatic (rendered at G2) -> art (per new asset: spec, two drawings, judge; a logo is
//   imported) -> animate (one Animator per scene) -> narrate -> sound + mix (tools) -> review (one round per task, a
//   redo round after blockers) -> rough cut (G3) -> deliver (export, G4) -> publish (opt-in, never private assets).
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { extname, join } from "node:path";
import { RECIPE_MAP } from "@pap/engine/recipes";
import { checkAsset } from "@pap/engine/standard";
import { contactSheet, libraryAssetDir, libraryFile, libraryIndex, publishAsset, renderSheet } from "@pap/render";
import type { RoleT } from "@pap/schema";
import {
  type ChannelMsg,
  changeOwner,
  cutWords,
  type GateId,
  type Note,
  type OpenProject,
  OWNER_STAGE,
  type QuestionT,
  type Registry,
  STAGES,
  type Stage,
  StoreError,
  type Task,
  type ToolContext,
  type Workspace,
} from "@pap/tools";
import { z } from "zod";
import type { Gateway } from "./gateway.ts";
import { errorKind, holdsRun } from "./llm/http.ts";
import type { ChatMessage, ContentPart } from "./llm/types.ts";
import {
  AnglesOut,
  type AssetKindT,
  artistIssues,
  DrawOut,
  type DrawOutT,
  JudgeOut,
  PlanOut,
  ReboardOut,
  ReviewOut,
  type ReviewOutT,
  SpecOut,
  StoryboardOut,
  TuneOut,
  templateFor,
} from "./outputs.ts";
import { CATALOGUE, stageOf, taskLabel } from "./plan/catalogue.ts";
import { envOf, estimatePlanTask, isLive, type PlanEnv, planEstimate, resolveTier } from "./plan/estimate.ts";
import { Executor, type Outcome } from "./plan/executor.ts";
import { logoIcon } from "./plan/import.ts";
import { aboutText, type Instance, InstanceTracker } from "./plan/instances.ts";
import { applyDiff, type PipRevisionResult, pipRevision, planPromptVars } from "./plan/pip.ts";
import {
  addReboard,
  addRedo,
  addReviewRound,
  changeRevision,
  expandPlan,
  finishWithin,
  hasArt,
  type NewAsset,
  type RulesCtx,
  realRemaining,
  reopenFrom,
  rerun,
  startPlan,
  suggestCap,
  type TrimT,
  trimWords,
  variantsOf,
} from "./plan/rules.ts";
import type { PlanDiffOutT, PlanOpT, PlanRevisionT, PlanTaskT, PlanView, ProductionPlanT } from "./plan/schema.ts";
import {
  loadPlan,
  MAX_PIP_PROPOSALS,
  MAX_REVISIONS_PER_RUN,
  revise,
  revisionSummaries,
  tasksToStart,
  touch,
  viewOf,
} from "./plan/store.ts";
import { validate as validatePlan } from "./plan/validate.ts";
import { card, fill } from "./prompts.ts";

const js = (s: z.ZodType) => z.toJSONSchema(s, { io: "input", unrepresentable: "any" }) as Record<string, unknown>;
const img = (data: Uint8Array, mediaType: "image/png" | "image/jpeg" = "image/png"): ContentPart => ({
  type: "image",
  mediaType,
  data: Buffer.from(data).toString("base64"),
});
const MEDIA: Record<string, "image/png" | "image/jpeg"> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
};
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
const PROVIDER_WORD: Record<string, string> = {
  anthropic: "Anthropic",
  openai: "OpenAI",
  openrouter: "OpenRouter",
  lmstudio: "LM Studio",
  ollama: "Ollama",
  llamacpp: "llama.cpp",
};
/** "anthropic" → "Anthropic"; an unknown id stays as it is */
/**
 * Pip's channel line for a hold, as a plain sentence: "Paused the crew: your Anthropic key was rejected." A leading
 * "Your"/"The" goes lower case; a name ("Anthropic") keeps its capital.
 */
export function pausedLine(why: string): string {
  const w = why.trim().replace(/^Waiting for you: /, "");
  const low = /^(Your|The|A|An|This|It|Every|No)\b/.test(w) ? w.charAt(0).toLowerCase() + w.slice(1) : w;
  return `Paused the crew: ${/[.?!]$/.test(low) ? low : `${low}.`}`;
}
/** the hold's question: "The crew is waiting: your fake key was rejected. What should it do?" (5-200 characters) */
export function holdQuestion(why: string): string {
  const w = pausedLine(why).replace(/^Paused the crew: /, "");
  return `The crew is waiting: ${cutWords(w, 160)} What should it do?`;
}
export type HoldOption = { id: string; label: string; detail: string };
/**
 * A hold's options (§1.8). A provider hold: Fix the key · Try again. A hold about scenes: Redo with the Director ·
 * Accept the look · Tell Pip what to change. Any other: Carry on · Tell Pip what to change. `scenes` are the person's
 * words for them ("scene 2").
 */
export function holdOptions(o: { scenes?: string[]; action?: ProblemAction }): {
  options: HoldOption[];
  recommendedId: string;
} {
  const tell: HoldOption = {
    id: "tell",
    label: "Tell Pip what to change",
    detail: "Write what to change in the note. The crew goes on with your change.",
  };
  if (o.action) {
    const fix: HoldOption = {
      id: "fix_key",
      label: "Fix the key",
      detail: "Open Settings › Providers and save a working key. The crew goes on by itself.",
    };
    const retry: HoldOption = { id: "retry", label: "Try again", detail: "The crew tries the step again now." };
    return o.action === "fix_key"
      ? { options: [fix, retry], recommendedId: "fix_key" }
      : { options: [retry, fix], recommendedId: "retry" };
  }
  const w = o.scenes?.length ? `${o.scenes.length === 1 ? "" : "these "}${o.scenes.join(" and ")}` : "";
  if (w)
    return {
      options: [
        {
          id: "redo_director",
          label: "Redo with the Director",
          detail: `The Director re-plans ${w}, then the Animator tunes ${o.scenes!.length === 1 ? "it" : "them"}.`,
        },
        { id: "accept", label: "Accept the look", detail: "The crew carries on with it as it is." },
        tell,
      ],
      recommendedId: "redo_director",
    };
  return {
    options: [{ id: "accept", label: "Carry on", detail: "The crew goes on with the plan as it is." }, tell],
    recommendedId: "accept",
  };
}
/** "scene 2" for a scene id, by its place in the video */
const sceneWord = (p: OpenProject, id: string) => {
  const k = p.doc().scenes.findIndex((s) => s.id === id);
  return k >= 0 ? `scene ${k + 1}` : id;
};
/** "$1.50", "$2": as Pip's cards say it */
const usd = (n: number) => `$${n < 1 ? n.toFixed(2) : n.toFixed(2).replace(/\.00$/, "")}`;
export const providerWord = (id?: string) => (id ? (PROVIDER_WORD[id] ?? id) : "the model provider");
export type ProblemAction = "retry" | "change_model" | "add_budget" | "fix_key";
/** the provider an error is about: the gateway tags it, else the id in "provider "x" is turned off" */
const providerOf = (e: any): string | undefined =>
  typeof e?.provider === "string"
    ? e.provider
    : (/provider "([^"]+)"/.exec(String(e?.message ?? ""))?.[1] ?? undefined);
/** a failure in plain words, and the one thing the person can do about it */
export function humanize(e: any, role = "crew"): { text: string; action: ProblemAction; provider?: string } {
  const who = `The ${ROLE_WORD[role] ?? role}`;
  const msg = String(e?.message ?? e);
  const kind = errorKind(e);
  const provider = providerOf(e);
  const named = provider ? { provider } : {};
  const P = providerWord(provider);
  // a provider problem first: a 401 never reads "isn't answering · Use a different model"
  if (kind === "auth") return { text: `Your ${P} key was rejected.`, action: "fix_key", ...named };
  if (kind === "credit") return { text: `Out of credit on ${P}.`, action: "fix_key", ...named };
  if (kind === "unreachable")
    return /turned off|no provider "/.test(msg)
      ? { text: `${P} is turned off in Settings.`, action: "fix_key", ...named }
      : { text: `Can't reach ${P}. Is it running?`, action: "retry", ...named };
  if (kind === "budget") return { text: "The crew reached your budget.", action: "add_budget" };
  if (kind === "rate") return { text: `${P} is busy right now (rate limited).`, action: "retry", ...named };
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
/** the hero's kind: `character` is the walking hero (outputs.ts); a creature, prop or icon never is */
const HERO_KIND = "character";
const MILESTONE: Record<string, string> = {
  // "Plan ready" belongs to the production plan now (the first plan after G0)
  "producer.plan": "Brief read",
  "writer.angles": "Script written",
  "director.storyboard": "Storyboard ready",
  // "Hero drawn" (id asset.judge) fires from castDrawing, and only for the hero: a `character` (HERO_KIND)
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
  const newAssets: { name: string; kind: AssetKindT; description: string }[] =
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
  /** Pip put the crew on hold (or a provider failure did: `hold`); set only by holdFor, so a hold always asks */
  held?: string;
  /** the hold's question (`hold: true`): answering it lifts the hold; any other lift withdraws it */
  holdQ?: string;
  /** a provider failure holds the run until the key is fixed (§1.8): the first one's kind, provider and words */
  hold?: { kind: string; provider?: string; text: string; action: ProblemAction };
  /** Pip decision rounds in this run */
  thinks?: number;
  /** Pip already asked the person something in this run */
  escalated?: boolean;
  /** the run's id in the plan (`ProductionPlan.runs`) */
  id: string;
  exec?: Executor;
  /** plan revisions this run wrote (the safety stop is MAX_REVISIONS_PER_RUN) */
  revisions: number;
  /** the Writer's angles, waiting for the pick at G1 */
  angles?: AnglesState;
  /** the cap the overrun question was asked at, and whether the person declined it */
  overrun?: { cap: number; declined?: boolean; finish?: boolean };
  /** "Finish within" took the second review round: this run reviews once */
  oneReview?: boolean;
  /** the person pressed "Looks good" at the rough cut in this run (D2: that passes the final too) */
  roughByUser?: boolean;
  /** the person asked for changes at this gate: the run ends there and its end starts the change (§1.9) */
  changesAt?: GateId;
  /**
   * the last plan change Pip made in this run, without its words, and the tasks it added: the same change again is
   * dropped while those tasks haven't run yet (§1.9)
   */
  lastPipChange?: { sig: string; tasks: string[] };
};
type AnglesState = { angles: { name: string; approach: string; cues: string[] }[]; recommended: number; row: string };
type ArtSpec = {
  name: string;
  kind: string;
  description: string;
  /** a creature's size and motion: the same template for the spec, the draws and the cast */
  size?: string;
  motion?: string;
  spec: z.infer<typeof SpecOut>;
  letters: string;
  row: string;
  fromRef?: string;
};
type Variant = { frames: DrawOutT; std: any; model: string; judge?: string } | null;
/**
 * a change run: its notes, the scenes it may redo, the scenes the Director re-plans, and the drawn assets it redraws
 * (a note on an asset)
 */
export type ChangePlan = { notes: string[]; scope?: string[]; reboard?: string[]; assets?: string[] };
/** the crew right now, for Pip's turn context and its card copy (Crew.snapshot) */
export type CrewSnapshot = {
  running: boolean;
  paused: boolean;
  /** why the run is held (a provider failure, Pip's hold) */
  held?: string;
  stage: string;
  line: string;
  gates: string[];
  passed: string[];
  questions: number;
  /** a plan-change card holds some tasks */
  pendingCard: boolean;
  /** plan task labels */
  failed: string[];
  fallbacks: string[];
  /** a review is still to come in this run (a note made now is read by it) */
  reviewPending: boolean;
  exportedAt?: string;
  /** what the crew works on right now (plan task labels) */
  working: string[];
  /** the question the held crew waits on (its hold question) */
  holdQuestion?: string;
};
/** what a person's change did right away (crew_request_change's result): Pip's words come from it */
export type ChangeResult = {
  /** the crew is working: the note waits for the next review */
  queued: boolean;
  stage: Stage;
  /** a run took the change on now */
  started: boolean;
  /** it was a held run, which goes on with the change */
  resumed: boolean;
  /** the crew still waits for the person on this question (a provider hold) */
  waiting?: string;
};
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
/**
 * What an escalation's option asks for, from its words: new art ("Draw a new owl"), a re-plan, a redo, or nothing
 * that costs ("Use the library owl", "Keep it", "No").
 */
export function optionKind(label: string): "draw" | "reboard" | "redo" | "free" {
  const w = label.toLowerCase();
  if (/\b(draw|drawing|drawn|new art|redraw|paint|sprite|illustrat\w*|commission)\b/.test(w)) return "draw";
  if (/\b(re-?plan|re-?board|storyboard|director|restage|re-?stage)\b/.test(w)) return "reboard";
  if (/\b(redo|re-?animate|animate|tune|retime|again|fix)\b/.test(w)) return "redo";
  return "free";
}
/**
 * The option to recommend: the cheapest that fits what's left of the cap (`leftUsd`), the first on a tie; when none
 * fits, the cheapest. Returns its index.
 */
export function cheapestOption(options: string[], usdOf: (label: string) => number, leftUsd: number): number {
  const costs = options.map((o) => usdOf(o));
  const fits = costs.map((c, i) => [c, i] as const).filter(([c]) => c <= leftUsd + 1e-9);
  const pool = fits.length ? fits : costs.map((c, i) => [c, i] as const);
  return pool.reduce((a, b) => (b[0] < a[0] - 1e-12 ? b : a))[1];
}
/** the Reviewer's verdict in one sentence: what the status and the channel say */
export function reviewVerdict(
  rev: { verdict: string; blockers: { scene: string }[] },
  word: (scene: string) => string = (s) => s,
): string {
  const n = rev.blockers.length;
  if (rev.verdict === "ship" || !n) return "The cut is ready to ship.";
  const scenes = [...new Set(rev.blockers.map((b) => b.scene))].map(word).map((w) => w.replace(/^scene /, ""));
  const where = scenes.length
    ? ` in ${scenes.length === 1 ? "scene" : "scenes"} ${scenes.length === 1 ? scenes[0] : `${scenes.slice(0, -1).join(", ")} and ${scenes.at(-1)}`}`
    : "";
  return `Found ${n} problem${n === 1 ? "" : "s"}${where}.`;
}
/** the scenes a trigger is about: a report's scene, a blocker's scenes (only the project's own) */
function scenesOf(t: Trigger | undefined, p: OpenProject): string[] {
  if (!t) return [];
  const ids = new Set(p.doc().scenes.map((s) => s.id));
  if (t.kind === "blocker") return [...new Set(t.scenes)].filter((s) => ids.has(s));
  if (t.kind === "report" && t.ref && ids.has(t.ref)) return [t.ref];
  return [];
}
/** two change plans as one: the notes and scenes of both (no scope on either means every scene) */
export function mergeChange(a: ChangePlan | undefined, b: ChangePlan): ChangePlan {
  if (!a) return b;
  const u = (x?: string[], y?: string[]) => [...new Set([...(x ?? []), ...(y ?? [])])];
  const reboard = u(a.reboard, b.reboard);
  const assets = u(a.assets, b.assets);
  return {
    notes: u(a.notes, b.notes),
    ...(a.scope && b.scope ? { scope: u(a.scope, b.scope) } : {}),
    ...(reboard.length ? { reboard } : {}),
    ...(assets.length ? { assets } : {}),
  };
}
const isEndCard = (sc: { kind: string; recipes?: { id: string }[] }) =>
  sc.kind === "decl" && !!sc.recipes?.some((r) => r.id === "end_card_loop");
/**
 * which scenes a set of change notes touches and which the Director re-plans; a note on an asset touches the scenes
 * that draw it (`usesOf`) and redraws it
 */
function planChange(p: OpenProject, notes: Note[], usesOf: (scene: string) => string[] = () => []): ChangePlan {
  const d = p.doc();
  const all = d.scenes.filter((s) => s.kind === "decl").map((s) => s.id);
  const reboard = new Set<string>();
  const scope = new Set<string>();
  const assets = new Set<string>();
  let everywhere = false;
  for (const n of notes) {
    if (n.target.asset && !n.target.scene) {
      assets.add(n.target.asset);
      for (const s of all) if (usesOf(s).includes(n.target.asset)) scope.add(s);
    } else if (n.assignee === "director") {
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
    ...(assets.size ? { assets: [...assets] } : {}),
  };
}

/**
 * A retry's revision (§1.8): failed tasks go back to pending in place (their dependents still wait on them), and
 * fallback tasks run again as fresh copies, with the finished work after them (gates included, so the export waits
 * for the redo; never publish), so a redone scene is reviewed and exported again. The originals stay done, no longer
 * marked fallback.
 */
export function retryRevision(
  tasks: PlanTaskT[],
  targets: PlanTaskT[],
  rev: number,
): { tasks: PlanTaskT[]; ops: PlanOpT[] } {
  const failed = new Set(targets.filter((t) => t.status === "failed").map((t) => t.id));
  const fallback = targets.filter((t) => t.status === "done" && t.outcome === "fallback").map((t) => t.id);
  let out = tasks.map((t) => (failed.has(t.id) ? { ...t, status: "pending" as const, note: undefined } : t));
  const ops: PlanOpT[] = [...failed].map((task) => ({ op: "add" as const, task, reason: "retry" }));
  if (fallback.length) {
    // the finished work downstream of a fallback runs again after it
    const ids = new Set(fallback);
    for (let grew = true; grew; ) {
      grew = false;
      for (const t of out)
        if (!ids.has(t.id) && t.status === "done" && t.kind !== "lib.publish" && t.dependsOn.some((d) => ids.has(d))) {
          ids.add(t.id);
          grew = true;
        }
    }
    const order = out.filter((t) => ids.has(t.id)).map((t) => t.id);
    const again = rerun(out, order, rev, { reason: "retry: redo what fell back" });
    const copies = new Set(again.map.values());
    out = again.tasks.map((t) =>
      copies.has(t.id)
        ? { ...t, outcome: undefined }
        : fallback.includes(t.id)
          ? { ...t, outcome: undefined, note: `redone as ${again.map.get(t.id)}` }
          : t,
    );
    ops.push(...again.ops);
  }
  return { tasks: out, ops };
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
/** who a gate's "Change something" goes to (a whole-stage note: no scene) */
const GATE_OWNER: Partial<Record<GateId, RoleT>> = {
  g0_brief: "producer",
  g1_script: "writer",
  g2_animatic: "director",
  g3_rough: "animator",
  g4_final: "editor",
};
const GATE_WORDS: Partial<Record<GateId, string>> = {
  g0_brief: "the brief",
  g1_script: "the script",
  g2_animatic: "the animatic",
  g3_rough: "the rough cut",
  g4_final: "the final cut",
};
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
  | { kind: "hold"; why: string; scenes?: string[] }
  | { kind: "escalate"; question: string; options?: string[] }
  | { kind: "replan"; diff: PlanDiffOutT };
export interface Conductor {
  think(
    p: OpenProject,
    trigger: Trigger,
    ctx: {
      change?: ChangePlan;
      redos: Map<string, number>;
      replan?: boolean;
      /**
       * a plan change (redo, re-board, replan) checked before it is accepted (§1.9): the validator's first error, a
       * name that isn't the project's, a second change on one trigger, or the same change again. The conductor sends
       * it back as the tool's error so the model can correct itself; null accepts it.
       */
      check?: (d: Decision) => string | null;
    },
  ): Promise<Decision[]>;
}
/** the decisions that change the plan: one per trigger (§1.9) */
const planChanging = (d: Decision) => d.kind === "redo" || d.kind === "reboard" || d.kind === "replan";
/** a plan change without its words: two with the same signature do the same thing */
const changeSig = (d: Decision) =>
  d.kind === "replan"
    ? `replan:${JSON.stringify(d.diff.ops.map(({ reason: _r, ...o }) => o))}`
    : d.kind === "redo" || d.kind === "reboard"
      ? `${d.kind}:${[...d.scenes].sort().join(",")}`
      : "";
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
    ref?: string,
  ): Promise<string | null> {
    if (!this.conductor) return null;
    const ask = p.say({ from, to: "pip", kind: "ask", text: q.question, ...(ref ? { ref } : {}) });
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
        ...(ref ? { ref } : {}),
      });
      return null;
    }
    const label = q.options.find((o) => o.id === a.optionId)?.label;
    p.say({
      from: "pip",
      to: from,
      kind: "answer",
      text: a.text || label || "",
      replyTo: ask.id,
      ...(ref ? { ref } : {}),
    });
    return label ? `${label}${a.text ? ` (${a.text})` : ""}` : a.text;
  }

  /** one Pip decision round on a trigger; bounded per run, and the fixed rules when there is no conductor */
  private async think(p: OpenProject, r: Run, tr: Trigger): Promise<Decision[]> {
    if (!this.conductor) return [];
    r.thinks = (r.thinks ?? 0) + 1;
    if (r.thinks > 12) return [{ kind: "hold", why: "the crew needed Pip more than 12 times in one run" }];
    try {
      // crew_replan only while this run has Pip proposals left (§1.6: at most 6)
      const run = this.planNow(p)?.runs.find((x) => x.id === r.id);
      const replan = !!run && run.pipProposals < MAX_PIP_PROPOSALS;
      // one plan change per trigger, checked before it is accepted, so a rejection goes back to Pip as a tool error;
      // a refusal stays inside the crew: Pip asks the person (crew_escalate) only after one corrected retry
      let accepted = false;
      let refused: string | null = null;
      let retried = false;
      const check = (d: Decision) => {
        if (d.kind === "escalate")
          return refused && !retried
            ? `correct the refused change once before asking the person (it was refused: ${refused.slice(0, 200)})`
            : null;
        if (!planChanging(d)) return null;
        if (accepted) return "one plan change per trigger: this one was not applied (the first one stands)";
        if (refused) retried = true;
        const why = this.checkChange(p, r, d);
        if (why) refused = why;
        if (why && d.kind === "replan") {
          // a refused proposal counts toward the run's six (§1.6), so failures can't loop
          const live = this.planNow(p)?.runs.find((x) => x.id === r.id);
          if (live) live.pipProposals++;
        }
        if (!why) accepted = true;
        return why;
      };
      return await this.conductor.think(p, tr, { change: r.change, redos: r.redos, replan, check });
    } catch (e: any) {
      // Pip's own key or provider failing holds the run the same way a crew member's does
      if (holdsRun(e) && this.runs.get(p.id) === r && this.holdRun(p, r, e, null)) return [];
      p.emit("log", { level: "warn", text: `Pip couldn't decide (${String(e?.message ?? e).slice(0, 120)}); holding` });
      return [{ kind: "hold", why: "Pip couldn't reach its model to decide what to do next" }];
    }
  }

  /**
   * Pip's plan change before it is applied (§1.9), or why not: the scenes are the project's and have redo rounds
   * left, the revision it makes passes the validator (crew_redo and crew_reboard too, not only crew_replan), its words
   * name only ids the project has, and it isn't the same change as Pip's last one in this run.
   */
  checkChange(p: OpenProject, r: Run, d: Decision, o: { replan?: boolean; by?: "pip" | "code" } = {}): string | null {
    if (!planChanging(d)) return null;
    const plan = this.planNow(p);
    if (!plan) return null;
    const last = r.lastPipChange;
    if (
      last?.sig === changeSig(d) &&
      plan.tasks.some((t) => last.tasks.includes(t.id) && isLive(t) && t.status !== "waiting_person")
    )
      return "the same plan change as your last one: it is already in the plan and hasn't run yet";
    const doc = p.doc();
    const ctx = { ...this.rulesCtx(p, plan.rev + 1), refs: doc.brief.references };
    const library = new Set(libraryIndex().assets.map((a) => a.id));
    const env = this.planEnv(p);
    const vctx = { doc, library, env, spentUsd: this.deps.gateway.spent(p.id).spentUsd, redos: r.redos };
    const fix = (e: { message: string; fix?: string }) => `${e.message}${e.fix ? ` (fix: ${e.fix})` : ""}`;
    if (d.kind === "replan") {
      // apply() leaves the validation to pipRevise, which says "Kept the default plan: …" on the channel
      if (o.replan === false) return null;
      const applied = applyDiff(plan.tasks, d.diff, ctx);
      const v = validatePlan(applied.tasks, {
        ...vctx,
        by: "pip",
        before: plan.tasks,
        ops: d.diff.ops.map((x) => ({ ...x, task: "task" in x ? x.task : undefined })) as any,
        texts: [...d.diff.ops.map((o) => o.reason), d.diff.summary],
        strictNames: true,
      });
      const first = [...applied.issues, ...v.errors][0];
      return first ? fix(first) : null;
    }
    if (d.kind !== "redo" && d.kind !== "reboard") return null;
    const ids = doc.scenes.map((s) => s.id);
    const unknown = d.scenes.filter((s) => !ids.includes(s));
    if (unknown.length) return `no scene ${unknown.join(", ")} (fix: use a scene id: ${ids.join(", ")})`;
    const over = d.scenes.filter((s) => (r.redos.get(s) ?? 0) >= MAX_REDO);
    // past the redo limit: accepted, and apply() holds the run and tells the person (the 2-redo hold)
    if (over.length === d.scenes.length) return null;
    const why = d.kind === "redo" ? d.why : d.direction;
    const out =
      d.kind === "redo"
        ? addRedo(plan.tasks, d.scenes, ctx, { reason: why.slice(0, 200) })
        : addReboard(plan.tasks, d.scenes, ctx, { reason: why.slice(0, 200) });
    // apply()'s re-check (`by: "code"`): a fixed rule's redo carries the Reviewer's or the member's words, and the
    // budget is the overrun flow's job, so only the plan's shape is checked there
    const pip = o.by !== "code";
    const v = validatePlan(out.tasks, {
      ...vctx,
      by: pip ? "pip" : "code",
      before: plan.tasks,
      ops: out.ops,
      ...(pip ? { texts: [why], strictNames: true } : {}),
    });
    return v.errors[0] ? fix(v.errors[0]) : null;
  }

  /**
   * apply Pip's decisions; a redo or re-board becomes a plan revision (the executor runs it after `after`). Returns
   * whether any scene was sent back, and the redo tunes it added. At most one plan change per trigger, each checked
   * (`checkChange`) even when the fixed rules decided it.
   */
  private async apply(
    p: OpenProject,
    r: Run,
    ds: Decision[],
    o: { after?: string[]; trigger?: Trigger } = {},
  ): Promise<{ redid: boolean; added: string[] }> {
    let redid = false;
    const added: string[] = [];
    const redoable = (ids: string[]) => {
      const ok = ids.filter((id) => (r.redos.get(id) ?? 0) < MAX_REDO && p.doc().scenes.some((s) => s.id === id));
      for (const id of ok) r.redos.set(id, (r.redos.get(id) ?? 0) + 1);
      return { ok, over: ids.filter((id) => !ok.includes(id)) };
    };
    let changed = false;
    let sig: { sig: string; had: Set<string> } | null = null;
    for (const d of ds) {
      if (planChanging(d)) {
        const why = changed ? "one plan change per trigger" : this.checkChange(p, r, d, { replan: false, by: "code" });
        if (why) {
          p.emit("log", { level: "warn", text: `Pip's ${d.kind} was not applied: ${why.slice(0, 200)}` });
          continue;
        }
        changed = true;
        const had = new Set((this.planNow(p)?.tasks ?? []).map((t) => t.id));
        sig = { sig: changeSig(d), had };
      }
      if (d.kind === "brief") {
        const m = p.say({ from: "pip", to: d.role, kind: "brief", text: d.text, ref: d.ref });
        const key = `${p.id}:${d.role}`;
        this.briefs.set(key, [...(this.briefs.get(key) ?? []), m]);
      } else if (d.kind === "redo" || d.kind === "reboard") {
        const { ok, over } = redoable(d.scenes);
        if (over.length)
          ds.push({
            kind: "hold",
            why: `${over.join(", ")} already had ${MAX_REDO} redo rounds for this request`,
            scenes: over,
          });
        if (!ok.length) continue;
        for (const id of ok) if (p.state.sceneStatus[id]) p.setSceneStatus(id, { version: "animatic", state: "stale" });
        if (d.kind === "reboard") {
          const m = p.say({
            from: "pip",
            to: "director",
            kind: "brief",
            text: `Re-plan ${ok.join(", ")}: ${d.direction}`,
            ref: ok[0],
          });
          this.briefs.set(`${p.id}:director`, [...(this.briefs.get(`${p.id}:director`) ?? []), m]);
          const why = `Pip sent ${ok.join(", ")} back to the Director: ${d.direction}`;
          const res = this.planRevise(p, r, { by: "pip", trigger: "conductor", reason: why }, (ts, ctx) =>
            addReboard(ts, ok, ctx, { after: o.after, reason: why.slice(0, 200) }),
          );
          added.push(...(res?.added.filter((id) => res.tasks.find((t) => t.id === id)?.kind === "scene.tune") ?? []));
        } else {
          const m = p.say({
            from: "pip",
            to: "animator",
            kind: "brief",
            text: `Redo ${ok.join(", ")}: ${d.why}`,
            ref: ok[0],
          });
          this.briefs.set(`${p.id}:animator`, [...(this.briefs.get(`${p.id}:animator`) ?? []), m]);
          const why = `Pip brought the Animator back for ${ok.join(", ")}: ${d.why}`;
          const res = this.planRevise(p, r, { by: "pip", trigger: "conductor", reason: why }, (ts, ctx) =>
            addRedo(ts, ok, ctx, { after: o.after, reason: why.slice(0, 200) }),
          );
          added.push(...(res?.added ?? []));
        }
        redid = true;
      } else if (d.kind === "replan") {
        await this.pipRevise(p, r, "conductor", d.diff);
      } else if (d.kind === "next") {
        if (d.why) p.say({ from: "pip", to: "crew", kind: "brief", text: `On track: ${d.why}` });
      } else if (d.kind === "escalate") {
        // one question to the person per run: a second trigger about the same trouble doesn't ask again
        if (r.escalated) continue;
        r.escalated = true;
        const opts = (d.options?.length ? d.options : ["Yes", "No"]).slice(0, 6);
        // the recommended answer is the cheapest one that fits what's left of the cap (never new art when a
        // library asset or a behaviour covers it: that option is cheaper)
        const { spentUsd } = this.deps.gateway.spent(p.id);
        const rec = cheapestOption(opts, (o) => this.optionUsd(p, o), p.doc().budget.capUsd - spentUsd);
        p.ask(
          {
            kind: "single",
            question: cutWords(d.question, 200),
            why: "The crew asked Pip, and only you can answer this.",
            options: opts.map((o, i) => ({ id: `o${i + 1}`, label: cutWords(o, 80), detail: "" })),
            recommendedId: `o${rec + 1}`,
            from: "pip",
          },
          "pip",
        );
        p.say({ from: "pip", to: "crew", kind: "brief", text: `Asked the person: ${d.question}` });
      } else if (d.kind === "hold" && !r.held) {
        // a hold always asks the person (holdFor): the scenes it is about come from the decision or its trigger
        this.holdFor(p, r, d.why, { scenes: d.scenes ?? scenesOf(o.trigger, p) });
      }
    }
    if (sig) {
      const { had } = sig;
      r.lastPipChange = {
        sig: sig.sig,
        tasks: (this.planNow(p)?.tasks ?? []).filter((t) => !had.has(t.id)).map((t) => t.id),
      };
    }
    return { redid, added };
  }

  /** what an escalation's option would cost at p50, read from its words and priced by the plan's estimates */
  private optionUsd(p: OpenProject, label: string): number {
    const env = this.planEnv(p);
    const est = (kind: keyof typeof CATALOGUE, count = 1) =>
      estimatePlanTask({ kind, role: CATALOGUE[kind].role, tier: "role" } as any, env).usd[0] * count;
    const kind = optionKind(label);
    if (kind === "free") return 0;
    if (kind === "draw")
      return est("asset.spec") + est("asset.draw", this.variants(p)) + est("asset.judge") + est("scene.tune");
    if (kind === "reboard") return est("director.storyboard") + est("art.cast") + est("scene.tune");
    return est("scene.tune");
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
    while (r.triggers.length && !r.held) {
      const tr = r.triggers.shift()!;
      await this.apply(p, r, await this.think(p, r, tr), { trigger: tr });
    }
    r.triggers = [];
  }
  private gateWaiters = new Map<
    string,
    (v: { verdict: string; reasons?: string[]; items?: string[]; by: string }) => void
  >();
  /** each project's production plan, as last written (runs/plan.json) */
  private plans = new Map<string, ProductionPlanT>();
  constructor(deps: CrewDeps) {
    this.deps = deps;
    // a hold's question is answered over HTTP or MCP alike: both go through the store, which asks the crew first
    deps.workspace.onAnswer = (p, q, a) => this.holdAnswer(p, q, a);
  }

  // ---------------------------------------------------------------- the production plan
  /** what planning needs from the gateway, with the project's own model choices */
  planEnv(p: OpenProject): PlanEnv {
    return envOf(this.deps.gateway, p.doc().crew.models);
  }
  /** drawings per new asset: the project's `crew.variants`, else Settings' `defaults.variants`, else 2 */
  variants(p: OpenProject): number {
    return variantsOf({ variants: p.doc().crew.variants }, { variants: this.deps.gateway.defaults?.().variants });
  }
  private rulesCtx(p: OpenProject, rev: number): RulesCtx {
    return { env: this.planEnv(p), rev, assetsOf: (id) => this.sceneAssets(p, id), variants: this.variants(p) };
  }
  /** the asset ids a decl scene's recipes draw: their asset params, or the params' defaults */
  private sceneAssets(p: OpenProject, sceneId: string): string[] {
    const sc = p.doc().scenes.find((s) => s.id === sceneId);
    if (sc?.kind !== "decl") return [];
    const out = new Set<string>();
    for (const rc of sc.recipes) {
      const R = (RECIPE_MAP as any)[rc.id];
      for (const [k, spec] of Object.entries<any>(R?.params ?? {}))
        if (spec.lib) out.add(String(rc.params?.[k] ?? spec.d ?? ""));
      for (const v of Object.values(rc.params ?? {})) if (typeof v === "string") out.add(v);
    }
    return [...out].filter(Boolean);
  }
  private pipView(p: OpenProject): PlanView["pip"] {
    const plan = this.plans.get(p.id);
    const run = plan?.runs.at(-1);
    return { mode: this.pipMode(p), proposals: run?.pipProposals ?? 0, max: MAX_PIP_PROPOSALS };
  }
  /** Pip's model is agent-capable (set by wireCrew from Pip's own check); without it Pip's plan call never runs */
  pipModeFor?: (model: string) => "agent" | "menu";
  /**
   * Pip's plan revision (§1.4): the `defaults.pipPlan` setting, and `off` in menu mode and on a local model, where
   * the rules plan stands with no call.
   */
  pipMode(p: OpenProject): "on" | "shadow" | "off" {
    const set = this.deps.gateway.defaults?.().pipPlan ?? "shadow";
    if (set === "off" || !this.pipModeFor) return "off";
    const model = this.deps.gateway.modelFor("assistant", p.doc().crew.models);
    if (this.planEnv(p).local(model) || this.pipModeFor(model) !== "agent") return "off";
    return set;
  }
  /** the plan as it is now, read-only (never writes rev 0: GET and status() only look) */
  planNow(p: OpenProject): ProductionPlanT | null {
    const hit = this.plans.get(p.id);
    if (hit) return hit;
    const plan = loadPlan(p);
    if (plan) this.plans.set(p.id, plan);
    return plan;
  }
  /** `state.plan` (§4.1) */
  planView(p: OpenProject): PlanView | null {
    const plan = this.planNow(p);
    if (!plan) return null;
    const env = this.planEnv(p);
    const { spentUsd } = this.deps.gateway.spent(p.id);
    const live = { ...plan, estimate: planEstimate(plan.tasks, spentUsd, env) };
    return viewOf(p, live, env, this.pipView(p));
  }
  /** GET /api/p/:id/plan/revisions */
  planRevisions(p: OpenProject) {
    return revisionSummaries(p);
  }

  // ---------------------------------------------------------------- crew instances (§2)
  private trackers = new Map<string, { p: OpenProject; t: InstanceTracker }>();
  /** the project's instance tracker, folded from its log on first use; from then on it sends `instance` events */
  private tracker(p: OpenProject): InstanceTracker {
    const hit = this.trackers.get(p.id);
    if (hit?.p === p) return hit.t;
    hit?.t.close();
    const t = new InstanceTracker(p, {
      sceneIds: () => p.doc().scenes.map((s) => s.id),
      humanize: (e, role) => humanize(e, role).text,
      now: () => ({ plan: this.planNow(p)?.tasks, rows: p.state.tasks }),
      idle: () => !this.runs.has(p.id),
    });
    this.trackers.set(p.id, { p, t });
    return t;
  }
  /** `state.instances` (§4.1); it also starts the `instance` events for the project */
  instances(p: OpenProject): Instance[] {
    return this.tracker(p).view();
  }
  /** GET /api/p/:id/instances/:iid/log: its attempts' transcripts and its channel messages, by time */
  instanceLog(p: OpenProject, iid: string) {
    const t = this.tracker(p);
    const instance = t.view().find((i) => i.id === iid);
    if (!instance) return null;
    const own = t.fold.owned(iid);
    const role = iid.split(":")[0];
    const sub = iid.split(":")[1];
    const refs = new Set([...own.tasks, ...own.rows, ...(sub ? [sub] : [])]);
    const entries: (
      | ({ at: string; source: "task"; taskId: string } & Record<string, unknown>)
      | { at: string; source: "channel"; msg: ChannelMsg }
    )[] = [];
    for (const id of own.rows)
      for (const e of p.transcript(id) as { at: string }[])
        entries.push({ ...e, at: e.at, source: "task", taskId: id });
    for (const msg of p.channel())
      if ((msg.from === role || msg.to === role) && (msg.ref ? refs.has(msg.ref) : own.singleton))
        entries.push({ at: msg.at, source: "channel", msg });
    entries.sort((a, b) => a.at.localeCompare(b.at));
    return { instance, entries };
  }
  /** "Ask Pip about this": the instance record for that turn's context, or null for an unknown id */
  instanceAbout(p: OpenProject, iid: string): { text: string; label: string } | null {
    const t = this.tracker(p);
    const i = t.view().find((x) => x.id === iid);
    return i ? { text: aboutText(i, t.fold.origins(iid), p.doc().budget.capUsd), label: i.label } : null;
  }
  /** the plan, written as rev 0 from what the project has when it has none yet */
  private ensurePlan(p: OpenProject, r: Run | null): ProductionPlanT {
    const have = this.planNow(p);
    if (have) return have;
    const ctx = this.rulesCtx(p, 0);
    const f = join(p.dir, "runs", "new-assets.json");
    const pendingNew: NewAsset[] = existsSync(f) ? JSON.parse(readFileSync(f, "utf8")) : [];
    const tasks = startPlan(p.doc(), p.state, ctx, pendingNew);
    const fresh = tasks.every((t) => t.status === "pending" || (t.kind === "gate" && t.status === "done"));
    const plan = revise(
      p,
      null,
      {
        by: fresh ? "rules" : "code",
        trigger: "start",
        reason: fresh ? "The rules plan for this brief." : "The plan, from what the project already has.",
        ops: [],
        tasks,
        run: r?.id ?? "none",
      },
      ctx.env,
      this.deps.gateway.spent(p.id).spentUsd,
      this.pipView(p),
    );
    this.plans.set(p.id, plan);
    return plan;
  }
  /**
   * Write a revision made by `f` on the current tasks. Nothing is written when it changes nothing. A run past
   * MAX_REVISIONS_PER_RUN holds.
   */
  private planRevise(
    p: OpenProject,
    r: Run | null,
    rv: { by: PlanRevisionT["by"]; trigger: PlanRevisionT["trigger"]; reason: string },
    f: (tasks: PlanTaskT[], ctx: RulesCtx) => { tasks: PlanTaskT[]; ops: PlanOpT[]; reason?: string } | null,
  ): { added: string[]; tasks: PlanTaskT[] } | null {
    const plan = this.ensurePlan(p, r);
    const ctx = this.rulesCtx(p, plan.rev + 1);
    const out = f(plan.tasks, ctx);
    if (!out || (!out.ops.length && JSON.stringify(out.tasks) === JSON.stringify(plan.tasks))) return null;
    if (r) {
      r.revisions++;
      if (r.revisions > MAX_REVISIONS_PER_RUN && !r.held)
        this.holdFor(p, r, `the plan changed more than ${MAX_REVISIONS_PER_RUN} times in one run`);
    }
    const next = revise(
      p,
      plan,
      { ...rv, reason: out.reason ?? rv.reason, ops: out.ops, tasks: out.tasks, run: r?.id ?? plan.run },
      ctx.env,
      this.deps.gateway.spent(p.id).spentUsd,
      this.pipView(p),
    );
    this.plans.set(p.id, next);
    const added = out.ops.flatMap((o) => (o.op === "add" ? [o.task] : []));
    this.overTwenty(p, next, plan, rv, added);
    // a person's change or retry is consent to its cost, up to the top of the range its card showed: later code and
    // Pip revisions compare against that (§1.6)
    if (rv.by === "person" && (rv.trigger === "change" || rv.trigger === "retry")) {
      next.approvedUsd = next.estimate.usd[1];
      touch(p, next, this.planEnv(p), this.deps.gateway.spent(p.id).spentUsd, this.pipView(p));
    }
    r?.exec?.wake();
    return { added, tasks: next.tasks };
  }
  /**
   * The 20% rule (§1.6): a revision whose p50 total is past 1.2 × what the person approved becomes a revision card;
   * its added tasks wait (plan.pending) while everything else runs. A change card is consent in itself.
   */
  private overTwenty(
    p: OpenProject,
    next: ProductionPlanT,
    prev: ProductionPlanT,
    rv: { by: PlanRevisionT["by"]; trigger: PlanRevisionT["trigger"]; reason: string },
    added: string[],
  ) {
    if (!this.onPlanCard || next.approvedUsd === null || next.pending) return;
    // new work: added tasks, and the art an expansion brings in (C5); expanded tunes were priced by their placeholder
    const art = next.ops.flatMap((o) =>
      o.op === "expand" && prev.tasks.find((t) => t.id === o.placeholder)?.expand === "per_new_asset" ? o.into : [],
    );
    const fresh = [...added, ...art];
    if (rv.by === "person" || !fresh.length) return;
    if (next.estimate.usd[0] <= 1.2 * next.approvedUsd + 1e-9) return;
    const tasks = fresh.filter((id) => next.tasks.find((t) => t.id === id && isLive(t)));
    if (!tasks.length) return;
    const ids = p.doc().scenes.map((s) => s.id);
    // who re-planned: the card names it with the crew it brings in (the Director, when the storyboard expanded)
    const planner: RoleT | "pip" | undefined =
      rv.by === "pip"
        ? "pip"
        : rv.trigger === "expand"
          ? "director"
          : rv.trigger === "budget"
            ? "producer"
            : rv.trigger === "conductor"
              ? "reviewer"
              : undefined;
    // the card's copy says what really waits: while some other live work can still run, "everything else keeps
    // running"; when every task left depends on the held ones, the rest waits too
    const held = new Set(tasks);
    const byId = new Map(next.tasks.map((t) => [t.id, t]));
    const waitsOn = (id: string, seen = new Set<string>()): boolean => {
      if (held.has(id)) return true;
      if (seen.has(id)) return false;
      seen.add(id);
      return (byId.get(id)?.dependsOn ?? []).some((d) => waitsOn(d, seen));
    };
    const othersRun = next.tasks.some(
      (t) => isLive(t) && t.status !== "waiting_person" && t.role !== "person" && !waitsOn(t.id),
    );
    const card = this.onPlanCard(p, {
      rev: next.rev,
      planner,
      othersRun,
      reason: next.reason,
      fromUsd: next.approvedUsd,
      toUsd: next.estimate.usd[0],
      deltaUsd: [next.estimate.usd[0] - prev.estimate.usd[0], next.estimate.usd[1] - prev.estimate.usd[1]],
      ops: next.ops.map((o) => {
        const id = o.op === "expand" ? o.placeholder : o.task;
        const t = next.tasks.find((x) => x.id === id);
        return { op: o.op, task: id, label: t ? taskLabel(t, ids) : id, reason: o.reason };
      }),
      whoInstances: [
        ...new Map(
          tasks.map((id) => next.tasks.find((t) => t.id === id)!).map((t) => [t.instance, taskLabel(t, ids)]),
        ).entries(),
      ]
        .filter(([i]) => i !== "person")
        .map(([instance, label]) => ({ instance, label })),
      roles: [
        ...new Set(tasks.map((id) => next.tasks.find((t) => t.id === id)!.role).filter((x) => x !== "person")),
      ] as RoleT[],
    });
    if (!card) return;
    next.pending = { rev: next.rev, cardId: card, tasks };
    touch(p, next, this.planEnv(p), this.deps.gateway.spent(p.id).spentUsd, this.pipView(p));
  }
  /** Pip posts a revision card (§4.4) and returns its id; unset, the 20% rule never holds tasks */
  onPlanCard?: (
    p: OpenProject,
    c: {
      rev: number;
      /** who re-planned (named on the card with the crew it brings in) */
      planner?: RoleT | "pip";
      /** other live work runs while the card waits */
      othersRun: boolean;
      reason: string;
      fromUsd: number;
      toUsd: number;
      deltaUsd: [number, number];
      ops: { op: string; task: string; label: string; reason: string }[];
      whoInstances: { instance: string; label: string }[];
      roles: RoleT[];
    },
  ) => string | null;
  /** the person confirmed the revision card: its tasks run, and the new total is what they approved */
  confirmPending(p: OpenProject) {
    const plan = this.planNow(p);
    if (!plan?.pending) return;
    plan.approvedUsd = plan.estimate.usd[0];
    delete plan.pending;
    touch(p, plan, this.planEnv(p), this.deps.gateway.spent(p.id).spentUsd, this.pipView(p));
    const r = this.runs.get(p.id);
    this.unwait(p, r);
    // the run that held the card already ended: confirming it starts the crew again
    if (!r) this.restartIdle(p);
    r?.resume?.();
    r?.exec?.wake();
  }
  /** a person's answer settles what the crew waited on: the problem and the "Waiting for you" line go */
  private unwait(p: OpenProject, r: Run | undefined) {
    if (r?.held) return;
    const line = /^Waiting for you/.test(p.state.status.line) ? { line: STAGE_LINE[p.state.stage] ?? "Working" } : {};
    p.setStatus({ ...line, problem: undefined, waiting: undefined });
  }
  /** start the crew again on a project whose plan still has work, when nothing runs and the person didn't pause it */
  private restartIdle(p: OpenProject) {
    if (this.runs.has(p.id) || p.state.paused || !this.planNow(p)?.tasks.some(isLive)) return false;
    this.run(p).catch(() => {});
    return true;
  }
  /** the person declined it: a `decline` revision drops those tasks, and Pip hears so at the next stage check */
  declinePending(p: OpenProject) {
    const plan = this.planNow(p);
    if (!plan?.pending) return;
    const drop = new Set(plan.pending.tasks);
    delete plan.pending;
    const r = this.runs.get(p.id) ?? null;
    this.planRevise(p, r, { by: "person", trigger: "decline", reason: "You kept the plan as it was." }, (ts) => ({
      tasks: ts.map((t) =>
        drop.has(t.id) && isLive(t) ? { ...t, status: "dropped" as const, note: "you declined it" } : t,
      ),
      ops: [...drop].map((task) => ({ op: "drop" as const, task, reason: "you declined it" })),
    }));
    r?.triggers.push({
      kind: "stage",
      stage: p.state.stage,
      notes: ["The person declined the plan change; carry on without it."],
    });
    this.unwait(p, r ?? undefined);
    if (!r) this.restartIdle(p);
    r?.resume?.();
    r?.exec?.wake();
  }
  /**
   * Pip's revision of the plan (§1.4): once after G0 (or Start on /new), or a conductor's crew_replan (`given`).
   * Counted per run (at most 6, failures included). Under `shadow` it is posted on the channel, not applied. A bad
   * answer keeps the rules plan: "Kept the default plan: <first error>".
   */
  private async pipRevise(
    p: OpenProject,
    r: Run,
    why: "g0" | "start" | "conductor",
    given?: PlanDiffOutT,
  ): Promise<PipRevisionResult | null> {
    const mode = given ? "on" : this.pipMode(p);
    if (mode === "off") return null;
    const plan = this.ensurePlan(p, r);
    const run = plan.runs.find((x) => x.id === r.id);
    if (!run || run.pipProposals >= MAX_PIP_PROPOSALS) return null;
    run.pipProposals++;
    const d = p.doc();
    const env = this.planEnv(p);
    const ctx = { ...this.rulesCtx(p, plan.rev + 1), refs: d.brief.references };
    const { spentUsd } = this.deps.gateway.spent(p.id);
    const lib: { id: string; kind: string; tags?: string[] }[] = libraryIndex().assets;
    const vctx = { doc: d, library: new Set(lib.map((a) => a.id)), env, spentUsd, redos: r.redos };
    let res: PipRevisionResult;
    if (given) {
      const applied = applyDiff(plan.tasks, given, ctx);
      const v = validatePlan(applied.tasks, {
        ...vctx,
        by: "pip",
        before: plan.tasks,
        ops: given.ops.map((x) => ({ ...x, task: "task" in x ? x.task : undefined })) as any,
        texts: [...given.ops.map((x) => x.reason), given.summary],
        strictNames: why === "conductor",
      });
      const errors = [...applied.issues, ...v.errors];
      res = {
        tasks: errors.length ? null : applied.tasks,
        ops: applied.ops,
        summary: given.summary || "Pip changed the plan.",
        ...(errors.length ? { kept: `${errors[0].message}${errors[0].fix ? ` (${errors[0].fix})` : ""}` } : {}),
        valid: errors.length ? "no" : "first",
        calls: 0,
        usd: 0,
        sec: 0,
        diff: given,
      };
    } else {
      const model = this.deps.gateway.modelFor("assistant", d.crew.models);
      p.setStatus({ line: "Pip is planning who works on this" });
      res = await pipRevision({
        gateway: this.deps.gateway,
        project: p.id,
        capUsd: d.budget.capUsd,
        model,
        vars: planPromptVars({
          brief: {
            idea: d.brief.idea,
            purpose: d.brief.purpose,
            audience: d.brief.audience,
            lengthSec: d.brief.lengthSec,
            narration: d.brief.narration,
            involvement: d.brief.involvement,
            style: d.brief.tone,
          },
          refs: d.brief.references.map((x) => ({ file: x.file, type: x.type, rights: x.rights })),
          library: lib,
          budget: {
            capUsd: d.budget.capUsd,
            reserveUsd: d.budget.reserveUsd,
            spentUsd,
            estUsd: [plan.estimate.usd[0], plan.estimate.usd[1]],
          },
          tasks: plan.tasks,
          ctx,
        }),
        tasks: plan.tasks,
        ctx,
        validate: vctx,
        signal: AbortSignal.any([r.abort.signal, AbortSignal.timeout(60_000)]),
      });
    }
    touch(p, plan, env, this.deps.gateway.spent(p.id).spentUsd, this.pipView(p));
    // the channel gets one plain sentence; the ops, task ids and errors go to the event log only
    if (!res.tasks) {
      p.emit("log", { level: "info", text: `Kept the default plan: ${res.kept ?? "no usable answer"}`.slice(0, 600) });
      p.say({ from: "pip", to: "crew", kind: "brief", text: "I kept the default plan." });
      return res;
    }
    if (!res.ops.length) return res;
    if (mode === "shadow") {
      p.emit("log", {
        level: "info",
        text: `Shadow plan (not applied): ${res.summary} ${res.ops.map((o) => `${o.op} ${"task" in o ? o.task : o.placeholder}: ${o.reason}`).join("; ")}`.slice(
          0,
          1200,
        ),
      });
      p.say({
        from: "pip",
        to: "crew",
        kind: "brief",
        text: `I looked for a better plan and kept the default one (${res.ops.length} change${res.ops.length === 1 ? "" : "s"} considered).`,
      });
      return res;
    }
    const tasks = res.tasks;
    this.planRevise(
      p,
      r,
      { by: "pip", trigger: why === "conductor" ? "conductor" : "pip_revision", reason: res.summary },
      () => ({ tasks, ops: res.ops }),
    );
    p.say({ from: "pip", to: "crew", kind: "brief", text: `Plan changed: ${res.summary}`.slice(0, 400) });
    return res;
  }

  /** a status-only change: saved, sent as a transient `plan` event */
  private setPlanStatus(p: OpenProject, id: string, status: PlanTaskT["status"], note?: string, outcome?: "fallback") {
    const plan = this.planNow(p);
    const t = plan?.tasks.find((x) => x.id === id);
    if (!plan || !t) return;
    t.status = status;
    if (note !== undefined) t.note = note.slice(0, 200);
    if (outcome) t.outcome = outcome;
    else if (status !== "done") delete t.outcome;
    t.taskIds = [...new Set([...t.taskIds, ...p.state.tasks.filter((x) => x.planTask === id).map((x) => x.id)])];
    touch(p, plan, this.planEnv(p), this.deps.gateway.spent(p.id).spentUsd, this.pipView(p));
  }
  /** the plan task the next rows of a handler belong to */
  private ptOf(pt: PlanTaskT | null | undefined) {
    return pt ? { planTask: pt.id, instance: pt.instance } : {};
  }

  // ---------------------------------------------------------------- the CrewApi the server uses
  status(p: OpenProject) {
    const { spentUsd, reservedUsd } = this.deps.gateway.spent(p.id);
    const doc = p.doc();
    const plan = this.planNow(p);
    const est = plan
      ? (() => {
          const e = planEstimate(plan.tasks, spentUsd, this.planEnv(p));
          return { usd: e.usd, sec: e.sec };
        })()
      : null;
    const run = this.runs.get(p.id);
    return {
      budget: {
        capUsd: doc.budget.capUsd,
        spentUsd,
        reservedUsd,
        estTotalUsd: est ? est.usd : null,
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
        /** plan tasks whose dependencies are done but that wait for a free slot (or the budget) */
        queued: plan ? plan.tasks.filter((t) => t.status === "ready").length : 0,
        /** what is running now, per endpoint (N6): `{ fake: { size: 4, used: 3 }, render: { size: 1, used: 0 } }` */
        slots: run?.exec?.slots() ?? {},
        /** when the current (or last) run started: failures before it belong to an older run */
        runStartedAt: run?.startedAt ?? plan?.runs.at(-1)?.startedAt ?? null,
        /** the run is held for the person (a provider failure, Pip's hold), and why */
        held: run?.held ?? null,
      },
    };
  }
  /**
   * The crew right now, for Pip's turn (§1.8): running or idle, held and why, open gates and questions, cards the plan
   * waits on, what failed or fell back, whether a review is still to come, and the last export.
   */
  snapshot(p: OpenProject): CrewSnapshot {
    const run = this.runs.get(p.id);
    const plan = this.planNow(p);
    const ids = p.doc().scenes.map((s) => s.id);
    const label = (t: PlanTaskT) => taskLabel(t, ids);
    const tasks = plan?.tasks ?? [];
    const exp = p.state.tasks
      .filter((t) => t.kind === "deliver.export" && t.status === "done" && !t.supersededBy)
      .at(-1);
    return {
      running: !!run,
      paused: p.state.paused,
      ...(run?.held ? { held: run.held } : {}),
      stage: p.state.stage,
      line: p.state.status.line,
      gates: p.state.gates.filter((g) => g.status === "open").map((g) => g.id),
      passed: p.state.gates.filter((g) => g.status === "passed").map((g) => g.id),
      questions: p.state.questions.filter((q) => q.status === "open").length,
      pendingCard: !!plan?.pending,
      failed: tasks.filter((t) => t.status === "failed").map(label),
      fallbacks: tasks.filter((t) => t.status === "done" && t.outcome === "fallback").map(label),
      reviewPending:
        !!run && tasks.some((t) => t.kind === "review.final" && (t.status === "pending" || t.status === "ready")),
      ...(exp?.endedAt ? { exportedAt: exp.endedAt } : {}),
      working: run ? tasks.filter((t) => t.status === "running").map(label) : [],
      ...(() => {
        const q = p.state.questions.find((x) => x.hold && x.status === "open");
        return q ? { holdQuestion: q.question } : {};
      })(),
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
    r.exec?.wake();
  }
  resume(p: OpenProject) {
    p.state.paused = false;
    p.saveState();
    const r = this.runs.get(p.id);
    // a hold left by an ended run (a restart) no longer stands
    if (!r) for (const q of p.state.questions.filter((x) => x.hold && x.status === "open")) p.withdraw(q.id);
    if (r) {
      // resume lifts a hold too: the tasks try again (and hold again if the key is still wrong)
      if (r.hold || r.held) this.liftHold(p, r);
      else {
        r.paused = false;
        this.unwait(p, r);
        r.resume?.();
        r.exec?.wake();
      }
    }
  }

  /**
   * A provider failure (a rejected key, no credit, no connection: `holdsRun`) holds the whole run instead of failing
   * it or falling back (§1.8). Tasks already running finish or hold too; nothing else starts. The first one sets the
   * problem, tells the person in Pip's thread once, and settles the cards that handed work to the run.
   */
  private holdRun(p: OpenProject, r: Run, e: unknown, t: PlanTaskT | null): boolean {
    if (!holdsRun(e) || r.abort.signal.aborted) return false;
    // the attempt's rows end cancelled: the try after the fix supersedes them, and no failure is left behind
    if (t)
      for (const row of p.state.tasks.filter((x) => x.planTask === t.id && x.status === "failed" && !x.supersededBy))
        p.upsertTask({ ...row, status: "cancelled", endedAt: row.endedAt ?? new Date().toISOString() });
    if (r.hold) return true;
    const h = humanize(e, t?.role);
    // a Pip hold already standing gives way: the provider is what really stops the crew now
    if (r.held) this.liftHold(p, r, { quiet: true });
    r.hold = { kind: errorKind(e), text: h.text, action: h.action, ...(h.provider ? { provider: h.provider } : {}) };
    this.holdFor(p, r, h.text, { action: h.action, ...(t ? { ref: t.id } : {}) });
    const row = t ? p.state.tasks.filter((x) => x.planTask === t.id).at(-1) : undefined;
    p.setStatus({
      problem: {
        text: h.text,
        action: h.action,
        taskId: row?.id ?? t?.id ?? "",
        kind: r.hold.kind,
        ...(h.provider ? { provider: h.provider } : {}),
      },
      waiting: undefined,
    });
    p.emit("log", { level: "error", text: `crew held: ${String((e as any)?.message ?? e).slice(0, 200)}` });
    const tasks = this.planNow(p)?.tasks ?? [];
    try {
      this.onHold?.(p, {
        text: h.text,
        action: h.action,
        ...(h.provider ? { provider: h.provider } : {}),
        kept: tasks.filter((x) => x.status === "done").length,
        waiting: tasks.filter(isLive).length,
      });
    } catch {}
    // the cards that handed work to this run keep waiting: a hold isn't the end of their change
    return true;
  }
  /** Pip tells the person once that the run is held on a provider, what was kept and what waits */
  onHold?: (
    p: OpenProject,
    h: { text: string; action: ProblemAction; provider?: string; kept: number; waiting: number },
  ) => void;
  /**
   * Hold the run for the person (§1.8). The one place `r.held` is set: it always opens a question (`from: "pip"`,
   * `hold: true`) with real options, so Needs you counts it. Answering it lifts the hold and acts on the choice
   * (holdAnswer); any other lift withdraws it.
   */
  private holdFor(
    p: OpenProject,
    r: Run,
    why: string,
    o: { scenes?: string[]; action?: ProblemAction; ref?: string } = {},
  ): boolean {
    if (r.held) return false;
    r.held = why
      .trim()
      .replace(/^Waiting for you: /, "")
      .replace(/\.$/, "");
    r.paused = true;
    p.state.paused = true;
    p.saveState();
    p.setStatus({ line: `Waiting for you: ${r.held}` });
    p.say({ from: "pip", to: "crew", kind: "brief", text: pausedLine(r.held), ...(o.ref ? { ref: o.ref } : {}) });
    const scenes = (o.scenes ?? []).filter((s) => p.doc().scenes.some((x) => x.id === s));
    const { options, recommendedId } = holdOptions({
      scenes: scenes.map((s) => sceneWord(p, s)),
      ...(o.action ? { action: o.action } : {}),
    });
    const q = p.ask(
      {
        kind: "single",
        question: holdQuestion(r.held),
        why: "The crew stopped and waits for your pick.",
        options,
        recommendedId,
        blocks: scenes,
        timeoutSec: null,
        from: "pip",
        hold: true,
      },
      "pip",
    );
    r.holdQ = q.id;
    return true;
  }
  /**
   * The person answered a hold's question (Workspace.onAnswer, before the store records it): an option that can't
   * act yet keeps it open ("keep"): Fix the key (saving a key lifts the hold), and Tell Pip with no words in the note.
   * Anything else is recorded, then acted on: the hold lifts, the Director re-plans, or the note becomes a change.
   */
  holdAnswer(p: OpenProject, q: QuestionT, a: { optionId?: string; note?: string }): "keep" | undefined {
    const id = a.optionId ?? q.recommendedId;
    if (id === "fix_key") return "keep";
    if (id === "tell" && !a.note?.trim()) return "keep";
    setTimeout(() => {
      try {
        this.actOnHold(p, q, id, a.note?.trim());
      } catch (e: any) {
        p.emit("log", { level: "error", text: `the hold's answer failed: ${String(e?.message ?? e).slice(0, 200)}` });
      }
    }, 0);
    return undefined;
  }
  private actOnHold(p: OpenProject, q: QuestionT, id: string, note?: string) {
    const r = this.runs.get(p.id);
    // an older hold's question: the run it held has moved on
    if (r && r.holdQ !== q.id) return;
    const scenes = q.blocks.filter((s) => p.doc().scenes.some((x) => x.id === s));
    if (id === "tell" && note) {
      const target = scenes.length === 1 ? { scene: scenes[0] } : {};
      const n = p.addNote({
        target,
        category: "other",
        text: note.slice(0, 1000),
        assignee: changeOwner(target, "other", note),
        by: "user",
      });
      if (!r) {
        p.state.paused = false;
        p.saveState();
      }
      this.requestChange(p, n);
      return;
    }
    if (id === "redo_director" && scenes.length) {
      for (const s of scenes) if (p.state.sceneStatus[s]) p.setSceneStatus(s, { version: "animatic", state: "stale" });
      const why = `You asked the Director to re-plan ${scenes.map((s) => sceneWord(p, s)).join(" and ")}.`;
      p.say({
        from: "pip",
        to: "director",
        kind: "brief",
        text: `Re-plan ${scenes.join(", ")}: ${why}`,
        ref: scenes[0],
      });
      this.planRevise(p, r ?? null, { by: "person", trigger: "change", reason: why }, (ts, ctx) =>
        addReboard(ts, scenes, ctx, { reason: why.slice(0, 200) }),
      );
    }
    if (r) this.liftHold(p, r);
    else this.resumeHeld(p);
  }
  /** a held project whose run ended (a restart): its plan goes on */
  private resumeHeld(p: OpenProject) {
    p.state.paused = false;
    p.saveState();
    p.setStatus({ line: "Picking up where the crew left off", problem: undefined, waiting: undefined });
    if (this.runs.has(p.id)) return;
    const { startedAt: _s, ...change } = p.state.change ?? ({} as any);
    this.run(p, { resume: true, ...(p.state.change ? { change } : {}) }).catch(() => {});
  }
  /** lift a hold: the run goes on from where it stopped (`quiet`: only the flags, a new hold follows at once) */
  private liftHold(p: OpenProject, r: Run, o: { quiet?: boolean } = {}) {
    if (r.holdQ) p.withdraw(r.holdQ);
    r.holdQ = undefined;
    r.hold = undefined;
    r.held = undefined;
    r.paused = false;
    p.state.paused = false;
    p.saveState();
    if (o.quiet) return;
    p.setStatus({ line: STAGE_LINE[p.state.stage] ?? "The crew is working", problem: undefined, waiting: undefined });
    p.say({ from: "pip", to: "crew", kind: "brief", text: "Back to work: the hold is lifted." });
    r.resume?.();
    r.exec?.wake();
  }
  /**
   * A provider's key was saved, or its test passed (`PUT /api/settings/providers/:id/key`, `POST …/test`): runs held
   * on it go on, and a project held on it whose run ended (a restart) resumes. Without an id, every hold lifts. A
   * passing test doesn't lift a credit hold (listing models works with no credit): a saved key or Try again does.
   */
  providerFixed(provider?: string, o: { test?: boolean } = {}): string[] {
    const out: string[] = [];
    const mine = (x?: string, kind?: string) => (!provider || !x || x === provider) && !(o.test && kind === "credit");
    for (const [id, r] of this.runs)
      if (r.hold && mine(r.hold.provider, r.hold.kind))
        try {
          this.liftHold(this.deps.workspace.get(id), r);
          out.push(id);
        } catch {}
    for (const { id } of this.deps.workspace.list()) {
      if (this.runs.has(id) || out.includes(id)) continue;
      try {
        const p = this.deps.workspace.get(id);
        const pr = p.state.status.problem;
        if (!pr || !(pr.action === "fix_key" || (pr.action === "retry" && pr.provider)) || !mine(pr.provider, pr.kind))
          continue;
        p.state.paused = false;
        p.saveState();
        for (const q of p.state.questions.filter((x) => x.hold && x.status === "open")) p.withdraw(q.id);
        p.setStatus({ line: "Picking up where the crew left off", problem: undefined, waiting: undefined });
        // as after a restart: the held run's running and waiting tasks start again
        const { startedAt: _s, ...change } = p.state.change ?? ({} as any);
        this.run(p, { resume: true, ...(p.state.change ? { change } : {}) }).catch(() => {});
        out.push(id);
      } catch {}
    }
    return out;
  }
  /**
   * "Try again" and Pip's "Redo what failed" (POST /crew/retry): a held run goes on; an idle crew runs the failed and
   * fallback tasks again (only `taskId`'s plan task when given: a plan task id or a state.tasks row id).
   */
  retry(p: OpenProject, o: { taskId?: string } = {}): { started: boolean; resumed: boolean; busy?: boolean } {
    const r = this.runs.get(p.id);
    if (r) {
      if (!r.hold && !r.held) return { started: false, resumed: false, busy: true };
      this.liftHold(p, r);
      return { started: false, resumed: true };
    }
    p.state.paused = false;
    p.saveState();
    this.run(p, { retry: true, ...(o.taskId ? { taskId: o.taskId } : {}) }).catch(() => {});
    return { started: true, resumed: false };
  }
  /** what a retry redoes: the failed and fallback plan tasks, or the one `taskId` names when it is one of them */
  retryTargets(p: OpenProject, taskId?: string): PlanTaskT[] {
    const tasks = this.planNow(p)?.tasks ?? [];
    const redo = (t: PlanTaskT) => t.status === "failed" || (t.status === "done" && t.outcome === "fallback");
    if (taskId) {
      const id = tasks.some((t) => t.id === taskId) ? taskId : p.state.tasks.find((x) => x.id === taskId)?.planTask;
      const one = tasks.find((t) => t.id === id);
      // a judge whose stand-in was cast redraws the variants that fell back with it
      if (one && redo(one))
        return one.kind === "asset.judge"
          ? [...tasks.filter((t) => t.kind === "asset.draw" && t.asset === one.asset && redo(t)), one]
          : [one];
    }
    return tasks.filter(redo);
  }
  /**
   * A verdict on a gate (HTTP, MCP's gate_decide, a Pip card). Only a gate that is open, or that a run waits on, takes
   * one: a click on an old card can't pass a gate a rerun locked again (409).
   */
  gate(p: OpenProject, gate: string, v: { verdict: string; items?: string[]; reasons?: string[]; by: string }) {
    const waiter = this.gateWaiters.get(`${p.id}:${gate}`);
    const now = p.state.gates.find((x) => x.id === gate);
    if (!waiter && now?.status !== "open")
      throw new StoreError(
        "gate_not_open",
        `${gate} isn't waiting for a verdict (it is ${now?.status ?? "unknown"})`,
        now?.status === "changes"
          ? "say what to change in Pip's field (crew_request_change), or run the crew again to be asked at this gate"
          : "answer a gate when the crew opens it (state.gates status open)",
        409,
      );
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
   * superseded), the plan gets a change revision, and the crew runs it, unless the person paused it.
   */
  requestChange(p: OpenProject, note: Note, extra: Note[] = []): ChangeResult {
    const stage = OWNER_STAGE[note.assignee] ?? "review";
    const live = this.runs.get(p.id);
    if (live && !live.held) {
      p.emit("log", { level: "info", text: `${note.id} waits for the next review: the crew is working` });
      return { queued: true, stage, started: false, resumed: false };
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
    const was = p.state.change;
    const { from, change } = this.startChange(p, notes);
    if (live) {
      // a held run: the change is the person's answer to the hold. The run takes it on (its notes, its scenes) and
      // goes on now; a provider hold still waits for the key, with the change in its plan
      live.change = mergeChange(live.change, change);
      live.scope = live.change.scope ? new Set(live.change.scope) : undefined;
      p.state.change = { ...live.change, startedAt: was?.startedAt ?? live.startedAt };
      p.saveState();
      if (live.hold) {
        live.exec?.wake();
        const q = p.state.questions.find((x) => x.id === live.holdQ && x.status === "open");
        return { queued: false, stage: from, started: false, resumed: false, ...(q ? { waiting: q.question } : {}) };
      }
      this.liftHold(p, live);
      return { queued: false, stage: from, started: true, resumed: true };
    }
    if (p.state.paused) return { queued: false, stage: from, started: false, resumed: false };
    this.run(p, { stage: from, change }).catch(() => {});
    return { queued: false, stage: from, started: true, resumed: false };
  }
  /**
   * reopen the stage a change needs and write its plan revision (§1.7 "Change requests become revisions"). Only what
   * the change touches comes back (`keepOf`); the new total is what the person approved by asking.
   */
  private startChange(p: OpenProject, notes: Note[]) {
    // rev 0 first, from the project as it was before the change reopened anything
    this.ensurePlan(p, null);
    const from = this.reopen(p, notes);
    const change = planChange(p, notes, (s) => this.sceneAssets(p, s));
    p.state.change = { ...change, startedAt: new Date().toISOString() };
    p.saveState();
    const what = notes[0]?.text.slice(0, 160) ?? "a change";
    this.planRevise(p, null, { by: "person", trigger: "change", reason: `Your change: ${what}` }, (ts, ctx) =>
      changeRevision(ts, change, from, ctx, p.state.sceneStatus, this.keepOf(p, change.assets)),
    );
    return { from, change };
  }
  /**
   * What a change would cost before it runs (the change card, §1.9): its revision on a copy of the plan, nothing
   * written. `null` when the project has no plan yet (the card then prices the change from the kinds it touches).
   */
  changeCost(
    p: OpenProject,
    c: { assignee: string; scene?: string; asset?: string },
  ): { usd: [number, number]; toUsd: [number, number] } | null {
    const plan = this.planNow(p);
    if (!plan) return null;
    const note = {
      id: "preview",
      target: { ...(c.scene ? { scene: c.scene } : {}), ...(c.asset ? { asset: c.asset } : {}) },
      assignee: c.assignee,
    } as Note;
    let from = OWNER_STAGE[c.assignee] ?? "review";
    if (STAGES.indexOf(p.state.stage) < STAGES.indexOf(from)) from = p.state.stage;
    const ss = structuredClone(p.state.sceneStatus);
    for (const id of c.scene ? [c.scene] : c.assignee === "animator" ? Object.keys(ss) : [])
      if (ss[id]) ss[id] = { version: "animatic", state: "stale" };
    const change = planChange(p, [note], (s) => this.sceneAssets(p, s));
    const out = changeRevision(
      plan.tasks.map((t) => ({ ...t })),
      change,
      from,
      this.rulesCtx(p, plan.rev + 1),
      ss,
      this.keepOf(p, change.assets),
    );
    const env = this.planEnv(p);
    const spent = this.deps.gateway.spent(p.id).spentUsd;
    const was = planEstimate(plan.tasks, spent, env).usd;
    const now = planEstimate(out.tasks, spent, env).usd;
    const r = (x: number) => Math.max(0, Math.round(x * 10000) / 10000);
    return { usd: [r(now[0] - was[0]), r(now[1] - was[1])], toUsd: now };
  }
  /**
   * What a rerun keeps as it is (§1.9): the chain and rights OK of art the project already has as itself (a stand-in
   * isn't art: a retry redraws it), and its publish question (answered, or about art that stays). `redraw` names
   * assets the change redoes.
   */
  keepOf(p: OpenProject, redraw: string[] = []): (t: PlanTaskT) => boolean {
    const d = p.doc();
    return (t) => {
      // a publish question already met (or asked of art that stays as it is) is never asked again
      if (t.kind === "lib.publish")
        return (
          d.assets.some((a) => a.id === t.asset && !!a.publish) ||
          (!!t.asset && !redraw.includes(t.asset) && hasArt(d, t.asset))
        );
      if (!t.asset || redraw.includes(t.asset)) return false;
      if (t.kind.startsWith("asset.") || (t.kind === "gate" && t.gate === "rights")) return hasArt(d, t.asset);
      return false;
    };
  }
  /** the art is in the project as itself and this change doesn't redraw it: its chain skips (a run-time guard) */
  private drawn(p: OpenProject, name: string) {
    return hasArt(p.doc(), name) && !p.state.change?.assets?.includes(name);
  }

  /** called when a run ends, or stops at a gate for the person, with what it did (Pip settles its cards) */
  onRunEnd?: (p: OpenProject, report: RunReport) => void;
  /**
   * The budget can't cover the next task, or spend crossed the ask-at line (§1.6 "Overrun"): the executor starts
   * nothing new. Pip turns this into the /budget card (P1b); without it the status line asks.
   */
  onOverrun?: (
    p: OpenProject,
    o: {
      needUsd: number;
      capUsd: number;
      spentUsd: number;
      suggestUsd: number;
      /** what "Finish within" would leave out, in the person's words, and whether the rest then fits */
      finish?: { trims: string[]; fits: boolean; restUsd: number; shortUsd: number };
    },
  ) => void;

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

  /**
   * Every rerun (a change, a retry, a run from a stage) locks the gates at and after the stage it reopens (§1.9), so
   * no copied gate passes on an old approval: the person is asked again (a resume never relocks).
   */
  private relockFrom(p: OpenProject, from: Stage) {
    for (const g of GATES.slice(GATES.indexOf(STAGE_GATE[from])))
      if (p.state.gates.find((x) => x.id === g)?.status !== "locked")
        p.setGate(g, { status: "locked", verdict: undefined });
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
    this.relockFrom(p, from);
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
        this.run(p, { resume: true, ...(p.state.change ? { change } : {}) }).catch(() => {});
        out.push(id);
      } catch {}
    }
    return out;
  }

  /**
   * Run the plan. `stage` reruns the plan from that stage (crew_run, a change); `resume` continues after a restart
   * (running and waiting tasks go back to pending); `retry` puts failed tasks back. With none of them the plan just
   * continues, or reruns from the current stage when nothing is left.
   */
  async run(
    p: OpenProject,
    opts: { stage?: string; change?: ChangePlan; resume?: boolean; retry?: boolean; taskId?: string } = {},
  ) {
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
      id: `run_${randomUUID().slice(0, 8)}`,
      revisions: 0,
    };
    this.runs.set(p.id, r);
    // the instance events follow the run from its first event
    this.tracker(p);
    p.state.startedAt ??= r.startedAt;
    p.state.paused = false;
    p.state.running = true;
    p.saveState();
    p.setDigest("The crew is working.");
    p.setStatus({ line: "The crew is working", problem: undefined, waiting: undefined });
    // the run's bounds in the log: a life never outlasts the run it belonged to (PIP-JOURNEY N24)
    p.emit("run", { id: r.id, status: "start" });
    let finished = false;
    let outcome: { status: RunReport["status"]; error?: string } = { status: "stopped" };
    // a raised cap: the executor looks again
    const onPatch = (e: { event: string; data: any }) => {
      if (e.event === "patch" && (e.data?.ops ?? []).some((o: any) => String(o.path).startsWith("/budget"))) {
        // a raised cap answers the overrun wait
        if (!r.held) this.unwait(p, r);
        r.resume?.();
        r.exec?.wake();
      }
    };
    p.events.on("event", onPatch);
    try {
      await this.execute(p, r, opts);
      if (r.abort.signal.aborted) throw new Paused("stopped");
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
        // blame the task the run really stopped on: a stuck plan names it; else this run's newest failure
        const rows = [...p.state.tasks].reverse();
        const blocking = typeof e?.blocking === "string" ? (e.blocking as string) : undefined;
        const failed =
          (blocking ? rows.find((x) => x.planTask === blocking) : undefined) ??
          rows.find((x) => x.status === "failed" && !x.supersededBy && (x.endedAt ?? "") >= r.startedAt) ??
          rows.find((x) => x.status === "failed" && !x.supersededBy);
        const blockRole = blocking ? this.planNow(p)?.tasks.find((t) => t.id === blocking)?.role : undefined;
        const h = humanize(e, failed?.role ?? blockRole);
        p.setStatus({ line: h.text, problem: { ...h, taskId: failed?.id ?? blocking } });
        p.setDigest(`The crew stopped: ${String(e?.message ?? e).slice(0, 200)}${e?.fix ? ` Fix: ${e.fix}` : ""}`);
        // the person's waits (a gate, a pick) end with the run
        r.abort.abort(new Paused("failed"));
      }
      throw e;
    } finally {
      p.events.off("event", onPatch);
      // its rows that are still open end with it (a pause "now", a failure): cancelled, ended now
      const at = new Date().toISOString();
      for (const t of p.state.tasks.filter(
        (x) => x.planTask && (x.status === "working" || x.status === "queued" || x.status === "waiting_user"),
      ))
        p.upsertTask({ ...t, status: "cancelled", endedAt: t.endedAt ?? at });
      p.emit("run", { id: r.id, status: outcome.status });
      this.runs.delete(p.id);
      // a finished, failed or deliberately stopped run is not resumed; only a crash leaves `running` set
      p.state.running = false;
      if (outcome.status !== "stopped") delete p.state.change;
      p.saveState();
      try {
        this.onRunEnd?.(p, this.report(p, r, outcome.status, outcome.error));
      } catch {}
      // changes the person asked for while this run worked, and that no review picked up: their stage reopens now
      // (only notes made during this run, so a change no stage can read never loops). A note no crew stage owns, or a
      // slash command that slipped into a note, is closed instead: it never reruns the crew (§1.9).
      const mine = p.state.notes.filter((n) => n.status === "open" && n.by === "user" && n.createdAt >= r.startedAt);
      for (const n of mine.filter((x) => !OWNER_STAGE[x.assignee] || x.text.trim().startsWith("/")))
        p.updateNote(n.id, { status: "declined", reason: "no crew stage owns this note" });
      // a note this run's change took on is its own, never a reason for another run
      const claimed = new Set(r.change?.notes ?? []);
      const left = p.state.notes.filter((n) => mine.includes(n) && n.status === "open" && !claimed.has(n.id));
      if ((finished || r.changesAt) && left.length && !p.state.paused) {
        const { from, change } = this.startChange(p, left);
        setTimeout(() => this.run(p, { stage: from, change }).catch(() => {}), 0);
      }
    }
  }

  /** the plan for this run (rev 0, a rerun from a stage, a resume, a retry), then the executor */
  private async execute(
    p: OpenProject,
    r: Run,
    opts: { stage?: string; change?: ChangePlan; resume?: boolean; retry?: boolean; taskId?: string },
  ) {
    const had = !!this.planNow(p);
    let plan = this.ensurePlan(p, r);
    // a resume continues the same run (its id stays in plan.runs); anything else is a new run
    const last = plan.runs.at(-1);
    if (opts.resume && had && last) r.id = last.id;
    else plan.runs = [...plan.runs, { id: r.id, startedAt: r.startedAt, pipProposals: 0 }];
    const sceneStatus = p.state.sceneStatus;
    if (opts.resume && had) {
      // running and ready work starts again; a person's wait opens again
      for (const t of plan.tasks)
        if (t.status === "running" || t.status === "ready" || t.status === "waiting_person") t.status = "pending";
      touch(p, plan, this.planEnv(p), this.deps.gateway.spent(p.id).spentUsd, this.pipView(p));
    } else if (opts.retry && this.retryTargets(p, opts.taskId).length) {
      const targets = this.retryTargets(p, opts.taskId);
      // the gates from the earliest redone stage on ask again
      this.relockFrom(
        p,
        targets.map(stageOf).reduce((a, b) => (STAGES.indexOf(b) < STAGES.indexOf(a) ? b : a)),
      );
      // the person asked for it, so the 20% rule doesn't hold it (by: "person")
      this.planRevise(
        p,
        r,
        {
          by: "person",
          trigger: "retry",
          reason: targets.length === 1 ? "Trying the step that failed again." : "Redoing what failed.",
        },
        (ts, ctx) => retryRevision(ts, targets, ctx.rev),
      );
    } else if (!opts.change) {
      const from = (opts.stage as Stage | undefined) ?? (plan.tasks.some(isLive) ? null : p.state.stage);
      if (from || (opts.resume && !had)) {
        const at = (from ?? p.state.stage) as Stage;
        if (from) this.relockFrom(p, at);
        this.planRevise(
          p,
          r,
          { by: "code", trigger: "start", reason: `The crew runs again from the ${at} stage.` },
          (ts) => reopenFrom(ts, at, plan.rev + 1, { sceneStatus, keep: this.keepOf(p) }),
        );
      }
    }
    plan = this.planNow(p)!;
    // a /new project: G0 was passed by Start, so Pip's revision comes now (once)
    if ((p.doc().brief as { source?: string }).source === "pip" && plan.rev === 0 && !had) {
      plan.approvedUsd ??= plan.estimate.usd[0];
      await this.pipRevise(p, r, "start");
      const now = this.planNow(p);
      if (now) p.milestone("plan.ready", `Plan ready · ${tasksToStart(now.tasks)} tasks to start`);
    }
    plan = this.planNow(p)!;
    const env = this.planEnv(p);
    let waitedOn = "";
    const exec = new Executor({
      tasks: () => this.planNow(p)?.tasks ?? [],
      held: (id) => !!this.planNow(p)?.pending?.tasks.includes(id),
      handle: (t) => this.handle(p, r, t),
      setStatus: (t, status, note, outcome) => this.setPlanStatus(p, t.id, status, note, outcome),
      endpoint: (t) => {
        const row = CATALOGUE[t.kind];
        if (t.role === "person" || !row.calls[1]) return null;
        const m = resolveTier(t.role as RoleT, t.tier, env);
        return m.slice(0, m.indexOf("/"));
      },
      laneSize: (ep) => env.laneSize(ep),
      affordable: (t) => this.affordable(p, r, t),
      overrun: (t) => this.overrun(p, r, t),
      stopped: () => r.paused,
      aborted: () => r.abort.signal.aborted,
      waitResume: () =>
        new Promise<void>((res) => {
          if (r.abort.signal.aborted) return res();
          r.resume = () => {
            r.resume = undefined;
            res();
          };
          r.abort.signal.addEventListener("abort", () => res(), { once: true });
        }).then(() => {
          if (!r.paused) p.emit("log", { level: "info", text: "crew resumed" });
        }),
      stageChanged: (s) => {
        if (p.state.stage !== s) p.setStage(s);
        if (!r.held && !/^Waiting for you/.test(p.state.status.line))
          p.setStatus({ phase: PHASE[s] ?? 0, line: STAGE_LINE[s] ?? "Working" });
        else p.setStatus({ phase: PHASE[s] ?? 0 });
      },
      drain: async (s) => {
        if (s === "animate" && this.planNow(p)?.tasks.some((t) => t.kind === "scene.tune" && t.status === "done"))
          p.milestone("scenes.animated", "Scenes animated");
        await this.drain(p, r, s);
      },
      // a provider failure is never a stand-in, whatever the task kind (§1.8); `hold` catches it first
      fatal: (t, e) => t.kind === "gate" || CATALOGUE[t.kind].fatal || holdsRun(e),
      hold: (t, e) => this.holdRun(p, r, e, t),
      waiting: (held) => {
        // only a card holds work now: say what the crew waits on
        const key = held.map((t) => t.id).join(",");
        if (r.held || key === waitedOn) return;
        waitedOn = key;
        p.setStatus({ line: "Waiting for you: the plan change in Pip's thread", waiting: "plan" });
      },
    });
    r.exec = exec;
    await exec.run();
    if (r.abort.signal.aborted) return;
    p.setStatus({ phase: 4, line: "Your video is ready", problem: undefined, waiting: undefined });
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

  /** the budget covers this task's worst case, and spend hasn't crossed the ask-at line unasked (§1.6) */
  private affordable(p: OpenProject, r: Run, t: PlanTaskT) {
    if (t.estUsd[1] <= 0) return true;
    const b = p.doc().budget;
    const { spentUsd, reservedUsd } = this.deps.gateway.spent(p.id);
    if (b.capUsd - spentUsd - reservedUsd < t.estUsd[1]) return false;
    const crossed = b.capUsd > 0 && (spentUsd + reservedUsd) / b.capUsd >= b.askAtFraction;
    return !crossed || r.overrun?.cap === b.capUsd;
  }
  private overrun(p: OpenProject, r: Run, t: PlanTaskT) {
    const b = p.doc().budget;
    const { spentUsd } = this.deps.gateway.spent(p.id);
    const fits = b.capUsd - spentUsd >= t.estUsd[1];
    const asked = r.overrun?.cap === b.capUsd;
    if (asked && fits) return;
    if (!asked) {
      r.overrun = { cap: b.capUsd };
      // at `auto` the crew wraps up within the cap by itself, and says so in Pip's thread
      if (p.doc().brief.involvement === "auto" && this.finishPlan(p)?.trims.length) {
        const done = this.finishWithinBudget(p, { auto: true });
        if (done.fits) return;
      }
      const now = this.finishPlan(p);
      const words = now ? now.trims.map((x) => trimWords(x, this.planNow(p)?.tasks ?? [])) : [];
      // a confirm applies exactly what the card lists, priced at what was left when it was asked
      if (now?.trims.length)
        this.finishOffers.set(p.id, {
          cap: b.capUsd,
          leftUsd: b.capUsd - spentUsd,
          ids: now.trims.map((x) => x.task),
        });
      try {
        this.onOverrun?.(p, {
          needUsd: t.estUsd[1],
          capUsd: b.capUsd,
          spentUsd,
          suggestUsd: this.suggestUsd(p, spentUsd),
          ...(words.length && now
            ? {
                finish: {
                  trims: words,
                  fits: now.fits,
                  restUsd: now.restUsd,
                  shortUsd: Math.max(0, now.restUsd - (b.capUsd - spentUsd)),
                },
              }
            : {}),
        });
      } catch {}
    }
    // only real remaining work: nothing the project already has, nothing a run-time guard would skip (§1.6)
    const want = Math.max(this.suggestUsd(p, spentUsd), b.capUsd + 0.5);
    // statements, no question mark: the line is also Pip's word to the crew, and the web ends a sentence once
    const why = fits
      ? `${Math.round(b.askAtFraction * 100)}% of the ${usd(b.capUsd)} cap is spent`
      : `the next step could cost ${usd(t.estUsd[1])} and ${usd(Math.max(0, b.capUsd - spentUsd))} is left`;
    const line = `Waiting for you: ${why}${fits ? `. Finish within it, or raise it to ${usd(want)}.` : ""}`;
    // a wait for the person, not a problem: the budget card is in Pip's thread (the status line names it)
    p.setStatus({ line, waiting: "budget" });
    p.say({
      from: "pip",
      to: "crew",
      kind: "brief",
      text: pausedLine(why),
      ref: t.id,
    });
  }
  /** the cap that finishes the real remaining work (none the project already satisfies), rounded up to $0.50 */
  suggestUsd(p: OpenProject, spentUsd = this.deps.gateway.spent(p.id).spentUsd) {
    return suggestCap(spentUsd, realRemaining(this.planNow(p)?.tasks ?? [], this.satisfied(p)));
  }
  /** live work the project already satisfies: the run-time guards skip it, so it costs nothing (§1.6) */
  private satisfied(p: OpenProject): (t: PlanTaskT) => boolean {
    const keep = this.keepOf(p, p.state.change?.assets ?? []);
    const st = p.state.sceneStatus;
    return (t) =>
      keep(t) ||
      (t.kind === "scene.tune" && !!t.scene && st[t.scene]?.version === "render" && st[t.scene]?.state === "ready");
  }
  /** what "Finish within" would trim now, on a copy (nothing written) */
  finishPlan(p: OpenProject) {
    const plan = this.planNow(p);
    if (!plan) return null;
    const { spentUsd } = this.deps.gateway.spent(p.id);
    return finishWithin(plan.tasks, {
      leftUsd: p.doc().budget.capUsd - spentUsd,
      satisfied: this.satisfied(p),
      ctx: this.rulesCtx(p, plan.rev + 1),
      reviewRounds: this.reviewRounds(),
    });
  }
  /**
   * "Finish within $X" (§1.6): a rules-made revision (`by: "code"`, trigger `budget`) trims droppable work in a fixed
   * order until the rest fits the cap. The overrun is answered for this cap and the crew goes on. At `auto` it runs
   * without asking, and Pip says what went in the thread.
   */
  finishWithinBudget(p: OpenProject, o: { auto?: boolean } = {}) {
    const r = this.runs.get(p.id) ?? null;
    const cap = p.doc().budget.capUsd;
    // the card's own offer (what it listed, at what was left then); `auto` and a stale offer price it now
    const offer = o.auto ? undefined : this.finishOffers.get(p.id);
    const mine = offer?.cap === cap ? offer : undefined;
    this.finishOffers.delete(p.id);
    let trims: TrimT[] = [];
    let fits = false;
    let before: PlanTaskT[] = [];
    this.planRevise(p, r, { by: "code", trigger: "budget", reason: `Finishing within the $${cap} cap.` }, (ts, ctx) => {
      before = ts;
      const { spentUsd } = this.deps.gateway.spent(p.id);
      const out = finishWithin(ts, {
        leftUsd: mine?.leftUsd ?? cap - spentUsd,
        satisfied: this.satisfied(p),
        ctx,
        reviewRounds: this.reviewRounds(),
        ...(mine ? { only: new Set(mine.ids) } : {}),
      });
      trims = out.trims;
      fits = out.fits;
      const words = out.trims.map((x) => trimWords(x, ts)).join("; ");
      return { tasks: out.tasks, ops: out.ops, reason: `Finishing within the $${cap} cap: ${words}.`.slice(0, 200) };
    });
    const words = trims.map((x) => trimWords(x, before));
    if (r) {
      r.overrun = { cap, finish: true };
      if (trims.some((x) => x.what === "review_round")) r.oneReview = true;
    }
    const text = words.length
      ? `To finish within the $${cap} cap I left out ${words.join(", ")}.${fits ? "" : " The rest may still need more; I'll ask if it does."}`
      : `Finishing within the $${cap} cap: there was nothing left to trim.`;
    p.say({ from: "pip", to: "crew", kind: "brief", text: text.slice(0, 300) });
    if (o.auto)
      try {
        this.onFinish?.(p, { capUsd: cap, trims: words, fits });
      } catch {}
    this.unwait(p, r ?? undefined);
    // the run that asked already ended: confirming starts the crew again (as a held card does, §1.8)
    if (!r) this.restartIdle(p);
    // the executor waits for a resume after an overrun: wake it once it does
    setTimeout(() => {
      r?.resume?.();
      r?.exec?.wake();
    }, 0);
    return { trims, fits };
  }
  /** the "Finish within" card's offer per project: what it listed, and what was left of the cap when it asked */
  private finishOffers = new Map<string, { cap: number; leftUsd: number; ids: string[] }>();
  /** at `auto` the crew trimmed to finish within the cap by itself: Pip says what went (a visible assumption) */
  onFinish?: (p: OpenProject, o: { capUsd: number; trims: string[]; fits: boolean }) => void;
  /** the person declined the overrun card: go on with what fits (P1b) */
  declineOverrun(p: OpenProject) {
    const r = this.runs.get(p.id);
    if (!r) return;
    r.overrun = { cap: p.doc().budget.capUsd, declined: true };
    this.unwait(p, r);
    r.resume?.();
    r.exec?.wake();
  }

  /** run one plan task's handler */
  private async handle(p: OpenProject, r: Run, t: PlanTaskT): Promise<Outcome> {
    switch (t.kind) {
      case "producer.plan":
        return this.brief(p, r, t);
      case "writer.angles":
        return this.script(p, r, t);
      case "director.storyboard":
        return t.scenes?.length ? this.reboard(p, r, t.scenes, t) : this.storyboard(p, r, t);
      case "art.cast":
        return this.cast(p, t);
      case "asset.import":
        return this.importLogo(p, t);
      case "asset.spec":
        return this.assetSpec(p, r, t);
      case "asset.draw":
        return this.assetDraw(p, r, t);
      case "asset.judge":
        return this.assetJudge(p, r, t);
      case "scene.tune":
        return this.tune(p, r, t);
      case "vo.align":
        return this.narrate(p, r, t);
      case "sound.mix":
        return this.sound(p, t);
      case "review.final":
        return this.review(p, r, t);
      case "deliver.export":
        return this.deliver(p, r, t);
      case "lib.publish":
        return this.publish(p, r, t);
      case "gate":
        return this.gateTask(p, r, t);
    }
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
      // N10: the instance's subject (its scene or asset), else its plan task, else the row
      const pt = t.planTask ? this.planNow(p)?.tasks.find((x) => x.id === t.planTask) : undefined;
      const ref = this.taskScenes.get(t.id) ?? pt?.scene ?? pt?.asset ?? t.planTask ?? t.id;
      p.say({
        from: t.role,
        to: "pip",
        kind: "report",
        // what it did, as a sentence ("Found 6 problems in scenes 2 and 4."), never "done: …"
        text: `${rep.status === "partial" ? "Partly done: " : rep.status === "blocked" ? "Stuck: " : ""}${cutWords(did, 240)}${rep.couldnt ? ` Couldn't: ${rep.couldnt}` : ""}${rep.needs ? ` Needs: ${rep.needs}` : ""}`,
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
  /** the row ends failed, or `partial` when its task goes on with a stand-in (a retry redoes it) */
  private failTask(p: OpenProject, t: Task, e: any, partial = false) {
    this.grants.delete(t.id);
    return p.upsertTask({
      ...t,
      status: partial ? "partial" : "failed",
      endedAt: new Date().toISOString(),
      error: { message: String(e?.message ?? e).slice(0, 400), fix: e?.fix },
    });
  }

  /**
   * A handler's stand-in (§1.8): a stop or a provider failure (`holdsRun`) rethrows, so the run holds instead of
   * carrying on with stand-ins; anything else ends the task done on its fallback, its row `partial`.
   */
  private fallbackOr(p: OpenProject, r: Run, row: Task | null, e: unknown, note: string): Outcome {
    if (r.abort.signal.aborted || holdsRun(e)) {
      if (row) this.failTask(p, row, e);
      throw e;
    }
    if (row) this.failTask(p, row, e, true);
    return { status: "done", note: `partial: ${note}`.slice(0, 200), outcome: "fallback" };
  }

  /** the model a plan task's tier resolves to; undefined keeps the role's own (and its fallback) */
  private modelOf(p: OpenProject, pt: PlanTaskT): string | undefined {
    return pt.tier === "role" ? undefined : resolveTier(pt.role as RoleT, pt.tier, this.planEnv(p));
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
      images?: { caption: string; data: Uint8Array; mediaType?: "image/png" | "image/jpeg" }[];
      /** the plan task's tier, resolved (undefined: the role's model) */
      model?: string;
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
    for (const im of o.images ?? []) content.push({ type: "text", text: im.caption }, img(im.data, im.mediaType));
    content.push(...(o.extra ?? []));
    const messages: ChatMessage[] = [...(o.history ?? []), { role: "user", content }];
    const doc = p.doc();
    const model = o.model ?? this.deps.gateway.modelFor(o.role, doc.crew.models);
    p.log(t.id, {
      kind: "model",
      title: `Asked ${model.split("/").pop()} (${c.id})`,
      // `kind` names the step in the drawer ("Critiqued variant 1"): one card serves a repair and a critique
      detail: { prompt: userText.slice(0, 6000), images: (o.images ?? []).map((i) => i.caption), kind: o.kind },
    });
    let thinking = "";
    const started = Date.now();
    // the live line (docs/API.md `progress`): thinking or writing, about how many tokens, the answer's tail; a drawing
    // also streams its raw JSON so far and the palette, for the live canvas. Throttled to one event per 250 ms, and a
    // heartbeat each second so the clock moves while a provider sends nothing
    const draws = o.prompt.startsWith("pixel-artist/");
    const colours = draws ? this.palette().colours : undefined;
    const live = { phase: "thinking" as "thinking" | "writing", chars: 0, tail: "", draft: "", last: 0 };
    const beat = (force = false) => {
      const now = Date.now();
      if (!force && now - live.last < 250) return;
      live.last = now;
      p.progress(t.id, {
        phase: live.phase,
        tokens: Math.round(live.chars / 4),
        seconds: Math.round((now - started) / 1000),
        tail: live.tail.slice(-400),
        ...(draws ? { draft: live.draft, palette: colours } : {}),
      });
    };
    const heart = setInterval(() => beat(true), 1000);
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
        model,
        signal: r.abort.signal,
        normalize: o.normalize,
        onEvent: (e) => {
          if (e.type === "thinking") {
            if (e.text && thinking.length < 20000) thinking += e.text;
            live.chars += e.text?.length ?? 0;
          } else if (e.type === "tool_call") live.draft = "";
          else {
            // a later rung of the structured ladder starts its answer again
            live.phase = "writing";
            live.chars += e.text.length;
            live.tail = (live.tail + e.text).slice(-1200);
            if (draws && live.draft.length < 60000) live.draft += e.text;
          }
          beat();
        },
      })
      .catch((e: any) => {
        p.log(t.id, { kind: "error", title: String(e?.message ?? e).slice(0, 200), thinking: thinking || undefined });
        throw e;
      })
      .finally(() => clearInterval(heart));
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

  /**
   * Wait at a gate unless the involvement level lets it pass. `every` stops at all five; `key` (D2) stops at the
   * brief, the rough cut and (via the pick) the script: the animatic passes by itself, and "Looks good" at the rough
   * cut passes the final too; `auto` passes them all in code. The wait ends with the run.
   */
  private async atGate(
    p: OpenProject,
    r: Run,
    pt: PlanTaskT | null,
    gate: GateId,
    items: { label: string; ref?: string }[],
  ) {
    const inv = p.doc().brief.involvement;
    const auto = inv === "auto";
    const withRough = gate === "g4_final" && inv === "key" && r.roughByUser;
    const userGate = inv === "every" || (inv === "key" && ["g0_brief", "g3_rough", "g4_final"].includes(gate));
    if (withRough) {
      p.setGate(gate, {
        status: "passed",
        items,
        verdict: { by: "user", verdict: "approve", at: new Date().toISOString(), note: "with the rough cut" } as any,
      });
      return { verdict: "approve" };
    }
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
    if (pt) this.setPlanStatus(p, pt.id, "waiting_person");
    const v = await this.waitGate(p, r, gate);
    if (v.verdict === "changes") this.changesAsked(p, r, gate, v);
    if (gate === "g3_rough" && v.by === "user") r.roughByUser = true;
    return v;
  }
  /**
   * "Change something" at a gate is never a pass (§1.9): its reasons become the person's note to the gate's owner,
   * the run ends at the gate (the gate task goes back to pending), and the run's end starts the change. With no
   * reasons the run waits for the person to say what to change (Pip's field; crew_request_change).
   */
  private changesAsked(
    p: OpenProject,
    r: Run,
    gate: GateId,
    v: { verdict: string; reasons?: string[]; items?: string[] },
  ): never {
    const text = [...(v.reasons ?? []), ...(v.items ?? [])]
      .map((x) => x.trim())
      .filter(Boolean)
      .join("; ")
      .slice(0, 2000);
    const owner = GATE_OWNER[gate] ?? "editor";
    if (text && !text.startsWith("/")) p.addNote({ target: {}, category: "other", text, assignee: owner, by: "user" });
    r.changesAt = gate;
    p.setStatus({
      line: text ? "The crew is making your change" : `Waiting for you: what to change in ${GATE_WORDS[gate] ?? gate}`,
    });
    r.abort.abort(new Paused("changes"));
    throw new Paused("changes");
  }
  private waitGate(p: OpenProject, r: Run, gate: GateId) {
    return new Promise<{ verdict: string; reasons?: string[]; by: string }>((res, rej) => {
      this.gateWaiters.set(`${p.id}:${gate}`, res);
      if (r.abort.signal.aborted) rej(new Paused("stopped"));
      r.abort.signal.addEventListener("abort", () => rej(new Paused("stopped")), { once: true });
    });
  }

  // ---------------------------------------------------------------- the handlers (one per plan task kind)
  /** producer.plan: the digest, the assumptions, and the questions only the person can answer */
  private async brief(p: OpenProject, r: Run, pt: PlanTaskT): Promise<Outcome> {
    const d = p.doc();
    const auto = d.brief.involvement === "auto";
    const t = this.task(p, { kind: "producer.plan", role: "producer", title: "Reading the brief", ...this.ptOf(pt) });
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
        const fromPip = await this.askPip(p, r, "producer", q, pt.id);
        if (fromPip) {
          notes.push({ by: "pip", text: `${q.question} → ${fromPip}` });
          continue;
        }
        const asked = p.ask({ ...q, kind: "single", blocks: ["script"], from: "producer" }, "producer");
        p.upsertTask({ ...t, status: "waiting_user", title: "Waiting for your answers" });
        this.setPlanStatus(p, pt.id, "waiting_person");
        const a = await p.waitAnswer(asked.id, r.abort.signal);
        this.setPlanStatus(p, pt.id, "running");
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
    return { status: "done" };
  }

  /** a gate task: the person's pick or OK, or the code that comes with it (the script pick, the animatic) */
  private async gateTask(p: OpenProject, r: Run, pt: PlanTaskT): Promise<Outcome> {
    switch (pt.gate) {
      case "g0_brief": {
        await this.atGate(p, r, pt, "g0_brief", [{ label: "Brief and budget" }]);
        // what the person approved at G0 is the plan's total now (the 20% line, §1.6)
        const plan = this.planNow(p);
        if (plan) {
          plan.approvedUsd = plan.estimate.usd[0];
          touch(p, plan, this.planEnv(p), this.deps.gateway.spent(p.id).spentUsd, this.pipView(p));
        }
        await this.pipRevise(p, r, "g0");
        const now = this.planNow(p);
        if (now) p.milestone("plan.ready", `Plan ready · ${tasksToStart(now.tasks)} tasks to start`);
        return { status: "done" };
      }
      case "g1_script":
        return this.pickScript(p, r, pt);
      case "g2_animatic": {
        // the animatic: rendered straight away from library assets and placeholder boxes
        const ren = await p.renderer_();
        const sheet = await contactSheet(ren, { every: 1 });
        writeFileSync(join(p.dir, "out", "animatic-contact.png"), sheet);
        p.emit("render", { kind: "still", url: `/api/p/${p.id}/files/animatic-contact.png` });
        for (const sc of p.doc().scenes) p.setSceneStatus(sc.id, { version: "animatic", state: "ready" });
        await this.atGate(p, r, pt, "g2_animatic", [
          { label: "Animatic: pacing before any art is drawn", ref: "out/animatic-contact.png" },
        ]);
        return { status: "done" };
      }
      case "rights":
        return this.rights(p, r, pt);
      case "g3_rough":
        return this.rough(p, r, pt);
      case "g4_final":
        await this.atGate(p, r, pt, "g4_final", [{ label: "Final video" }]);
        return { status: "done" };
      default:
        return { status: "skipped", note: `no gate ${pt.gate}` };
    }
  }

  /** writer.angles: three angles in the word budget, with one repair turn */
  private async script(p: OpenProject, r: Run, pt: PlanTaskT): Promise<Outcome> {
    const d = p.doc();
    const t = this.task(p, {
      kind: "writer.angles",
      role: "writer",
      title: "Writing three script angles",
      ...this.ptOf(pt),
    });
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
        model: this.modelOf(p, pt),
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
          model: this.modelOf(p, pt),
        });
      }
      for (const n of p.state.notes.filter((x) => x.assignee === "writer" && x.status === "open"))
        p.updateNote(n.id, { status: "done", reason: "the Writer rewrote the script with it" });
      const { angles } = out.data;
      const recommended = Math.min(out.data.recommended, angles.length - 1);
      this.done(p, t, {
        summary: angles.map((a, i) => `${i === recommended ? "★ " : ""}${a.name}: ${a.cues[0]}`).join(" / "),
      });
      r.angles = { angles, recommended, row: t.id };
      writeFileSync(join(p.dir, "runs", "angles.json"), JSON.stringify(r.angles, null, 1));
    } catch (e) {
      this.failTask(p, t, e);
      throw e;
    }
    return { status: "done" };
  }

  /** G1: the person picks an angle (unless the crew runs on its own), then the cues are set and the timing follows */
  private async pickScript(p: OpenProject, r: Run, pt: PlanTaskT): Promise<Outcome> {
    const f = join(p.dir, "runs", "angles.json");
    const st: AnglesState | undefined = r.angles ?? (existsSync(f) ? JSON.parse(readFileSync(f, "utf8")) : undefined);
    if (!st) throw Object.assign(new Error("no script angles to pick from"), { fix: "run the Writer again" });
    const { angles, recommended } = st;
    const t = p.state.tasks.find((x) => x.id === st.row) ?? ({ id: st.row, role: "writer" } as Task);
    const auto = p.doc().brief.involvement === "auto";
    let pick = recommended;
    try {
      if (!auto) {
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
            // the pick is the script gate's own choice: it blocks the script (G1), so the person sees it there
            blocks: ["script"],
            from: "writer",
          },
          "writer",
        );
        p.setGate("g1_script", { status: "open", items: [{ label: "Pick a script angle", ref: q.id }] });
        this.setPlanStatus(p, pt.id, "waiting_person");
        const a = await p.waitAnswer(q.id, r.abort.signal);
        pick = Number((a.answer?.optionId ?? `angle_${recommended}`).split("_")[1]);
      }
      const chosen = angles[pick] ?? angles[0];
      p.log(t.id, {
        kind: "step",
        title: auto ? `The crew picked "${chosen.name}" (it runs on its own)` : `You picked "${chosen.name}"`,
      });
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
      if (t.status) this.failTask(p, t, e);
      throw e;
    }
    return { status: "done" };
  }

  private libraryList() {
    return libraryIndex().assets.map((a) => {
      const f = JSON.parse(readFileSync(join(libraryAssetDir(a.id)!, "asset.json"), "utf8"));
      return `${a.id}: ${a.kind} ${a.w}x${a.h}, frames ${f.frames.slice(0, 10).join(", ")}${f.frames.length > 10 ? ", …" : ""}`;
    });
  }
  /** art the plan already brings in (imported logos, drawings from references), for the Director's asset list */
  private plannedArt(p: OpenProject): string[] {
    const plan = this.planNow(p);
    return (plan?.tasks ?? [])
      .filter(
        (t) =>
          (t.kind === "asset.import" || t.kind === "asset.spec") &&
          t.asset &&
          !t.expand &&
          isLive(t) &&
          (t.fromRef || t.description),
      )
      .map((t) =>
        t.kind === "asset.import"
          ? `${t.asset}: icon 16x16, the person's logo (use it as toast iconAsset or item_collect itemAsset)`
          : `${t.asset}: ${t.assetKind ?? "character"}${t.assetKind === "creature" ? ` ${t.assetSize ?? "16x16"} ${t.motion ?? "walk"}` : ""} ${t.fromRef ? "drawn from the person's reference" : "being drawn for this video"} (add it to newAssets as "${t.asset}")`,
      );
  }

  /** director.storyboard: the board from the recipe menu (the baseline board when the model can't), recipes set */
  private async storyboard(p: OpenProject, r: Run, pt: PlanTaskT): Promise<Outcome> {
    const t = this.task(p, {
      kind: "director.storyboard",
      role: "director",
      title: "Building scenes from the recipe menu",
      ...this.ptOf(pt),
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
      const libNames = [...this.libraryList(), ...this.plannedArt(p)];
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
          model: this.modelOf(p, pt),
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
            model: this.modelOf(p, pt),
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
      await this.applyBoard(p, t, board);
      this.done(p, t, {
        summary: board.scenes.map((s) => `${s.title} (${s.recipes.map((x) => x.id).join(", ")})`).join(" → "),
      });
    } catch (e) {
      this.failTask(p, t, e);
      throw e;
    }
    this.expandAfterBoard(p, r);
    return { status: "done" };
  }

  /** the board is set: the scene and new-art placeholders become real tasks (a `code` revision, §1.3 "Expansion") */
  private expandAfterBoard(p: OpenProject, r: Run) {
    const f = join(p.dir, "runs", "new-assets.json");
    const pending: NewAsset[] = existsSync(f) ? JSON.parse(readFileSync(f, "utf8")) : [];
    const refs = (this.planNow(p)?.tasks ?? []).filter((t) => t.kind === "asset.spec" && t.fromRef && isLive(t));
    const fresh = pending.filter((a) => !refs.some((t) => t.asset === a.name));
    this.planRevise(p, r, { by: "code", trigger: "expand", reason: "The storyboard is done." }, (ts, ctx) =>
      expandPlan(ts, p.doc(), fresh as NewAsset[], ctx),
    );
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
      ...d.assets.map((a) => a.id),
      ...this.plannedArt(p).map((l) => l.split(":")[0]),
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

  /** the scene windows, then each scene's recipes; what needs drawing goes to runs/new-assets.json (cast: art.cast) */
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
    for (const s of b.scenes)
      await this.tool(p, "director", t.id, "scene_set_recipes", {
        scene: s.id,
        recipes: s.recipes,
        reason: `recipes for ${s.title}`,
      });
    // remember what needs drawing (a drawing from a reference keeps its reference)
    const refs = new Map(
      (this.planNow(p)?.tasks ?? [])
        .filter((x) => x.kind === "asset.spec" && x.fromRef)
        .map((x) => [x.asset, x.fromRef]),
    );
    const pending = b.newAssets
      .filter((a) => !p.doc().assets.some((x) => x.id === a.name))
      .map((a) => (refs.get(a.name) ? { ...a, fromRef: refs.get(a.name) } : a));
    writeFileSync(join(p.dir, "runs", "new-assets.json"), JSON.stringify(pending, null, 1));
    for (const sc of b.scenes) p.setSceneStatus(sc.id, { version: "board", state: "ready" });
  }

  /** art.cast: the Art Director casts the library assets the scenes' recipes name (and the font) */
  private async cast(p: OpenProject, pt: PlanTaskT): Promise<Outcome> {
    const t = this.task(p, {
      kind: "art.cast",
      role: "art-director",
      title: pt.scenes?.length ? `Casting for ${pt.scenes.join(", ")}` : "Casting the library art",
      ...this.ptOf(pt),
    });
    try {
      const scenes = p
        .doc()
        .scenes.filter((s) => s.kind === "decl" && (!pt.scenes?.length || pt.scenes.includes(s.id))) as {
        recipes: { id: string; params: Record<string, unknown> }[];
      }[];
      const f = join(p.dir, "runs", "new-assets.json");
      const planned = new Set<string>(
        pt.scenes?.length ? [] : (existsSync(f) ? JSON.parse(readFileSync(f, "utf8")) : []).map((a: any) => a.name),
      );
      for (const x of this.planNow(p)?.tasks ?? [])
        if (x.asset && isLive(x) && x.kind !== "lib.publish") planned.add(x.asset);
      const before = p.doc().assets.length;
      await this.castFor(p, t, scenes, planned);
      const cast = p.doc().assets.length - before;
      if (!cast) p.log(t.id, { kind: "step", title: "Everything the scenes use was already in the project" });
      this.done(p, t, { summary: "cast the library art the scenes use" });
    } catch (e) {
      this.failTask(p, t, e);
      throw e;
    }
    return { status: "done" };
  }

  /** cast the library assets the recipes name (and the font), then the fixed ids the compiled scenes draw */
  private async castFor(
    p: OpenProject,
    t: Task,
    scenes: { recipes: { id: string; params: Record<string, unknown> }[] }[],
    planned: Set<string>,
  ) {
    const d = p.doc();
    const want = new Set<string>(["font"]);
    for (const s of scenes)
      for (const rc of s.recipes) {
        const R = (RECIPE_MAP as any)[rc.id];
        for (const [k, spec] of Object.entries<any>(R?.params ?? {}))
          if (spec.lib) want.add(String(rc.params[k] ?? spec.d ?? spec.lib));
      }
    const lib = new Set(this.libraryList().map((l) => l.split(":")[0]));
    for (const name of want) {
      if (d.assets.some((a) => a.id === name) || planned.has(name)) continue;
      if (name === "font")
        await this.tool(p, "art-director", t.id, "cast_asset", { name: "font", libraryId: "font-5x8" });
      else if (lib.has(name)) await this.tool(p, "art-director", t.id, "cast_asset", { name, libraryId: name });
    }
    // the compiled scenes draw fixed-id assets no param names (flag_raise's castle, the backdrop's moon, skyline and
    // tiles): cast every one the library has, or frame() draws a placeholder box
    const { missingAssets } = await import("@pap/engine/lints");
    for (const m of missingAssets(p.doc(), p.timeline().at, lib))
      if (m.libraryId && !planned.has(m.id) && !p.doc().assets.some((a) => a.id === m.id))
        await this.tool(p, "art-director", t.id, "cast_asset", { name: m.id, libraryId: m.libraryId });
  }

  /**
   * A person's change that adds beats (characters, actors, a new moment): the Director re-plans only these scenes
   * from the recipe menu and the library, with the change in its prompt; the rest of the board stays. The cast that
   * follows (art.cast with these scenes) casts what the library has. What the menu can only approximate is reported
   * back to the person.
   */
  private async reboard(p: OpenProject, r: Run, ids: string[], pt: PlanTaskT): Promise<Outcome> {
    const t = this.task(p, {
      kind: "director.storyboard",
      role: "director",
      title: `Re-planning ${ids.length === 1 ? "a scene" : `${ids.length} scenes`} for your change`,
      ...this.ptOf(pt),
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
        model: this.modelOf(p, pt),
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
          model: this.modelOf(p, pt),
        });
        issues = check(out.data);
      }
      // scenes still wrong keep their recipes; the rest are applied
      const bad = new Set(issues.map((i) => i.split(/[.: ]/)[0]));
      const good = out.data.scenes.filter((sc) => ids.includes(sc.id) && !bad.has(sc.id));
      for (const sc of good)
        await this.tool(p, "director", t.id, "scene_set_recipes", {
          scene: sc.id,
          recipes: sc.recipes,
          reason: `re-planned for the person's change: ${vars.change.slice(0, 200)}`,
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
    return { status: "done" };
  }

  // ---------------------------------------------------------------- art: import, spec, draw, judge, rights
  private palette() {
    const palette = JSON.parse(readFileSync(libraryFile("palettes", "pap-night.json"), "utf8"));
    const table = Object.entries<any>(palette.colours)
      .map(([k, v]) => `${k}  ${v.hex}  ${v.use}`)
      .join("\n");
    const colours = Object.fromEntries(Object.entries<any>(palette.colours).map(([k, x]) => [k, x.hex])) as Record<
      string,
      string
    >;
    return { palette, table, colours };
  }
  private artFile = (p: OpenProject, name: string, what: string) => {
    mkdirSync(join(p.dir, "runs", "art"), { recursive: true });
    return join(p.dir, "runs", "art", `${name.replace(/[^a-z0-9_-]/gi, "")}.${what}.json`);
  };
  /** the reference image a chain comes from, as a model input (only spec and draw calls, RIGHTS.md §4) */
  private refImage(
    p: OpenProject,
    t: Task,
    file?: string,
  ): { caption: string; data: Uint8Array; mediaType: "image/png" | "image/jpeg" }[] {
    if (!file) return [];
    const path = join(p.dir, file);
    if (!path.startsWith(p.dir) || !existsSync(path)) return [];
    const mediaType = MEDIA[extname(path).toLowerCase()];
    if (!mediaType) return [];
    p.log(t.id, {
      kind: "step",
      title: `Sent the reference ${file.split("/").pop()} to the model (private to this project)`,
    });
    return [
      {
        caption: "The person's reference (capture two or three traits, never trace it):",
        data: readFileSync(path),
        mediaType,
      },
    ];
  }
  /** the asset a chain is for, from the storyboard's list or the plan task itself */
  private assetOf(
    p: OpenProject,
    pt: PlanTaskT,
  ): { name: string; kind: string; description: string; size?: string; motion?: string } {
    const f = join(p.dir, "runs", "new-assets.json");
    const listed: NewAsset[] = existsSync(f) ? JSON.parse(readFileSync(f, "utf8")) : [];
    const a = listed.find((x) => x.name === pt.asset);
    const size = a?.size ?? pt.assetSize;
    const motion = a?.motion ?? pt.motion;
    return {
      name: pt.asset!,
      kind: a?.kind ?? pt.assetKind ?? "character",
      description: a?.description ?? pt.description ?? `${pt.asset}`,
      ...(size ? { size } : {}),
      ...(motion ? { motion } : {}),
    };
  }

  /** asset.import: a logo is quantized to the palette as a private 16x16 icon and cast; it is never drawn */
  private async importLogo(p: OpenProject, pt: PlanTaskT): Promise<Outcome> {
    const name = pt.asset!;
    if (this.drawn(p, name)) return { status: "skipped", note: "already in the project" };
    const t = this.task(p, {
      kind: "asset.import",
      role: "art-director",
      title: `Importing ${name}`,
      ...this.ptOf(pt),
    });
    try {
      const path = join(p.dir, pt.fromRef ?? "");
      if (!pt.fromRef || !path.startsWith(p.dir) || !existsSync(path))
        throw Object.assign(new Error(`the reference ${pt.fromRef} is missing`), {
          fix: "add the logo file to the project's references again",
        });
      const { colours } = this.palette();
      const q = logoIcon(readFileSync(path), colours);
      const file = {
        id: name,
        version: 1,
        kind: "icon",
        w: 16,
        h: 16,
        frames: ["icon"],
        palette: "pap-night@1",
        tags: ["icon"],
        description: "The person's logo, imported as is (private).",
        licence: "LicenseRef-Private",
        rights: { likeness: false, brand: true, trademark: true, public: false },
        provenance: { source: "imported", role: "art-director", origin: p.id, ref: pt.fromRef, maxErr: q.maxErr },
        hash: randomUUID().slice(0, 16),
        standard: null,
        grid: { icon: q.rows },
      };
      mkdirSync(join(p.dir, "assets"), { recursive: true });
      writeFileSync(join(p.dir, "assets", `${name}.json`), `${JSON.stringify(file, null, 1)}\n`);
      await p.patch(
        [
          {
            op: "add",
            path: "/assets/-",
            value: {
              id: name,
              src: `file:assets/${name}.json`,
              flags: { private: true, brand: { owner: "the person", trademark: true } },
            },
          },
        ],
        { reason: `import the logo as ${name}`, author: { kind: "agent", role: "art-director", task: t.id } },
      );
      this.done(p, t, { summary: `${name}: 16x16 icon, private (colour error ${q.meanErr.toFixed(3)})` });
    } catch (e) {
      this.failTask(p, t, e);
      throw e;
    }
    return { status: "done" };
  }

  /** asset.spec: the Art Director's drawing spec (with the reference image when the chain comes from one) */
  private async assetSpec(p: OpenProject, r: Run, pt: PlanTaskT): Promise<Outcome> {
    const a = this.assetOf(p, pt);
    if (this.drawn(p, a.name)) return { status: "skipped", note: "already in the project" };
    const { palette, table } = this.palette();
    const tpl = templateFor(a.kind, a);
    const ts = this.task(p, {
      kind: "asset.spec",
      role: "art-director",
      title: `Spec for ${a.name}`,
      ...this.ptOf(pt),
    });
    try {
      const spec = (
        await this.ask(p, r, ts, {
          role: "art-director",
          kind: "asset.spec",
          prompt: "art-director/spec",
          vars: {
            name: a.name,
            description: a.description,
            kind: a.kind === "creature" ? `creature (${a.motion ?? "walk"})` : a.kind,
            template: `${tpl.w}x${tpl.h}, frames ${tpl.frames.join(", ")}. ${tpl.note}`,
            palette: table,
          },
          schema: SpecOut,
          images: this.refImage(p, ts, pt.fromRef),
          model: this.modelOf(p, pt),
        })
      ).data;
      const letters = [...new Set([..."k.", ...spec.letters.replace(/[^A-Za-z]/g, "")])]
        .filter((c) => c !== "." && palette.colours[c])
        .join("");
      this.done(p, ts, { summary: spec.description.slice(0, 200) });
      const st: ArtSpec = { ...a, spec, letters, row: ts.id, ...(pt.fromRef ? { fromRef: pt.fromRef } : {}) };
      writeFileSync(this.artFile(p, a.name, "spec"), JSON.stringify(st, null, 1));
    } catch (e) {
      this.failTask(p, ts, e);
      throw e;
    }
    return { status: "done" };
  }
  private specOf(p: OpenProject, name: string): ArtSpec | null {
    const f = this.artFile(p, name, "spec");
    return existsSync(f) ? JSON.parse(readFileSync(f, "utf8")) : null;
  }

  /**
   * asset.draw: one variant; a failure costs nothing more (the judge works with what passed). With one drawing per
   * asset there is no judge: the drawing is the pick, written and cast here (and the library stands in when it failed).
   */
  private async assetDraw(p: OpenProject, r: Run, pt: PlanTaskT): Promise<Outcome> {
    const name = pt.asset!;
    const v = pt.variant ?? 1;
    // a stand-in from an earlier judge is not the drawing: a retry draws it (§1.8)
    if (this.drawn(p, name)) return { status: "skipped", note: "already in the project" };
    const st = this.specOf(p, name);
    if (!st) return { status: "skipped", note: "no spec to draw from" };
    const { palette, table } = this.palette();
    const tpl = templateFor(st.kind, st);
    // one drawing per asset (the chain's `variants: 1`): no judge follows, this draw is the pick
    const solo = pt.variants === 1;
    let res: Variant = null;
    try {
      res = await this.drawVariant(
        p,
        r,
        { name, kind: st.kind, description: st.description },
        tpl,
        st.spec,
        st.letters,
        table,
        palette,
        v,
        pt,
      );
    } catch (e: any) {
      const fb = this.fallbackOr(p, r, null, e, String(e?.message ?? e).slice(0, 180));
      p.emit("log", { level: "warn", role: "pixel-artist", text: `${name} v${v} failed: ${e.message}` });
      writeFileSync(this.artFile(p, name, `v${v}`), JSON.stringify(res));
      // the only drawing failed: the library stands in, as the judge would
      return solo ? this.standIn(p, st, name) : fb;
    }
    writeFileSync(this.artFile(p, name, `v${v}`), JSON.stringify(res));
    if (solo && res) await this.castDrawing(p, st, tpl, { v, x: res });
    return { status: "done" };
  }
  /** asset.judge: the better variant (the library stands in when none passed), written and cast */
  private async assetJudge(p: OpenProject, r: Run, pt: PlanTaskT): Promise<Outcome> {
    const name = pt.asset!;
    // a stand-in from an earlier judge is not the drawing: a retry draws it (§1.8)
    if (this.drawn(p, name)) return { status: "skipped", note: "already in the project" };
    const st = this.specOf(p, name);
    if (!st) return { status: "skipped", note: "no spec" };
    const tpl = templateFor(st.kind, st);
    const read = (v: number): Variant => {
      const f = this.artFile(p, name, `v${v}`);
      return existsSync(f) ? JSON.parse(readFileSync(f, "utf8")) : null;
    };
    // the variants this judge waits on (1 to 3; one "Finish within" dropped stays out)
    const plan = this.planNow(p)?.tasks ?? [];
    const mine = pt.dependsOn
      .map((id) => plan.find((t) => t.id === id))
      .filter((t): t is PlanTaskT => !!t && t.kind === "asset.draw" && t.status !== "dropped")
      .map((t) => t.variant ?? 1);
    const vs = [...new Set(mine.length ? mine : [1, 2])].sort((a, b) => a - b);
    const ok = vs.map((v) => ({ v, x: read(v) })).filter((x): x is { v: number; x: NonNullable<Variant> } => !!x.x);
    if (!ok.length) return this.standIn(p, st, name);
    let best = ok[0];
    const picked = (v: number) => `/api/p/${p.id}/variants/${name}-v${v}.png`;
    if (ok.length === 1) {
      // judged by the rules: one variant passed, so it is the pick (a short row, so the drawer shows the step)
      const tj = this.task(p, {
        kind: "asset.judge",
        role: "art-director",
        title: `Choosing the best ${name}`,
        ...this.ptOf(pt),
      });
      p.log(tj.id, {
        kind: "step",
        title: `Picked variant ${best.v}: ${vs.length > 1 ? "the only one that passed the standard" : "the only drawing"}`,
      });
      this.done(p, tj, { summary: `variant ${best.v}, the only one that passed`, lastImage: picked(best.v) });
    } else {
      const tj = this.task(p, {
        kind: "asset.judge",
        role: "art-director",
        title: `Choosing the best ${name}`,
        ...this.ptOf(pt),
      });
      try {
        const content: ContentPart[] = [];
        for (const [i, x] of ok.entries())
          content.push(
            { type: "text", text: `Variant ${i + 1}:` },
            img(readFileSync(join(p.dir, "runs", `${name}-v${x.v}.png`))),
          );
        const j = (
          await this.ask(p, r, tj, {
            role: "art-director",
            kind: "asset.judge",
            prompt: "art-director/judge",
            vars: { name, description: st.description },
            schema: JudgeOut,
            extra: content,
            model: this.modelOf(p, pt),
          })
        ).data;
        best = ok[j.best - 1] ?? ok[0];
        // the face and the milestone show the chosen variant, not the last one drawn
        this.done(p, tj, { summary: j.reason, lastImage: picked(best.v) });
        best.x.judge = j.reason;
      } catch (e) {
        this.failTask(p, tj, e);
        throw e;
      }
    }
    await this.castDrawing(p, st, tpl, best);
    return { status: "done" };
  }

  /** no drawing passed: a library asset stands in, marked so a retry knows to draw it (§1.8) */
  private async standIn(p: OpenProject, st: ArtSpec, name: string): Promise<Outcome> {
    const stand = st.kind === "character" ? "mentor-ai" : "items";
    p.emit("log", {
      level: "warn",
      role: "art-director",
      text: `no variant of ${name} passed the standard; casting the library's ${stand} instead`,
    });
    await this.tool(p, "art-director", st.row, "cast_asset", { name, libraryId: stand });
    // marked, so a retry knows this is a stand-in and draws the asset (hasArt is false for it)
    const k = p.doc().assets.findIndex((x) => x.id === name);
    if (k >= 0)
      await p.patch([{ op: "add", path: `/assets/${k}/standIn`, value: true }], {
        reason: `${stand} stands in for ${name}`,
        author: { kind: "agent", role: "art-director" },
      });
    return { status: "done", note: `partial: the library's ${stand} stands in`, outcome: "fallback" };
  }

  /** the picked drawing becomes the project's asset file and is cast under its name (a stand-in is replaced) */
  private async castDrawing(
    p: OpenProject,
    st: ArtSpec,
    tpl: { w: number; h: number; frames: string[] },
    best: { v: number; x: NonNullable<Variant> },
  ) {
    const name = st.name;
    // a drawing from a likeness reference is private and never published (RIGHTS.md §1)
    const likeness = !!st.fromRef;
    const grid = Object.fromEntries(best.x.frames.frames.map((fr) => [fr.name, fr.rows]));
    const file = {
      id: name,
      version: 1,
      kind: st.kind,
      w: tpl.w,
      h: tpl.h,
      frames: tpl.frames,
      palette: "pap-night@1",
      tags: [st.kind, ...(st.motion ? [st.motion] : [])],
      description: st.spec.description,
      licence: likeness ? "LicenseRef-Private" : "LicenseRef-PAP-Library",
      rights: { likeness, brand: false, trademark: false, public: !likeness },
      provenance: {
        source: "generated",
        role: "pixel-artist",
        model: best.x.model,
        provider: best.x.model.split("/")[0],
        origin: p.id,
        judgeReason: best.x.judge ?? null,
        promptVersion: card("pixel-artist", "draw").version,
        ...(st.fromRef ? { ref: st.fromRef } : {}),
      },
      hash: randomUUID().slice(0, 16),
      standard: best.x.std,
      grid,
    };
    mkdirSync(join(p.dir, "assets"), { recursive: true });
    writeFileSync(join(p.dir, "assets", `${name}.json`), `${JSON.stringify(file, null, 1)}\n`);
    writeFileSync(join(p.dir, "assets", `${name}.png`), readFileSync(join(p.dir, "runs", `${name}-v${best.v}.png`)));
    // once per project, for the hero only, from either pick (the judge, or a lone drawing): never a moth or a lamp
    if (st.kind === HERO_KIND)
      p.milestone("asset.judge", "Hero drawn", `/api/p/${p.id}/variants/${name}-v${best.v}.png`);
    const d = p.doc();
    // a stand-in cast under this name (an earlier fallback) is replaced in place: one ref per name
    const at = d.assets.findIndex((x) => x.id === name);
    await p.patch(
      [
        {
          op: at < 0 ? "add" : "replace",
          path: at < 0 ? "/assets/-" : `/assets/${at}`,
          value: {
            id: name,
            src: `file:assets/${name}.json`,
            flags: likeness
              ? { private: true, likeness: { person: "the person in the reference", refs: [st.fromRef!] } }
              : { private: false },
          },
        },
      ],
      {
        reason: `add the drawn ${name}`,
        author: { kind: "agent", role: "art-director" },
        baseRev: d.rev,
      },
    );
  }

  /** the person's OK before any scene uses a likeness or a logo (never passed by itself, at any involvement) */
  private async rights(p: OpenProject, r: Run, pt: PlanTaskT): Promise<Outcome> {
    const name = pt.asset!;
    const ref = p.doc().assets.find((a) => a.id === name);
    if (!ref) return { status: "skipped", note: `${name} isn't in the project` };
    const logo = !!ref.flags.brand;
    const q = p.ask(
      {
        kind: "single",
        question: logo
          ? `Your logo (${name}) in the video. Use it?`
          : `${name}, drawn from your reference. Use it in the video?`,
        why: "It comes from your reference, so only you can say yes. Private to this project: it never goes into the public library.",
        options: [
          { id: "use", label: "Use it", detail: "Private to this project" },
          logo
            ? { id: "leave", label: "Leave it out", detail: "The video goes on without it" }
            : { id: "redraw", label: "Redraw", detail: "The crew draws it again from the same reference" },
        ],
        recommendedId: "use",
        blocks: ["animate"],
        from: "pip",
        rights: { asset: name, private: true },
      },
      "pip",
    );
    p.say({ from: "pip", to: "crew", kind: "ask", text: `Asked the person whether ${name} may be used`, ref: name });
    this.setPlanStatus(p, pt.id, "waiting_person");
    const a = await p.waitAnswer(q.id, r.abort.signal);
    const pick = a.answer?.optionId ?? "use";
    if (pick === "use") return { status: "done", note: "the person said yes" };
    if (pick === "redraw") {
      // the chain runs again; whatever waited on this OK waits on the new one
      const chain = (this.planNow(p)?.tasks ?? []).filter((t) => t.asset === name && t.kind !== "lib.publish");
      const ids = chain.filter((t) => t.status === "done" || t.id === pt.id).map((t) => t.id);
      await p.patch([{ op: "remove", path: `/assets/${p.doc().assets.findIndex((x) => x.id === name)}` }], {
        reason: `redraw ${name}`,
        author: { kind: "user" },
      });
      this.planRevise(
        p,
        r,
        { by: "person", trigger: "change", reason: `You asked for ${name} to be drawn again.` },
        (ts) => rerun(ts, ids, (this.planNow(p)?.rev ?? 0) + 1, { reason: `you asked for ${name} again` }),
      );
      return { status: "done", note: "the person asked for a redraw" };
    }
    // leave it out: the asset goes, and the recipes that named it fall back to their defaults
    const d = p.doc();
    const ops: any[] = [];
    d.scenes.forEach((s, k) => {
      if (s.kind !== "decl") return;
      s.recipes.forEach((rc, n) => {
        for (const [key, v] of Object.entries(rc.params ?? {}))
          if (v === name) ops.push({ op: "remove", path: `/scenes/${k}/recipes/${n}/params/${key}` });
      });
    });
    ops.push({ op: "remove", path: `/assets/${d.assets.findIndex((x) => x.id === name)}` });
    await p.patch(ops, { reason: `leave ${name} out`, author: { kind: "user" } });
    return { status: "done", note: "the person left it out" };
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
    pt: PlanTaskT,
  ) {
    const t = this.task(p, {
      kind: "asset.draw",
      role: "pixel-artist",
      title: `Drawing ${a.name}, variant ${v}`,
      ...this.ptOf(pt),
    });
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
        rights: { likeness: !!pt.fromRef, brand: false, trademark: false, public: !pt.fromRef },
        // the system's field, filled here: the standard rejects an empty provenance, and the artist can't write it
        provenance: {
          source: "generated",
          role: "pixel-artist",
          origin: p.id,
          variant: v,
          promptVersion: card("pixel-artist", "draw").version,
          ...(pt.fromRef ? { ref: pt.fromRef } : {}),
        },
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
      const model = this.modelOf(p, pt);
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
        images: this.refImage(p, t, pt.fromRef),
        model,
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
          model,
        });
      }
      if (shape(out.data).length)
        throw new Error(`grid errors after 2 repairs: ${shape(out.data).slice(0, 3).join("; ")}`);
      // critique rounds against the rendered sheet (vision), stopping when the artist says ship
      const caps = this.deps.gateway.caps(model ?? this.deps.gateway.modelFor("pixel-artist", p.doc().crew.models));
      // "Finish within" may take the round away (pt.critiques 0)
      const rounds = caps?.vision === "failed" ? 0 : Math.min(1, pt.critiques ?? 1);
      for (let k = 0; k < rounds; k++) {
        await this.checkpoint(p, r);
        p.upsertTask({ ...t, title: `Drawing ${a.name}, variant ${v}, critique ${k + 1}` });
        const std = checkAsset(toFile(out.data), { colours, sky: palette.sky });
        // only what the artist can fix: provenance, licence and the file's records are the system's
        const fixable = artistIssues(std.hard);
        const next = await this.ask(p, r, t, {
          role: "pixel-artist",
          kind: "asset.critique",
          prompt: "pixel-artist/critique",
          vars: {
            name: a.name,
            frames: tpl.frames.join(", "),
            issues: fixable.length
              ? `The standard checker found:\n${fixable.map((i) => `${i.frame ?? ""} ${i.message} (fix: ${i.fix})`).join("\n")}`
              : "",
            reads: spec.reads,
          },
          schema: DrawOut,
          history: out.messages,
          images: [{ caption: "Your sprite:", data: sheetOf(out.data) }],
          model,
        });
        if (!shape(next.data).length) out = next;
        if (/\bship\b/i.test(next.data.notes)) break;
      }
      const std = checkAsset(toFile(out.data), { colours, sky: palette.sky });
      // a code-only step: the drawer shows it, so the row never reads "No record kept"
      p.log(t.id, {
        kind: "step",
        title: std.ok
          ? `Checked variant ${v} against the PAP standard: it passes`
          : `Checked variant ${v} against the PAP standard: ${std.hard.length} ${std.hard.length === 1 ? "issue" : "issues"}`,
        ...(std.ok ? {} : { detail: std.hard.slice(0, 8).map((i) => `${i.frame ?? ""} ${i.message}`.trim()) }),
      });
      const sheet = sheetOf(out.data);
      writeFileSync(join(p.dir, "runs", `${a.name}-v${v}.png`), sheet);
      this.done(p, t, {
        summary: `${std.ok ? "passes" : `${std.hard.length} standard issues`}: ${out.data.notes.slice(0, 160)}`,
        lastImage: `/api/p/${p.id}/variants/${a.name}-v${v}.png`,
      });
      if (!std.ok)
        throw new Error(
          `variant ${v} fails the standard: ${std.hard
            .slice(0, 3)
            .map((i) => i.message)
            .join("; ")}`,
        );
      return { frames: out.data, std, model: t.model ?? "", judge: undefined as string | undefined };
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

  /** scene.tune: one Animator tunes one scene's recipe params from three stills and the lints */
  private async tune(p: OpenProject, r: Run, pt: PlanTaskT): Promise<Outcome> {
    const { recipeCatalog } = await import("@pap/engine/recipes");
    const { lintFrames, lintProject } = await import("@pap/engine/lints");
    const cat = recipeCatalog();
    const s = p.doc().scenes.find((x) => x.id === pt.scene);
    if (s?.kind !== "decl") return { status: "skipped", note: "not a recipe scene" };
    // on a resume or a redo of other scenes, a scene an animator already finished is not redone
    const ss = p.state.sceneStatus[s.id];
    if (ss?.version === "render" && ss.state === "ready") return { status: "skipped", note: "already animated" };
    const t = this.sceneTask(
      s.id,
      this.task(p, { kind: "scene.tune", role: "animator", title: `Animating ${s.title || s.id}`, ...this.ptOf(pt) }),
    );
    p.setSceneStatus(s.id, { version: "animatic", state: "drafting" });
    try {
      const d = p.doc();
      const sc = d.scenes.find((x) => x.id === s.id)!;
      if (sc.kind !== "decl") {
        this.done(p, t);
        return { status: "done" };
      }
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
        model: this.modelOf(p, pt),
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
      // a weak model failing here costs nothing: the scene keeps its recipes as they are (a provider failure holds)
      const fb = this.fallbackOr(p, r, t, e, `kept as built (${String(e?.message ?? e).slice(0, 140)})`);
      p.emit("log", {
        level: "warn",
        role: "animator",
        text: `${s.id}: kept as built (${String(e?.message ?? e).slice(0, 120)})`,
      });
      return fb;
    }
    return { status: "done" };
  }

  /** vo.align: the person's narration take, aligned and applied */
  private async narrate(p: OpenProject, r: Run, pt: PlanTaskT): Promise<Outcome> {
    const d = p.doc();
    if (d.brief.narration !== "user" || d.audio.vo.length) return { status: "skipped", note: "no narration to align" };
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
    this.setPlanStatus(p, pt.id, "waiting_person");
    const a = await p.waitAnswer(q.id, r.abort.signal);
    if (a.answer?.optionId !== "recorded") return { status: "done", note: "no narration" };
    const { readdirSync, statSync } = await import("node:fs");
    const dir = join(p.dir, "private", "vo");
    const takes = existsSync(dir)
      ? readdirSync(dir)
          .map((f) => ({ f, m: statSync(join(dir, f)).mtimeMs }))
          .sort((x, y) => y.m - x.m)
      : [];
    if (!takes.length) {
      p.emit("log", { level: "warn", text: "no narration take found in private/vo/" });
      return { status: "done", note: "partial: no take found in private/vo/", outcome: "fallback" };
    }
    const t = this.task(p, { kind: "vo.align", role: "editor", title: "Aligning your narration", ...this.ptOf(pt) });
    await this.tool(p, "editor", t.id, "vo_align", { file: `private/vo/${takes[0].f}`, apply: true });
    this.done(p, t);
    return { status: "done" };
  }

  /** sound.mix: the effects, the music bed and the mix (tools only) */
  private async sound(p: OpenProject, pt: PlanTaskT): Promise<Outcome> {
    const d = p.doc();
    const t = this.task(p, {
      kind: "sound.mix",
      role: "mixer",
      title: "Sound effects, music and the mix",
      ...this.ptOf(pt),
    });
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
    return { status: "done" };
  }

  /** review rounds per run (settings `defaults.reviewRounds`, default 2: one round plus one fix round) */
  protected reviewRounds(): number {
    return this.deps.gateway.defaults?.().reviewRounds ?? 2;
  }

  /**
   * review.final: one round. Blockers become notes; in a person's change run only the changed scenes are redone.
   * Blockers on the round before the last send their scenes back (Pip decides in a change run), and a next round
   * checks the fixes before the rough cut.
   */
  private async review(p: OpenProject, r: Run, pt: PlanTaskT): Promise<Outcome> {
    const round = pt.round ?? 1;
    // changes the person asked for while the crew worked: their scenes are redone before the review looks
    const asked =
      round === 1
        ? [
            ...new Set(
              p.state.notes
                .filter((n) => n.assignee === "animator" && n.status === "open" && n.by === "user" && n.target.scene)
                .map((n) => n.target.scene!),
            ),
          ]
        : [];
    if (asked.length) {
      for (const s of asked) if (p.state.sceneStatus[s]) p.setSceneStatus(s, { version: "animatic", state: "stale" });
      const why = `your change came in while the crew worked: ${asked.join(", ")} first`;
      this.planRevise(
        p,
        r,
        { by: "person", trigger: "change", reason: `Redoing ${asked.join(", ")} for your change before the review.` },
        (ts, ctx) => {
          const red = addRedo(ts, asked, ctx, { reason: why.slice(0, 200) });
          const again = rerun(red.tasks, [pt.id], ctx.rev, { reason: why.slice(0, 200) });
          const copy = again.map.get(pt.id)!;
          return {
            tasks: again.tasks.map((t) =>
              t.id === copy ? { ...t, dependsOn: [...new Set([...t.dependsOn, ...red.added])] } : t,
            ),
            ops: [...red.ops, ...again.ops],
          };
        },
      );
      return { status: "skipped", note: "waits for your changes to the scenes" };
    }
    const t = this.task(p, {
      kind: "review.final",
      role: "reviewer",
      title: round > 1 ? "Checking the fixes" : "Reviewing the cut",
      ...this.ptOf(pt),
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
          model: this.modelOf(p, pt),
        })
      ).data;
      // the report says the verdict: "Found 6 problems in scenes 2 and 4.", or "The cut is ready to ship."
      this.reports.set(t.id, { status: "done", did: reviewVerdict(rev, (id) => sceneWord(p, id)) });
      this.done(p, t, { summary: `${rev.verdict}: ${rev.summary}` });
    } catch (e: any) {
      // no usable review from this model: the lints already passed, so the cut goes on to the gate as it is
      const fb = this.fallbackOr(p, r, t, e, "review unavailable; continuing on lints only");
      p.emit("log", {
        level: "warn",
        role: "reviewer",
        text: `review unavailable (${String(e?.message ?? e).slice(0, 120)}); continuing on lints only`,
      });
      return fb;
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
    // "Finish within" may have made this round the last (the plan task's lastRound, or the run's oneReview)
    const last = r.oneReview || !!this.planNow(p)?.tasks.find((x) => x.id === pt.id)?.lastRound;
    if (rev.verdict === "ship" || !redo.length || round >= this.reviewRounds() || last) return { status: "done" };
    const scenes = [...new Set(redo.map((b) => b.scene))].filter((s) => p.doc().scenes.some((x) => x.id === s));
    let tunes: string[] = [];
    if (this.conductor && r.change) {
      // a blocker on a scene the person asked to change: Pip decides (redo, re-board, or hold)
      const ds = await this.think(p, r, {
        kind: "blocker",
        scenes,
        text: redo.map((b) => `${b.scene}: ${b.issue}`),
        round: round - 1,
      });
      const { redid, added } = await this.apply(p, r, ds, {
        after: [pt.id],
        trigger: { kind: "blocker", scenes, text: [], round: round - 1 },
      });
      if (!redid || r.held) return { status: "done" };
      tunes = added;
    } else {
      // the blockers' scenes are redone
      for (const s of scenes) if (p.state.sceneStatus[s]) p.setSceneStatus(s, { version: "animatic", state: "stale" });
      const why = `the Reviewer found blockers in ${scenes.join(", ")}`;
      const res = this.planRevise(
        p,
        r,
        { by: "code", trigger: "conductor", reason: `Redoing ${scenes.join(", ")}: ${why}.` },
        (ts, ctx) => addRedo(ts, scenes, ctx, { after: [pt.id], reason: why }),
      );
      tunes = res?.added ?? [];
    }
    if (tunes.length)
      this.planRevise(
        p,
        r,
        { by: "code", trigger: "conductor", reason: "Checking the fixes before the rough cut." },
        (ts, ctx) => addReviewRound(ts, pt.id, tunes, ctx, "check the fixes"),
      );
    return { status: "done" };
  }

  /** G3: the rough cut; in a person's change run, blockers left on its scenes stop the crew here for the person */
  private async rough(p: OpenProject, r: Run, pt: PlanTaskT): Promise<Outcome> {
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
      this.setPlanStatus(p, pt.id, "waiting_person");
      const v = await this.waitGate(p, r, g);
      if (v.verdict === "changes") this.changesAsked(p, r, g, v);
      if (v.by === "user") r.roughByUser = true;
      return { status: "done" };
    }
    await this.atGate(p, r, pt, "g3_rough", [{ label: "Rough cut", ref: "out/contact.png" }]);
    return { status: "done" };
  }

  /** deliver.export: the video and subtitles */
  private async deliver(p: OpenProject, r: Run, pt: PlanTaskT): Promise<Outcome> {
    const t = this.task(p, { kind: "deliver.export", role: "editor", title: "Exporting the video", ...this.ptOf(pt) });
    try {
      const res = await this.tool(p, "editor", t.id, "export_video", {});
      r.done.exported = true;
      this.done(p, t, { summary: `${(res.data as any).file}, ${(res.data as any).seconds.toFixed(1)} s` });
    } catch (e) {
      this.failTask(p, t, e);
      throw e;
    }
    return { status: "done" };
  }

  /**
   * lib.publish: a new public asset goes into the person's library (settings.paths.library, never the repo's seed)
   * only with their yes, and never a private one. The answer is stored on the asset (`publish`), so the question is
   * asked once per asset, never again on a rerun. While it waits, the Librarian's row says so (waiting_user).
   */
  private async publish(p: OpenProject, r: Run, pt: PlanTaskT): Promise<Outcome> {
    const a = p.doc().assets.find((x) => x.id === pt.asset);
    if (!a?.src.startsWith("file:")) return { status: "skipped", note: "not a drawn asset" };
    if (a.publish) return { status: "skipped", note: `already answered (${a.publish})` };
    // the second check (V9 is the first): private, likeness and brand assets never leave the project
    if (a.flags.private || a.flags.likeness || a.flags.brand) return { status: "skipped", note: "private" };
    const file = join(p.dir, a.src.slice(5));
    const asset = JSON.parse(readFileSync(file, "utf8"));
    if (asset.rights?.likeness || asset.rights?.brand || asset.rights?.trademark || asset.rights?.public === false)
      return { status: "skipped", note: "private" };
    if (libraryAssetDir(a.id)) return { status: "skipped", note: "already in the library" };
    const auto = p.doc().brief.involvement === "auto";
    const row = this.task(p, {
      kind: "lib.publish",
      role: "librarian",
      title: auto ? `Publishing ${a.id}` : `Waiting for you: publish ${a.id}?`,
      ...(auto ? {} : { status: "waiting_user" as const }),
      ...this.ptOf(pt),
    });
    let yes = auto;
    if (!auto) {
      const q = p.ask(
        {
          kind: "yesno",
          question: `Add "${a.id}" to your asset library?`,
          why: "Your other projects could reuse it. It passed the PAP standard and shows no real person or brand.",
          options: [
            { id: "yes", label: "Yes, add it", detail: "" },
            { id: "no", label: "Keep it in this project", detail: "" },
          ],
          recommendedId: "yes",
          blocks: [],
          timeoutSec: null,
          from: "librarian",
        },
        "librarian",
      );
      p.log(row.id, { kind: "step", title: `Asked you whether to add ${a.id} to your library` });
      this.setPlanStatus(p, pt.id, "waiting_person");
      yes = (await p.waitAnswer(q.id, r.abort.signal)).answer?.optionId === "yes";
      this.setPlanStatus(p, pt.id, "running");
      p.log(row.id, { kind: "step", title: yes ? "You said yes" : "You kept it in this project" });
      p.upsertTask({ ...row, status: "working", title: `Publishing ${a.id}` });
    }
    await this.answerPublish(p, a.id, yes ? "yes" : "no");
    if (!yes) {
      this.done(p, row, { title: `Kept ${a.id} in this project`, summary: "kept in this project" });
      return { status: "done", note: "kept in this project" };
    }
    try {
      const png = file.replace(/\.json$/, ".png");
      const out = publishAsset(asset, existsSync(png) ? readFileSync(png) : null);
      p.log(row.id, { kind: "step", title: `Added ${a.id} to your library`, detail: { dir: out.dir } });
      this.done(p, row, { title: `Published ${a.id}`, summary: out.dir });
    } catch (e) {
      this.failTask(p, row, e);
      throw e;
    }
    return { status: "done" };
  }
  /** the person's publish answer, on the asset (the question is never asked twice) */
  private async answerPublish(p: OpenProject, id: string, answer: "yes" | "no") {
    const k = p.doc().assets.findIndex((x) => x.id === id);
    if (k < 0) return;
    await p.patch([{ op: "add", path: `/assets/${k}/publish`, value: answer }], {
      reason: `the person's answer to publishing ${id}`,
      author: { kind: "user" },
    });
  }
}
