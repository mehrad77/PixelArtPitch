// The project in plain words, for the default (simple) view: five steps instead of nine stages, one status
// sentence, milestones and money as one quiet line. The rule: if the crew can fix it alone, the person never hears
// about it; if it can't, they get one sentence and one button. Pure functions, no React.
import { clock, duration } from "./format.ts";
import { numberLocale } from "./locale.ts";
import type {
  ChangesPreview,
  ClipState,
  CrewState,
  GateId,
  Milestone,
  ProblemAction,
  ProjectState,
  Role,
  SceneVersion,
  Stage,
  Task,
} from "./types.ts";

// ---- five steps ----
export const PHASES: { label: string; stages: Stage[] }[] = [
  { label: "Idea", stages: ["brief"] },
  { label: "Story", stages: ["script", "storyboard"] },
  { label: "Pictures", stages: ["art", "animate"] },
  { label: "Sound", stages: ["narrate", "sound"] },
  { label: "Finished", stages: ["review", "deliver"] },
];
export const phaseOfStage = (stage: Stage) =>
  Math.max(
    0,
    PHASES.findIndex((p) => p.stages.includes(stage)),
  );
export const hasVideo = (s: ProjectState) => s.files.some((f) => f.kind === "video");
/** 0..4 for the step the crew is on; 5 once the video is out and nobody is working */
export function phaseOf(s: ProjectState): number {
  const busy = s.tasks.some((t) => t.status === "working" || t.status === "queued");
  if (hasVideo(s) && s.stage === "deliver" && !busy) return PHASES.length;
  const p = s.status?.phase;
  // a project made before status tracking has phase 0 but a later stage: trust the further of the two
  return Math.max(p != null && p >= 0 && p < PHASES.length ? p : 0, phaseOfStage(s.stage));
}

// ---- recovered failures ----
/** a failed task is recovered when a later task with the same role and kind (and parent, if any) started after it */
export function isRecovered(task: Task, tasks: Task[]): boolean {
  if (task.status !== "failed") return false;
  if (task.supersededBy && tasks.some((t) => t.id === task.supersededBy)) return true;
  const failedAt = Date.parse(task.endedAt ?? task.startedAt ?? "") || 0;
  return tasks.some(
    (t) =>
      t.id !== task.id &&
      t.role === task.role &&
      t.kind === task.kind &&
      (task.parent == null || t.parent === task.parent) &&
      (t.startedAt ? Date.parse(t.startedAt) >= failedAt : (t.attempt ?? 1) > (task.attempt ?? 1)),
  );
}
export const visibleTasks = (tasks: Task[]) => tasks.filter((t) => !isRecovered(t, tasks));
/** how many earlier tries of this task failed and were retried */
export function retriesOf(task: Task, tasks: Task[]): number {
  return tasks.filter(
    (t) =>
      t.id !== task.id &&
      t.role === task.role &&
      t.kind === task.kind &&
      (t.parent ?? null) === (task.parent ?? null) &&
      isRecovered(t, tasks),
  ).length;
}

// ---- the crew, in plain words ----
export type Member = { id: string; label: string; roles: Role[]; hue: 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 };
export const CREW: Member[] = [
  { id: "producer", label: "Producer", roles: ["producer"], hue: 1 },
  { id: "writer", label: "Writer", roles: ["writer", "director"], hue: 2 },
  { id: "artist", label: "Artist", roles: ["art-director", "pixel-artist", "librarian"], hue: 3 },
  { id: "animator", label: "Animator", roles: ["animator", "scene-coder"], hue: 4 },
  { id: "sound", label: "Sound", roles: ["sound-designer", "mixer"], hue: 5 },
  { id: "editor", label: "Editor", roles: ["editor"], hue: 6 },
  { id: "reviewer", label: "Reviewer", roles: ["reviewer"], hue: 7 },
];
export const memberOf = (role: Role) => CREW.find((m) => m.roles.includes(role)) ?? CREW[0];
/** who asks or speaks, in a sentence: "the writer", "the artist"; the Librarian is named as itself, not its
 * department, and Pip is Pip (never "the producer", the department an unknown sender falls back to) */
export const theMember = (role: Role | "pip" | (string & {})) =>
  role === "pip" ? "Pip" : role === "librarian" ? "the Librarian" : `the ${memberOf(role as Role).label.toLowerCase()}`;
