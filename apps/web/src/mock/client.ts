// The in-browser mock backend (?mock=1 or VITE_PAP_MOCK=1). One singleton holds every project; a simulated crew
// runs a project only while something subscribes to it (ref-counted, so React's StrictMode double effects are safe).
// The simulation never seeks, scrolls or opens anything: it only emits events, like the server would.
import { humanStatus, PHASES, phaseOf, problemOf } from "../lib/human.ts";
import { applyEvent } from "../lib/reducer.ts";
import type {
  ActivityEntry,
  AnswerInput,
  ArtAsset,
  Client,
  ConnState,
  CreateProjectInput,
  Finding,
  Gate,
  GateId,
  GateVerdict,
  LibraryIndex,
  Milestone,
  ModelRow,
  Note,
  NoteInput,
  PatchEntryT,
  PatchOpT,
  ProjectState,
  ProjectStatus,
  ProjectSummary,
  ProjectT,
  QuestionT,
  Role,
  SceneStatus,
  ServerEvent,
  Session,
  Settings,
  Stage,
  Task,
  TimelineJSON,
} from "../lib/types.ts";
import { type Beat, closing, failure, middle, opening, wholeRun } from "./activity.ts";
import { drawFrame, drawSheet } from "./art.ts";
import {
  CUES_ANGLE,
  estimateCues,
  LIBRARY,
  MODELS,
  makeDoc,
  ROLE_MODELS,
  SCENE_TITLES,
  SETTINGS,
  scenesFor,
} from "./fixtures.ts";

const TICK_MS = 1000;
const iso = (offsetSec = 0) => new Date(Date.now() + offsetSec * 1000).toISOString();
const clone = <T>(v: T): T => structuredClone(v);
const wait = (ms = 120) => new Promise((r) => setTimeout(r, ms));

type MockProject = {
  state: ProjectState;
  history: PatchEntryT[];
  seq: number;
  phase: number;
  tick: number;
  listeners: Set<(e: ServerEvent) => void>;
  timer: ReturnType<typeof setInterval> | null;
  takes: Map<string, string>;
  pauseIn: number | null;
  reopen: { gate: GateId; at: number } | null;
  transcripts: Map<string, string[]>;
  /** ticks each working task has spent, to pace its live activity */
  beatClock: Map<string, number>;
  /** a first try's id → the id of its newest retry, so the script keeps addressing the live task */
  alias: Map<string, string>;
  /** the script waits while a problem only the person can fix is open */
  hold: boolean;
  lastStatus: string;
};

/** the orchestrator's task kinds, by mock task id */
const KIND: Record<string, string> = {
  t_producer: "producer.plan",
  t_writer: "writer.angles",
  t_director: "director.storyboard",
  t_librarian: "lib.match",
  t_art: "asset.draw",
  t_ad: "asset.judge",
  t_sound: "sound.sfx",
  t_anim: "scene.tune",
  t_editor: "vo.align",
  t_mixer: "sound.mix",
  t_review: "review.final",
  t_export: "deliver.export",
};

function timelineOf(doc: ProjectT): TimelineJSON {
  let cues = estimateCues(doc.script.cues, doc.script.timing.lead);
  const al = doc.script.timing.aligned;
  if (doc.script.timing.mode === "aligned" && al)
    cues = cues.map((c) => (al[c.id] ? { ...c, start: al[c.id][0], end: al[c.id][1] } : c));
  const scenes = scenesFor(cues);
  return {
    cues,
    hold: doc.composition.hold,
    endHold: doc.composition.endHold,
    duration: scenes.at(-1)?.to ?? 30,
    scenes,
    events: { lanterns_on: cues[2]?.start ?? 6 },
  };
}

function task(id: string, role: Role, title: string, status: Task["status"], extra: Partial<Task> = {}): Task {
  return { id, kind: KIND[id] ?? role, role, title, status, model: ROLE_MODELS[role], usd: 0, estUsd: 0.3, ...extra };
}

