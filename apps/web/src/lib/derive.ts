// Views over ProjectState: departments, stage states, timeline clips. Pure functions, no React.

import { CLIP_STATE_WORD, isRecovered, VERSION_WORD } from "./human.ts";
import type {
  ClipState,
  GateId,
  NoteCategory,
  ProjectState,
  Role,
  SceneStatus,
  Stage,
  Task,
  TaskStatus,
  TimelineJSON,
} from "./types.ts";
import { STAGES } from "./types.ts";

export const STAGE_LABEL: Record<Stage, string> = {
  brief: "Brief",
  script: "Script",
  storyboard: "Storyboard",
  art: "Art",
  animate: "Animate",
  narrate: "Narrate",
  sound: "Sound",
  review: "Review",
  deliver: "Deliver",
};
export const STAGE_GROUPS: { label: string; stages: Stage[] }[] = [
  { label: "Plan", stages: ["brief", "script", "storyboard"] },
  { label: "Make", stages: ["art", "animate"] },
  { label: "Finish", stages: ["narrate", "sound", "review", "deliver"] },
];
export const isStage = (s: string): s is Stage => (STAGES as readonly string[]).includes(s);

export const GATE_STAGE: Record<GateId, Stage> = {
  g0_brief: "brief",
  g1_script: "script",
  g2_animatic: "storyboard",
  g3_rough: "animate",
  g4_final: "review",
};
export const GATE_LABEL: Record<GateId, string> = {
  g0_brief: "G0 · brief",
  g1_script: "G1 · script",
  g2_animatic: "G2 · animatic",
  g3_rough: "G3 · rough cut",
  g4_final: "G4 · final",
};

export const ROLE_LABEL: Record<Role, string> = {
  producer: "Producer",
  writer: "Writer",
  director: "Director",
  "art-director": "Art director",
  "pixel-artist": "Pixel artist",
  animator: "Animator",
  "scene-coder": "Scene coder",
  "sound-designer": "Sound designer",
  mixer: "Mixer",
  editor: "Editor",
  reviewer: "Reviewer",
  librarian: "Librarian",
  assistant: "Pip",
};
export const ROLES = Object.keys(ROLE_LABEL) as Role[];

export type Department = { id: string; label: string; roles: Role[]; stages: Stage[] };
export const DEPARTMENTS: Department[] = [
  { id: "production", label: "Production", roles: ["producer"], stages: ["brief"] },
  { id: "story", label: "Story", roles: ["writer", "director"], stages: ["script", "storyboard"] },
  { id: "art", label: "Art", roles: ["art-director", "pixel-artist"], stages: ["art"] },
  { id: "animation", label: "Animation", roles: ["animator", "scene-coder"], stages: ["animate"] },
  { id: "sound", label: "Sound", roles: ["sound-designer", "mixer"], stages: ["narrate", "sound"] },
  { id: "edit", label: "Edit", roles: ["editor"], stages: ["narrate", "deliver"] },
  { id: "review", label: "Review", roles: ["reviewer"], stages: ["review"] },
  { id: "library", label: "Library", roles: ["librarian"], stages: ["art"] },
];
export const deptOf = (role: Role) => DEPARTMENTS.find((d) => d.roles.includes(role)) ?? DEPARTMENTS[0];

export const TASK_STATUS: Record<
  TaskStatus,
  { word: string; tone: "accent" | "muted" | "signal" | "error" | "warning" | "success" | "info" }
> = {
  upcoming: { word: "Upcoming", tone: "muted" },
  queued: { word: "Queued", tone: "muted" },
  working: { word: "Working", tone: "accent" },
  waiting_user: { word: "Needs you", tone: "signal" },
  waiting: { word: "Waiting", tone: "muted" },
  done: { word: "Done", tone: "success" },
  partial: { word: "Stand-in", tone: "warning" },
  failed: { word: "Failed", tone: "error" },
  cancelled: { word: "Cancelled", tone: "muted" },
};
const ACTIVE_ORDER: TaskStatus[] = [
  "waiting_user",
  "failed",
  "working",
  "queued",
  "waiting",
  "upcoming",
  "partial",
  "done",
  "cancelled",
];
/** the task that speaks for a group of tasks: needs-you first, then failures, then work in progress. A failure a
 * later try recovered never speaks. */
