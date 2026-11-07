// The crew as instances (docs/PIP-JOURNEY.md §3): the pure half of the row, the drawer and Studio's Crew tab. Who
// shows where, what each face is called, the sentences the row says and the words over Pip. No JSX and type-only
// imports, so the node test reads it directly.
import type { ChannelMsg, Instance, PlanGate, PlanRevisionSummary, PlanTaskView, ProjectState, Role } from "./types.ts";

/** the server sends instances (P2's server fills `instances`; an older one sends none, so the departments stay) */
export const hasInstances = (s: ProjectState) => (s.instances?.length ?? 0) > 0;

/** §3.1: each role's calm glyphs, so a Writer and a Director never look alike */
export const ROLE_GLYPH: Record<Role, string> = {
  writer: "• •",
  director: "▪ ▪",
  "art-director": "* *",
  "pixel-artist": "+ +",
  librarian: "□ □",
  animator: "o O",
  "scene-coder": "o o",
  "sound-designer": "~ ~",
  mixer: "≈ ≈",
  editor: "= =",
  reviewer: "° °",
  producer: "o o",
  assistant: "◠ ◠",
};
/** §3.1: each role's hue (its department's, except the Pixel artist) */
export const ROLE_HUE: Record<Role, 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8> = {
  writer: 2,
  director: 2,
  "art-director": 3,
  "pixel-artist": 8,
  librarian: 3,
  animator: 4,
  "scene-coder": 4,
  "sound-designer": 5,
  mixer: 5,
  editor: 6,
  reviewer: 7,
  producer: 1,
  assistant: 1,
};

/** how long a finished face holds its ✓ before it folds into the counter (§3.1) */
export const FINISH_HOLD_MS = 2000;
/** how long Pip conducts for one batch; under reduced motion the baton stays still this long (§3.1) */
export const CONDUCT_MS = 1200;

/** "Animator · scene 3" → "scene 3" */
export const qualifier = (label: string) => label.split(" · ")[1] ?? "";
/** "Animator · scene 3" → "Animator" */
export const roleWord = (label: string) => label.split(" · ")[0];
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
const low = (s: string) => s.charAt(0).toLowerCase() + s.slice(1);

/** §5: a spawn or return bubble over Pip: the reason with its leading "Pip " dropped, the first letter capitalized */
export const bubbleOfReason = (reason: string) => cap(reason.replace(/^Pip /, ""));

/** what changed between two looks at the instances */
export type InstanceNews = {
  /** one polite sentence each, for the row's region (§5) */
  said: string[];
  /** the words over Pip for the spawns and returns, merged into one bubble */
  pip: string;
  /** a spawn or return happened: Pip conducts */
  conduct: boolean;
};

/** the sentences the row's region says for what changed between two looks at the instances */
export function instanceNews(prev: Map<string, Instance>, next: Instance[]): InstanceNews {
  const spawned: Instance[] = [];
  const returned: string[] = [];
  const out: string[] = [];
  for (const i of next) {
    const was = prev.get(i.id);
    // a face first seen live was spawned; one first seen as a ghost says nothing
    if (!was) {
      if (i.state === "live") spawned.push(i);
      continue;
    }
    const wasFinished = was.state === "finished";
    if (i.state === "live" && was.state === "planned") spawned.push(i);
    else if (wasFinished && i.state !== "finished") {
      // a return is said when its new life opens (N1); one back only as a ghost says nothing yet
      const life = i.lives.at(-1);
      if (life && life.to === null && life.reason) returned.push(life.reason);
    } else if (i.state === "finished" && !wasFinished) out.push(leaveSentence(i));
  }
  // a batch of one role over scenes merges: "Pip brought in 3 Animators, one per scene."
  const byRole = new Map<string, Instance[]>();
  for (const i of spawned) byRole.set(i.role, [...(byRole.get(i.role) ?? []), i]);
  const lead: string[] = [];
  for (const [, list] of byRole)
    if (list.length > 1 && list.every((i) => i.subject?.scene))
      lead.push(`Pip brought in ${list.length} ${roleWord(list[0].label)}s, one per scene`);
    else for (const i of list) lead.push(i.reason);
  const words = [...lead, ...returned].filter(Boolean);
  return {
    said: [...words.map((w) => `${w}.`), ...out],
    pip: words.map(bubbleOfReason).join(". "),
    conduct: words.length > 0,
  };
}