const upFirst = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
/** a sentence ends once: "…$2.00?" stays, "…was rejected" gets its full stop */
export const sentence = (s: string) => (/[.?!…]$/.test(s.trim()) ? s.trim() : `${s.trim()}.`);

/** a task's title as the person reads it: "Drawing your hero", "Animating scene 2 of 5" */
/** the asset a drawing task is about, from its title ("Choosing the best hero variants" → "hero") */
export const assetNameOf = (t: Task) =>
  t.title.match(/^(?:Drawing|Spec for|Choosing the best|Judging)\s+([a-z][\w ]*?)(?:\s+variants?)?(?:,|$)/i)?.[1];
export function plainTitle(t: Task, s: ProjectState): string {
  const name = assetNameOf(t);
  switch (t.kind) {
    case "producer.plan":
      return "Planning your video";
    case "writer.angles":
    case "writer.repair":
      return "Writing your script";
    case "director.storyboard":
    case "director.repair":
      return "Sketching the scenes";
    case "asset.spec":
    case "asset.draw":
    case "asset.critique":
    case "asset.repair":
    case "asset.judge":
      return name ? `Drawing your ${name.toLowerCase()}` : "Drawing the pictures";
    case "scene.tune": {
      const said = t.title.match(/scene \d+ of \d+/i)?.[0];
      if (said) return `Animating ${said}`;
      const n = s.doc.scenes.length;
      const i = s.doc.scenes.findIndex((sc) => t.title.includes(sc.title || sc.id) || t.title.includes(sc.id));
      return i >= 0 && n ? `Animating scene ${i + 1} of ${n}` : "Animating the scenes";
    }
    case "vo.align":
      return "Lining up your narration";
    case "sound.mix":
      return "Adding music and sound";
    case "review.final":
      return "Checking for mistakes";
    case "deliver.export":
      return "Exporting your video";
    case "lib.match":
      return "Finding art in the library";
    case "lib.publish":
      return "Saving the art for next time";
  }
  // no known kind: keep the title, without ids and technical tails
  const head = t.title.split(",")[0].trim();
  if (/^Animating scene \d+ of \d+/.test(t.title)) return t.title.split(",")[0];
  if (/[a-z]\d*_[a-z]/i.test(head) || /\b(pass|critique|variant)\b/i.test(head)) return head.replace(/\s+\S*_\S*/g, "");
  return head;
}

