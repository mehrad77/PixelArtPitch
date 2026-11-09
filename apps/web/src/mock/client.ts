// The in-browser mock backend (?mock=1 or VITE_PAP_MOCK=1). One singleton holds every project; a simulated crew
// runs a project only while something subscribes to it (ref-counted, so React's StrictMode double effects are safe).
// The simulation never seeks, scrolls or opens anything: it only emits events, like the server would.
import { partsOf } from "@pap/tools/parts";
import { ApiError } from "../lib/api.ts";
import { crewRunning, humanStatus, problemOf, STAGE_WORD } from "../lib/human.ts";
import { msgsOf } from "../lib/instances.ts";
import { applyEvent } from "../lib/reducer.ts";
import { mergeSettings } from "../lib/settings.ts";
import type {
  ActivityEntry,
  AnswerInput,
  ArtAsset,
  ChannelMsg,
  Client,
  ConnectionTrust,
  ConnState,
  CreateProjectInput,
  Draft,
  DraftRef,
  FileRow,
  Finding,
  Gate,
  GateId,
  GateVerdict,
  InstanceLog,
  InstanceLogEntry,
  LibraryIndex,
  Milestone,
  ModelRow,
  Note,
  NoteInput,
  Parts,
  PatchEntryT,
  PatchOpT,
  PipDecision,
  PipItem,
  PlanRevisionSummary,
  ProjectState,
  ProjectStatus,
  ProjectSummary,
  ProjectT,
  QuestionT,
  RefType,
  Role,
  SceneStatus,
  ServerEvent,
  Session,
  Settings,
  Stage,
  Task,
  TimelineJSON,
  Version,
  WorkspaceLine,
} from "../lib/types.ts";
import { type Beat, closing, failure, middle, opening, wholeRun } from "./activity.ts";
import { drawContactSheet, drawFrame, drawLogo, drawSheet } from "./art.ts";
import { roughCutAudio } from "./audio.ts";
import { MockDrafts } from "./drafts.ts";
import { fixtureChanges, fixtureInstances } from "./fixture-crew.ts";
import {
  CUES_ANGLE,
  estimateCues,
  LIBRARY,
  MODELS,
  makeDoc,
  makeQuestDayDoc,
  ROLE_MODELS,
  SCENE_TITLES,
  SETTINGS,
  scenesFor,
} from "./fixtures.ts";
import { JOURNEY, Journey, type JourneyFlags, journeyFlags, OVERRUN_CAP, routeNote } from "./journey.ts";
import { blobUrl, MockPip, srtOf } from "./pip.ts";
import { mockProgress } from "./progress.ts";

/** the journey flags (PIP-JOURNEY §6), read once at boot and kept for the tab: journey=todo, speed, slots, auto,
 * scenario, proxy=0 (no playable rough cut, as an older server) and stale=1 (the "old build" banner) */
function bootFlags(): JourneyFlags & { journey: string | null; stale: boolean } {
  let search = location.search;
  try {
    const q = new URLSearchParams(search);
    if (["journey", "speed", "slots", "auto", "scenario", "proxy", "stale"].some((k) => q.has(k)))
      sessionStorage.setItem("pap-journey", search);
    else search = sessionStorage.getItem("pap-journey") ?? search;
  } catch {}
  const q = new URLSearchParams(search);
  return { ...journeyFlags(search), journey: q.get("journey"), stale: q.get("stale") === "1" };
}
export const FLAGS =
  typeof location !== "undefined"
    ? bootFlags()
    : { speed: 1, slots: 3, auto: false, scenario: null, journey: null, proxy: true, stale: false };

const TICK_MS = 1000;
const iso = (offsetSec = 0) => new Date(Date.now() + offsetSec * 1000).toISOString();
const clone = <T>(v: T): T => structuredClone(v);
const wait = (ms = 120) => new Promise((r) => setTimeout(r, ms));

type MockProject = {
  state: ProjectState;
  /** syncParts is running (its own events don't start it again) */
  syncing?: boolean;
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
  /** a project started from /new: the journey runs it instead of the script above */
  journey?: Journey;
  /** the last crew sync saw the journey held (the crew reads paused while held, as the server's does) */
  wasHeld?: boolean;
  /** the rough cut with sound, once the review wrote it */
  proxy?: string;
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
  // a doc that sets its own scene times (the journey's QuestDay) keeps them; the older fixtures derive them from cues
  const own = doc.scenes.length > 0 && doc.scenes.every((s) => typeof s.from === "number" && /^s\d\d$/.test(s.id));
  const scenes = own ? doc.scenes.map((s) => ({ id: s.id, from: Number(s.from), to: Number(s.to) })) : scenesFor(cues);
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
  // one member per role in the scripted fixtures (fixture-crew.ts): the row names it, as the server's rows do
  return {
    id,
    kind: KIND[id] ?? role,
    role,
    title,
    status,
    model: ROLE_MODELS[role],
    usd: 0,
    estUsd: 0.3,
    instance: role,
    ...extra,
  };
}

