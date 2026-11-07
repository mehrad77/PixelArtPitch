// The project in plain words, for the default (simple) view: five steps instead of nine stages, one status
// sentence, milestones and money as one quiet line. The rule: if the crew can fix it alone, the person never hears
// about it; if it can't, they get one sentence and one button. Pure functions, no React.
import type {
  ClipState,
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
  return p != null && p >= 0 && p < PHASES.length ? p : phaseOfStage(s.stage);
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

/** a task's title as the person reads it: "Drawing your hero", "Animating scene 2 of 5" */
export function plainTitle(t: Task, s: ProjectState): string {
  const name = t.title.match(
    /^(?:Drawing|Spec for|Choosing the best|Judging)\s+([a-z][\w ]*?)(?:\s+variants?)?(?:,|$)/i,
  )?.[1];
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
export type Problem = { text: string; action: ProblemAction; taskId: string };
export const PROBLEM_BUTTON: Record<ProblemAction, string> = {
  retry: "Try again",
  change_model: "Choose another model",
  add_budget: "Add $2 to the budget",
};
function actionFor(t: Task): ProblemAction {
  // the message says what happened; the fix often names Settings as a last resort, so it doesn't pick the button
  const m = (t.error?.message ?? "").toLowerCase();
  if (/budget|cap\b|spend|out of money|insufficient/.test(m)) return "add_budget";
  if (/did not answer|didn't answer|not answer|unreachable|model|provider|connect|refused|key\b/.test(m))
    return "change_model";
  return "retry";
}
const REASON: Record<ProblemAction, string> = {
  retry: "something went wrong",
  change_model: "the AI it uses isn't answering",
  add_budget: "the budget is used up",
};
export const unrecoveredFailures = (s: ProjectState) =>
  s.tasks.filter((t) => t.status === "failed" && !isRecovered(t, s.tasks));
/** the server's problem when it sends one, else the newest failure no later try recovered */
export function problemOf(s: ProjectState): Problem | undefined {
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
export const needsNarration = (s: ProjectState) =>
  s.doc.brief.narration === "user" &&
  phaseOf(s) === 3 &&
  !s.doc.audio.vo.length &&
  s.tasks.some((t) => t.role === "editor" && t.status === "waiting_user");

export function humanStatus(s: ProjectState): HumanStatus {
  const gates = s.gates.filter((g) => g.status === "open");
  const qs = s.questions.filter((q) => q.status === "open");
  const more = gates.length + qs.length - 1;
  const tail = more > 0 ? ` ${more === 1 ? "One more thing" : `${more} more things`} after that.` : "";
  // a question behind an open gate is asked first (the card shows it first too)
  const behind = qs.find((q) => gates.some((g) => q.blocks.includes(GATE_AT[g.id])));
  if (behind)
    return {
      text: `The ${memberOf(behind.from as Role).label.toLowerCase()} has a question for you.${tail}`,
      tone: "needs",
    };
  if (gates[0]) return { text: `${GATE_READY[gates[0].id]}${tail}`, tone: "needs" };
  if (qs[0])
    return {
      text: `The ${memberOf(qs[0].from as Role).label.toLowerCase()} has a question for you.${tail}`,
      tone: "needs",
    };
  if (needsNarration(s))
    return { text: "The pictures are done. Record your narration when you're ready.", tone: "needs" };
  const problem = problemOf(s);
  if (problem) return { text: problem.text, tone: "problem", problem };
  const crew = s.crew?.state ?? "running";
  if (crew === "paused") return { text: "Paused. Nothing is spent while the crew waits.", tone: "paused" };
  if (phaseOf(s) >= PHASES.length) return { text: "Your video is ready.", tone: "info" };
  if (s.status?.line) return { text: s.status.line, tone: crew === "pausing" ? "paused" : "working" };
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
  "asset.judge": "Hero drawn",
  "review.final": "Checked for mistakes",
};
/** the server's milestones when it sends them, else derived from finished tasks; oldest first */
export function milestones(s: ProjectState): Milestone[] {
  if (s.milestones?.length) return [...s.milestones].sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  const out: Milestone[] = [];
  const done = s.tasks.filter((t) => t.status === "done");
  const seen = new Set<string>();
  for (const t of done) {
    const text = DONE_TEXT[t.kind];
    if (!text || seen.has(t.kind)) continue;
    seen.add(t.kind);
    out.push({ id: `m:${t.kind}`, at: t.endedAt ?? t.startedAt ?? "", text, image: t.lastImage });
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
const LOCALE = typeof navigator !== "undefined" ? navigator.language : "en";
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
export function setView(v: View) {
  try {
    localStorage.setItem("pap.view", v);
  } catch {
    // storage off: the choice lasts for this page only
  }
}