function newProject(
  id: string,
  title: string,
  brief: Partial<ProjectT["brief"]>,
  capUsd: number,
  seeded: boolean,
): MockProject {
  const doc = makeDoc(id, title, brief);
  doc.budget.capUsd = capUsd;
  if (!seeded) doc.notes = [];
  const timeline = timelineOf(doc);
  const sceneStatus: Record<string, SceneStatus> = {};
  for (const s of timeline.scenes) sceneStatus[s.id] = { version: "slate", stale: false, state: "planned" };
  const deadline = doc.brief.deadline ?? (seeded ? iso(2 * 3600) : null);
  const state: ProjectState = {
    doc,
    rev: doc.rev,
    timeline,
    stage: seeded ? "script" : "brief",
    gates: [
      {
        id: "g0_brief",
        status: seeded ? "passed" : "locked",
        items: [{ label: "Brief as the crew sees it" }, { label: "Plan and budget split" }],
      },
      { id: "g1_script", status: "locked", items: [{ label: "Pick a script angle" }] },
      {
        id: "g2_animatic",
        status: "locked",
        items: [{ label: "Scene order and timing", ref: "s1_open" }, { label: "Board for every cue" }],
      },
      { id: "g3_rough", status: "locked", items: [{ label: "Motion in every scene", ref: "s3_product" }] },
      {
        id: "g4_final",
        status: "locked",
        items: [{ label: "Review findings closed" }, { label: "Loudness at −15 LUFS" }],
      },
    ],
    tasks: [
      task(
        "t_producer",
        "producer",
        seeded ? "Planned the crew and the budget split" : "Reading the brief and planning the crew",
        seeded ? "done" : "upcoming",
        {
          usd: seeded ? 0.18 : 0,
          estUsd: 0.2,
          summary: seeded ? "Split the $6 cap: story 20%, art 45%, animation 20%, sound and edit 15%." : undefined,
          ...(seeded ? { startedAt: iso(-900), endedAt: iso(-840) } : {}),
        },
      ),
    ],
    questions: [],
    notes: seeded
      ? [
          {
            id: "n1",
            target: { scene: "s2_problem", track: "scenes" },
            category: "too_slow",
            text: "The long walk drags; cut it to one beat.",
            assignee: "director",
            status: "picked_up",
            createdAt: iso(-600),
          },
        ]
      : [],
    budget: { capUsd, spentUsd: seeded ? 0.42 : 0, reservedUsd: 0, estTotalUsd: [capUsd * 0.55, capUsd * 0.85] },
    time: { startedAt: iso(seeded ? -900 : 0), etaSec: [1500, 2400], deadline },
    files: [],
    digest: seeded
      ? "The brief is approved. The Writer is drafting three angles for the script while the Librarian matches sprites from the library."
      : "The Producer is reading your brief.",
    sceneStatus,
    findings: [],
    art: [],
    crew: { state: "running" },
    milestones: seeded ? [{ id: "m_plan", at: iso(-840), text: "Plan ready" }] : [],
  };
  // the plan ran before this visit: its whole transcript is already on record
  const planned = state.tasks.find((t) => t.id === "t_producer");
  if (seeded && planned) state.activity = { t_producer: wholeRun(planned) };
  const history: PatchEntryT[] = seeded
    ? [
        entry(
          1,
          0,
          { kind: "user" },
          "Created the project from the composer",
          [{ op: "add", path: "/brief", value: "…" }],
          [{ op: "remove", path: "/brief" }],
        ),
        entry(
          2,
          1,
          { kind: "agent", role: "producer", model: ROLE_MODELS.producer },
          "Set a 30 s cut for the demo-night slot",
          [{ op: "replace", path: "/brief/lengthSec", value: 30 }],
          [{ op: "replace", path: "/brief/lengthSec", value: 60 }],
        ),
        entry(
          3,
          2,
          { kind: "agent", role: "writer", model: ROLE_MODELS.writer },
          "Drafted eight cues from the brief",
          [{ op: "replace", path: "/script/cues", value: doc.script.cues }],
          [{ op: "replace", path: "/script/cues", value: [] }],
        ),
      ]
    : [];
  return {
    state,
    history,
    seq: 100,
    phase: seeded ? 1 : 0,
    tick: 0,
    listeners: new Set(),
    timer: null,
    takes: new Map(),
    pauseIn: null,
    reopen: null,
    transcripts: new Map(),
    beatClock: new Map(),
    alias: new Map(),
    hold: false,
    lastStatus: "",
  };
}

function entry(
  seq: number,
  baseRev: number,
  author: PatchEntryT["author"],
  reason: string,
  ops: PatchOpT[],
  inverse: PatchOpT[],
): PatchEntryT {
  return { seq, opId: `op_${seq}`, ts: iso(-60 * (10 - seq)), baseRev, author, reason, ops, inverse };
}

// ---- a minimal RFC 6902 apply (add/replace/remove) with inverses, for the mock's patches ----
function parts(path: string) {
  return path === ""
    ? []
    : path
        .slice(1)
        .split("/")
        .map((s) => s.replace(/~1/g, "/").replace(/~0/g, "~"));
}
function applyOps(doc: unknown, ops: PatchOpT[]): { doc: unknown; inverse: PatchOpT[] } {
  const root = { v: clone(doc) } as Record<string, unknown>;
  const inverse: PatchOpT[] = [];
  for (const op of ops) {
    if (op.op !== "add" && op.op !== "replace" && op.op !== "remove") continue;
    const ps = ["v", ...parts(op.path)];
    let cur = root as Record<string, unknown> | unknown[];
    for (const k of ps.slice(0, -1)) cur = (cur as Record<string, unknown>)[k] as Record<string, unknown>;
    const key = ps[ps.length - 1];
    const obj = cur as Record<string, unknown>;
    const had = key in obj;
    const before = obj[key];
    if (Array.isArray(cur)) {
      const i = key === "-" ? cur.length : Number(key);
      if (op.op === "add") {
        cur.splice(i, 0, clone(op.value));
        inverse.unshift({ op: "remove", path: op.path.replace(/-$/, String(i)) });
      } else if (op.op === "remove") {
        inverse.unshift({ op: "add", path: op.path, value: cur[i] });
        cur.splice(i, 1);
      } else {
        inverse.unshift({ op: "replace", path: op.path, value: cur[i] });
        cur[i] = clone(op.value);
      }
    } else if (op.op === "remove") {
      inverse.unshift({ op: "add", path: op.path, value: before });
      delete obj[key];
    } else {
      inverse.unshift(had ? { op: "replace", path: op.path, value: before } : { op: "remove", path: op.path });
      obj[key] = clone(op.value);
    }
  }
  return { doc: root.v, inverse };
}

class MockBackend {
  projects = new Map<string, MockProject>();
  settings: Settings = clone(SETTINGS);
  models: ModelRow[] = clone(MODELS);
  library: LibraryIndex = clone(LIBRARY);

  constructor() {
    this.projects.set("lantern", newProject("lantern", "Lantern · demo night", {}, 6, true));
  }