export function leadTask(tasks: Task[]): Task | undefined {
  return tasks
    .filter((t) => !isRecovered(t, tasks))
    .sort((a, b) => ACTIVE_ORDER.indexOf(a.status) - ACTIVE_ORDER.indexOf(b.status))[0];
}

/** 0..1 from elapsed vs ETA, or undefined when unknown (indeterminate bar) */
export function taskProgress(t: Task, now = Date.now()): number | undefined {
  if (t.status === "done") return 1;
  if (t.status !== "working" || !t.startedAt || t.etaSec == null) return undefined;
  const el = (now - Date.parse(t.startedAt)) / 1000;
  return Math.min(0.99, el / Math.max(1, el + t.etaSec));
}

export type StageState = "done" | "now" | "upcoming" | "needs";
export function stageStates(s: ProjectState): Record<Stage, StageState> {
  const cur = STAGES.indexOf(s.stage);
  const out = {} as Record<Stage, StageState>;
  STAGES.forEach((st, i) => {
    out[st] = i < cur ? "done" : i === cur ? "now" : "upcoming";
  });
  for (const g of s.gates) if (g.status === "open") out[GATE_STAGE[g.id]] = "needs";
  for (const q of s.questions) if (q.status === "open") for (const b of q.blocks) if (isStage(b)) out[b] = "needs";
  return out;
}
export const STAGE_STATE_WORD: Record<StageState, string> = {
  done: "Done",
  now: "Now",
  upcoming: "Upcoming",
  needs: "Needs you",
};

/** the server's count when it sends one (it counts the crew's cards too), else open questions and gates */
export const needsYouCount = (s: ProjectState) =>
  s.needs?.count ??
  s.questions.filter((q) => q.status === "open").length + s.gates.filter((g) => g.status === "open").length;

export const NOTE_CATEGORY: Record<NoteCategory, string> = {
  too_fast: "Too fast",
  too_slow: "Too slow",
  unclear: "Unclear",
  art: "Art",
  sound: "Sound",
  text: "Text",
  other: "Other",
};

// ---- timeline clips ----
export type TrackId = "notes" | "scenes" | "picture" | "text" | "voice" | "sfx" | "music";
export const TRACKS: { id: TrackId; label: string; assignee: Role | "producer" }[] = [
  { id: "notes", label: "Notes", assignee: "producer" },
  { id: "scenes", label: "Scenes", assignee: "director" },
  { id: "picture", label: "Picture", assignee: "animator" },
  { id: "text", label: "Text", assignee: "writer" },
  { id: "voice", label: "Voice", assignee: "editor" },
  { id: "sfx", label: "SFX", assignee: "sound-designer" },
  { id: "music", label: "Music", assignee: "sound-designer" },
];
export type Clip = {
  id: string;
  track: TrackId;
  from: number;
  to: number;
  label: string;
  state: ClipState;
  /** a point marker (note, gate, sfx hit) instead of a span */
  point?: boolean;
  by?: Role;
  scene?: string;
  cue?: string;
  kind?: "note" | "finding" | "gate";
};
export const CLIP_WORD: Record<ClipState, string> = CLIP_STATE_WORD;

const sceneStatusOf = (s: ProjectState, id: string): SceneStatus =>
  s.sceneStatus?.[id] ?? { version: "slate", stale: false, state: "planned" };

/** resolve a doc time expression with what the client knows: numbers, "@event", E(cue)/S(cue)±n, scene ids */
export function resolveTime(expr: string | number, tl: TimelineJSON): number | null {
  if (typeof expr === "number") return expr;
  const s = expr.trim();
  if (/^-?\d+(\.\d+)?$/.test(s)) return Number(s);
  if (s.startsWith("@")) return tl.events[s.slice(1)] ?? null;
  const m = s.match(/^([ES])\(([a-z0-9_]+)\)\s*([+-]\s*\d+(?:\.\d+)?)?$/);
  if (m) {
    const cue = tl.cues.find((c) => c.id === m[2]);
    const sc = tl.scenes.find((c) => c.id === m[2]);
    const base = cue ? (m[1] === "S" ? cue.start : cue.end) : sc ? (m[1] === "S" ? sc.from : sc.to) : null;
    if (base == null) return null;
    return base + (m[3] ? Number(m[3].replace(/\s/g, "")) : 0);
  }
  return tl.events[s] ?? null;
}