function newProject(
  id: string,
  title: string,
  brief: Partial<ProjectT["brief"]>,
  capUsd: number,
  seeded: boolean,
  make: typeof makeDoc = makeDoc,
): MockProject {
  const doc = make(id, title, brief);
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

/** the video, its .srt and .vtt, as blob URLs so Download and Open work in mock mode */
function mockFiles(name: string, cues: TimelineJSON["cues"], size: number): FileRow[] {
  const srt = srtOf(cues);
  return [
    { name, url: blobUrl("mock video: the real studio writes an mp4 here", "video/mp4"), bytes: size, kind: "video" },
    { name: name.replace(/\.mp4$/, ".srt"), url: blobUrl(srt), bytes: srt.length, kind: "subtitles" },
    {
      name: name.replace(/\.mp4$/, ".vtt"),
      url: blobUrl(`WEBVTT\n\n${srt.replace(/,(\d{3})/g, ".$1")}`, "text/vtt"),
      bytes: srt.length + 8,
      kind: "subtitles",
    },
  ];
}

class MockBackend {
  projects = new Map<string, MockProject>();
  pip: MockPip = new MockPip({
    state: (id) => this.projects.get(id)?.state ?? null,
    emit: (id, e) => {
      const p = this.projects.get(id);
      if (p) this.emit(p, e);
    },
    setFiles: (id, files) => {
      const p = this.projects.get(id);
      if (p) this.x(p, { files });
    },
    handoff: (id) => {
      const p = this.projects.get(id);
      if (!p) return;
      p.phase = 50;
      p.tick = 0;
      p.hold = false;
      this.x(p, { crew: { state: "running" } });
      this.pushStatus(p);
    },
    createProject: async (title, idea) => {
      let id =
        title
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, "_")
          .replace(/^_|_$/g, "")
          .slice(0, 30) || "pitch";
      if (!/^[a-z]/.test(id)) id = `p_${id}`;
      while (this.projects.has(id)) id = `${id}_2`;
      const np = newProject(id, title, { idea }, 5, false);
      np.state.crew = { state: "idle" };
      np.state.tasks = [];
      np.phase = 99;
      this.projects.set(id, np);
      return id;
    },
    createDraft: (from) => this.drafts.create(from).draft.id,
    titles: () =>
      [...this.projects.values()].map((p) => ({ id: p.state.doc.id, title: p.state.doc.title, state: p.state })),
    lastChange: (id) => {
      const p = this.projects.get(id);
      const undone = new Set(p?.history.flatMap((h) => (h.undoes != null ? [h.undoes] : [])) ?? []);
      const e = [...(p?.history ?? [])].reverse().find((h) => h.undoes == null && !undone.has(h.seq));
      if (!e) return null;
      const by = e.author.kind === "agent" ? `the ${String(e.author.role ?? "crew").replace(/-/g, " ")}` : "you";
      return { seq: e.seq, reason: e.reason, by };
    },
    undo: async (id, seq, reason) => {
      const p = this.get(id);
      const e = p.history.find((h) => h.seq === seq);
      if (e) this.addPatch(p, { kind: "user" }, reason, e.inverse, seq);
    },
    setCap: (id, usd) => {
      const p = this.projects.get(id);
      if (p) this.x(p, { budget: { ...p.state.budget, capUsd: usd } });
    },
  });
  /** the crew channel, per project */
  channels = new Map<string, ChannelMsg[]>();
  say(p: MockProject, from: string, to: string, kind: ChannelMsg["kind"], text: string, ref?: string) {
    const m: ChannelMsg = {
      id: `ch_${p.seq}_${Date.now().toString(36)}`,
      at: iso(),
      from,
      to,
      kind,
      text,
      ...(ref ? { ref } : {}),
    };
    const id = p.state.doc.id;
    this.channels.set(id, [...(this.channels.get(id) ?? []), m]);
    this.emit(p, { event: "channel", data: m });
  }
  settings: Settings = clone(SETTINGS);
  models: ModelRow[] = clone(MODELS);
  library: LibraryIndex = clone(LIBRARY);

  drafts: MockDrafts = new MockDrafts({
    push: (draft, item) => this.pip.push(draft, item),
    update: (draft, card) => this.pip.update(draft, card),
    card: (draft, card, run) => {
      const kept = this.pip.card(draft, card, run);
      // `auto=1`: the recommended answers, Mine for the rights, and Start, 3 ticks after each card opens
      if (FLAGS.auto)
        setTimeout(
          () => {
            const values =
              card.type === "form" && card.form === "brief_fields"
                ? Object.fromEntries(
                    card.fields.map((f) => [
                      f.key,
                      f.type === "files"
                        ? (f.value as DraftRef[]).map((r) => ({ name: r.name, type: r.type, rights: "mine" }))
                        : f.type === "number"
                          ? Number(f.recommended)
                          : String(f.recommended),
                    ]),
                  )
                : undefined;
            this.pip.decide(card.id, { draft, decision: "confirm", ...(values ? { values } : {}) }).catch(() => {});
          },
          (3 * TICK_MS) / FLAGS.speed,
        );
      return kept;
    },
    thinking: (draft) => this.pip.send(draft, { type: "thinking" }),
    start: (d) => this.startDraft(d),
    copyOf: (id) => {
      const s = this.projects.get(id)?.state;
      if (!s) return null;
      const b = s.doc.brief;
      const audience = { pitch: "investors", social: "users", launch: "launch" }[String(b.purpose)] as
        | string
        | undefined;
      return {
        title: s.doc.title,
        fields: {
          ...(audience ? { audience } : {}),
          ...(typeof b.lengthSec === "number" ? { lengthSec: b.lengthSec } : {}),
          ...(b.narration === "none" || b.narration === "user" ? { narration: b.narration } : {}),
          ...(b.involvement ? { involvement: b.involvement } : {}),
          ...(b.tone?.length ? { style: [...b.tone].slice(0, 3) } : {}),
          ...(s.budget.capUsd > 0 ? { budget: s.budget.capUsd } : {}),
          profile: this.settings.profile,
        },
      };
    },
    started: (draft, id) => {
      const p = this.projects.get(id);
      this.pip.move(draft, id);
      this.drafts.drafts.delete(draft);
      if (p?.journey) this.play(p, p.journey.start());
    },
  });

  constructor() {
    this.pip.drafts = {
      reply: (key, text) => this.drafts.reply(key, text),
      answer: (key, card, values) => {
        if (card.type === "form" && card.form === "brief_fields") this.drafts.answer(key, card, values);
      },
      brief: (key) => this.drafts.brief(key),
      files: (key) => this.drafts.announce(key),
    };
    if (FLAGS.journey === "todo") {
      this.journeyFixtures();
      this.seedInstances();
      return;
    }
    this.projects.set("lantern", newProject("lantern", "Lantern · demo night", {}, 6, true));
    // a few more, still, for the Projects overview: one stopped mid-run, one not started, the finished example
    const done = (id: string, role: Role, title: string, at: number): Task =>
      task(id, role, title, "done", { usd: 0.12, startedAt: iso(at - 120), endedAt: iso(at) });
    const harbor = newProject("harbor", "Harbor lights", {}, 5, false);
    Object.assign(harbor.state, {
      stage: "animate",
      tasks: [
        done("t_producer", "producer", "Reading the brief and planning the crew", -9000),
        done("t_writer", "writer", "Writing three script angles", -8400),
        done("t_director", "director", "Storyboarding five scenes", -7800),
        done("t_artist", "pixel-artist", "Drawing hero variants", -7000),
        task("t_tune_s1", "scene-coder", "Animating scene 1 of 5", "upcoming"),
      ],
      crew: { state: "idle" },
      budget: { ...harbor.state.budget, spentUsd: 1.84 },
      time: { ...harbor.state.time, etaSec: null },
      milestones: [
        { id: "m_plan", at: iso(-9000), text: "Plan ready" },
        { id: "m_script", at: iso(-8400), text: "Script written · 3 options" },
      ],
    });
    for (const sc of harbor.state.timeline.scenes)
      harbor.state.sceneStatus = {
        ...harbor.state.sceneStatus,
        [sc.id]: { version: "animatic", stale: false, state: "ready" },
      };
    harbor.phase = 99;
    this.projects.set("harbor", harbor);
    const fresh = newProject("fresh", "Night market", {}, 4, false);
    Object.assign(fresh.state, { tasks: [], crew: { state: "idle" }, time: { ...fresh.state.time, etaSec: null } });
    fresh.phase = 99;
    this.projects.set("fresh", fresh);
    const example = newProject("example", "Moth and lamp · example", {}, 0, false);
    Object.assign(example.state, {
      stage: "deliver",
      tasks: [done("t_producer", "producer", "Reading the brief and planning the crew", -86400)],
      crew: { state: "idle" },
      time: { ...example.state.time, etaSec: null },
      files: mockFiles("pitch.mp4", example.state.timeline.cues, 2_400_000),
      milestones: [{ id: "m_video", at: iso(-86400), text: "Your video is ready" }],
    });
    for (const sc of example.state.timeline.scenes)
      example.state.sceneStatus = {
        ...example.state.sceneStatus,
        [sc.id]: { version: "render", stale: false, state: "locked" },
      };
    example.phase = 99;
    this.projects.set("example", example);
    this.seedInstances();
  }
  /** the scripted fixtures start with their crew row as their rows say (the journey's projects build their own) */
  seedInstances() {
    for (const p of this.projects.values()) if (!p.journey) p.state.instances = fixtureInstances(p.state, ROLE_MODELS);
  }

  get(id: string) {
    const p = this.projects.get(id);
    if (!p) throw Object.assign(new Error(`No project ${id}`), { status: 404 });
    if (!p.state.versions) this.syncParts(p, true);
    return p;
  }

  // ---- the journey "todo" (PIP-JOURNEY §6) ----
  /** `journey=todo`: two projects to come back to, a finished one and one waiting on a pick */
  journeyFixtures() {
    const teaser = newProject("questday_teaser", "QuestDay teaser", { idea: "A 15 s teaser for QuestDay." }, 3, false);
    const doneAt = -2 * 3600;
    Object.assign(teaser.state, {
      stage: "deliver",
      tasks: [
        task("t_export", "editor", "Exported your video", "done", {
          usd: 0,
          startedAt: iso(doneAt - 60),
          endedAt: iso(doneAt),
        }),
      ],
      crew: { state: "idle" },
      budget: { ...teaser.state.budget, spentUsd: 1.12 },
      time: { ...teaser.state.time, etaSec: null },
      files: mockFiles("questday-teaser.mp4", teaser.state.timeline.cues, 1_200_000),
      milestones: [{ id: "m_video", at: iso(doneAt), text: "Your video is ready" }],
    });
    for (const sc of teaser.state.timeline.scenes)
      teaser.state.sceneStatus = {
        ...teaser.state.sceneStatus,
        [sc.id]: { version: "render", stale: false, state: "locked" },
      };
    teaser.phase = 99;
    this.projects.set(teaser.state.doc.id, teaser);
    const lantern = newProject("lantern", "Lantern · demo night", {}, 6, true);
    const q: QuestionT = {
      id: "q_angle",
      kind: "single",
      question: "Which angle should the script take?",
      why: "All three fit 30 s. The angle sets the hero, the scenes and most of the art bill.",
      options: [
        { id: "walker", label: "The walker", detail: "A night owl finds the good stalls. Closest to the brief." },
        { id: "vendor", label: "The vendor", detail: "A stall owner lights her lantern from her phone." },
        { id: "numbers", label: "The numbers", detail: "Nine hundred walkers a week, for the investors." },
      ],
      recommendedId: "walker",
      blocks: ["script"],
      timeoutSec: null,
      from: "writer",
      askedAt: iso(-1200),
      status: "open",
    };
    Object.assign(lantern.state, {
      questions: [q],
      tasks: [
        ...lantern.state.tasks,
        task("t_writer", "writer", "Waiting for you to pick an angle", "waiting_user", {
          usd: 0.21,
          startedAt: iso(-1500),
        }),
      ],
      crew: { state: "idle" },
      digest: "The Writer has three angles. Pick one and the Director boards the scenes.",
    });
    lantern.phase = 99;
    this.projects.set("lantern", lantern);
  }
  /** Start on the brief card: the project, its conversation moved over, the draft gone, and rev 0 */
  startDraft(d: Draft): string {
    const title = d.title || String(d.fields.title ?? "") || JOURNEY.title;
    let id =
      title
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "_")
        .replace(/^_|_$/g, "")
        .slice(0, 30) || "pitch";
    if (!/^[a-z]/.test(id)) id = `p_${id}`;
    while (this.projects.has(id)) id = `${id}_2`;
    const f = d.fields;
    const p = newProject(
      id,
      title,
      {
        idea: String(f.idea ?? ""),
        lengthSec: typeof f.lengthSec === "number" ? f.lengthSec : 30,
        narration: f.narration === "user" ? "user" : "none",
        involvement: "key",
        references: d.refs.map((r) => ({ file: r.name, type: r.type, rights: r.rights, note: "" })),
      },
      // the overrun scenario's cap puts its 80% line inside the run
      FLAGS.scenario === "overrun" ? OVERRUN_CAP : typeof f.budget === "number" ? f.budget : JOURNEY.capUsd,
      false,
      makeQuestDayDoc,
    );
    Object.assign(p.state, {
      tasks: [],
      crew: { state: "running" },
      digest: "",
      instances: [],
      plan: null,
      budget: { ...p.state.budget, estTotalUsd: [...JOURNEY.estUsd] },
      time: { ...p.state.time, etaSec: [...JOURNEY.estSec] },
    });
    for (const g of p.state.gates) g.status = g.id === "g0_brief" ? "open" : "locked";
    p.phase = 99;
    this.projects.set(id, p);
    const cues = p.state.timeline.cues;
    p.journey = new Journey({
      ...FLAGS,
      base: Date.now(),
      sceneIds: p.state.timeline.scenes.map((sc) => sc.id),
      logo: d.refs.some((r) => r.type === "logo"),
      logoIcon: d.refs.some((r) => r.type === "logo") ? drawLogo() : undefined,
      capUsd: p.state.budget.capUsd,
      proxyUrl: () => {
        // the review re-encodes the rough cut each round; the same sound serves every round
        const tl = p.state.timeline;
        p.proxy ??= roughCutAudio((tl.hold ?? 0) + tl.duration + (tl.endHold ?? 0));
        return p.proxy;
      },
      files: () => {
        const rows = mockFiles("questday-pitch.mp4", cues, 2_400_000);
        return { rows, pip: rows.map((r) => ({ name: r.name, kind: r.kind, sizeBytes: r.bytes, url: r.url })) };
      },
    });
    return id;
  }
  /** one journey tick, and the ETA counting down while the crew works (the run's minutes, compressed) */
  journeyTick(p: MockProject, j: Journey) {
    this.play(p, j.step());
    // each working task's model call, live (the server's `progress` event): transient, never in the journey's log
    for (const t of p.state.tasks) {
      const at = Date.parse(t.startedAt ?? "");
      const live = Number.isFinite(at) ? mockProgress(t, (Date.now() - at) / 1000, FLAGS.speed) : null;
      if (live) this.emit(p, { event: "progress", data: { what: "task", ...live } });
    }
    const eta = p.state.time.etaSec;
    if (eta && !j.waits.size && !j.ended)
      this.x(p, { time: { ...p.state.time, etaSec: [Math.max(30, eta[0] - 10), Math.max(30, eta[1] - 12)] } });
  }
  /** the journey's events, as the server would send them: Pip's into the conversation, the crew's onto the channel */
  play(p: MockProject, events: ServerEvent[]) {
    const id = p.state.doc.id;
    for (const e of events) {
      if (e.event === "pip") {
        if (e.data.type === "item") {
          for (const c of e.data.item.kind === "pip" ? e.data.item.cards : [])
            if (c.type === "plan" && c.status === "proposed")
              this.pip.card(
                id,
                c,
                async () => {
                  this.play(p, p.journey?.act({ type: "card", cardId: c.id, decision: "confirm" }) ?? []);
                },
                () => this.play(p, p.journey?.act({ type: "card", cardId: c.id, decision: "decline" }) ?? []),
              );
          this.pip.push(id, e.data.item);
        } else if (e.data.type === "card") this.pip.update(id, e.data.card);
        continue;
      }
      if (e.event === "channel") {
        this.channels.set(id, [...(this.channels.get(id) ?? []), e.data]);
        this.emit(p, e);
        continue;
      }
      this.emit(p, e);
    }
    if (events.length) this.pushStatus(p);
    if (p.journey?.nodes.find((n) => n.id === "g4")?.status === "done" && p.state.crew?.state !== "idle")
      this.x(p, { crew: { state: "idle" } });
  }

  /** a provider's key was saved or tested: journeys held on it go on (the server's Crew.providerFixed) */
  providerFixed(provider: string) {
    for (const p of this.projects.values())
      if (p.journey?.hold?.provider === provider) this.play(p, p.journey.act({ type: "key", provider }));
  }
  emit(p: MockProject, e: ServerEvent) {
    p.state = applyEvent(p.state, e);
    p.seq++;
    const copy = clone(e);
    for (const l of p.listeners) l(copy);
    if (["patch", "x-state", "stage", "render"].includes(e.event)) this.syncParts(p);
  }
  /**
   * What the server does after a patch, a scene's status or an export: a new exported video is the next version
   * (history/versions.jsonl), and the parts go out as a `parts` event when they change. `quiet` sets them without
   * events (a project read before anyone listens).
   */
  syncParts(p: MockProject, quiet = false) {
    if (p.syncing) return;
    p.syncing = true;
    try {
      const video = p.state.files.find((f) => f.kind === "video");
      const had = p.state.versions ?? [];
      let versions = had;
      if (video && !had.some((v) => v.url === video.url)) {
        const v = had.reduce((m, x) => Math.max(m, x.v), 0) + 1;
        versions = [
          ...had,
          {
            v,
            rev: p.state.doc.rev,
            at: iso(),
            file: `out/versions/v${v}.mp4`,
            sec: p.state.timeline.duration,
            sha1: "mock",
            url: video.url,
          },
        ];
      }
      const parts = mockParts(p, versions);
      const changed = JSON.stringify(parts) !== JSON.stringify(p.state.parts);
      if (quiet) {
        p.state = { ...p.state, versions, ...(parts ? { parts } : {}) };
        return;
      }
      if (versions !== had) this.x(p, { versions });
      if (parts && changed) this.emit(p, { event: "parts", data: parts });
    } finally {
      p.syncing = false;
    }
  }
  setTask(p: MockProject, first: string, patch: Partial<Task> & { role?: Role; title?: string }) {
    const id = p.alias.get(first) ?? first;
    const old = p.state.tasks.find((t) => t.id === id);
    const role = patch.role ?? old?.role ?? "producer";
    const next: Task = { ...(old ?? task(id, role, patch.title ?? "", "queued")), ...patch };
    if (patch.status === "working" && !next.startedAt) next.startedAt = iso();
    if (patch.status === "done") next.endedAt = iso();
    this.emit(p, { event: "task", data: next });
    this.syncInstances(p);
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
  /** a scripted fixture's crew row, re-derived from its rows: the changed members go out as `instance` events */
  syncInstances(p: MockProject) {
    if (p.journey) return;
    for (const data of fixtureChanges(p.state, ROLE_MODELS)) this.emit(p, { event: "instance", data });
  }
  /** what the server will send as `status`: the same plain sentence the client derives, plus the problem */
  pushStatus(p: MockProject) {
    this.syncCrew(p);
    this.syncInstances(p);
    const bare: ProjectState = { ...p.state, status: undefined };
    const h = humanStatus(bare);
    const eta = bare.time.etaSec;
    // a journey scenario that holds the run or waits on a card says so, as the server's status does
    const own = p.journey?.statusNow;
    const st: ProjectStatus = own
      ? {
          line: own.line,
          ...(own.problem ? { problem: own.problem } : {}),
          ...(own.waiting ? { waiting: own.waiting } : {}),
        }
      : {
          line: h.text,
          ...(eta && eta[1] > 0 ? { etaSec: (eta[0] + eta[1]) / 2 } : {}),
          ...(problemOf(bare) ? { problem: problemOf(bare) } : {}),
        };
    const key = JSON.stringify(st);
    if (key === p.lastStatus) return;
    p.lastStatus = key;
    this.emit(p, { event: "status", data: st });
  }
  /** the server's crew fields (running, paused, stage, lastActiveAt, queued), derived from the simulated run */
  syncCrew(p: MockProject) {
    let st = p.state.crew?.state ?? "running";
    // a held run is paused on the server (`state.paused`), and goes on when the hold lifts
    if (p.journey?.hold) st = "paused";
    else if (p.wasHeld && st === "paused") st = "running";
    p.wasHeld = !!p.journey?.hold;
    const times = p.state.tasks.flatMap((t) => [t.startedAt, t.endedAt]).filter((x): x is string => !!x);
    const last = times.sort().at(-1) ?? null;
    const crew = {
      state: st,
      // the server's run is alive while held (running, and paused)
      running: st === "running" || st === "pausing" || !!p.journey?.hold,
      paused: st === "paused",
      stage: p.state.stage,
      lastActiveAt: last,
      queued: p.state.tasks.filter((t) => t.status === "queued").length,
      held: p.journey?.held ?? null,
    };
    const c = p.state.crew;
    if (
      c &&
      c.state === crew.state &&
      c.running === crew.running &&
      c.paused === crew.paused &&
      c.stage === crew.stage &&
      c.lastActiveAt === crew.lastActiveAt &&
      c.queued === crew.queued &&
      (c.held ?? null) === crew.held
    )
      return;
    this.x(p, { crew });
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
    const j = p.journey;
    p.timer = j
      ? setInterval(() => this.journeyTick(p, j), TICK_MS / FLAGS.speed)
      : setInterval(() => this.tick(p), TICK_MS);
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
    if (p.phase === 50) return this.change(p, k);
    if (p.phase === 51) return this.rest(p, k);
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
              ...mockFiles(name, tl.cues, 18_400_000),
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

  /** the rest of a stopped run: each scene animated in turn, a check, the export */
  rest(p: MockProject, k: number) {
    const tl = p.state.timeline;
    const n = tl.scenes.length;
    const per = 4;
    const i = Math.floor(k / per);
    if (i < n && k % per === 0) {
      if (i === 0) this.stage(p, "animate");
      const id = `t_rest_s${i + 1}_${p.seq}`;
      this.setTask(p, id, {
        role: i % 2 ? "scene-coder" : "animator",
        kind: "scene.tune",
        title: `Animating scene ${i + 1} of ${n}`,
        status: "working",
        etaSec: per,
        estUsd: 0.06,
      });
      p.alias.set(`t_rest_s${i + 1}`, id);
      const sc = tl.scenes[i];
      if (sc) this.scene(p, sc.id, { state: "drafting", by: "animator" });
    }
    if (i < n && k % per === per - 1) {
      this.setTask(p, `t_rest_s${i + 1}`, { status: "done" });
      const sc = tl.scenes[i];
      if (sc) this.scene(p, sc.id, { state: "ready", version: "render", stale: false });
    }
    const base = n * per;
    if (k === base) {
      this.stage(p, "sound");
      this.setTask(p, `t_rest_mix_${p.seq}`, {
        role: "sound-designer",
        kind: "sound.mix",
        title: "Mixing",
        status: "working",
        etaSec: 3,
      });
      p.alias.set("t_rest_mix", [...p.state.tasks].reverse().find((t) => t.kind === "sound.mix")?.id ?? "");
    }
    if (k === base + 3) {
      this.setTask(p, "t_rest_mix", { status: "done" });
      this.stage(p, "review");
      this.setTask(p, `t_rest_review_${p.seq}`, {
        role: "reviewer",
        kind: "review.final",
        title: "Checking the cut",
        status: "working",
        etaSec: 3,
      });
      p.alias.set("t_rest_review", [...p.state.tasks].reverse().find((t) => t.kind === "review.final")?.id ?? "");
    }
    if (k === base + 6) {
      this.setTask(p, "t_rest_review", { status: "done", summary: "Nothing to fix." });
      this.stage(p, "deliver");
      this.setTask(p, `t_rest_export_${p.seq}`, {
        role: "editor",
        kind: "deliver.export",
        title: "Encoding the final at 6×",
        status: "working",
        etaSec: 3,
      });
      p.alias.set("t_rest_export", [...p.state.tasks].reverse().find((t) => t.kind === "deliver.export")?.id ?? "");
    }
    if (k === base + 9) {
      this.setTask(p, "t_rest_export", { status: "done", title: "Encoded the final" });
      const name = p.state.doc.delivery[0]?.out ?? "pitch.mp4";
      this.x(p, { files: mockFiles(name, tl.cues, 18_400_000), crew: { state: "idle" } });
      this.milestone(p, "Your video is ready");
      this.digest(p, "The final is encoded with subtitles.");
      p.phase = 99;
    }
  }

  /** a change Pip handed to the crew: reopen Pictures, redo one scene, check it, export again */
  change(p: MockProject, k: number) {
    const tl = p.state.timeline;
    const sc = tl.scenes[1] ?? tl.scenes[0];
    const n = tl.scenes.length;
    // Pip directs: the director re-boards, can't do dialogue, Pip accepts the toast, then the animator and reviewer
    if (k === 0) {
      this.stage(p, "storyboard");
      if (sc) this.scene(p, sc.id, { stale: true, state: "drafting", by: "director" });
      this.say(
        p,
        "pip",
        "director",
        "brief",
        "Re-board scene 2: the hero bigger, and the founder says the tagline.",
        sc?.id,
      );
      const boardId = `t_change_board_${p.seq}`;
      this.setTask(p, boardId, {
        role: "director",
        kind: "director.storyboard",
        title: "Re-boarding scene 2",
        status: "working",
        etaSec: 3,
        estUsd: 0.04,
      });
      p.alias.set("t_change_board", boardId);
    }
    if (k === 2) {
      this.setTask(p, "t_change_board", { status: "done", summary: "Re-boarded scene 2; the line is a toast." });
      this.say(
        p,
        "director",
        "pip",
        "report",
        "Partly done: there's no dialogue recipe, so the founder's line is a toast.",
        sc?.id,
      );
    }
    if (k === 3) {
      this.say(p, "pip", "director", "answer", "Fine: a toast reads well here. Handing it to the animator.");
      this.say(
        p,
        "pip",
        "animator",
        "brief",
        "Scene 2: the hero 25% bigger; keep the toast inside the title-safe box.",
        sc?.id,
      );
      this.stage(p, "animate");
      if (sc) this.scene(p, sc.id, { stale: true, state: "drafting", by: "animator" });
      const changeId = `t_change_${p.seq}`;
      this.setTask(p, changeId, {
        role: "animator",
        kind: "scene.tune",
        title: `Animating scene 2 of ${n}`,
        status: "working",
        etaSec: 8,
        estUsd: 0.2,
      });
      p.alias.set("t_change", changeId);
      this.digest(p, "The animator is redrawing scene 2 with your change.");
    }
    if (k === 8) {
      this.setTask(p, "t_change", { status: "done", summary: "Made the hero bigger in scene 2." });
      this.say(
        p,
        "animator",
        "pip",
        "report",
        "Done: the hero is bigger in scene 2, and the toast sits in the safe box.",
        sc?.id,
      );
      if (sc) this.scene(p, sc.id, { stale: false, state: "ready", version: "render" });
      this.stage(p, "review");
      const changeReviewId = `t_change_review_${p.seq}`;
      this.setTask(p, changeReviewId, {
        role: "reviewer",
        kind: "review.final",
        title: "Checking scene 2",
        status: "working",
        etaSec: 5,
        estUsd: 0.08,
      });
      p.alias.set("t_change_review", changeReviewId);
    }
    if (k === 13) {
      this.say(p, "reviewer", "pip", "report", "Scene 2 reads well; nothing else moved.", sc?.id);
      this.setTask(p, "t_change_review", { status: "done", summary: "Scene 2 reads well; nothing else moved." });
      this.stage(p, "deliver");
      const changeExportId = `t_change_export_${p.seq}`;
      this.setTask(p, changeExportId, {
        role: "editor",
        kind: "deliver.export",
        title: "Encoding the final at 6×",
        status: "working",
        etaSec: 4,
      });
      p.alias.set("t_change_export", changeExportId);
    }
    if (k === 17) {
      this.setTask(p, "t_change_export", { status: "done", title: "Encoded the final", summary: "Exported again." });
      this.x(p, { crew: { state: "idle" }, files: [...p.state.files] });
      this.digest(p, "Your change is in. The new video is ready.");
      this.pip.push(p.state.doc.id, {
        id: `pi_sum_${p.seq}`,
        at: iso(),
        kind: "pip",
        text: "Your change is in: the hero is bigger in scene 2. The founder's line is a toast, since there's no dialogue recipe yet. The new video is ready.",
        cards: [],
      });
      this.milestone(p, "Scene 2 changed");
      p.phase = 99;
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

/** partsOf over the mock's state: its scene statuses in the crew's words (approval and locked are drawn) */
function mockParts(p: MockProject, versions: Version[]): Parts | null {
  const sceneStatus: Record<string, { version: SceneStatus["version"]; state: string }> = {};
  for (const [id, st] of Object.entries(p.state.sceneStatus ?? {}))
    sceneStatus[id] = {
      version: st.version,
      state: st.stale ? "stale" : st.state === "approval" || st.state === "locked" ? "ready" : st.state,
    };
  try {
    return partsOf({
      doc: p.state.doc,
      sceneStatus,
      history: p.history,
      versions,
    });
  } catch {
    return null;
  }
}

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
    const list = [...be().projects.values()].map((mp): ProjectSummary => {
      if (!mp.state.versions) be().syncParts(mp, true);
      const s = mp.state;
      const crew = s.crew?.state ?? "running";
      const running = crew === "running" || crew === "pausing";
      const times = s.tasks.flatMap((t) => [t.startedAt, t.endedAt]).filter((x): x is string => !!x);
      const last = s.versions?.at(-1);
      const mid = s.timeline.scenes[Math.floor(s.timeline.scenes.length / 2)];
      const h = humanStatus(s);
      return {
        id: s.doc.id,
        title: s.doc.title,
        dir: `~/Movies/PixelArtPitch/${s.doc.id}`,
        canTrash: true,
        rev: s.rev,
        stage: s.stage,
        spentUsd: s.budget.spentUsd,
        capUsd: s.budget.capUsd,
        etaSec: running && s.time.etaSec ? (s.time.etaSec[0] + s.time.etaSec[1]) / 2 : null,
        deadline: s.time.deadline,
        needsYou:
          s.questions.filter((q) => q.status === "open").length + s.gates.filter((g) => g.status === "open").length,
        updatedAt: running ? new Date().toISOString() : (times.sort().at(-1) ?? iso(-3 * 3600)),
        running,
        paused: crew === "paused",
        status: { line: h.text, problem: problemOf(s) },
        milestones: s.milestones?.length ?? 0,
        parts: s.parts?.parts.map(({ id, state, done, of }) => ({ id, state, done, of })),
        version: last
          ? { v: last.v, at: last.at, upToDate: s.parts?.parts.find((x) => x.id === "video")?.state === "ready" }
          : null,
        working: [...new Set(s.tasks.filter((t) => t.status === "working").map((t) => t.role))],
        waiting: [...new Set(s.tasks.filter((t) => t.status === "waiting_user").map((t) => t.role))],
        thumb: mid ? this.frameUrl(s.doc.id, (mid.from + mid.to) / 2, 1) : undefined,
      };
    });
    // drafts from /new are listed too (PIP-ORCHESTRATION §4.5), with zeroed fields; status.line is Pip's last words
    const drafts: ProjectSummary[] = [...be().drafts.drafts.values()].map(({ draft: d }) => ({
      id: d.id,
      title: d.title || "New video",
      dir: "",
      rev: 0,
      stage: "brief",
      spentUsd: 0,
      capUsd: 0,
      etaSec: null,
      deadline: null,
      needsYou: 0,
      updatedAt: d.updatedAt,
      createdAt: d.createdAt,
      draft: true,
      status: { line: be().drafts.lastLine(be().pip.conv(d.id).items) },
    }));
    return [...list, ...drafts];
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
    // "Show all options" started a draft: its conversation moves to the project, and the draft goes (no model call)
    if (input.draft && be().drafts.drafts.has(input.draft)) {
      be().pip.move(input.draft, id);
      be().drafts.drafts.delete(input.draft);
    }
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
  /** the mock has no run to report on: a placeholder page that says where the real one comes from */
  reportUrl(id: string) {
    const html = `<!doctype html><meta charset="utf-8"><title>Run report</title><body style="font:16px system-ui;background:#0e1210;color:#e9e6da;padding:2rem"><h1>Run report</h1><p>The mock studio has no run to report on. With the studio server, this page is <code>pap report ${id.replace(/[^a-z0-9_]/gi, "")}</code>: who worked when, what it cost and what failed.</p></body>`;
    return URL.createObjectURL(new Blob([html], { type: "text/html" }));
  }
  frameUrl(id: string, t: number, _scale = 2, rev?: number) {
    const p = be().projects.get(id);
    if (!p) return "";
    return drawFrame(this.frameSpec(p, t, rev));
  }
  /** what the frame at `t` shows: the journey's QuestDay cut, or the older fixtures' night market */
  frameSpec(p: MockProject, t: number, rev?: number): Parameters<typeof drawFrame>[0] {
    const tl = p.state.timeline;
    let i = tl.scenes.findIndex((s) => t >= s.from && t < s.to);
    if (i < 0) i = t <= 0 ? 0 : tl.scenes.length - 1;
    const sc = tl.scenes[i];
    const st = sc ? p.state.sceneStatus?.[sc.id] : undefined;
    const j = p.journey;
    // the journey's film is QuestDay's own cut: its four scenes, its logo toast, the step 10 change on scene 2
    const bigger =
      (!!j?.edited || j?.nodes.find((n) => n.id === "t_tune_s02_r2")?.status === "done") &&
      (rev == null || rev >= p.state.rev);
    const logo =
      !!j && j.opts.logo !== false && p.state.questions.find((q) => q.id === "q_rights")?.answer?.optionId !== "leave";
    return {
      t,
      sceneIndex: i,
      sceneTitle: (sc && SCENE_TITLES[sc.id]) || sc?.id || "",
      version: st?.version ?? "slate",
      variant: j ? (i === 1 && bigger ? 2 : 0) : rev != null && rev < p.state.rev ? 1 : 0,
      // a stale scene (its board changed, not redrawn yet): the server draws empty sky there
      ...(st?.stale && st.version === "render" && rev == null ? { empty: true } : {}),
      ...(j ? { look: "questday" as const, from: sc?.from, to: sc?.to, logo } : {}),
    };
  }
  proxyUrl(id: string) {
    return be().projects.get(id)?.proxy ?? "";
  }
  fileUrl(id: string, name: string) {
    const p = be().projects.get(id);
    // the rough cut's contact sheet, drawn as the server lays it out: one still a second, six columns
    if (p?.journey && name === "contact.png") {
      const tl = p.state.timeline;
      const n = Math.ceil(tl.duration);
      const key = `contact|${p.state.rev}|${JSON.stringify(p.state.sceneStatus ?? {})}`;
      if (p.takes.get("contact.key") !== key) {
        const specs = Array.from({ length: n }, (_, i) => this.frameSpec(p, i + 0.5));
        p.takes.set("contact.png", drawContactSheet(specs));
        p.takes.set("contact.key", key);
      }
    }
    return p?.takes.get(name) ?? "";
  }
  async answer(id: string, qid: string, a: AnswerInput) {
    await wait();
    const b = be();
    const p = b.get(id);
    if (p.journey) {
      b.play(p, p.journey.act({ type: "answer", qid, optionId: a.optionId, ...(a.note ? { note: a.note } : {}) }));
      const q = p.state.questions.find((x) => x.id === qid);
      if (!q) throw new Error("That question is gone.");
      return clone(q);
    }
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
      b.milestone(p, `You picked the script: ${q.options.find((x) => x.id === pick)?.label ?? pick}`);
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
    if (p.journey) {
      // "Change something" at the rough cut goes through the one door (routeNote), as the server's gate path does
      if (v.verdict === "changes")
        b.play(
          p,
          p.journey.act({ type: "gate", gate, verdict: "changes", text: (v.reasons ?? []).join(" "), items: v.items }),
        );
      else b.play(p, p.journey.act({ type: "gate", gate, verdict: "approve" }));
      return clone(p.state.gates.find((g) => g.id === gate) as Gate);
    }
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
    // a project the script left alone (stopped, or never started here): run the rest of it as a short demo
    if (p.phase === 99 && !p.state.files.some((f) => f.kind === "video")) {
      p.phase = 51;
      p.tick = 0;
    }
    be().x(p, { crew: { state: "running" } });
  }
  /** the server's POST …/export: a new mp4 in out/ is the next version (no model calls); 409 while a crew runs */
  async exportVideo(id: string) {
    await wait(400);
    const b = be();
    const p = b.get(id);
    if (crewRunning(p.state))
      throw new ApiError(409, {
        code: "busy",
        message: "the crew is working on this project",
        fix: "wait for it to finish, or pause it",
      });
    const name = p.state.doc.delivery[0]?.out ?? "pitch.mp4";
    const files = mockFiles(name, p.state.timeline.cues, 18_400_000);
    b.x(p, { files: [...p.state.files.filter((f) => !files.some((x) => x.name === f.name)), ...files] });
    b.emit(p, { event: "render", data: { kind: "final", url: files[0].url } });
    return { file: `out/${name}`, v: p.state.versions?.at(-1)?.v ?? 1 };
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
    // Resume lifts a held run too, as the server's does (§1.8)
    const held = p.journey?.hold;
    if (held) b.play(p, p.journey?.act({ type: "key", provider: held.provider }) ?? []);
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
    b.settings = mergeSettings(b.settings, clone(partial));
    return clone(b.settings);
  }
  async saveKey(provider: string) {
    await wait();
    const b = be();
    const pr = b.settings.providers.find((x) => x.id === provider);
    if (pr) pr.hasKey = true;
    b.providerFixed(provider);
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
    be().providerFixed(provider);
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
  async pip(project?: string, opts: { draft?: string } = {}) {
    await wait(80);
    if (opts.draft) {
      be().drafts.get(opts.draft);
      return be().pip.get(opts.draft);
    }
    if (project) be().get(project);
    return be().pip.get(project);
  }
  async pipAsk(project: string | undefined, text: string, opts: { draft?: string; about?: { instance: string } } = {}) {
    const b = be();
    if (opts.draft) {
      b.drafts.get(opts.draft);
      return b.pip.ask(opts.draft, text);
    }
    const p = project ? b.get(project) : null;
    // the journey answers its own two messages (steps 10 and 12); anything else is Pip's usual menu
    if (p?.journey?.handlesAsk(text)) {
      const key = p.state.doc.id;
      b.pip.push(key, { id: `pu_${Date.now().toString(36)}`, at: new Date().toISOString(), kind: "user", text });
      b.pip.send(key, { type: "thinking" });
      b.play(p, p.journey.act({ type: "ask", text, ...(opts.about ? { about: opts.about } : {}) }));
      return { turnId: `turn_${Date.now().toString(36)}` };
    }
    return b.pip.ask(project, text);
  }
  async changesPreview(id: string, body: { gate?: GateId; text: string; items?: string[] }) {
    await wait(160);
    const p = be().projects.get(id);
    const ids = p?.state.timeline.scenes.map((x) => x.id) ?? [];
    const r = routeNote(body.text, body.items ?? [], p?.journey ? ["s01", "s02", "s03", "s04"] : ids);
    return clone(r);
  }
  async build() {
    await wait(40);
    const at = new Date(Date.now() - 3 * 3600_000).toISOString();
    return { webStale: FLAGS.stale, builtAt: at, srcAt: FLAGS.stale ? new Date().toISOString() : at };
  }
  async pipCard(cardId: string, d: PipDecision) {
    await wait(80);
    return be().pip.decide(cardId, d);
  }
  pipSummary(project: string | undefined, text: string) {
    return be().pip.saveSummary(project, text);
  }
  pipContext(project?: string) {
    return be().pip.context(project);
  }
  async instanceLog(id: string, iid: string): Promise<InstanceLog | null> {
    await wait(80);
    const b = be();
    if (!b.projects.has(id)) return null;
    const s = b.get(id).state;
    const instance = s.instances?.find((i) => i.id === iid);
    if (!instance) return null;
    const all = s.instances ?? [];
    const entries: InstanceLogEntry[] = [
      ...s.tasks
        .filter((t) => t.instance === iid)
        .flatMap((t) => (s.activity?.[t.id] ?? []).map((e) => ({ ...e, source: "task" as const, taskId: t.id }))),
      ...msgsOf(instance, b.channels.get(id) ?? [], all).map((msg) => ({
        at: msg.at,
        source: "channel" as const,
        msg,
      })),
    ].sort((a, z) => Date.parse(a.at) - Date.parse(z.at));
    return clone({ instance, entries });
  }
  async planRevisions(id: string): Promise<PlanRevisionSummary[]> {
    await wait(60);
    const b = be();
    return b.projects.has(id) ? clone(b.get(id).journey?.revisions ?? []) : [];
  }
  async channel(project: string) {
    await wait(60);
    return clone(be().channels.get(project) ?? []);
  }
  subscribeWorkspace(on: (e: ServerEvent) => void, onConn?: (s: ConnState) => void) {
    onConn?.("open");
    return be().pip.subscribeWorkspace(on);
  }
  async connections() {
    await wait();
    return clone(be().pip.connections);
  }
  addConnections(json: string) {
    return be().pip.addConnections(json);
  }
  async updateConnection(name: string, patch: { enabled?: boolean; trust?: ConnectionTrust }) {
    await wait();
    return be().pip.updateConnection(name, patch);
  }
  async removeConnection(name: string) {
    await wait();
    be().pip.removeConnection(name);
  }
  testConnection(name: string) {
    return be().pip.testConnection(name);
  }
  // ---- /new (mock/drafts.ts) ----
  async createDraft(from?: string) {
    await wait(120);
    return be().drafts.create(from);
  }
  async draft(id: string) {
    await wait(80);
    const d = be().drafts.get(id).draft;
    return { draft: clone(d), items: clone(be().pip.conv(id).items) as PipItem[] };
  }
  async deleteDraft(id: string) {
    await wait();
    be().drafts.remove(id);
    be().pip.convs.delete(id);
  }
  async removeProject(id: string, opts: { trash?: boolean } = {}) {
    await wait();
    const p = be().projects.get(id);
    if (!p) throw new Error(`no project ${id}`);
    be().projects.delete(id);
    const dir = `~/Movies/PixelArtPitch/${id}`;
    return { dir, trashed: opts.trash ? `~/.pixelartpitch/trash/${id}` : null };
  }
  async draftFile(id: string, name: string, body: Blob): Promise<{ ref: DraftRef }> {
    await wait(200);
    return { ref: be().drafts.addFile(id, name, body) };
  }
  async draftRef(id: string, name: string, patch: { type?: RefType; rights?: DraftRef["rights"] }) {
    await wait(60);
    return be().drafts.patchRef(id, name, patch);
  }
  async draftFields(id: string, fields: Draft["fields"]) {
    await wait(60);
    return be().drafts.setFields(id, fields);
  }
  async draftComposer(id: string) {
    await wait(60);
    return be().drafts.composer(id);
  }
  async workspaceLine(): Promise<WorkspaceLine> {
    await wait(60);
    const rows = [...be().projects.values()].map(({ state: s }) => {
      const video = s.files.some((f) => f.kind === "video");
      const ready = s.milestones?.find((m) => m.text === "Your video is ready");
      const needs =
        s.questions.filter((q) => q.status === "open").length + s.gates.filter((g) => g.status === "open").length;
      const crew = s.crew?.state ?? "idle";
      return {
        id: s.doc.id,
        title: s.doc.title,
        finishedAt: video ? Date.parse(ready?.at ?? "") || Date.now() : undefined,
        working:
          !video && !needs && (crew === "running" || crew === "pausing") ? `at ${STAGE_WORD[s.stage]}` : undefined,
        waiting: needs || undefined,
      };
    });
    return MockDrafts.line(rows);
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