  get(id: string) {
    const p = this.projects.get(id);
    if (!p) throw Object.assign(new Error(`No project ${id}`), { status: 404 });
    return p;
  }

  emit(p: MockProject, e: ServerEvent) {
    p.state = applyEvent(p.state, e);
    p.seq++;
    const copy = clone(e);
    for (const l of p.listeners) l(copy);
  }
  setTask(p: MockProject, first: string, patch: Partial<Task> & { role?: Role; title?: string }) {
    const id = p.alias.get(first) ?? first;
    const old = p.state.tasks.find((t) => t.id === id);
    const role = patch.role ?? old?.role ?? "producer";
    const next: Task = { ...(old ?? task(id, role, patch.title ?? "", "queued")), ...patch };
    if (patch.status === "working" && !next.startedAt) next.startedAt = iso();
    if (patch.status === "done") next.endedAt = iso();
    this.emit(p, { event: "task", data: next });
    this.log(p, role, `${next.title}: ${next.status}`);
    // what the server logs on the way: the step and the model call, then the change and the answer, or the error
    if (patch.status && patch.status !== old?.status) {
      const beats: Beat[] =
        patch.status === "working"
          ? old?.status === "waiting_user"
            ? [{ kind: "step", title: "Picked up your answer and carried on" }]
            : opening(next)
          : patch.status === "done"
            ? closing(next)
            : patch.status === "failed"
              ? failure(next)
              : patch.status === "waiting_user"
                ? [{ kind: "step", title: `Asked you a question: ${next.title}` }]
                : [];
      for (const b of beats) this.activity(p, id, b);
    }
  }
  activity(p: MockProject, taskId: string, b: Beat) {
    this.emit(p, { event: "activity", data: { task: taskId, at: iso(), ...b } });
  }
  /** start a new try of a failed task: the old one points at it, and the script follows the new id */
  retry(p: MockProject, first: string, extra: Partial<Task> = {}) {
    const old = p.state.tasks.find((t) => t.id === (p.alias.get(first) ?? first) || t.id === first);
    if (!old) return;
    const base = [...p.alias.entries()].find(([, v]) => v === old.id)?.[0] ?? old.id;
    const attempt = (old.attempt ?? 1) + 1;
    const next = `${base}_${attempt}`;
    this.setTask(p, old.id, { supersededBy: next });
    this.setTask(p, next, {
      role: old.role,
      kind: old.kind,
      title: old.title,
      parent: old.parent,
      status: "working",
      attempt,
      etaSec: 5,
      estUsd: old.estUsd,
      error: undefined,
      ...extra,
    });
    p.alias.set(base, next);
  }
  milestone(p: MockProject, text: string, image?: string) {
    const m: Milestone = { id: `m_${p.seq}`, at: iso(), text, ...(image ? { image } : {}) };
    this.emit(p, { event: "milestone", data: m });
  }
  /** what the server will send as `status`: the same plain sentence the client derives, plus the problem */
  pushStatus(p: MockProject) {
    const bare: ProjectState = { ...p.state, status: undefined };
    const h = humanStatus(bare);
    const eta = bare.time.etaSec;
    const st: ProjectStatus = {
      line: h.text,
      phase: Math.min(PHASES.length - 1, phaseOf(bare)),
      ...(eta && eta[1] > 0 ? { etaSec: (eta[0] + eta[1]) / 2 } : {}),
      ...(problemOf(bare) ? { problem: problemOf(bare) } : {}),
    };
    const key = JSON.stringify(st);
    if (key === p.lastStatus) return;
    p.lastStatus = key;
    this.emit(p, { event: "status", data: st });
  }
  log(p: MockProject, role: Role, line: string) {
    const list = p.transcripts.get(role) ?? [];
    list.push(`[${new Date().toLocaleTimeString()}] ${line}`);
    p.transcripts.set(role, list);
  }
  x(p: MockProject, data: Partial<ProjectState>) {
    this.emit(p, { event: "x-state", data });
  }
  scene(p: MockProject, id: string, st: Partial<SceneStatus>) {
    const cur = p.state.sceneStatus?.[id] ?? { version: "slate", stale: false, state: "planned" };
    this.x(p, { sceneStatus: { ...p.state.sceneStatus, [id]: { ...cur, ...st } } });
  }
  allScenes(p: MockProject, st: Partial<SceneStatus>) {
    const out: Record<string, SceneStatus> = {};
    for (const s of p.state.timeline.scenes)
      out[s.id] = { ...(p.state.sceneStatus?.[s.id] ?? { version: "slate", stale: false, state: "planned" }), ...st };
    this.x(p, { sceneStatus: out });
  }
  gateSet(p: MockProject, id: GateId, status: Gate["status"]) {
    const g = p.state.gates.find((x) => x.id === id);
    if (g) this.emit(p, { event: "gate", data: { ...g, status } });
  }
  stage(p: MockProject, stage: Stage) {
    this.emit(p, { event: "stage", data: { stage } });
  }
  digest(p: MockProject, text: string) {
    this.emit(p, { event: "digest", data: { text } });
  }
  addPatch(p: MockProject, author: PatchEntryT["author"], reason: string, ops: PatchOpT[], undoes?: number) {
    const { doc, inverse } = applyOps(p.state.doc, ops);
    const seq = (p.history.at(-1)?.seq ?? 0) + 1;
    const e: PatchEntryT = {
      seq,
      opId: `op_${seq}`,
      ts: iso(),
      baseRev: p.state.rev,
      author,
      reason,
      ops,
      inverse,
      ...(undoes != null ? { undoes } : {}),
    };
    p.history.push(e);
    const d = doc as ProjectT;
    d.rev = p.state.rev + 1;
    p.state = { ...p.state, doc: d, rev: d.rev, timeline: timelineOf(d) };
    this.emit(p, { event: "patch", data: e });
    return { rev: d.rev, seq };
  }