export function buildClips(s: ProjectState): Clip[] {
  const tl = s.timeline;
  const clips: Clip[] = [];
  const titles = new Map(s.doc.scenes.map((sc) => [sc.id, sc.title || sc.id]));
  // notes, findings, gates
  for (const n of s.notes) {
    const r = n.target.range;
    const sc = n.target.scene ? tl.scenes.find((x) => x.id === n.target.scene) : undefined;
    const cue = n.target.cue ? tl.cues.find((x) => x.id === n.target.cue) : undefined;
    const from = r?.[0] ?? sc?.from ?? cue?.start ?? 0;
    const to = r?.[1] ?? sc?.to ?? cue?.end ?? from;
    clips.push({
      id: `note:${n.id}`,
      track: "notes",
      from,
      to,
      point: to - from < 0.05,
      label: `${NOTE_CATEGORY[n.category]}${n.text ? `: ${n.text}` : ""}`,
      state:
        n.status === "done"
          ? "ready"
          : n.status === "proposed"
            ? "approval"
            : n.status === "picked_up"
              ? "drafting"
              : "planned",
      kind: "note",
    });
  }
  for (const f of s.findings ?? [])
    clips.push({
      id: `finding:${f.id}`,
      track: "notes",
      from: f.t,
      to: f.t,
      point: true,
      label: f.text,
      state: "approval",
      kind: "finding",
    });
  for (const g of s.gates) {
    if (g.status === "locked") continue;
    const ref = g.items.find((i) => i.ref)?.ref;
    const at = (ref && tl.scenes.find((x) => x.id === ref)?.from) || 0;
    clips.push({
      id: `gate:${g.id}`,
      track: "notes",
      from: at,
      to: at,
      point: true,
      label: GATE_LABEL[g.id],
      state: g.status === "open" ? "approval" : g.status === "passed" ? "locked" : "stale",
      kind: "gate",
    });
  }
  // scenes and picture
  for (const sc of tl.scenes) {
    const st = sceneStatusOf(s, sc.id);
    // "needs you" belongs to the gate marker on the Notes track and to the Inbox; a clip says its own state
    const state: ClipState = st.stale ? "stale" : st.state === "approval" ? "ready" : st.state;
    clips.push({
      id: `scene:${sc.id}`,
      track: "scenes",
      from: sc.from,
      to: sc.to,
      label: titles.get(sc.id) ?? sc.id,
      state,
      scene: sc.id,
      by: st.by,
    });
    clips.push({
      id: `pic:${sc.id}`,
      track: "picture",
      from: sc.from,
      to: sc.to,
      label: VERSION_WORD[st.version],
      state,
      scene: sc.id,
      by: st.by,
    });
  }
  // text
  const aligned = s.doc.script.timing.mode === "aligned";
  for (const c of tl.cues)
    clips.push({
      id: `cue:${c.id}`,
      track: "text",
      from: c.start,
      to: c.end,
      label: c.text,
      state: aligned ? "locked" : "ready",
      cue: c.id,
    });
  // voice: one clip per recorded file, spanning the cues; with nothing recorded the timeline draws one band instead
  if (s.doc.audio.vo.length) {
    const end = tl.cues.at(-1)?.end ?? tl.duration;
    s.doc.audio.vo.forEach((v, i) => {
      clips.push({
        id: `vo:${i}`,
        track: "voice",
        from: v.offset,
        to: Math.max(v.offset + 1, end),
        label: v.file.split("/").pop() ?? v.file,
        state: aligned ? "ready" : "stale",
      });
    });
  }
  // sfx
  s.doc.audio.sfx.events.forEach((e, i) => {
    const t = resolveTime(e.t, tl);
    if (t == null) return;
    clips.push({ id: `sfx:${i}`, track: "sfx", from: t, to: t, point: true, label: e.type, state: "ready" });
  });
  // music
  const m = s.doc.audio.music;
  if (m)
    clips.push({
      id: "music",
      track: "music",
      from: 0,
      to: tl.duration,
      label: `chip bed${m.lift ? ` · lifts in ${m.lift}` : ""}`,
      state: "ready",
    });
  return clips;
}

export const initials = (role: Role) =>
  ROLE_LABEL[role]
    .split(/\s+/)
    .map((w) => w[0])
    .join("")
    .toUpperCase();