// ---- problems the person can act on ----
export type Problem = { text: string; action: ProblemAction; taskId: string; provider?: string };
export const PROBLEM_BUTTON: Record<ProblemAction, string> = {
  retry: "Try again",
  change_model: "Use a different model",
  add_budget: "Add budget",
  fix_key: "Fix the key",
};
function actionFor(t: Task): ProblemAction {
  // the message says what happened; the fix often names Settings as a last resort, so it doesn't pick the button
  const m = (t.error?.message ?? "").toLowerCase();
  // a key or credit problem before the budget words: a provider's "insufficient credit" is not the project's cap
  if (/\b40[13]\b|authentication|permission_error|invalid api key|no api key|credit|billing|quota/.test(m))
    return "fix_key";
  if (/budget|cap\b|spend|out of money|insufficient/.test(m)) return "add_budget";
  if (/did not answer|didn't answer|not answer|unreachable|model|provider|connect|refused|key\b/.test(m))
    return "change_model";
  return "retry";
}
const REASON: Record<ProblemAction, string> = {
  retry: "something went wrong",
  change_model: "the AI it uses isn't answering",
  add_budget: "the budget is used up",
  fix_key: "its model provider turned the key down",
};
/** failures no later try recovered and no later run superseded (a run that started after the failure) */
export const unrecoveredFailures = (s: ProjectState) => {
  const since = Date.parse(s.crew?.runStartedAt ?? "") || 0;
  return s.tasks.filter(
    (t) =>
      t.status === "failed" &&
      !isRecovered(t, s.tasks) &&
      (!since || (Date.parse(t.endedAt ?? t.startedAt ?? "") || 0) >= since),
  );
};
/**
 * The server's problem when it sends one, else the newest failure no later try recovered. While the crew is
 * running nothing is a problem, except a held run's own ("Waiting for you: Your key was rejected", live on `status`).
 */
/** the run is held for the person (a rejected key, Pip's hold): a wait on them, not a stop */
export const isHeld = (s: ProjectState) =>
  !!s.crew?.held || (!!s.status?.problem && /^Waiting for you/.test(s.status.line ?? ""));
export function problemOf(s: ProjectState): Problem | undefined {
  if (crewRunning(s) && !isHeld(s)) return undefined;
  if (s.status?.problem) return s.status.problem;
  const f = unrecoveredFailures(s).at(-1);
  if (!f) return undefined;
  const action = actionFor(f);
  return { text: `${memberOf(f.role).label} stopped: ${REASON[action]}.`, action, taskId: f.id };
}

/** the "crew stopped" digest outlives the failure it describes; hide it once no failure is left */
export const isStaleDigest = (s: ProjectState) => /^The crew stopped/.test(s.digest) && !unrecoveredFailures(s).length;

// ---- the one sentence ----
const ACTIVE = ["working", "waiting_user", "queued"] as const;
/** the task that speaks for the crew: working first (the newest one), then waiting on you, then queued */
export const leadWorking = (s: ProjectState) =>
  visibleTasks(s.tasks)
    .filter((t) => (ACTIVE as readonly string[]).includes(t.status))
    .sort(
      (a, b) =>
        ACTIVE.indexOf(a.status as never) - ACTIVE.indexOf(b.status as never) ||
        (Date.parse(b.startedAt ?? "") || 0) - (Date.parse(a.startedAt ?? "") || 0),
    )[0];

function minutesLeft(s: ProjectState): string {
  const e = s.status?.etaSec ?? (s.time.etaSec ? (s.time.etaSec[0] + s.time.etaSec[1]) / 2 : null);
  if (e == null || e <= 0) return "";
  if (e < 90) return " · about a minute left";
  return ` · about ${Math.round(e / 60)} minutes left`;
}

export type HumanStatus = {
  text: string;
  tone: "needs" | "problem" | "working" | "info" | "paused";
  problem?: Problem;
};
export const GATE_TITLE: Record<GateId, string> = {
  g0_brief: "Happy with the plan?",
  g1_script: "Happy with the script?",
  g2_animatic: "Happy with the pacing?",
  g3_rough: "Happy with the cut?",
  g4_final: "Ready to export?",
};
const GATE_AT: Record<GateId, Stage> = {
  g0_brief: "brief",
  g1_script: "script",
  g2_animatic: "storyboard",
  g3_rough: "animate",
  g4_final: "review",
};
const GATE_READY: Record<GateId, string> = {
  g0_brief: "The plan is ready for a look.",
  g1_script: "The script is ready for a look.",
  g2_animatic: "The scenes are timed and ready for a look.",
  g3_rough: "The first cut is ready for a look.",
  g4_final: "The video is ready to export.",
};
/**
 * The questions an open gate stands for (its `items[].ref` names them: G1's "which angle?"): the gate shows them as its
 * own pick, so they are one thing that waits on you, not two
 */
export const askedByGate = (s: ProjectState): Set<string> =>
  new Set(
    s.gates
      .filter((g) => g.status === "open")
      .flatMap((g) => g.items.map((i) => i.ref ?? ""))
      .filter((ref) => s.questions.some((q) => q.id === ref && q.status === "open")),
  );
/** the open questions that are not a gate's own pick */
export const openAsks = (s: ProjectState) => {
  const own = askedByGate(s);
  return s.questions.filter((q) => q.status === "open" && !own.has(q.id));
};

export const needsNarration = (s: ProjectState) =>
  s.doc.brief.narration === "user" &&
  phaseOf(s) === 3 &&
  !s.doc.audio.vo.length &&
  s.tasks.some((t) => t.role === "editor" && t.status === "waiting_user");

export function humanStatus(s: ProjectState): HumanStatus {
  const gates = s.gates.filter((g) => g.status === "open");
  const qs = openAsks(s);
  const own = askedByGate(s);
  // a gate that is a pick ("which angle?") says so: the member that asks has a question for you
  const pick = gates.find((g) => g.items.some((i) => i.ref && own.has(i.ref)));
  if (pick) {
    const q = s.questions.find((x) => pick.items.some((i) => i.ref === x.id));
    const more = gates.length + qs.length - 1;
    const tail = more > 0 ? ` ${more === 1 ? "One more thing" : `${more} more things`} after that.` : "";
    if (q)
      return {
        text: `${upFirst(theMember(q.from as Role))} has a question for you.${tail}`,
        tone: "needs",
      };
  }
  const more = gates.length + qs.length - 1;
  const tail = more > 0 ? ` ${more === 1 ? "One more thing" : `${more} more things`} after that.` : "";
  // a question behind an open gate is asked first (the card shows it first too)
  const behind = qs.find((q) => gates.some((g) => q.blocks.includes(GATE_AT[g.id])));
  if (behind)
    return {
      text: `${upFirst(theMember(behind.from as Role))} has a question for you.${tail}`,
      tone: "needs",
    };
  if (gates[0]) return { text: `${GATE_READY[gates[0].id]}${tail}`, tone: "needs" };
  if (qs[0])
    return {
      text: `${upFirst(theMember(qs[0].from as Role))} has a question for you.${tail}`,
      tone: "needs",
    };
  if (needsNarration(s))
    return { text: "The pictures are done. Record your narration when you're ready.", tone: "needs" };
  const problem = problemOf(s);
  // a held run waits on you ("Fix the key"); only a run that broke off reads Stopped
  if (problem) return { text: problem.text, tone: isHeld(s) ? "needs" : "problem", problem };
  // the crew waits on a card in Pip's thread (a plan change, the budget): a wait for you, not a problem
  if (s.status?.line && /^Waiting for you/.test(s.status.line)) return { text: s.status.line, tone: "needs" };
  const crew = crewStateOf(s);
  // the main line follows the reason: "Waiting to start" only before anything ran, "Stopped" once a run broke off
  const why = waitReason(s);
  if (why.kind === "not_started") return { text: "Waiting to start", tone: "info" };
  if (why.kind === "stopped") return { text: "Stopped", tone: "paused" };
  if (crew === "paused") return { text: "Paused. Nothing is spent while the crew waits.", tone: "paused" };
  if (phaseOf(s) >= PHASES.length) return { text: "Your video is ready.", tone: "info" };
  if (s.status?.line && !/^Waiting to start/i.test(s.status.line))
    return { text: s.status.line, tone: crew === "pausing" ? "paused" : "working" };
  const lead = leadWorking(s);
  if (lead && lead.status === "working")
    return {
      text: `${plainTitle(lead, s)}${crew === "pausing" ? " · pausing after this step" : minutesLeft(s)}`,
      tone: crew === "pausing" ? "paused" : "working",
    };
  if (s.digest && !isStaleDigest(s)) return { text: s.digest, tone: "info" };
  if (crew === "pausing") return { text: "Pausing after this step.", tone: "paused" };
  return { text: "The crew is getting ready.", tone: "info" };
}

// ---- milestones ----
const DONE_TEXT: Record<string, string> = {
  "producer.plan": "Plan ready",
  "writer.angles": "Script written · 3 options",
  "director.storyboard": "Storyboard ready",
  "review.final": "Checked for mistakes",
};
/** the server's milestones when it sends them, else derived from finished tasks; oldest first */
/** a finished task's milestone words: the asset a judge picked is named ("Founder drawn") */
function doneText(t: Task): string | undefined {
  if (t.kind !== "asset.judge") return DONE_TEXT[t.kind];
  const name = assetNameOf(t);
  return name ? `${upFirst(name.toLowerCase())} drawn` : "Picked the drawing";
}
export function milestones(s: ProjectState): Milestone[] {
  if (s.milestones?.length) return [...s.milestones].sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  const out: Milestone[] = [];
  const done = s.tasks.filter((t) => t.status === "done");
  const seen = new Set<string>();
  for (const t of done) {
    const text = doneText(t);
    // one milestone per kind, and per asset for the drawings
    const key = t.kind === "asset.judge" ? `${t.kind}:${text}` : t.kind;
    if (!text || seen.has(key)) continue;
    seen.add(key);
    out.push({ id: `m:${key}`, at: t.endedAt ?? t.startedAt ?? "", text, image: t.lastImage });
  }
  const tunes = s.tasks.filter((t) => t.kind === "scene.tune");
  if (tunes.length && tunes.every((t) => t.status === "done" || isRecovered(t, s.tasks))) {
    const last =
      tunes
        .map((t) => t.endedAt ?? "")
        .sort()
        .at(-1) ?? "";
    out.push({ id: "m:scenes", at: last, text: "Scenes animated", image: tunes.at(-1)?.lastImage });
  }
  const video = s.files.find((f) => f.kind === "video");
  if (video) out.push({ id: "m:video", at: new Date().toISOString(), text: "Your video is ready" });
  return out.sort((a, b) => (Date.parse(a.at) || 0) - (Date.parse(b.at) || 0));
}

// ---- money ----
const LOCALE = numberLocale();
const whole = new Intl.NumberFormat(LOCALE, { style: "currency", currency: "USD", maximumFractionDigits: 0 });
const cents = new Intl.NumberFormat(LOCALE, { style: "currency", currency: "USD", minimumFractionDigits: 2 });
/** "$5", "$0.42": whole dollars without the cents */
export const usdPlain = (v: number) => (Number.isInteger(v) ? whole.format(v) : cents.format(v));
/** "$0.42 of $5"; from 80% of the cap it says the crew will ask, in the warning tone */
export function plainUsd(committed: number, cap: number): { text: string; warn: boolean } {
  const warn = cap > 0 && committed >= cap * 0.8;
  const text = `${usdPlain(Math.round(committed * 100) / 100)} of ${usdPlain(cap)}`;
  return { text: warn ? `${text} · the crew will ask before spending more` : text, warn };
}

// ---- Studio's state words ----
export const CLIP_STATE_WORD: Record<ClipState, string> = {
  planned: "To do",
  drafting: "In progress",
  ready: "Done",
  stale: "Needs update",
  approval: "Needs you",
  locked: "Locked",
};
export const VERSION_WORD: Record<SceneVersion, string> = {
  slate: "Not started",
  board: "Sketch",
  animatic: "Rough",
  render: "Final",
};

// ---- time ----
/** "0:04", "1:20": minutes and seconds, for people (not frames) */
export function mss(t: number): string {
  const s = Math.max(0, Math.floor(t));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

// ---- which view ----
export type View = "simple" | "studio";
export function getView(): View {
  try {
    return localStorage.getItem("pap.view") === "studio" ? "studio" : "simple";
  } catch {
    return "simple";
  }
}
let viewNow: View | null = null;
const viewListeners = new Set<() => void>();
/** the remembered view; the in-memory copy wins, so the choice holds even with storage off */
export const currentView = (): View => viewNow ?? getView();
export function setView(v: View) {
  viewNow = v;
  try {
    localStorage.setItem("pap.view", v);
  } catch {
    // storage off: the choice lasts for this page only
  }
  for (const l of viewListeners) l();
}
export function onViewChange(cb: () => void): () => void {
  viewListeners.add(cb);
  return () => viewListeners.delete(cb);
}

// ---- the project last opened, for the header's Crew button off a project page ----
export function getLastProject(): string | null {
  try {
    return localStorage.getItem("pap.lastProject");
  } catch {
    return null;
  }
}
export function setLastProject(id: string) {
  try {
    localStorage.setItem("pap.lastProject", id);
  } catch {
    // storage off: the header falls back to the project with the newest activity
  }
}

// ---- the crew's run ----
/** the run state from either shape the server sends */
export function crewStateOf(s: ProjectState): CrewState {
  const c = s.crew;
  if (c?.state) return c.state;
  if (c?.paused) return "paused";
  if (c?.running === false) return "idle";
  return "running";
}
/** whether the crew is running (paused counts as not running) */
export const crewRunning = (s: ProjectState) => {
  const st = crewStateOf(s);
  return st === "running" || st === "pausing";
};
/** a stage in plain words, for sentences: "Paused by you during the script" */
export const STAGE_WORD: Record<Stage, string> = {
  brief: "the plan",
  script: "the script",
  storyboard: "the storyboard",
  art: "the drawings",
  animate: "animation",
  narrate: "narration",
  sound: "sound",
  review: "the final check",
  deliver: "the export",
};
/** the roles that work in a stage */
export const STAGE_ROLES: Record<Stage, Role[]> = {
  brief: ["producer"],
  script: ["writer"],
  storyboard: ["director"],
  art: ["art-director", "pixel-artist", "librarian"],
  animate: ["animator", "scene-coder"],
  narrate: ["editor"],
  sound: ["sound-designer", "mixer"],
  review: ["reviewer"],
  deliver: ["editor"],
};
const cap1 = (t: string) => t.charAt(0).toUpperCase() + t.slice(1);
const crewStage = (s: ProjectState): Stage => s.crew?.stage ?? s.stage;
export const stageTasks = (s: ProjectState, stage: Stage) =>
  visibleTasks(s.tasks.filter((t) => STAGE_ROLES[stage].includes(t.role)));

export type WaitAction = "needs" | "problem" | "resume" | "start" | "continue" | "open";
export type WaitReason = {
  kind: "needs" | "problem" | "paused" | "not_started" | "stopped" | "queued" | "working" | "finished" | "between";
  text: string;
  action?: WaitAction;
  problem?: Problem;
  stage?: Stage;
};

/** what the person is waiting for, as one muted line under the status; the first case that applies wins */
export function waitReason(s: ProjectState): WaitReason {
  const stage = crewStage(s);
  // 1. waiting for you
  const gates = s.gates.filter((g) => g.status === "open");
  const qs = s.questions.filter((q) => q.status === "open");
  const behind = qs.find((q) => gates.some((g) => q.blocks.includes(GATE_AT[g.id])));
  const ask = behind?.question ?? (gates[0] ? GATE_TITLE[gates[0].id] : qs[0]?.question);
  if (ask) return { kind: "needs", text: `Waiting for you: ${ask}`, action: "needs" };
  if (needsNarration(s)) return { kind: "needs", text: "Waiting for you: record your narration", action: "needs" };
  // 2. a problem only the person can fix
  const problem = problemOf(s);
  if (problem) return { kind: "problem", text: problem.text, action: "problem", problem };
  // 3. paused
  const crew = crewStateOf(s);
  if (crew === "paused")
    return { kind: "paused", text: `Paused by you during ${STAGE_WORD[stage]}.`, action: "resume", stage };
  // 8. finished (before the "not running" cases: a finished crew is not running either)
  if (phaseOf(s) >= PHASES.length)
    return { kind: "finished", text: "Everything is done. Your video is in Finished.", action: "open" };
  if (!crewRunning(s)) {
    // 4. nothing done yet
    if (!s.tasks.length) return { kind: "not_started", text: "The crew hasn't started yet.", action: "start" };
    // 5. work broke off
    const at = s.crew?.lastActiveAt;
    return {
      kind: "stopped",
      text: `The crew stopped during ${STAGE_WORD[stage]}${at ? ` at ${clock(new Date(at))}` : ""}.`,
      action: "continue",
      stage,
    };
  }
  const tasks = stageTasks(s, stage);
  const working = s.tasks.filter((t) => t.status === "working");
  const queued = s.crew?.queued ?? s.tasks.filter((t) => t.status === "queued").length;
  // 6. in line for the model
  if (!working.length && queued > 0) {
    const next = s.tasks.find((t) => t.status === "queued");
    const local = isLocalModel(next?.model);
    return {
      kind: "queued",
      text: `Waiting for the model: ${queued} ${queued === 1 ? "step" : "steps"} in line${local ? ". LM Studio answers one request at a time" : ""}`,
    };
  }
  // 7. working
  if (working.length) {
    const done = tasks.filter((t) => t.status === "done").length;
    const m = Math.max(tasks.length, done);
    // a stage with no steps of its own (the work runs under another stage's roles): say nothing, not "0 of 0"
    if (!m) return { kind: "working", text: "" };
    return { kind: "working", text: `${done} of ${m} ${m === 1 ? "step" : "steps"} done in this stage` };
  }
  return { kind: "between", text: "Getting the next step ready." };
}

/** a model that runs on this computer: free, and it answers one request at a time */
export const isLocalModel = (m?: string) => !!m && /^(lmstudio|ollama|llamacpp)\//.test(m);

// ---- what an action will cause, said before it runs ----
export type EffectAction =
  | { kind: "start" }
  | { kind: "continue"; stage: Stage }
  | { kind: "retry"; taskId: string }
  | { kind: "change_model"; taskId: string }
  | { kind: "fix_key"; provider?: string }
  | { kind: "add_budget"; amount: number }
  | { kind: "resume" }
  /** `preview`: the server's dry run of the change (POST …/changes/preview): who it goes to and what it costs */
  | { kind: "gate_changes"; stage: Stage; items: string[]; preview?: ChangesPreview | null };
export type Effect = {
  /** one line, or "" when the action does only what its label says */
  text: string;
  /** costly or destructive: a two-step confirm in place */
  confirm: boolean;
  /** where to read more (Settings → Roles) */
  href?: string;
};
const CONFIRM_USD = 0.5;
/** "about $0.20 and 3 min", "free, about 3 min", "cost unknown until it starts" */
function costLine(tasks: Task[], fallbackSec?: number | null): { text: string; usd: number | null } {
  const local = tasks.length > 0 && tasks.every((t) => isLocalModel(t.model));
  const known = tasks.filter((t) => t.estUsd != null || t.usd > 0);
  const usd = known.length
    ? known.reduce((a, t) => a + Math.max(0, (t.estUsd ?? t.usd) - (t.status === "done" ? 0 : t.usd)), 0)
    : null;
  const secs = tasks.reduce((a, t) => a + (t.etaSec ?? 0), 0) || fallbackSec || 0;
  const time = secs > 0 ? `about ${duration(secs)}` : "";
  if (local) return { text: time ? `free, ${time}` : "free; time unknown until it starts", usd: 0 };
  if (usd == null)
    return { text: time ? `cost unknown until it starts, ${time}` : "cost and time unknown until it starts", usd };
  return {
    text: `about ${usdPlain(Math.round(usd * 100) / 100)}${time ? ` and ${time.replace("about ", "")}` : ""}`,
    usd,
  };
}
/** "$0.02", "$0.10–$0.14" */
const usdRange = (lo: number, hi: number) => {
  const r = (v: number) => usdPlain(Math.round(v * 100) / 100);
  return Math.round(lo * 100) === Math.round(hi * 100) ? r(hi) : `${r(lo)}–${r(hi)}`;
};
/** "about 2 minutes", "under a minute" */
const durationRange = (sec: [number, number]) =>
  sec[1] < 60 ? "under a minute" : `about ${duration(Math.round((sec[0] + sec[1]) / 2))}`;
const etaMid = (s: ProjectState) => (s.time.etaSec ? (s.time.etaSec[0] + s.time.etaSec[1]) / 2 : null);

/** the one effect line for an action, shared by the simple view, Studio and the crew drawer */
export function effectOf(a: EffectAction, s: ProjectState): Effect {
  switch (a.kind) {
    case "start": {
      const est = s.budget.estTotalUsd;
      const eta = etaMid(s);
      const money = est ? `about ${usdPlain(est[0])} to ${usdPlain(est[1])} in all` : "cost unknown until it starts";
      return {
        text: `Starts the crew on your brief: ${money}${eta ? `, ${duration(eta)}` : ""}.`,
        confirm: (est?.[1] ?? 0) > CONFIRM_USD,
      };
    }
    case "continue": {
      const left = stageTasks(s, a.stage).filter((t) => t.status !== "done" && t.status !== "cancelled");
      const c = costLine(left, etaMid(s));
      return {
        text: `Restarts ${STAGE_WORD[a.stage]}: ${c.text}; finished steps are kept.`,
        confirm: (c.usd ?? 0) > CONFIRM_USD,
      };
    }
    case "retry": {
      const t = s.tasks.find((x) => x.id === a.taskId);
      if (!t) return { text: "Runs the step again; cost unknown until it starts.", confirm: false };
      const c = costLine([{ ...t, usd: 0 }]);
      return {
        text: `Runs “${plainTitle(t, s)}” again: ${c.text}; finished work is kept.`,
        confirm: (c.usd ?? 0) > CONFIRM_USD,
      };
    }
    case "change_model": {
      const t = s.tasks.find((x) => x.id === a.taskId);
      const who = t ? memberOf(t.role).label.toLowerCase() : "crew member";
      return {
        text: `Switches the ${who} to another model for this project, picked in Settings › Roles. Future steps may cost more; the cost is unknown until you pick one.`,
        confirm: false,
        href: "/settings/roles",
      };
    }
    case "fix_key":
      return {
        text: `Opens Settings › Providers${a.provider ? ` at ${PROVIDER_WORD[a.provider] ?? LOCAL_WORD[a.provider] ?? a.provider}` : ""}. Once the key is saved or its test passes, the crew picks up where it stopped.`,
        confirm: false,
        href: "/settings/providers",
      };
    case "add_budget": {
      const cap = s.budget.capUsd + a.amount;
      const need = s.budget.estTotalUsd?.[1];
      const ask = Math.round(s.doc.budget.askAtFraction * 100);
      const finish =
        need == null
          ? "the total is unknown, so the crew may ask again"
          : need <= cap
            ? "lets the crew finish"
            : `the crew may need about ${usdPlain(Math.ceil(need - cap))} more`;
      return {
        text: `New cap ${usdPlain(cap)}: +${usdPlain(a.amount)} ${finish}; it will still ask at ${ask}%.`,
        confirm: true,
      };
    }
    case "resume": {
      const lead = leadWorking(s) ?? s.tasks.find((t) => t.status === "queued" || t.status === "working");
      return { text: lead ? `Continues from “${plainTitle(lead, s)}”.` : "", confirm: false };
    }
    case "gate_changes": {
      // the server routed it (the Director for cast, staging or the end card; the Animator for motion): its words
      if (a.preview) {
        const [lo, hi] = a.preview.usd;
        const money = hi <= 0 ? "free" : `about ${usdRange(lo, hi)}`;
        const time = a.preview.sec[1] > 0 ? `, ${durationRange(a.preview.sec)}` : "";
        return {
          text: `${sentence(a.preview.summary).replace(/\.$/, "")}: ${money}${time}.`,
          confirm: hi > CONFIRM_USD,
        };
      }
      const redo = stageTasks(s, a.stage).filter((t) => t.status === "done");
      const c = costLine(redo.map((t) => ({ ...t, status: "upcoming" as const, usd: 0, estUsd: t.estUsd ?? t.usd })));
      const role = memberOf(STAGE_ROLES[a.stage][0]).label.toLowerCase();
      const what = a.items.length ? a.items.join(", ").toLowerCase() : `all of ${STAGE_WORD[a.stage]}`;
      // a costly change asks again; a cheap one (or one whose cost is unknown) doesn't add a second press
      return { text: `${cap1(`the ${role}`)} redoes ${what}: ${c.text}.`, confirm: (c.usd ?? 0) > CONFIRM_USD };
    }
  }
}

// ---- models, in words (Studio and the crew drawer only: the simple view never names a model) ----
const PROVIDER_WORD: Record<string, string> = {
  anthropic: "Anthropic",
  openai: "OpenAI",
  openrouter: "OpenRouter",
  custom: "Custom",
};
const LOCAL = new Set(["lmstudio", "ollama", "llamacpp"]);
const LOCAL_WORD: Record<string, string> = { lmstudio: "LM Studio", ollama: "Ollama", llamacpp: "llama.cpp" };
/** a provider id in words: "anthropic" → "Anthropic", "lmstudio" → "LM Studio" */
export const providerName = (p: string) => PROVIDER_WORD[p] ?? LOCAL_WORD[p] ?? p;
/** a local model's own name: its last path segment, a hyphen before a number read as a space
    ("openai/gpt-oss-20b" → "gpt-oss 20b", "google/gemma-4-26b-a4b-qat" → "gemma 4 26b-a4b-qat") */
const localName = (name: string) =>
  name
    .split("/")
    .pop()
    ?.replace(/:latest$/, "")
    .replace(/-(?=\d)/g, " ") ?? name;
/** "anthropic/claude-sonnet-5-5" → "Sonnet 5.5 · Anthropic"; "lmstudio/openai/gpt-oss-20b" → "gpt-oss 20b · LM Studio" */
export function modelWords(id?: string): string {
  if (!id) return "Model picked when it starts";
  const slash = id.indexOf("/");
  const provider = slash > 0 ? id.slice(0, slash) : "";
  const name = slash > 0 ? id.slice(slash + 1) : id;
  if (LOCAL.has(provider)) return `${localName(name)} · ${LOCAL_WORD[provider]}`;
  let pretty = name;
  const claude = name.match(/^claude-([a-z]+)((?:-\d+)*)$/i);
  if (claude) {
    const ver = claude[2].split("-").filter(Boolean).join(".");
    pretty = `${cap1(claude[1])}${ver ? ` ${ver}` : ""}`;
  }
  const who = PROVIDER_WORD[provider] ?? provider;
  return who ? `${pretty} · ${who}` : pretty;
}
/** the short name for a task group's suffix: "Sonnet 5.5", "gemma-4-26b" */
export const modelShort = (id?: string) => (id ? modelWords(id).split(" · ")[0] : "");