  start(p: MockProject) {
    if (p.timer) return;
    p.timer = setInterval(() => this.tick(p), TICK_MS);
  }
  stop(p: MockProject) {
    if (p.timer) clearInterval(p.timer);
    p.timer = null;
  }

  tick(p: MockProject) {
    const crew = p.state.crew?.state ?? "running";
    if (crew === "paused" || crew === "idle") return this.pushStatus(p);
    if (crew === "pausing" && p.pauseIn != null && --p.pauseIn <= 0) {
      p.pauseIn = null;
      this.x(p, { crew: { state: "paused" } });
      this.digest(p, "The crew is paused after finishing its current step. Resume when you are ready.");
      return;
    }
    // spend: working tasks burn money and count down
    let burned = 0;
    for (const t of p.state.tasks) {
      if (t.status !== "working") continue;
      const rate =
        t.role === "pixel-artist"
          ? 0.035
          : t.model?.startsWith("lmstudio") || t.model?.startsWith("ollama")
            ? 0
            : 0.012;
      burned += rate;
      this.emit(p, {
        event: "task",
        data: { ...t, usd: +(t.usd + rate).toFixed(4), etaSec: Math.max(1, (t.etaSec ?? 10) - 1) },
      });
      // a tool call every few seconds while it works
      const c = (p.beatClock.get(t.id) ?? 0) + 1;
      p.beatClock.set(t.id, c);
      if (c % 3 === 2) this.activity(p, t.id, middle(p.state.tasks.find((x) => x.id === t.id) ?? t, (c - 2) / 3));
    }
    if (burned) {
      const reserved = p.state.tasks
        .filter((t) => t.status === "working")
        .reduce((a, t) => a + Math.max(0, (t.estUsd ?? 0) - t.usd), 0);
      this.emit(p, {
        event: "ledger",
        data: {
          usd: burned,
          spentUsd: +(p.state.budget.spentUsd + burned).toFixed(4),
          reservedUsd: +reserved.toFixed(3),
          model: "mixed",
          role: "producer",
        },
      });
    }
    const eta = p.state.time.etaSec;
    if (eta) this.x(p, { time: { ...p.state.time, etaSec: [Math.max(0, eta[0] - 6), Math.max(0, eta[1] - 6)] } });
    if (p.reopen && --p.reopen.at <= 0) {
      this.gateSet(p, p.reopen.gate, "open");
      this.digest(p, "The Producer revised the work you sent back. It is ready for another look.");
      p.reopen = null;
    }
    if (!p.hold) {
      this.script(p);
      p.tick++;
    }
    this.pushStatus(p);
  }