/** §5: "{label} finished." · "{label} stopped." · "{label} is partly done: {couldnt}" */
export function leaveSentence(i: Instance): string {
  if (i.outcome === "partial" && i.lastReport?.couldnt) return `${i.label} is partly done: ${i.lastReport.couldnt}`;
  if (i.outcome === "stopped") return `${i.label} stopped.`;
  if (i.outcome === "failed") return `${i.label} failed.`;
  return `${i.label} finished.`;
}

/** §3.3: the outcome, always an icon and a word */
export const OUTCOME_WORD: Record<NonNullable<Instance["outcome"]>, string> = {
  done: "✓ done",
  partial: "◐ partly done",
  stopped: "■ stopped",
  failed: "✕ failed",
};

/** §3.3: time alive is the sum of its lives, so a return adds up (seconds) */
export function timeAlive(i: Instance, now = Date.now()): number {
  let ms = 0;
  for (const l of i.lives) {
    const a = Date.parse(l.from);
    const b = l.to ? Date.parse(l.to) : now;
    if (Number.isFinite(a) && Number.isFinite(b) && b > a) ms += b - a;
  }
  return ms / 1000;
}

const GATE_PICK: Record<PlanGate, string> = {
  g0_brief: "Start",
  g1_script: "the script pick",
  g2_animatic: "the pacing pick",
  rights: "your logo pick",
  g3_rough: "the rough cut pick",
  g4_final: "the final pick",
};
const DONE_STATUS = new Set(["done", "skipped", "dropped"]);

/** a ghost's next plan task: ready first, then the first pending one */
export function nextTaskOf(id: string, plan: PlanTaskView[]): PlanTaskView | undefined {
  const mine = plan.filter((t) => t.instance === id);
  return mine.find((t) => t.status === "ready") ?? mine.find((t) => t.status === "pending");
}

/** the gates that wait on the person, by involvement (Decision 2); `rights` always does */
export function personGates(involvement: string | undefined): Set<PlanGate> {
  if (involvement === "every") return new Set(["g1_script", "g2_animatic", "rights", "g3_rough", "g4_final"]);
  if (involvement === "auto") return new Set(["rights"]);
  return new Set(["g1_script", "rights", "g3_rough"]);
}

/** what a ghost waits on: the nearest pick the person has (or will have), else the nearest member still at work */
export function startsAfter(
  task: PlanTaskView,
  plan: PlanTaskView[],
  picks: Set<PlanGate> = personGates(undefined),
): string | null {
  const byId = new Map(plan.map((t) => [t.id, t]));
  const seen = new Set<string>();
  const queue = [...task.dependsOn];
  while (queue.length) {
    const id = queue.shift() as string;
    if (seen.has(id)) continue;
    seen.add(id);
    const t = byId.get(id);
    if (!t || DONE_STATUS.has(t.status)) continue;
    if (t.gate) {
      if (t.status === "waiting_person" || picks.has(t.gate)) return GATE_PICK[t.gate];
      queue.push(...t.dependsOn);
      continue;
    }
    if (t.instance && t.instance !== task.instance) return `the ${t.label}`;
    queue.push(...t.dependsOn);
  }
  return null;
}

/** §5: the line in a ghost's popover */
export function ghostLine(id: string, s: ProjectState): string {
  const plan = s.plan?.tasks ?? [];
  const next = nextTaskOf(id, plan);
  if (next?.status === "ready") {
    const n = plan.filter((t) => t.status === "running").length;
    return `Waiting for a free slot. ${n} ${n === 1 ? "is" : "are"} working.`;
  }
  const after = next ? startsAfter(next, plan, personGates(s.doc?.brief?.involvement)) : null;
  return after ? `Starts after ${after}.` : "Up next.";
}

/** the word in a ghost's name: "up next", or "waiting for a free slot" when its task is ready */
export function ghostWord(id: string, s: ProjectState): string {
  return nextTaskOf(id, s.plan?.tasks ?? [])?.status === "ready" ? "waiting for a free slot" : "up next";
}

/** the instance a stuck face belongs to: the failed task the problem names */
export function stuckInstances(s: ProjectState): Set<string> {
  const id = s.status?.problem?.taskId;
  return new Set(s.tasks.filter((t) => t.id === id && t.instance).map((t) => t.instance as string));
}

/** an instance record for a plan task that has none on the wire yet (a planned member, far off the horizon) */
function planned(t: PlanTaskView): Instance {
  const [, sub] = t.instance.split(":");
  return {
    id: t.instance,
    role: t.role as Role,
    label: t.label,
    ...(sub ? { subject: t.scene ? { scene: t.scene } : { asset: t.asset ?? sub } } : {}),
    model: t.model,
    state: "planned",
    ghost: false,
    running: 0,
    spawnedAt: null,
    endedAt: null,
    lives: [],
    reason: t.reason ?? "",
    tasks: [t.id],
    usd: 0,
    outcome: null,
  };
}

export type CrewGroups = { working: Instance[]; upNext: Instance[]; finished: Instance[] };

/** §3.3: the drawer's and Studio's groups. Working: live or stuck, in join order. Up next: every instance not
 * started or idle, in plan order, uncapped. Finished: newest `endedAt` first. */
export function crewGroups(s: ProjectState): CrewGroups {
  const all = s.instances ?? [];
  const plan = s.plan?.tasks ?? [];
  const order = plan.map((t) => t.instance);
  const pos = (id: string) => {
    const k = order.indexOf(id);
    return k < 0 ? order.length : k;
  };
  const stuck = stuckInstances(s);
  const working = all
    .filter((i) => i.state === "live" || stuck.has(i.id))
    .sort((a, b) => (a.spawnedAt ?? "").localeCompare(b.spawnedAt ?? "") || pos(a.id) - pos(b.id));
  const byId = new Map(all.map((i) => [i.id, i]));
  const upNext: Instance[] = [];
  const seen = new Set<string>();
  for (const t of plan) {
    if (!t.instance || t.gate || seen.has(t.instance)) continue;
    const i = byId.get(t.instance);
    if (i && (i.state === "live" || i.state === "finished" || stuck.has(i.id))) continue;
    if (!i && DONE_STATUS.has(t.status)) continue;
    seen.add(t.instance);
    upNext.push(i ?? planned(t));
  }
  for (const i of all)
    if (!seen.has(i.id) && (i.state === "planned" || i.state === "idle") && !stuck.has(i.id)) upNext.push(i);
  const finished = all
    .filter((i) => i.state === "finished" && !stuck.has(i.id))
    .sort((a, b) => (b.endedAt ?? "").localeCompare(a.endedAt ?? ""));
  return { working, upNext, finished };
}

/** the instance a channel message is about: its role plus `ref` (the scene, asset or task), else the singleton */
export function instanceOfMsg(m: ChannelMsg, all: Instance[]): string | null {
  const role = m.from === "pip" ? m.to : m.from;
  const mine = all.filter((i) => i.role === role);
  if (!mine.length) return null;
  if (m.ref) {
    const hit = mine.find(
      (i) => i.subject?.scene === m.ref || i.subject?.asset === m.ref || i.tasks.includes(m.ref as string),
    );
    if (hit) return hit.id;
  }
  return mine.find((i) => i.id === role)?.id ?? (mine.length === 1 ? mine[0].id : null);
}

/** one instance's messages with Pip */
export const msgsOf = (inst: Instance, msgs: ChannelMsg[], all: Instance[]) =>
  msgs.filter((m) => instanceOfMsg(m, all) === inst.id);

const BY_WORD: Record<PlanRevisionSummary["by"], string> = { rules: "Rules", pip: "Pip", code: "Pip", person: "You" };
/** §3.4: "rev 1 · 21:06 · Pip: added a Pixel artist for the founder: the library had no founder sprite." */
export function revisionLine(r: PlanRevisionSummary, clock: (d: Date) => string): string {
  const reason = r.reason.replace(/\.?$/, ".");
  return `rev ${r.rev} · ${clock(new Date(r.at))} · ${BY_WORD[r.by]}: ${low(reason)}`;
}