  /** the crew's run, as a list of timed beats per phase; a phase waits on the user at its end */
  script(p: MockProject) {
    const k = p.tick;
    const tl = p.state.timeline;
    const still = (sceneIdx: number, version: "board" | "animatic" | "render") => {
      const sc = tl.scenes[sceneIdx];
      if (!sc) return "";
      const url = drawFrame({
        t: (sc.from + sc.to) / 2,
        sceneIndex: sceneIdx,
        sceneTitle: SCENE_TITLES[sc.id] ?? sc.id,
        version,
      });
      this.emit(p, { event: "render", data: { kind: "still", url } });
      return url;
    };
    switch (p.phase) {
      case 0:
        if (k === 0) {
          this.setTask(p, "t_producer", {
            status: "working",
            etaSec: 5,
            title: "Reading the brief and planning the crew",
          });
          for (const [id, role, title] of [
            ["t_writer", "writer", "Write the script"],
            ["t_director", "director", "Board the scenes"],
            ["t_art", "pixel-artist", "Draw the sprites"],
          ] as const)
            this.setTask(p, id, { role, title, status: "upcoming", estUsd: 0.6 });
        }
        if (k === 5) {
          this.setTask(p, "t_producer", {
            status: "done",
            summary: "Planned eight cues, five scenes and a 45% art share of the budget.",
          });
          this.milestone(p, "Plan ready");
          this.gateSet(p, "g0_brief", "open");
          this.digest(
            p,
            "The Producer has read the brief and planned the crew. Approve the brief (G0) to start the script.",
          );
        }
        return;
      case 1:
        if (k === 0) {
          this.stage(p, "script");
          this.setTask(p, "t_writer", {
            role: "writer",
            title: "Writing 3 angles for the script",
            status: "working",
            etaSec: 6,
            estUsd: 0.4,
          });
          this.setTask(p, "t_librarian", {
            role: "librarian",
            title: "Matching library sprites to the brief",
            status: "working",
            etaSec: 9,
            estUsd: 0.05,
          });
        }
        if (k === 4) {
          const url = still(0, "board");
          this.scene(p, tl.scenes[0].id, { version: "board", state: "drafting", by: "librarian" });
          const lib = p.state.tasks.find((t) => t.id === "t_librarian");
          if (lib) this.setTask(p, "t_librarian", { lastImage: url });
        }
        if (k === 6) {
          this.setTask(p, "t_writer", { status: "waiting_user", title: "Waiting for you to pick an angle" });
          this.gateSet(p, "g1_script", "open");
          const q: QuestionT = {
            id: "q_angle",
            kind: "single",
            question: "Which angle should the script take?",
            why: "All three fit 30 s. The angle sets the hero, the scenes and most of the art bill.",
            options: [
              {
                id: "walker",
                label: "The walker",
                detail: "A night owl finds the good stalls. Closest to the brief.",
                costUsd: 0,
                timeSec: 0,
              },
              {
                id: "vendor",
                label: "The vendor",
                detail: "Mina's stall fills up. Warmer, needs one more character.",
                costUsd: 0.6,
                timeSec: 240,
              },
              {
                id: "data",
                label: "The numbers",
                detail: "Market size first. Fewer sprites, more charts.",
                costUsd: -0.4,
                timeSec: -120,
              },
            ],
            recommendedId: "walker",
            blocks: ["script", "storyboard", "t_director"],
            timeoutSec: null,
            from: "writer",
            askedAt: iso(),
            status: "open",
          };
          this.emit(p, { event: "question", data: q });
          this.digest(
            p,
            "The Writer has three angles ready and needs you to pick one. The walker is closest to your brief.",
          );
        }
        if (k === 9)
          this.setTask(p, "t_librarian", {
            status: "done",
            summary: "Found moon, props and tiles in the library; the lantern logo stays private to this project.",
          });
        return;
      case 2:
        if (k === 0) {
          if (p.state.tasks.find((t) => t.id === "t_librarian")?.status === "working")
            this.setTask(p, "t_librarian", { status: "done", summary: "Found moon, props and tiles in the library." });
          this.stage(p, "storyboard");
          this.setTask(p, "t_director", {
            role: "director",
            title: "Boarding 5 scenes",
            status: "working",
            etaSec: 10,
            estUsd: 0.5,
          });
        }
        if (k > 0 && k <= 10 && k % 2 === 0) {
          const i = k / 2 - 1;
          const url = still(i, "board");
          if (tl.scenes[i]) this.scene(p, tl.scenes[i].id, { version: "board", state: "ready", by: "director" });
          this.setTask(p, "t_director", { lastImage: url, title: `Boarding scene ${i + 1} of ${tl.scenes.length}` });
        }
        if (k === 5)
          this.setTask(p, "t_sound", {
            role: "sound-designer",
            title: "Choosing SFX hits for each beat",
            status: "working",
            etaSec: 6,
            estUsd: 0,
          });
        if (k === 8)
          this.setTask(p, "t_sound", {
            status: "failed",
            error: {
              message: "LM Studio did not answer at 127.0.0.1:1234.",
              fix: "Start LM Studio's local server, or pick another Sound model in Settings, Roles.",
            },
          });
        // the crew fixes this one alone: it retries on the fallback model, and the person never hears about it
        if (k === 10) this.retry(p, "t_sound", { model: ROLE_MODELS.writer });
        if (k === 13)
          this.setTask(p, "t_sound", { status: "done", summary: "Picked six SFX hits on the fallback model." });
        if (k === 11) {
          this.setTask(p, "t_director", {
            status: "done",
            title: "Boarded 5 scenes",
            summary: "Five scenes, one beat each; the long walk is cut to one beat as you noted.",
          });
          this.milestone(p, "Storyboard ready", p.state.tasks.find((t) => t.id === "t_director")?.lastImage);
          this.allScenes(p, { version: "animatic", state: "approval" });
          this.emit(p, {
            event: "note",
            data: {
              ...(p.state.notes.find((n) => n.id === "n1") as Note),
              status: "done",
              reason: "Cut to one 3 s beat.",
            },
          });
          this.gateSet(p, "g2_animatic", "open");
          this.digest(
            p,
            "The animatic is ready: five scenes with their timing. Approve it (G2) and the Pixel artist starts drawing.",
          );
        }
        return;
      case 3: {
        if (k === 0) {
          if (p.state.tasks.find((t) => t.id === p.alias.get("t_sound"))?.status === "working")
            this.setTask(p, "t_sound", { status: "done", summary: "Picked six SFX hits on the fallback model." });
          this.stage(p, "art");
          this.setTask(p, "t_art", {
            role: "pixel-artist",
            title: "Drawing hero, variant 1 of 3, critique 0",
            status: "working",
            etaSec: 12,
            estUsd: 1.6,
          });
          this.setTask(p, "t_ad", {
            role: "art-director",
            title: "Judging hero variants",
            status: "queued",
            estUsd: 0.3,
          });
        }
        if (k > 0 && k <= 6 && k % 2 === 0) {
          const v = k / 2;
          const img = drawSheet(`hero-v${v}`, 16, 24, 4);
          const reasons = [
            "Reads at 1×, but the lantern is lost against the stall roof.",
            "Clear silhouette; the lantern glow is the brightest cell. Best fit for the brief.",
            "Strong walk cycle, but two greens in the coat break the palette.",
          ];
          const hero: ArtAsset = {
            id: "hero",
            label: "Hero (walker)",
            variants: [
              ...(p.state.art?.[0]?.variants ?? []),
              { id: `v${v}`, img, score: [6.5, 8.6, 7.1][v - 1], reason: reasons[v - 1] },
            ],
          };
          this.x(p, { art: [hero, ...(p.state.art?.slice(1) ?? [])] });
          this.setTask(p, "t_art", {
            lastImage: img,
            title: `Drawing hero, variant ${Math.min(3, v + 1)} of 3, critique ${v}`,
          });
          if (v === 1) this.setTask(p, "t_ad", { status: "working", etaSec: 6 });
        }
        if (k === 8) {
          const art = p.state.art ?? [];
          this.x(p, {
            art: [
              { ...art[0], chosen: "v2" },
              {
                id: "stall",
                label: "Stall",
                chosen: "v1",
                variants: [
                  {
                    id: "v1",
                    img: drawSheet("stall", 24, 24, 2),
                    score: 8.1,
                    reason: "Matches the market photo's roof colours.",
                  },
                ],
              },
            ],
          });
          this.setTask(p, "t_ad", {
            status: "done",
            summary: "Chose hero v2: clearest silhouette and the lantern reads first.",
          });
          this.setTask(p, "t_art", {
            status: "done",
            title: "Drew hero and stall",
            summary: "Hero v2 and one stall, 4 frames each.",
          });
          this.milestone(p, "Hero drawn", art[0]?.variants.find((v) => v.id === "v2")?.img);
          this.allScenes(p, { state: "drafting", by: "animator" });
        }
        if (k === 9) {
          this.stage(p, "animate");
          this.setTask(p, "t_anim", {
            role: "animator",
            title: "Animating s3_product, pass 1",
            status: "working",
            etaSec: 8,
            estUsd: 0.7,
          });
          this.digest(p, "Art is chosen: hero variant 2 and one stall. The Animator is putting the scenes in motion.");
        }
        if (k > 9 && k <= 15) {
          const i = k - 10;
          if (tl.scenes[i]) {
            const url = still(i, "render");
            this.scene(p, tl.scenes[i].id, { version: "render", state: "ready", stale: false, by: "animator" });
            this.setTask(p, "t_anim", { lastImage: url, title: `Animating scene ${i + 1} of ${tl.scenes.length}` });
          }
        }
        if (k === 16) {
          this.setTask(p, "t_anim", { status: "done", title: "Animated 5 scenes" });
          this.milestone(p, "Scenes animated", p.state.tasks.find((t) => t.id === "t_anim")?.lastImage);
          this.gateSet(p, "g3_rough", "open");
          this.digest(
            p,
            "The rough cut is ready with motion in every scene. Approve it (G3) to move on to narration and sound.",
          );
        }
        return;
      }
      case 4:
        if (k === 0) {
          this.stage(p, "narrate");
          this.setTask(p, "t_editor", {
            role: "editor",
            title: "Waiting for your narration (open Record)",
            status: "waiting_user",
            estUsd: 0.1,
          });
          this.setTask(p, "t_mixer", {
            role: "mixer",
            title: "Building the chip bed and the mix",
            status: "working",
            etaSec: 6,
            estUsd: 0,
          });
        }
        // this one the crew can't fix alone: the script waits until the person presses Try again
        if (k === 3 && !p.alias.has("t_mixer")) {
          this.setTask(p, "t_mixer", {
            status: "failed",
            error: {
              message: "The mix came back silent twice.",
              fix: "Try again; if it fails a third time, pick another Mixer model in Settings, Roles.",
            },
          });
          p.hold = true;
        }
        if (k === 6) {
          this.setTask(p, "t_mixer", { status: "done", summary: "Music −14 dB, SFX −15 dB, limiter 0.84." });
          this.stage(p, "review");
          this.setTask(p, "t_review", {
            role: "reviewer",
            title: "Watching the rough cut",
            status: "working",
            etaSec: 5,
            estUsd: 0.25,
          });
        }
        if (k === 11) {
          const f: Finding[] = [
            {
              id: "f1",
              t: tl.cues[1]?.start ?? 4,
              scene: tl.scenes[1]?.id,
              severity: "warning",
              text: "Caption covers the walker's feet for 0.8 s.",
              fix: "Raise the walker 4 px in s2.",
            },
            {
              id: "f2",
              t: tl.cues[4]?.end ?? 14,
              scene: tl.scenes[3]?.id,
              severity: "info",
              text: "The coin hit lands 0.3 s before the word.",
              fix: "Move the SFX to E(c06).",
            },
            {
              id: "f3",
              t: (tl.scenes.at(-1)?.from ?? 20) + 1,
              scene: tl.scenes.at(-1)?.id,
              severity: "error",
              text: "End card logo is 1 px off the safe area.",
              fix: "Inset it to the title-safe box.",
            },
          ];
          this.x(p, { findings: f });
          this.setTask(p, "t_review", { status: "done", summary: "Three findings: one error, one warning, one note." });
          this.milestone(p, "Checked for mistakes");
          this.gateSet(p, "g4_final", "open");
          this.digest(
            p,
            "The Reviewer found three things, one of them an error on the end card. Look them over, then approve the final (G4).",
          );
        }
        return;
      case 5:
        if (k === 0) {
          this.stage(p, "deliver");
          if (p.state.tasks.find((t) => t.id === "t_editor")?.status === "waiting_user")
            this.setTask(p, "t_editor", { status: "done", title: "Lined up the narration" });
          this.setTask(p, "t_export", {
            role: "editor",
            title: "Encoding the final at 6×",
            status: "working",
            etaSec: 5,
          });
        }
        if (k === 5) {
          this.setTask(p, "t_export", {
            status: "done",
            title: "Encoded the final",
            summary: "1920×1080, 30 fps, −15 LUFS.",
          });
          const name = p.state.doc.delivery[0]?.out ?? "pitch.mp4";
          this.x(p, {
            files: [
              { name, url: "", bytes: 18_400_000, kind: "video" },
              { name: name.replace(/\.mp4$/, ".srt"), url: "", bytes: 1200, kind: "subtitles" },
              { name: name.replace(/\.mp4$/, ".vtt"), url: "", bytes: 1300, kind: "subtitles" },
              {
                name: "contact.png",
                url: drawFrame({ t: 5, sceneIndex: 2, sceneTitle: "contact", version: "render" }),
                bytes: 42_000,
                kind: "image",
              },
            ],
            crew: { state: "idle" },
            time: { ...p.state.time, etaSec: [0, 0] },
          });
          this.digest(p, "The final is encoded with subtitles. Everything is in Deliver.");
          this.milestone(p, "Your video is ready");
        }
        return;
    }
  }

  advance(p: MockProject) {
    p.phase++;
    p.tick = 0;
  }
}

let backend: MockBackend | null = null;
const be = () => {
  backend ??= new MockBackend();
  return backend;
};

export class MockClient implements Client {
  readonly mock = true;

  async session(): Promise<Session> {
    return {
      version: "0.0.0-mock",
      token: "mock-token-0000",
      workspace: { roots: ["~/Movies/PixelArtPitch"], libraryDir: "library" },
    };
  }
  async projects(): Promise<ProjectSummary[]> {
    await wait();
    return [...be().projects.values()].map(({ state: s }) => ({
      id: s.doc.id,
      title: s.doc.title,
      dir: `~/Movies/PixelArtPitch/${s.doc.id}`,
      rev: s.rev,
      stage: s.stage,
      spentUsd: s.budget.spentUsd,
      capUsd: s.budget.capUsd,
      etaSec: s.time.etaSec?.[1] ?? null,
      deadline: s.time.deadline,
      needsYou:
        s.questions.filter((q) => q.status === "open").length + s.gates.filter((g) => g.status === "open").length,
      updatedAt: new Date().toISOString(),
    }));
  }
  async createProject(input: CreateProjectInput) {
    await wait(300);
    const base =
      input.title
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "_")
        .replace(/^_|_$/g, "")
        .slice(0, 30) || "pitch";
    let id = /^[a-z]/.test(base) ? base : `p_${base}`;
    while (be().projects.has(id)) id = `${id}_2`;
    be().projects.set(id, newProject(id, input.title, input.brief, input.budgetUsd, false));
    return { id };
  }
  async project(id: string) {
    await wait();
    return clone(be().get(id).state);
  }
  async history(id: string) {
    await wait(60);
    return clone(be().get(id).history);
  }
  async patch(id: string, body: { ops: PatchOpT[]; reason: string; baseRev: number }) {
    await wait();
    return be().addPatch(be().get(id), { kind: "user" }, body.reason, body.ops);
  }
  async undo(id: string, seq: number, reason: string) {
    await wait();
    const p = be().get(id);
    const e = p.history.find((h) => h.seq === seq);
    if (!e) throw new Error(`No change #${seq}`);
    if (p.history.some((h) => h.undoes === seq)) throw new Error(`Change #${seq} is already reverted`);
    return be().addPatch(p, { kind: "user" }, reason, e.inverse, seq);
  }
  frameUrl(id: string, t: number, _scale = 2, rev?: number) {
    const p = be().projects.get(id);
    if (!p) return "";
    const tl = p.state.timeline;
    let i = tl.scenes.findIndex((s) => t >= s.from && t < s.to);
    if (i < 0) i = t <= 0 ? 0 : tl.scenes.length - 1;
    const sc = tl.scenes[i];
    const st = sc ? p.state.sceneStatus?.[sc.id] : undefined;
    return drawFrame({
      t,
      sceneIndex: i,
      sceneTitle: (sc && SCENE_TITLES[sc.id]) || sc?.id || "",
      version: st?.version ?? "slate",
      variant: rev != null && rev < p.state.rev ? 1 : 0,
    });
  }
  proxyUrl() {
    return "";
  }
  fileUrl(id: string, name: string) {
    return be().projects.get(id)?.takes.get(name) ?? "";
  }
  async answer(id: string, qid: string, a: AnswerInput) {
    await wait();
    const b = be();
    const p = b.get(id);
    const q = p.state.questions.find((x) => x.id === qid);
    if (!q) throw new Error("That question is gone.");
    const next: QuestionT = {
      ...q,
      status: "answered",
      answer: { ...a, by: a.note === "Let Producer decide" ? "producer" : "user" },
    };
    b.emit(p, { event: "question", data: next });
    if (qid === "q_angle") {
      const pick = a.optionId ?? q.recommendedId;
      b.addPatch(
        p,
        { kind: "agent", role: "writer", model: ROLE_MODELS.writer },
        `Rewrote the script for the "${pick}" angle you picked`,
        [{ op: "replace", path: "/script/cues", value: CUES_ANGLE[pick] ?? CUES_ANGLE.walker }],
      );
      b.setTask(p, "t_writer", {
        status: "done",
        title: "Wrote the script",
        summary: `Went with the ${pick} angle: ${p.state.doc.script.cues.length} cues.`,
      });
      b.gateSet(p, "g1_script", "passed");
      b.milestone(p, "Script written · 3 options");
      b.digest(p, `You picked the ${pick} angle. The Director is boarding the scenes now.`);
      b.advance(p);
    }
    return clone(next);
  }
  async addNote(id: string, n: NoteInput) {
    await wait();
    const b = be();
    const p = b.get(id);
    const note: Note = {
      id: `n${Date.now().toString(36)}`,
      target: n.target,
      category: n.category,
      text: n.text ?? "",
      assignee: n.assignee ?? "producer",
      status: "open",
      createdAt: new Date().toISOString(),
    };
    b.emit(p, { event: "note", data: note });
    setTimeout(() => b.emit(p, { event: "note", data: { ...note, status: "picked_up" } }), 3000);
    return clone(note);
  }
  async gate(id: string, gate: GateId, v: GateVerdict) {
    await wait();
    const b = be();
    const p = b.get(id);
    if (v.verdict === "changes") {
      b.gateSet(p, gate, "changes");
      b.digest(
        p,
        `You asked for changes at ${gate.slice(0, 2).toUpperCase()}. The Producer is passing your reasons to the crew.`,
      );
      p.reopen = { gate, at: 6 };
    } else {
      b.gateSet(p, gate, "passed");
      if (gate === "g1_script") {
        const q = p.state.questions.find((x) => x.id === "q_angle" && x.status === "open");
        if (q)
          return this.answer(id, q.id, { optionId: q.recommendedId }).then(() =>
            clone(p.state.gates.find((g) => g.id === gate) as Gate),
          );
      }
      b.advance(p);
    }
    return clone(p.state.gates.find((g) => g.id === gate) as Gate);
  }
  async crewRun(id: string) {
    const p = be().get(id);
    be().x(p, { crew: { state: "running" } });
  }
  async crewPause(id: string, mode: "after_step" | "now") {
    await wait();
    const b = be();
    const p = b.get(id);
    if (mode === "now") {
      p.pauseIn = null;
      b.x(p, { crew: { state: "paused" } });
      b.digest(p, "You paused the crew. Work in progress is kept; nothing is spent while paused.");
    } else {
      p.pauseIn = 3;
      b.x(p, { crew: { state: "pausing" } });
    }
  }
  async crewResume(id: string) {
    await wait();
    const b = be();
    const p = b.get(id);
    p.pauseIn = null;
    b.x(p, { crew: { state: "running" } });
    b.digest(p, "The crew is back at work.");
  }
  async crewRetry(id: string, taskId: string) {
    await wait();
    const b = be();
    const p = b.get(id);
    if (!p.state.tasks.some((t) => t.id === taskId && t.status === "failed"))
      throw new Error("That task isn't stopped.");
    b.retry(p, taskId);
    p.hold = false;
    b.pushStatus(p);
  }
  async transcript(id: string, taskId: string) {
    await wait();
    const p = be().get(id);
    const t = p.state.tasks.find((x) => x.id === taskId);
    if (!t) return null;
    const lines = p.transcripts.get(t.role) ?? [];
    return [
      `system: You are the ${t.role} on a pixel-art pitch crew.`,
      `tool read_project → rev ${p.state.rev}, ${p.state.doc.script.cues.length} cues`,
      ...lines,
    ].join("\n");
  }
  async taskTranscript(id: string, taskId: string): Promise<ActivityEntry[] | null> {
    await wait();
    const p = be().get(id);
    if (!p.state.tasks.some((t) => t.id === taskId)) return null;
    return clone(p.state.activity?.[taskId] ?? []);
  }
  async uploadVo(id: string, body: Blob, take: string) {
    await wait(400);
    const p = be().get(id);
    const file = `vo/${take}.${body.type.includes("wav") ? "wav" : "webm"}`;
    p.takes.set(file, URL.createObjectURL(body));
    return { file };
  }
  async align(id: string, file: string) {
    await wait(800);
    const p = be().get(id);
    if (!p.takes.has(file) && !file) throw new Error("No take to align.");
    return {
      proposal: p.state.timeline.cues.map((c, i) => ({
        cue: c.id,
        start: +(c.start + 0.15 + (i % 3) * 0.1).toFixed(2),
        end: +(c.end + 0.05 + (i % 2) * 0.2).toFixed(2),
      })),
    };
  }
  async settings() {
    await wait();
    return clone(be().settings);
  }
  async saveSettings(partial: Partial<Settings>) {
    await wait();
    const b = be();
    b.settings = { ...b.settings, ...clone(partial) };
    return clone(b.settings);
  }
  async saveKey(provider: string) {
    await wait();
    const b = be();
    const pr = b.settings.providers.find((x) => x.id === provider);
    if (pr) pr.hasKey = true;
    return { hasKey: true as const };
  }
  async testProvider(provider: string) {
    await wait(700);
    const pr = be().settings.providers.find((x) => x.id === provider);
    if (!pr) return { ok: false, models: [], error: "Save this provider first." };
    if (pr.kind === "lmstudio")
      return {
        ok: false,
        models: [],
        error: `Nothing answered at ${pr.baseUrl}. Start LM Studio's local server and try again.`,
      };
    if (!pr.hasKey && !["ollama", "llamacpp"].includes(pr.kind))
      return { ok: false, models: [], error: "No key saved. Paste a key, save it, then test again." };
    return {
      ok: true,
      models: be()
        .models.filter((m) => m.provider === provider)
        .map((m) => m.id),
    };
  }
  async models() {
    await wait();
    return clone(be().models);
  }
  async library() {
    await wait();
    return clone(be().library);
  }
  sheetUrl(assetId: string) {
    const a = be().library.assets.find((x) => x.id === assetId);
    return drawSheet(assetId, a?.w ?? 16, a?.h ?? 16, a?.frames ?? 1);
  }
  subscribe(id: string, on: (e: ServerEvent) => void, onConn?: (s: ConnState) => void) {
    const b = be();
    const p = b.projects.get(id);
    if (!p) return () => {};
    p.listeners.add(on);
    onConn?.("open");
    b.start(p);
    return () => {
      p.listeners.delete(on);
      if (!p.listeners.size) b.stop(p);
    };
  }
}
