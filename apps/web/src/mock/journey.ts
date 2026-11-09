// The journey "todo" (docs/PIP-JOURNEY.md §6): "Make a 30-second pitch for my todo app", from Start to the final cut,
// as the server would stream it. It is data (the plan's tasks, their length in ticks, what each one reports and the
// revisions it triggers) played by a small deterministic executor: slots, the ghost horizon (PIP-ORCHESTRATION §2)
// and the instance fold. No clock, no Math.random, ids from counters. MockClient plays it with timers and the
// person's presses; apps/web/test/journey.test.ts plays it in node with `auto` and checks the checkpoint table.
// Node runs this file directly: type-only imports, plus the node-safe activity beats and fixtures.
import type {
  ChannelMsg,
  FileRow,
  Instance,
  InstanceChange,
  Milestone,
  PipCard,
  PipFile,
  PipItem,
  PlanGate,
  PlanRevisionSummary,
  PlanTaskStatus,
  PlanTaskView,
  PlanView,
  QuestionT,
  Role,
  ServerEvent,
  Stage,
  Task,
} from "../lib/types.ts";
import { closing, middle, opening } from "./activity.ts";
import { ROLE_MODELS } from "./fixtures.ts";

// ---- the flags (read once at boot) ----
/**
 * `scenario=…` plays one of the P4 run's situations on top of the journey, with the server's own card and status shapes
 * (PIP-JOURNEY §6): `revision` (a plan change past 20%, held for a card), `overrun` (the cap is $1.50: at 80% the "Finish
 * within" and "Raise the cap" pair), `publish` (the Librarian asks to add the founder to the library), `keyfail` (the
 * founder's draw gets a rejected key: the run holds until a key is saved or tested, and the founder's face is stuck)
 */
export const SCENARIOS = [
  "revision",
  "overrun",
  "publish",
  "keyfail",
  // v0.3 (the P5 run's fixes)
  "hold",
  "holdcard",
  "g3director",
  "drawer",
  "sheet",
  "pipkey",
  // v0.5.2 (the change router)
  "edits",
] as const;
export type Scenario = (typeof SCENARIOS)[number];
/** the waits a scenario adds: `auto=1` never answers them (the run stops there for you, and for a screenshot) */
const SCENARIO_WAITS = new Set([
  "card:c_rev",
  "card:c_finish",
  "answer:q_publish",
  "key:anthropic",
  "answer:q_hold",
  "card:c_hold",
]);
/** a scenario that stops at one of the journey's own moments, so it can be looked at: the G1 pick (asks in the crew
 * drawer), the rough cut (the contact sheet, a change routed to the Director, Pip's rejected key) */
const STOPS_AT: Partial<Record<Scenario, string>> = {
  drawer: "answer:q_angle",
  sheet: "gate:g3_rough",
  g3director: "gate:g3_rough",
  pipkey: "gate:g3_rough",
  edits: "gate:g3_rough",
};
/** the `edits` scenario's second message: the time of day, a rule edit Pip offers on a free card */
export const DAYTIME = "make it in daytime";
/** the cap the `overrun` scenario sets, so the 80% line falls inside the run */
export const OVERRUN_CAP = 1.5;
export type JourneyFlags = {
  speed: number;
  slots: number;
  auto: boolean;
  scenario?: Scenario | null;
  /** the review writes a playable rough cut (out/proxy.mp4, with sound); `proxy=0` plays an older server without */
  proxy?: boolean;
};
export function journeyFlags(search: string): JourneyFlags {
  const q = new URLSearchParams(search);
  const num = (k: string, d: number, lo: number, hi: number) => {
    const n = Number(q.get(k));
    return Number.isFinite(n) && n >= lo && n <= hi && q.get(k) !== null ? n : d;
  };
  const sc = q.get("scenario");
  return {
    speed: num("speed", 1, 0.1, 100),
    slots: Math.round(num("slots", 3, 1, 8)),
    auto: q.get("auto") === "1",
    scenario: (SCENARIOS as readonly string[]).includes(sc ?? "") ? (sc as Scenario) : null,
    proxy: q.get("proxy") !== "0",
  };
}

// ---- one door for changes (the server's routeChange, dry): who a note goes to and what it costs ----
/** what a change costs in the mock: the Director's re-board, each scene's re-tune, and the review after */
export const CHANGE_USD = { reboard: 0.06, tune: 0.05, review: 0.03 } as const;
const DIRECTOR_WORDS =
  /\b(cast|character|who|owl|moth|cat|founder|hero|sprite|staging|stage|position|place|sit|sits|stand|fly|flies|walk|backdrop|background|sky|roof|rooftop|lantern|glow|text card|title card|end card|logo|recipe|scene order|order of the scenes)\b/i;
export type RoutedNote = {
  role: Role;
  roles: Role[];
  scenes: string[];
  usd: [number, number];
  sec: [number, number];
  summary: string;
};
/**
 * The route a note takes (the server's routeChange): cast, staging, recipes, the backdrop, text cards and the end card
 * go to the Director, who re-boards and hands the scenes on; timing and motion inside a scene go to the Animator. The
 * scenes are the ticked ones, else the ones the note names ("scene 3", "the end card"), else every scene.
 */
export function routeNote(text: string, items: string[] = [], sceneIds: readonly string[] = SCENES): RoutedNote {
  const all = [...sceneIds];
  const named = new Set<string>();
  for (const it of items) {
    const m = it.match(/(\d+)/);
    if (m && all[Number(m[1]) - 1]) named.add(all[Number(m[1]) - 1]);
    if (all.includes(it)) named.add(it);
  }
  for (const m of text.matchAll(/\bscenes?\s+(\d+)/gi)) if (all[Number(m[1]) - 1]) named.add(all[Number(m[1]) - 1]);
  if (/\bend card\b/i.test(text) && all.length) named.add(all[all.length - 1]);
  const scenes = named.size ? all.filter((x) => named.has(x)) : all;
  const director = DIRECTOR_WORDS.test(text);
  const role: Role = director ? "director" : "animator";
  const usd = +((director ? CHANGE_USD.reboard : 0) + scenes.length * CHANGE_USD.tune + CHANGE_USD.review).toFixed(2);
  const where =
    scenes.length === all.length
      ? "every scene"
      : scenes.length === 1
        ? `scene ${all.indexOf(scenes[0]) + 1}`
        : `scenes ${scenes.map((x) => all.indexOf(x) + 1).join(" and ")}`;
  const summary = director
    ? `The Director re-boards ${where}, then the Animator redoes ${scenes.length === 1 ? "it" : "them"} and the Reviewer checks`
    : `The Animator redoes the motion in ${where}, then the Reviewer checks`;
  return {
    role,
    roles: director ? ["director", "animator", "reviewer"] : ["animator", "reviewer"],
    scenes,
    usd: [usd, +(usd * 1.3).toFixed(2)],
    sec: [60 + scenes.length * 30, 120 + scenes.length * 45],
    summary,
  };
}

// ---- the run's fixed facts (the roster, §2) ----
export const JOURNEY = {
  projectId: "questday_pitch",
  title: "QuestDay pitch",
  idea: "A 30 s pitch for QuestDay, my todo app that turns tasks into quests.",
  /** the step 2 message, typed by `auto` */
  say: "a 30 s pitch for QuestDay, my todo app that turns tasks into quests. no voice. keep it under $3",
  logo: "questday-logo.png",
  capUsd: 3,
  /** the brief card's estimate: rev 0's p50/p90 (the new drawing's placeholder priced in) */
  estUsd: [1.4, 2.2] as [number, number],
  estSec: [600, 900] as [number, number],
  /** the step 10 message, typed by `auto` */
  change: "make the hero bigger in scene 2",
  /** the step 12 question */
  why: "why did you add a Pixel artist?",
  /** Pip's six metered turns on the project: the revision after Start, the answer to scene 3, the rough cut, the
   * change card, the export, the why */
  pipTurnUsd: 0.02,
} as const;

/** the scenes, by position: "s01" is scene 1 */
const SCENES = ["s01", "s02", "s03", "s04"] as const;

type Hook = (sim: Journey, n: Node) => void;
type Node = {
  id: string;
  kind: string;
  role: Role | "person";
  /** "" for gates */
  instance: string;
  gate?: PlanGate;
  scene?: string;
  asset?: string;
  round?: number;
  stage: Stage;
  deps: string[];
  /** how many ticks it runs, per attempt */
  ticks: number;
  /** what it spends in all (a retry's share included) */
  usd: number;
  est: [number, number];
  conditional: boolean;
  status: PlanTaskStatus;
  addedIn: number;
  reason?: string;
  /** the task row's title */
  title: string;
  elapsed: number;
  attempt: number;
  taskId: string | null;
  startedAt: string | null;
  /** runs at the start of each of its ticks (elapsed counts from 1) */
  during?: (sim: Journey, n: Node, elapsed: number) => void;
  done?: Hook;
  /** the question its member asks the person when its work is done: the member stays (needs you) until answered */
  asks?: (at: string) => QuestionT;
  /** the task row's title while it waits on the person */
  asking?: string;
};
type Meta = {
  id: string;
  role: Role;
  label: string;
  subject?: { scene?: string; asset?: string };
  reason: string;
  spawnedAt: string | null;
  endedAt: string | null;
  lives: { from: string; to: string | null; reason?: string }[];
  lastReport?: Instance["lastReport"];
  endReason?: string;
  /** the question it is waiting on the person for, and the task that asked */
  asking?: { qid: string; node: Node } | null;
  /** plan order of its first task */
  order: number;
};

const ROLE_WORD: Record<string, string> = {
  writer: "Writer",
  director: "Director",
  "art-director": "Art director",
  "pixel-artist": "Pixel artist",
  animator: "Animator",
  mixer: "Mixer",
  reviewer: "Reviewer",
  editor: "Editor",
  librarian: "Librarian",
};
export const labelOf = (instance: string): string => {
  const [role, sub] = instance.split(":");
  const word = ROLE_WORD[role] ?? role;
  if (!sub) return word;
  const scene = sub.match(/^s0*(\d+)$/);
  return `${word} · ${scene ? `scene ${scene[1]}` : sub}`;
};

/** where a gate waits on the person under "Only the key picks" (Decision 2); the rest pass in code */
const PERSON_GATES = new Set<PlanGate>(["g1_script", "rights", "g3_rough"]);
const isGate = (n: Node) => n.kind === "gate";

export type JourneyAction =
  | { type: "answer"; qid: string; optionId?: string; note?: string }
  /** a provider's key was saved, or its test passed: a run held on it goes on (§1.8) */
  | { type: "key"; provider: string }
  /** `changes` at G3 carries the person's note and the ticked scenes */
  | { type: "gate"; gate: PlanGate; verdict: "approve" | "changes"; text?: string; items?: string[] }
  | { type: "card"; cardId: string; decision: "confirm" | "decline" }
  | { type: "ask"; text: string; about?: { instance: string } };
/** what the run waits on: `card:<id>`, `answer:<qid>`, `gate:<id>`, `ask:<text>`, `key:<provider>` (§6) */
export type Wait = string;

export type JourneyOpts = JourneyFlags & {
  /** ms since the epoch at tick 0; every timestamp is base + tick × 1000 ÷ speed */
  base: number;
  /** the project's timeline scene ids, by position (for sceneStatus) */
  sceneIds?: string[];
  /** the files the export writes (blob URLs in the browser, nothing in node) */
  files?: () => { rows: FileRow[]; pip: PipFile[] };
  /** the logo as a 16×16 icon (a data URL in the browser) */
  logoIcon?: string;
  /** the draft had a logo: the import, the `rights` pick and the logo toast are planned only then (default true) */
  logo?: boolean;
  /** the project's cap (the `overrun` scenario's is OVERRUN_CAP) */
  capUsd?: number;
  /** the rough cut with sound, as the review writes it (a blob URL in the browser; nothing in node) */
  proxyUrl?: () => string;
};
/** what the server's `status` says while a scenario holds the run or waits on a card (the mock sends it as is) */
export type JourneyStatus = {
  line: string;
  problem?: { text: string; action: "fix_key" | "retry"; taskId: string; provider?: string };
  waiting?: "plan" | "budget";
};
/** the server's pausedLine: Pip's channel line for a hold, as a plain sentence */
export function pausedLine(why: string): string {
  const w = why.trim().replace(/^Waiting for you: /, "");
  const low = /^(Your|The|A|An|This|It|Every|No)\b/.test(w) ? w.charAt(0).toLowerCase() + w.slice(1) : w;
  return `Paused the crew: ${/[.?!]$/.test(low) ? low : `${low}.`}`;
}
const money = (n: number) => `$${n < 1 ? n.toFixed(2) : n.toFixed(2).replace(/\.00$/, "")}`;

export class Journey {
  readonly opts: JourneyOpts;
  nodes: Node[] = [];
  metas = new Map<string, Meta>();
  rev = 0;
  tick = 0;
  spent = 0;
  out: ServerEvent[] = [];
  /** the last instance views sent, to diff against */
  sent = new Map<string, Instance>();
  waits = new Map<Wait, number>();
  stageNow: Stage = "brief";
  /** the G3 press under "key" passes G4 too (Decision 2) */
  finalApproved = false;
  /** how far `auto` has come: the G3 opens it has seen */
  g3Opens = 0;
  ended = false;
  private n = { task: 0, pip: 0, ch: 0, m: 0 };
  /** the scenario's status while it holds or waits; null: the client derives the line as usual */
  statusNow: JourneyStatus | null = null;
  /** `crew.held`: the run is held for the person, and why */
  held: string | null = null;
  /** a provider failure holds the run: nothing new starts until that provider is fixed */
  hold: { provider: string } | null = null;
  /** the budget question is open: nothing new starts until it is answered */
  budgetWait = false;
  /** Pip holds the run on a partial cast (the `hold` scenarios): nothing new starts until q_hold or c_hold answers */
  pipHold = false;
  private holdAt = -1;
  private holdAnswered = false;
  private overrunAsked = false;
  /** "Finish within" was chosen: the second review round is left out */
  private trimmed = false;
  /** a revision past the 20% line holds its tasks until its card is answered */
  pending: { rev: number; cardId: string; tasks: string[] } | null = null;
  private est: [number, number] = [...JOURNEY.estUsd];
  private approved: number = JOURNEY.estUsd[0];
  cap: number;

  constructor(opts: JourneyOpts) {
    this.opts = opts;
    this.cap = opts.capUsd ?? JOURNEY.capUsd;
  }

  at(): string {
    return new Date(this.opts.base + (this.tick * 1000) / this.opts.speed).toISOString();
  }
  private emit(e: ServerEvent) {
    this.out.push(e);
  }
  private flush(): ServerEvent[] {
    const o = this.out;
    this.out = [];
    return o;
  }
  node(id: string): Node {
    const n = this.nodes.find((x) => x.id === id);
    if (!n) throw new Error(`no plan task ${id}`);
    return n;
  }

  // ---- building the plan ----
  private add(
    n: Omit<
      Node,
      "status" | "elapsed" | "attempt" | "taskId" | "startedAt" | "addedIn" | "conditional" | "est" | "ticks" | "usd"
    > &
      Partial<Pick<Node, "conditional" | "est" | "ticks" | "usd">>,
    reason?: string,
  ) {
    const node: Node = {
      ticks: 0,
      usd: 0,
      est: [n.usd ?? 0, (n.usd ?? 0) * 1.5],
      conditional: false,
      ...n,
      status: "pending",
      elapsed: 0,
      attempt: 1,
      taskId: null,
      startedAt: null,
      addedIn: this.rev,
    };
    this.nodes.push(node);
    if (node.instance && !this.metas.has(node.instance)) {
      const [role, sub] = node.instance.split(":");
      this.metas.set(node.instance, {
        id: node.instance,
        role: role as Role,
        label: labelOf(node.instance),
        ...(sub ? { subject: node.scene ? { scene: node.scene } : { asset: sub } } : {}),
        reason: reason ?? node.reason ?? "",
        spawnedAt: null,
        endedAt: null,
        lives: [],
        order: this.nodes.length,
      });
    }
    return node;
  }
  private gate(id: string, gate: PlanGate, stage: Stage, deps: string[]) {
    return this.add({ id, kind: "gate", role: "person", instance: "", gate, stage, deps, title: gate });
  }

  /** rev 0: the rules skeleton after G0, with the scenes expected for 30 s (the server's first plan is rev 0, N26);
   * the new drawing is a placeholder until the cast says what it is (it has no face) */
  private rulesPlan() {
    this.rev = 0;
    this.gate("g0", "g0_brief", "brief", []).status = "done";
    this.add({
      id: "t_write",
      kind: "writer.angles",
      role: "writer",
      instance: "writer",
      stage: "script",
      deps: ["g0"],
      ticks: 5,
      usd: 0.22,
      title: "Writing three script angles",
      reason: "Pip brought in the Writer for three script angles",
      asks: Q_ANGLE,
      asking: "Waiting for you to pick an angle",
    });
    const logo = this.opts.logo !== false;
    if (logo)
      this.add({
        id: "t_import",
        kind: "asset.import",
        role: "art-director",
        instance: "art-director",
        asset: "logo",
        stage: "storyboard",
        deps: ["g0"],
        ticks: 1,
        usd: 0,
        title: "Bringing in your logo as a 16 px icon",
        reason: "Pip brought in the Art director to bring in your logo",
        asks: Q_RIGHTS,
        asking: "Waiting for your OK on the logo",
      });
    this.gate("g1", "g1_script", "script", ["t_write"]);
    if (logo) this.gate("rights", "rights", "storyboard", ["t_import"]);
    this.add({
      id: "t_board",
      kind: "director.storyboard",
      role: "director",
      instance: "director",
      stage: "storyboard",
      deps: logo ? ["g1", "t_import"] : ["g1"],
      ticks: 5,
      usd: 0.18,
      title: "Storyboarding 4 scenes",
      reason: "Pip brought in the Director to board 4 scenes",
      done: (s) => s.scenes("board"),
    });
    this.add({
      id: "t_cast",
      kind: "art.cast",
      role: "art-director",
      instance: "art-director",
      stage: "storyboard",
      deps: ["t_board"],
      ticks: 3,
      usd: 0,
      title: "Casting from the library",
      during: (s, _n, k) => {
        if (k === 2) s.castFindsNoFounder();
      },
    });
    this.gate("g2", "g2_animatic", "storyboard", ["t_cast"]);
    const tune: Record<string, { ticks: number; usd: number; deps: string[] }> = {
      s01: { ticks: 4, usd: 0.14, deps: ["g2"] },
      s02: { ticks: 5, usd: 0.12, deps: ["g2"] },
      s03: { ticks: 3, usd: 0.19, deps: ["g2"] },
      // the end card carries the logo toast only when there is a logo
      s04: { ticks: 6, usd: 0.12, deps: logo ? ["g2", "rights"] : ["g2"] },
    };
    SCENES.forEach((sc, i) => {
      this.add({
        id: `t_tune_${sc}`,
        kind: "scene.tune",
        role: "animator",
        instance: `animator:${sc}`,
        scene: sc,
        round: 1,
        stage: "animate",
        deps: tune[sc].deps,
        ticks: tune[sc].ticks,
        usd: tune[sc].usd,
        title: `Animating scene ${i + 1} of 4`,
        reason: `Pip brought in an Animator for scene ${i + 1}`,
        during:
          sc === "s03"
            ? (s, n, k) => {
                if (k === 3 && n.attempt === 1) s.sceneThreeHitsAWall(n);
              }
            : undefined,
        done: (s) => s.scene(sc, "render"),
      });
    });
    this.add({
      id: "t_mix",
      kind: "sound.mix",
      role: "mixer",
      instance: "mixer",
      stage: "sound",
      deps: SCENES.map((sc) => `t_tune_${sc}`),
      ticks: 3,
      usd: 0.1,
      title: "Mixing music and sound",
      reason: "Pip brought in the Mixer for music and sound",
    });
    this.add({
      id: "t_review_r1",
      kind: "review.final",
      role: "reviewer",
      instance: "reviewer",
      round: 1,
      stage: "review",
      deps: ["t_mix"],
      ticks: 3,
      usd: 0.08,
      title: "Checking the cut",
      reason: "Pip brought in the Reviewer to check the cut",
      done: (s) => s.reviewFindsTheHeadline(),
    });
    this.gate("g3", "g3_rough", "review", ["t_review_r1"]);
    this.add({
      id: "t_export",
      kind: "deliver.export",
      role: "editor",
      instance: "editor",
      stage: "deliver",
      deps: ["g3"],
      ticks: 4,
      usd: 0,
      title: "Exporting your video",
      reason: "Pip brought in the Editor to export the video",
      done: (s) => s.exported(),
    });
    this.gate("g4", "g4_final", "deliver", ["t_export"]);
  }

  // ---- the plan as the wire sees it ----
  view(): PlanView {
    const tasks: PlanTaskView[] = this.nodes.map((n) => ({
      id: n.id,
      kind: n.kind,
      role: n.role,
      ...(n.gate ? { gate: n.gate } : {}),
      ...(n.scene ? { scene: n.scene } : {}),
      ...(n.asset ? { asset: n.asset } : {}),
      ...(n.round ? { round: n.round } : {}),
      instance: n.instance,
      label: n.instance ? labelOf(n.instance) : n.id,
      stage: n.stage,
      dependsOn: [...n.deps],
      tier: "role",
      model: n.role === "person" ? null : (ROLE_MODELS[n.role] ?? null),
      estUsd: n.est,
      conditional: n.conditional,
      status: n.status,
      taskIds: n.taskId ? [n.taskId] : [],
      addedIn: n.addedIn,
      ...(n.reason ? { reason: n.reason } : {}),
    }));
    return {
      rev: this.rev,
      at: this.at(),
      by: this.revBy,
      reason: this.revReason,
      tasks,
      estimate: { usd: [...this.est], sec: JOURNEY.estSec, rough: true },
      approvedUsd: this.approved,
      pip: { mode: "on", proposals: 0, max: 6 },
      ...(this.pending ? { pending: { ...this.pending, tasks: [...this.pending.tasks] } } : {}),
    };
  }
  revBy: PlanView["by"] = "rules";
  /** every revision, oldest first (GET /api/p/:id/plan/revisions) */
  revisions: PlanRevisionSummary[] = [];
  revReason = "The rules plan for a 30 s pitch";
  private revision(by: PlanView["by"], trigger: string, reason: string, ops: PlanRevisionSummary["ops"], d: number) {
    this.rev++;
    this.revBy = by;
    this.revReason = reason;
    const revision: PlanRevisionSummary = { rev: this.rev, at: this.at(), by, trigger, reason, ops, deltaUsd: [d, d] };
    this.revisions.push(revision);
    this.emit({ event: "plan", data: { view: this.view(), revision } });
    this.milestone(`Plan changed: ${reason.charAt(0).toLowerCase()}${reason.slice(1)}`);
  }

  // ---- what the run says ----
  milestone(text: string) {
    const m: Milestone = { id: `m_${++this.n.m}`, at: this.at(), text, kind: "plan" };
    this.emit({ event: "milestone", data: m });
  }
  channel(from: string, to: string, kind: ChannelMsg["kind"], text: string, ref?: string) {
    const m: ChannelMsg = { id: `ch_${++this.n.ch}`, at: this.at(), from, to, kind, text, ...(ref ? { ref } : {}) };
    this.emit({ event: "channel", data: m });
  }
  pip(text: string, cards: PipCard[] = [], metered = true) {
    const item: PipItem = { id: `pip_${++this.n.pip}`, at: this.at(), kind: "pip", text, cards, model: "mock" };
    this.emit({ event: "pip", data: { type: "item", item } });
    if (metered) this.spend(JOURNEY.pipTurnUsd, "assistant", ROLE_MODELS.assistant);
  }
  private spend(usd: number, role: Role, model: string) {
    if (!usd) return;
    this.spent = +(this.spent + usd).toFixed(4);
    this.emit({ event: "ledger", data: { usd, spentUsd: this.spent, reservedUsd: 0, model, role } });
  }
  question(q: QuestionT) {
    this.emit({ event: "question", data: q });
    this.waits.set(`answer:${q.id}`, this.tick);
  }
  scene(sc: string, version: "board" | "render") {
    const ids = this.opts.sceneIds ?? [];
    const id = ids[SCENES.indexOf(sc as (typeof SCENES)[number])];
    if (!id) return;
    this.sceneStatus = {
      ...this.sceneStatus,
      [id]: { version, stale: false, state: version === "render" ? "ready" : "planned", by: "animator" },
    };
    this.emit({ event: "x-state", data: { sceneStatus: this.sceneStatus } });
  }
  scenes(version: "board" | "animatic") {
    const ids = this.opts.sceneIds ?? [];
    this.sceneStatus = Object.fromEntries(
      ids.map((id) => [id, { version, stale: false, state: "planned" as const, by: "director" as Role }]),
    );
    if (ids.length) this.emit({ event: "x-state", data: { sceneStatus: this.sceneStatus } });
  }
  sceneStatus: Record<
    string,
    { version: "board" | "animatic" | "render"; stale: boolean; state: "planned" | "ready"; by: Role }
  > = {};

  // ---- the moments (§4) ----
  /** 7b: the cast finds no founder sprite; code expands the new-art placeholder into one drawing (rev 1) */
  castFindsNoFounder() {
    const ad = this.metas.get("art-director");
    if (ad) ad.lastReport = { status: "partial", did: "Cast 6 sprites from the library", couldnt: "No founder sprite" };
    this.channel("art-director", "pip", "report", "No founder sprite in the library.", "t_cast");
    // a partial holds the run, and the hold always asks (v0.3): Pip's question with three answers
    if (this.opts.scenario === "hold" || this.opts.scenario === "holdcard") return this.holdForCast();
    this.expandFounder();
  }
  /** rev 1: code expands the new-art placeholder into one drawing (the library had no founder sprite) */
  private expandFounder(by: PlanView["by"] = "code") {
    const reason = "Added a Pixel artist for the founder: the library had no founder sprite.";
    const draw = this.add(
      {
        id: "t_draw_founder",
        kind: "asset.draw",
        role: "pixel-artist",
        instance: "pixel-artist:founder",
        asset: "founder",
        stage: "art",
        deps: ["g2"],
        ticks: 4,
        usd: 0.31,
        title: "Drawing founder variants",
        reason: "Pip brought in a Pixel artist for the founder",
        during:
          this.opts.scenario === "keyfail"
            ? (s, n, k) => {
                if (k === 2 && n.attempt === 1) s.keyRejected(n);
              }
            : undefined,
        done: this.opts.scenario === "publish" ? (s) => s.askToPublish() : undefined,
      },
      "Pip brought in a Pixel artist for the founder",
    );
    // the founder walks in scenes 1–3; the end card doesn't need it
    for (const sc of ["s01", "s02", "s03"]) this.node(`t_tune_${sc}`).deps.push(draw.id);
    // plan order is dependency order: the drawing goes before the scenes that wait on it
    this.nodes.splice(this.nodes.indexOf(draw), 1);
    this.nodes.splice(this.nodes.indexOf(this.node("t_tune_s01")), 0, draw);
    const meta = this.metas.get(draw.instance);
    if (meta) meta.order = (this.metas.get("animator:s01")?.order ?? meta.order) - 0.5;
    const ops: PlanRevisionSummary["ops"] = [
      { op: "expand", task: draw.id, label: labelOf(draw.instance), reason: "The library had no founder sprite." },
    ];
    if (this.opts.scenario !== "revision") {
      this.revision(by, "expand", reason, ops, 0);
      return;
    }
    // past 20% over what was approved: the drawing waits for the person's OK (orch planRevise → Pip.revisionCard)
    const from = this.approved;
    this.est = [1.95, 2.9];
    this.pending = { rev: this.rev + 1, cardId: "c_rev", tasks: [draw.id] };
    this.revision("code", "expand", reason, ops, 0.55);
    const card: Extract<PipCard, { type: "plan" }> = {
      id: "c_rev",
      type: "plan",
      title: `Plan change: ${money(from)} → about ${money(this.est[0])}`,
      detail: reason,
      who: ["pixel-artist"],
      whoInstances: [{ instance: draw.instance, label: labelOf(draw.instance) }],
      usd: [0.55, 0.7],
      sec: null,
      // the server lists no expand op, and scene 4 can still run: "everything else keeps running"
      effects: ["Everything else keeps running while you decide."],
      confirmLabel: "Go ahead",
      revision: { rev: this.rev, ops, fromUsd: from, toUsd: this.est[0], planner: "director" },
      status: "proposed",
    };
    this.cards.set(card.id, card);
    this.pip(`The plan grew past what you approved: ${reason}`, [card], false);
    this.waits.set(`card:${card.id}`, this.tick);
    this.statusNow = { line: "Waiting for you: the plan change in Pip's thread", waiting: "plan" };
  }

  // ---- the scenarios (P4's situations, with the server's shapes) ----
  /** hold, holdcard: the cast is partly done; Pip holds the run and asks (holdFor), so Needs you is never 0 */
  private holdForCast() {
    this.pipHold = true;
    this.holdAt = this.tick;
    this.held = "The cast is partly done: no founder sprite in the library";
    this.statusNow = { line: "Waiting for you: Pip's question about the founder" };
    this.channel("pip", "crew", "brief", pausedLine("no founder sprite in the library"), "t_cast");
    this.question(Q_HOLD(this.at()));
    this.pip(
      "The cast is partly done: the library has no founder sprite. I paused the crew until you choose how to go on.",
      [],
      false,
    );
  }
  /** the hold's answer: the crew goes on with it ("Redo with the Director" draws the founder, "Accept the look" goes
   * on with a stand-in; "Tell Pip what to change" keeps the hold for your note) */
  private answerHold(optionId: string, note?: string) {
    this.holdAnswered = true;
    if (optionId === "tell" && note) {
      // as the server: the note is routed (the cast is the Director's), the hold lifts and the change runs
      this.liftPipHold();
      this.channel("pip", "director", "brief", note.slice(0, 200), "t_cast");
      this.pip(`Sent your note to the Director: "${note.slice(0, 120)}". The crew goes on with it.`, [], false);
      this.expandFounder("person");
      return;
    }
    this.liftPipHold();
    if (optionId === "redo") this.expandFounder("pip");
    else this.channel("pip", "art-director", "answer", "Go on with the stand-in for the founder.", "t_cast");
  }
  private liftPipHold() {
    this.pipHold = false;
    this.held = null;
    this.statusNow = null;
    this.waits.delete("ask:hold");
    this.channel("pip", "crew", "brief", "Back to work: the hold is lifted.");
  }
  /** holdcard: a Pip card confirmed during a hold applies now: it closes the hold's question and the run goes on */
  private decideHoldCard(c: Extract<PipCard, { type: "plan" }>, decision: "confirm" | "decline") {
    if (decision === "decline") {
      this.setCard({ ...c, status: "declined" });
      return;
    }
    if (!this.holdAnswered) {
      this.holdAnswered = true;
      this.emit({ event: "question", data: { ...Q_HOLD(this.at()), status: "withdrawn" } });
    }
    this.waits.delete("answer:q_hold");
    this.liftPipHold();
    this.setCard({
      ...c,
      status: "done",
      result: { text: "Started now: the Director re-plans the cast with your note." },
    });
    this.expandFounder("pip");
  }
  /** the review writes a playable rough cut with sound (out/proxy.mp4), and says so (render {kind: "proxy"}) */
  private proxyOut() {
    if (this.opts.proxy === false) return;
    const url = this.opts.proxyUrl?.();
    if (url) this.emit({ event: "render", data: { kind: "proxy", url } });
  }
  /** "Change something" at G3, routed as the server routes it (one door): the Director for cast and staging, the
   * Animator for motion; the estimate the card showed is the revision's delta */
  private gateChange(text: string, items: string[]) {
    const g3 = this.node("g3");
    g3.status = "pending";
    this.emit({ event: "gate", data: { id: "g3_rough", status: "locked", items: GATE_ITEMS.g3_rough } });
    this.waits.delete("gate:g3_rough");
    const r = routeNote(text, items);
    const k = ++this.changes;
    // the scenes the change reopens go stale until they are redrawn (the server's frame there is empty sky)
    const ids = this.opts.sceneIds ?? [];
    for (const sc of r.scenes) {
      const id = ids[SCENES.indexOf(sc as (typeof SCENES)[number])];
      const cur = id ? this.sceneStatus[id] : undefined;
      if (id && cur) this.sceneStatus = { ...this.sceneStatus, [id]: { ...cur, stale: true } };
    }
    if (ids.length) this.emit({ event: "x-state", data: { sceneStatus: this.sceneStatus } });
    const ops: PlanRevisionSummary["ops"] = [];
    let after: string[] = [];
    if (r.role === "director") {
      const board = this.add({
        id: `t_reboard_${k}`,
        kind: "director.reboard",
        role: "director",
        instance: "director",
        stage: "storyboard",
        deps: [],
        ticks: 3,
        usd: CHANGE_USD.reboard,
        est: [CHANGE_USD.reboard, CHANGE_USD.reboard * 1.3],
        title: "Re-boarding with your note",
      });
      ops.push({ op: "add", task: board.id, label: labelOf("director"), reason: cap(text) });
      after = [board.id];
      this.reviveReason.set("director", "Pip brought the Director back to re-board with your note");
    }
    const tunes = r.scenes.map((sc) => {
      const i = SCENES.indexOf(sc as (typeof SCENES)[number]);
      const t = this.add({
        id: `t_tune_${sc}_c${k}`,
        kind: "scene.tune",
        role: "animator",
        instance: `animator:${sc}`,
        scene: sc,
        round: 2 + k,
        stage: "animate",
        deps: after,
        ticks: 2,
        usd: CHANGE_USD.tune,
        est: [CHANGE_USD.tune, CHANGE_USD.tune * 1.3],
        title: `Animating scene ${i + 1} of 4, your change`,
        done: (s) => s.scene(sc, "render"),
      });
      this.reviveReason.set(t.instance, `Pip brought the Animator back for your change in scene ${i + 1}`);
      ops.push({ op: "add", task: t.id, label: labelOf(t.instance), reason: cap(text) });
      return t.id;
    });
    const review = this.add({
      id: `t_review_c${k}`,
      kind: "review.final",
      role: "reviewer",
      instance: "reviewer",
      round: 3 + k,
      stage: "review",
      deps: tunes,
      ticks: 2,
      usd: CHANGE_USD.review,
      est: [CHANGE_USD.review, CHANGE_USD.review * 1.3],
      title: "Checking your change",
      done: (s) => s.pip("The rough cut is ready again, with your change.", [], false),
    });
    ops.push({ op: "add", task: review.id, label: labelOf("reviewer"), reason: "Check the change." });
    this.reviveReason.set("reviewer", "Pip brought the Reviewer back to check your change");
    g3.deps = [review.id];
    this.est = [+(this.est[0] + r.usd[0]).toFixed(2), +(this.est[1] + r.usd[1]).toFixed(2)];
    const who = r.role === "director" ? "the Director, who re-boards" : "the Animator";
    this.revision("person", "change", `Your rough-cut note goes to ${who}`, ops, r.usd[0]);
    // the revision's own delta is the estimate the card showed
    const rev = this.revisions.at(-1);
    if (rev) rev.deltaUsd = [...r.usd];
  }
  changes = 0;
  // ---- P4's scenarios ----
  /** keyfail: the provider turns the key down mid-draw; the run holds, Pip says so once, nothing new starts */
  keyRejected(n: Node) {
    const row = { ...this.taskRow(n, "cancelled"), endedAt: this.at() };
    this.emit({ event: "task", data: row });
    n.status = "pending";
    n.elapsed = 0;
    n.attempt = 2;
    n.taskId = null;
    n.startedAt = null;
    const m = this.metas.get(n.instance);
    const life = m?.lives.at(-1);
    if (life && !life.to) life.to = this.at();
    const text = "Your Anthropic key was rejected.";
    this.hold = { provider: "anthropic" };
    this.held = text.replace(/\.$/, "");
    this.statusNow = {
      line: `Waiting for you: ${this.held}`,
      problem: { text, action: "fix_key", taskId: row.id, provider: "anthropic" },
    };
    this.channel("pip", "crew", "brief", pausedLine(text), n.id);
    const kept = this.nodes.filter((x) => x.status === "done").length;
    const waiting = this.nodes.filter((x) => !["done", "skipped", "dropped"].includes(x.status)).length;
    const keptWords = kept ? `${kept} finished step${kept === 1 ? " is" : "s are"} kept` : "nothing was lost";
    const waits = waiting ? `; ${waiting} wait${waiting === 1 ? "s" : ""} for the fix` : "";
    // Pip.holdNotice: a notice, not a model turn (unmetered)
    this.pip(
      `${text} I paused the crew instead of using stand-ins: ${keptWords}${waits}. Fix it in Settings → Providers: once the key is saved or its test passes, the crew picks up where it stopped.`,
      [],
      false,
    );
    this.waits.set("key:anthropic", this.tick);
  }
  /** the key is fixed: the hold lifts and the run goes on from where it stopped */
  private liftHold() {
    this.hold = null;
    this.held = null;
    this.statusNow = null;
    this.waits.delete("key:anthropic");
    this.channel("pip", "crew", "brief", "Back to work: the hold is lifted.");
  }
  /** overrun: spend reached 80% of the cap before a task starts; the budget question's two cards (Pip.overrunCard) */
  private askBudget(next: Node) {
    this.overrunAsked = true;
    this.budgetWait = true;
    const want = Math.max(2, this.cap + 0.5);
    const finish: Extract<PipCard, { type: "plan" }> = {
      id: "c_finish",
      type: "plan",
      title: `Finish within ${money(this.cap)}`,
      detail: `The crew leaves out a few extras so the rest fits the ${money(this.cap)} cap.`,
      who: [],
      usd: [0, 0],
      sec: null,
      effects: ["Leaves out the second review round.", "Everything else is made as planned."],
      confirmLabel: `Finish within ${money(this.cap)}`,
      status: "proposed",
    };
    const raise: Extract<PipCard, { type: "plan" }> = {
      id: "c_raise",
      type: "plan",
      title: `Raise the cap to ${money(want)}`,
      detail: `The project's budget cap goes from ${money(this.cap)} to ${money(want)} so the crew can finish as planned.`,
      who: [],
      usd: [0, 0],
      sec: null,
      effects: [
        `The next step could cost up to ${money(next.est[1])}.`,
        "Keep it as it is: the crew goes on only with steps that fit, then waits for you.",
      ],
      confirmLabel: `Set ${money(want)}`,
      status: "proposed",
    };
    this.cards.set(finish.id, finish);
    this.cards.set(raise.id, raise);
    this.pip(`The crew is near the budget: ${money(this.spent)} of ${money(this.cap)} spent.`, [finish, raise], false);
    this.waits.set(`card:${finish.id}`, this.tick);
    // as the server says it (Crew.askBudget): statements, so the web ends each sentence once
    const why = `80% of the ${money(this.cap)} cap is spent`;
    this.statusNow = {
      line: `Waiting for you: ${why}. Finish within it, or raise it to ${money(want)}.`,
      waiting: "budget",
    };
    this.channel("pip", "crew", "brief", pausedLine(why), next.id);
  }
  /** publish: the founder is drawn and new, so the Librarian asks once whether it goes into the person's library */
  askToPublish() {
    const n = this.add({
      id: "t_publish_founder",
      kind: "lib.publish",
      role: "librarian",
      instance: "librarian",
      asset: "founder",
      stage: "deliver",
      deps: ["t_draw_founder"],
      ticks: 1,
      usd: 0,
      title: "Publishing founder",
      reason: "Pip brought in the Librarian to ask about the founder",
      asks: Q_PUBLISH,
      asking: "Waiting for you: publish founder?",
    });
    n.addedIn = this.rev;
  }
  /** step 8: scene 3 reports partial, Pip answers, the same task tries again */
  sceneThreeHitsAWall(n: Node) {
    const m = this.metas.get("animator:s03");
    if (m)
      m.lastReport = {
        status: "partial",
        did: "Animated the quest board",
        couldnt: "No recipe for two people talking.",
      };
    this.channel("animator", "pip", "report", "No recipe for two people talking.", "s03");
    this.channel(
      "pip",
      "animator",
      "answer",
      "Use a toast for the line and keep both characters left of the box.",
      "s03",
    );
    this.spend(JOURNEY.pipTurnUsd, "assistant", ROLE_MODELS.assistant);
    n.attempt = 2;
    n.elapsed = 0;
    n.ticks = 3;
    this.emit({ event: "task", data: this.taskRow(n, "working") });
  }
  /** step 9: round 1 finds the clipped headline; code adds the scene 1 redo and round 2 (rev 2) */
  reviewFindsTheHeadline() {
    this.emit({
      event: "x-state",
      data: {
        findings: [
          {
            id: "f_headline",
            t: 2,
            scene: this.opts.sceneIds?.[0],
            severity: "error",
            text: "The headline is clipped in scene 1",
            fix: "Move it up so it ends above y=146.",
          },
        ],
      },
    });
    const redo = this.add({
      id: "t_tune_s01_r2",
      kind: "scene.tune",
      role: "animator",
      instance: "animator:s01",
      scene: "s01",
      round: 2,
      stage: "animate",
      deps: ["t_review_r1"],
      ticks: 3,
      usd: 0.05,
      conditional: true,
      title: "Animating scene 1 of 4, the headline fix",
      reason: "Pip brought the Animator back to fix the scene 1 headline",
      done: (s) => s.scene("s01", "render"),
    });
    if (this.trimmed) {
      // "Finish within" left the second review round out: the fix goes straight to the rough cut
      this.node("g3").deps = [redo.id];
      this.revision(
        "code",
        "conductor",
        "Scene 1 goes back to the Animator for the headline",
        [{ op: "add", task: redo.id, label: labelOf(redo.instance), reason: "The headline is clipped in scene 1." }],
        0.05,
      );
      this.reviveReason.set("animator:s01", redo.reason ?? "");
      return;
    }
    const r2 = this.add({
      id: "t_review_r2",
      kind: "review.final",
      role: "reviewer",
      instance: "reviewer",
      round: 2,
      stage: "review",
      deps: [redo.id],
      ticks: 2,
      usd: 0.03,
      conditional: true,
      title: "Checking the fix",
      done: (s) => s.emit({ event: "x-state", data: { findings: [] } }),
    });
    this.node("g3").deps = [r2.id];
    this.revision(
      "code",
      "conductor",
      "Scene 1 goes back to the Animator for the headline",
      [
        { op: "add", task: redo.id, label: labelOf(redo.instance), reason: "The headline is clipped in scene 1." },
        { op: "add", task: r2.id, label: labelOf(r2.instance), reason: "Check the fix." },
      ],
      0.08,
    );
    this.reviveReason.set("animator:s01", redo.reason ?? "");
  }
  reviveReason = new Map<string, string>();
  /** step 10: the change card's revision (rev 3, the person's) */
  change() {
    const g3 = this.node("g3");
    g3.status = "pending";
    this.emit({ event: "gate", data: { id: "g3_rough", status: "locked", items: GATE_ITEMS.g3_rough } });
    this.waits.delete("gate:g3_rough");
    const redo = this.add({
      id: "t_tune_s02_r2",
      kind: "scene.tune",
      role: "animator",
      instance: "animator:s02",
      scene: "s02",
      round: 2,
      stage: "animate",
      deps: [],
      ticks: 4,
      usd: 0.08,
      title: "Animating scene 2 of 4, a bigger hero",
      reason: "Pip brought the Animator back for a bigger hero in scene 2",
      done: (s) => s.scene("s02", "render"),
    });
    const r3 = this.add({
      id: "t_review_r3",
      kind: "review.final",
      role: "reviewer",
      instance: "reviewer",
      round: 3,
      stage: "review",
      deps: [redo.id],
      ticks: 2,
      usd: 0.03,
      title: "Checking the change",
      done: (s) => {
        s.pip("The rough cut is ready again, with your change.", [], false);
        s.cardDone("c_ch", "Scene 2 redone; the hero is 2× now.");
      },
    });
    g3.deps = [r3.id];
    this.revision(
      "person",
      "change",
      "Scene 2 goes back to the Animator for a bigger hero",
      [
        { op: "add", task: redo.id, label: labelOf(redo.instance), reason: "Make the hero bigger in scene 2." },
        { op: "add", task: r3.id, label: labelOf(r3.instance), reason: "Check the change." },
      ],
      0.11,
    );
    this.reviveReason.set("animator:s02", redo.reason ?? "");
  }
  cards = new Map<string, Extract<PipCard, { type: "plan" }>>();
  private setCard(c: Extract<PipCard, { type: "plan" }>) {
    this.cards.set(c.id, c);
    this.emit({ event: "pip", data: { type: "card", card: c } });
  }
  /** the revision card: confirm runs its tasks and moves approvedUsd to the new estimate; decline drops them */
  private decideRevision(c: Extract<PipCard, { type: "plan" }>, decision: "confirm" | "decline") {
    const held = this.pending?.tasks ?? [];
    this.pending = null;
    this.statusNow = null;
    if (decision === "confirm") {
      this.approved = this.est[0];
      this.setCard({ ...c, status: "done", result: { text: "The crew goes on with the new plan." } });
      return;
    }
    this.setCard({ ...c, status: "declined" });
    this.est = [...JOURNEY.estUsd];
    for (const id of held) {
      this.node(id).status = "dropped";
      for (const n of this.nodes) n.deps = n.deps.filter((d) => d !== id);
    }
  }
  /** the budget question's two cards: answering one settles the other (Pip.decide's siblings) */
  private decideBudget(c: Extract<PipCard, { type: "plan" }>, decision: "confirm" | "decline") {
    this.waits.delete("card:c_finish");
    this.budgetWait = false;
    this.statusNow = null;
    for (const id of ["c_finish", "c_raise"]) {
      const o = this.cards.get(id);
      if (!o || o.id === c.id || o.status !== "proposed") continue;
      this.setCard({
        ...o,
        status: "declined",
        result: { text: decision === "decline" ? "Kept as it is." : "You chose the other way." },
      });
    }
    if (decision === "decline") {
      this.setCard({ ...c, status: "declined" });
      return;
    }
    if (c.id === "c_finish") {
      this.trimmed = true;
      this.setCard({ ...c, status: "done", result: { text: "The crew finishes within the cap." } });
      this.revision(
        "code",
        "budget",
        `Finish within ${money(this.cap)}: the first review round is the last`,
        [
          {
            op: "trim",
            task: "t_review_r1",
            label: labelOf("reviewer"),
            reason: "Leaves out the second review round.",
          },
        ],
        0,
      );
      return;
    }
    this.cap = Math.max(2, this.cap + 0.5);
    this.emit({
      event: "x-state",
      data: { budget: { capUsd: this.cap, spentUsd: this.spent, reservedUsd: 0, estTotalUsd: [...this.est] } },
    });
    this.setCard({ ...c, status: "done", result: { text: `The cap is ${money(this.cap)} now.` } });
  }
  cardDone(id: string, text: string) {
    const c = this.cards.get(id);
    if (!c) return;
    const done = { ...c, status: "done" as const, result: { text } };
    this.cards.set(id, done);
    this.emit({ event: "pip", data: { type: "card", card: done } });
  }
  exported() {
    const f = this.opts.files?.();
    if (f) this.emit({ event: "x-state", data: { files: f.rows } });
    const g4 = this.node("g4");
    if (this.finalApproved) {
      g4.status = "done";
      this.emit({ event: "gate", data: { id: "g4_final", status: "passed", items: GATE_ITEMS.g4_final } });
      this.milestone("Your video is ready");
    }
    this.pip("Your video is ready. A new video is exported, with scene 2's change.", [
      { id: "c_files", type: "files", files: f?.pip ?? [] },
    ]);
  }

  // ---- the executor ----
  /** Start was pressed on the brief card (G0 passed by the person): rev 0, then the first tick of work */
  start(): ServerEvent[] {
    this.emit({ event: "gate", data: { id: "g0_brief", status: "passed", items: GATE_ITEMS.g0_brief } });
    this.rulesPlan();
    const revision: PlanRevisionSummary = {
      rev: 0,
      at: this.at(),
      by: "rules",
      trigger: "start",
      reason: this.revReason,
      ops: [],
      deltaUsd: [0, 0],
    };
    this.revisions.push(revision);
    this.emit({ event: "plan", data: { view: this.view(), revision } });
    const n = this.nodes.filter((x) => !isGate(x) && x.status !== "done").length;
    this.milestone(`Plan ready · ${n} tasks to start`);
    // Pip's revision on top (D1) adds nothing here: it is metered all the same
    this.spend(JOURNEY.pipTurnUsd, "assistant", ROLE_MODELS.assistant);
    // the first tasks start with the plan, so the row never shows an empty crew
    this.settle();
    return this.flush();
  }

  /** one tick: running tasks advance (and end), gates settle, ready tasks start, then the row is re-derived */
  step(): ServerEvent[] {
    this.tick++;
    for (const n of this.nodes) {
      if (n.status !== "running") continue;
      n.elapsed++;
      n.during?.(this, n, n.elapsed);
      if (n.status === "running" && n.elapsed % 2 === 1 && n.elapsed < n.ticks)
        this.emit({
          event: "activity",
          data: { task: n.taskId ?? n.id, at: this.at(), ...middle(this.taskRow(n), n.elapsed) },
        });
    }
    for (const n of this.nodes) if (n.status === "running" && n.elapsed >= n.ticks) this.finish(n);
    this.settle();
    this.auto();
    return this.flush();
  }

  private settle() {
    // gates and ready tasks, until nothing changes (a gate that passes in code can free tasks in the same tick)
    for (let guard = 0; guard < 20; guard++) {
      let moved = false;
      for (const n of this.nodes) {
        if (n.status !== "pending" || !this.depsDone(n)) continue;
        if (isGate(n)) {
          moved = this.reachGate(n) || moved;
          continue;
        }
        n.status = "ready";
        moved = true;
      }
      if (!moved) break;
    }
    const slots = this.opts.slots - this.nodes.filter((x) => x.status === "running").length;
    let free = slots;
    for (const n of this.nodes) {
      // a hold (a rejected key) or the open budget question: nothing new starts (§1.8, §1.6)
      if (free <= 0 || this.hold || this.budgetWait || this.pipHold) break;
      if (n.status !== "ready" || this.pending?.tasks.includes(n.id)) continue;
      if (this.opts.scenario === "overrun" && !this.overrunAsked && this.spent >= 0.8 * this.cap) {
        this.askBudget(n);
        break;
      }
      this.begin(n);
      free--;
    }
    this.diff();
    this.stageView();
    // a status-only plan view (transient on the server): the UI reads `ready` from it ("waiting for a free slot")
    const sig = this.nodes.map((n) => `${n.id}:${n.status}`).join();
    if (sig !== this.planSig) {
      this.planSig = sig;
      this.emit({ event: "plan", data: { view: this.view() } });
    }
  }
  private planSig = "";
  private depsDone(n: Node) {
    return n.deps.every((d) => {
      const s = this.node(d).status;
      return s === "done" || s === "skipped";
    });
  }
  /** a gate whose work is done: the person's picks open; the others pass in code */
  private reachGate(n: Node): boolean {
    const g = n.gate as PlanGate;
    if (g === "rights") {
      // the rights node is the q_rights question, opened when the import ends; it passes only on the answer
      if (n.status === "pending") n.status = "waiting_person";
      return false;
    }
    if (g === "g1_script") {
      n.status = "waiting_person";
      return false;
    }
    if (g === "g4_final" && !this.finalApproved) {
      n.status = "waiting_person";
      this.emit({ event: "gate", data: { id: g, status: "open", items: GATE_ITEMS[g] } });
      this.waits.set(`gate:${g}`, this.tick);
      return false;
    }
    if (PERSON_GATES.has(g)) {
      n.status = "waiting_person";
      this.emit({ event: "gate", data: { id: g as "g3_rough", status: "open", items: GATE_ITEMS[g as "g3_rough"] } });
      this.waits.set(`gate:${g}`, this.tick);
      if (g === "g3_rough") {
        this.g3Opens++;
        if (this.g3Opens === 1) this.pip("The rough cut is ready. One fix was made on scene 1.");
      }
      return false;
    }
    // G2 under "key" passes in code (verdict by the producer, note "auto"); G4 once the G3 press approved it
    n.status = "done";
    if (g !== "g0_brief") this.emit({ event: "gate", data: { id: g, status: "passed", items: GATE_ITEMS[g] } });
    if (g === "g2_animatic") this.scenes("animatic");
    return true;
  }
  private begin(n: Node) {
    n.status = "running";
    n.elapsed = 0;
    n.taskId ??= `t_${++this.n.task}`;
    n.startedAt = this.at();
    const m = this.metas.get(n.instance);
    if (m) {
      const was = this.sent.get(m.id);
      if (!m.spawnedAt) m.spawnedAt = this.at();
      m.endedAt = null;
      if (!m.lives.length || m.lives.at(-1)?.to) {
        const reason =
          !was || was.state === "planned"
            ? m.reason
            : was.state === "finished"
              ? this.reviveReason.get(m.id)
              : undefined;
        m.lives.push({ from: this.at(), to: null, ...(reason ? { reason } : {}) });
      }
      // N3: the face comes before its task's `working`
      this.sendInstance(m.id);
    }
    const row = this.taskRow(n, "working");
    this.emit({ event: "task", data: row });
    for (const b of opening(row)) this.emit({ event: "activity", data: { task: row.id, at: this.at(), ...b } });
  }
  private finish(n: Node) {
    n.status = "done";
    const row = this.taskRow(n, "done");
    this.emit({ event: "task", data: row });
    for (const b of closing(row)) this.emit({ event: "activity", data: { task: row.id, at: this.at(), ...b } });
    if (n.role !== "person") this.spend(n.usd, n.role, ROLE_MODELS[n.role]);
    n.done?.(this, n);
    if (n.kind === "review.final") this.proxyOut();
    const m = this.metas.get(n.instance);
    if (m && n.asks) {
      // its work is done and the plan moves on, but its row waits on the person, so the member stays (needs you)
      const q = n.asks(this.at());
      m.asking = { qid: q.id, node: n };
      this.emit({ event: "task", data: { ...row, status: "waiting_user", title: n.asking ?? n.title } });
      this.question(q);
      return;
    }
    if (m) {
      const life = m.lives.at(-1);
      if (life && !life.to && !this.nodes.some((x) => x !== n && x.instance === m.id && x.status === "running"))
        life.to = this.at();
      // a partial report stands (the cast's missing founder, scene 3's workaround); anything else ends done
      const partial = n.kind === "art.cast" || (m.id === "animator:s03" && n.attempt > 1);
      if (!partial || !m.lastReport) m.lastReport = { status: "done", did: n.title };
    }
  }
  taskRow(n: Node, status: Task["status"] = n.status === "running" ? "working" : "done"): Task {
    return {
      id: n.taskId ?? n.id,
      kind: n.kind,
      role: n.role as Role,
      title: n.title,
      status,
      model: ROLE_MODELS[n.role as Role],
      usd: status === "done" ? n.usd : 0,
      estUsd: n.est[0],
      ...(n.startedAt ? { startedAt: n.startedAt } : {}),
      ...(status === "done" ? { endedAt: this.at() } : {}),
      ...(n.attempt > 1 ? { attempt: n.attempt } : {}),
      ...(n.kind === "asset.import" && this.opts.logoIcon ? { lastImage: this.opts.logoIcon } : {}),
      planTask: n.id,
      instance: n.instance,
    };
  }

  // ---- instances: the fold and the horizon (PIP-ORCHESTRATION §2) ----
  /** the ghost set: instances not live with a ready task, or a pending one within 2 hops of a running or ready task;
   * gates are transparent; at most 3, nearest first */
  ghosts(): string[] {
    const dist = new Map<string, number>();
    const queue: string[] = [];
    for (const n of this.nodes)
      if (n.status === "running" || n.status === "ready") {
        dist.set(n.id, 0);
        queue.push(n.id);
      }
    // 0/1 weights: through a gate costs nothing
    while (queue.length) {
      const id = queue.shift() as string;
      const d = dist.get(id) ?? 0;
      for (const v of this.nodes) {
        if (!v.deps.includes(id) || v.status === "done" || v.status === "dropped") continue;
        const nd = d + (isGate(v) ? 0 : 1);
        if (nd > 2 || (dist.has(v.id) && (dist.get(v.id) ?? 9) <= nd)) continue;
        dist.set(v.id, nd);
        if (isGate(v)) queue.unshift(v.id);
        else queue.push(v.id);
      }
    }
    const best = new Map<string, { d: number; order: number }>();
    this.nodes.forEach((n, order) => {
      if (!n.instance) return;
      const ok = n.status === "ready" || (n.status === "pending" && (dist.get(n.id) ?? 9) <= 2);
      if (!ok) return;
      if (this.nodes.some((x) => x.instance === n.instance && x.status === "running")) return;
      if (this.metas.get(n.instance)?.asking) return;
      const d = n.status === "ready" ? 0 : (dist.get(n.id) ?? 9);
      const cur = best.get(n.instance);
      if (!cur || d < cur.d) best.set(n.instance, { d, order });
    });
    return [...best]
      .sort((a, b) => a[1].d - b[1].d || a[1].order - b[1].order)
      .slice(0, 3)
      .map(([id]) => id);
  }
  instanceView(id: string, ghosts: string[]): Instance {
    const m = this.metas.get(id) as Meta;
    const mine = this.nodes.filter((n) => n.instance === id && n.status !== "dropped");
    const running = mine.filter((n) => n.status === "running").length;
    // a member whose task waits on the person stays live: its face asks (needs you), and it isn't finished
    const asking = !!m.asking;
    const unfinished = asking || mine.some((n) => ["pending", "ready", "running", "waiting_person"].includes(n.status));
    const state: Instance["state"] =
      running > 0 || asking ? "live" : !m.spawnedAt ? "planned" : unfinished ? "idle" : "finished";
    const usd = +mine
      .filter((n) => n.status === "done")
      .reduce((a, n) => a + n.usd, 0)
      .toFixed(2);
    const last = mine.filter((n) => n.taskId).at(-1);
    return {
      id,
      role: m.role,
      label: m.label,
      ...(m.subject ? { subject: m.subject } : {}),
      model: last ? (ROLE_MODELS[m.role] ?? null) : null,
      state,
      ghost: state !== "live" && ghosts.includes(id),
      running,
      spawnedAt: m.spawnedAt,
      endedAt: state === "finished" ? m.endedAt : null,
      lives: m.lives.map((l) => ({ ...l })),
      reason: m.reason,
      ...(state === "finished" && m.endReason ? { endReason: m.endReason } : {}),
      tasks: mine.map((n) => n.id),
      usd,
      outcome:
        state !== "finished"
          ? null
          : m.lastReport?.status === "partial" || m.lastReport?.status === "blocked"
            ? "partial"
            : "done",
      ...(m.lastReport ? { lastReport: { ...m.lastReport } } : {}),
    };
  }
  private changeOf(prev: Instance | undefined, next: Instance): InstanceChange | null {
    const pState = prev?.state ?? "planned";
    if (pState === next.state) return (prev?.ghost ?? false) !== next.ghost ? "ghost" : null;
    if (next.state === "finished") return "end";
    if (pState === "finished") return "revive";
    if (pState === "planned" && next.state === "live") return "spawn";
    if (next.state === "live") return "live";
    if (next.state === "idle") return "idle";
    return (prev?.ghost ?? false) !== next.ghost ? "ghost" : null;
  }
  private sendInstance(id: string, ghosts = this.ghosts()) {
    const prev = this.sent.get(id);
    const next = this.instanceView(id, ghosts);
    const change = this.changeOf(prev, next);
    if (!change) return;
    const m = this.metas.get(id) as Meta;
    if (change === "end") {
      m.endedAt = this.at();
      next.endedAt = m.endedAt;
      m.endReason = m.id === "pixel-artist:founder" ? "Drawn and approved." : m.lastReport?.did;
      if (m.endReason) next.endReason = m.endReason;
    }
    this.sent.set(id, next);
    this.emit({ event: "instance", data: { instance: next, change } });
  }
  /** re-derive every instance and send the ones that changed, finished ones first, then the row in join order */
  private diff() {
    const ghosts = this.ghosts();
    const ids = [...this.metas.values()].sort((a, b) => a.order - b.order).map((m) => m.id);
    for (const id of ids) this.sendInstance(id, ghosts);
  }
  private stageView() {
    const ORDER: Stage[] = ["brief", "script", "storyboard", "art", "animate", "narrate", "sound", "review", "deliver"];
    const open = this.nodes.filter((n) => n.status !== "done" && n.status !== "skipped" && n.status !== "dropped");
    const stage = open.length ? ORDER[Math.min(...open.map((n) => ORDER.indexOf(n.stage)))] : "deliver";
    if (stage === this.stageNow) return;
    this.stageNow = stage;
    this.emit({ event: "stage", data: { stage } });
  }

  // ---- the person ----
  act(a: JourneyAction): ServerEvent[] {
    if (a.type === "answer") {
      this.waits.delete(`answer:${a.qid}`);
      const q =
        a.qid === "q_angle"
          ? Q_ANGLE(this.at())
          : a.qid === "q_rights"
            ? Q_RIGHTS(this.at())
            : a.qid === "q_publish"
              ? Q_PUBLISH(this.at())
              : a.qid === "q_hold"
                ? Q_HOLD(this.at())
                : null;
      if (!q) return [];
      const optionId = a.optionId ?? q.recommendedId;
      // as the server: "Tell Pip" with no words keeps the hold's question open
      if (a.qid === "q_hold" && optionId === "tell" && !a.note?.trim()) return [];
      if (a.qid === "q_publish") {
        const n = this.node("t_publish_founder");
        n.title = optionId === "yes" ? "Published founder" : "Kept founder in this project";
      }
      this.emit({ event: "question", data: { ...q, status: "answered", answer: { optionId, by: "user" } } });
      // the member that asked is done once it has its answer
      for (const m of this.metas.values())
        if (m.asking?.qid === a.qid) {
          const n = m.asking.node;
          m.asking = null;
          this.emit({ event: "task", data: this.taskRow(n, "done") });
          const life = m.lives.at(-1);
          if (life && !life.to) life.to = this.at();
          m.lastReport = { status: "done", did: n.title };
        }
      if (a.qid === "q_angle") {
        this.node("g1").status = "done";
        this.emit({ event: "gate", data: { id: "g1_script", status: "passed", items: GATE_ITEMS.g1_script } });
      } else if (a.qid === "q_rights") this.node("rights").status = "done";
      else if (a.qid === "q_hold") {
        // the card a typed note made is settled by the answer, and the other way round
        const c = this.cards.get("c_hold");
        if (c && c.status === "proposed")
          this.setCard({ ...c, status: "declined", result: { text: "You answered the question instead." } });
        this.waits.delete("card:c_hold");
        this.answerHold(optionId, a.note?.trim());
      }
      this.settle();
    } else if (a.type === "gate") {
      this.waits.delete(`gate:${a.gate}`);
      if (a.verdict === "changes" && a.gate === "g3_rough" && this.node("g3").status === "waiting_person") {
        this.gateChange(a.text ?? "", a.items ?? []);
        this.settle();
      } else if (a.verdict === "approve") {
        const id = a.gate === "g3_rough" ? "g3" : a.gate === "g4_final" ? "g4" : null;
        if (!id) return [];
        this.node(id).status = "done";
        const g = a.gate as "g3_rough" | "g4_final";
        this.emit({ event: "gate", data: { id: g, status: "passed", items: GATE_ITEMS[g] } });
        // "Looks good" at G3 also passes G4 (Decision 2)
        if (a.gate === "g3_rough") this.finalApproved = true;
        else this.milestone("Your video is ready");
        this.settle();
      }
    } else if (a.type === "card") {
      this.waits.delete(`card:${a.cardId}`);
      const c = this.cards.get(a.cardId);
      if (!c || (c.status !== "proposed" && c.status !== "running")) return [];
      if (a.cardId === "c_rev") this.decideRevision(c, a.decision);
      else if (a.cardId === "c_hold") this.decideHoldCard(c, a.decision);
      else if (a.cardId === "c_finish" || a.cardId === "c_raise") this.decideBudget(c, a.decision);
      else if (a.cardId === "c_undo" || a.cardId === "c_free") {
        // Pip's free edits: no crew, no revision; the picture follows at once
        if (a.decision === "decline") this.setCard({ ...c, status: "declined" });
        else if (a.cardId === "c_undo") {
          this.edited = false;
          this.setCard({ ...c, status: "done", result: { text: "Undone: scene 2's hero is back to its size." } });
        } else {
          this.time = "day";
          this.setCard({ ...c, status: "done", result: { text: "The video is now set at day." } });
        }
      } else if (a.decision === "decline") this.setCard({ ...c, status: "declined" });
      else {
        this.setCard({ ...c, status: "running" });
        this.change();
      }
      this.settle();
    } else if (a.type === "key") {
      if (this.hold?.provider !== a.provider) return [];
      this.liftHold();
      this.settle();
    } else if (a.type === "ask") {
      this.waits.delete(`ask:${a.text}`);
      this.asks.push({ at: this.tick + 2, ...a });
    }
    return this.flush();
  }
  asks: (JourneyAction & { type: "ask"; at: number })[] = [];
  /** Pip's replies to the journey's two messages land 2 ticks after they are sent; anything else is not the journey's */
  static handles(text: string): boolean {
    const t = text.toLowerCase();
    return /hero\b.*\bbigger|bigger\b.*\bhero/.test(t) || /why\b.*pixel artist/.test(t) || /\bday-?time\b/.test(t);
  }
  /** the `edits` scenario: Pip made the step 10 edit itself (scene 2's hero is 2×), and the time it set */
  edited = false;
  time: "night" | "day" = "night";
  /** the messages this run answers itself: the journey's two, any note while Pip holds the run, and every message
   * in the `pipkey` scenario (whose answer is the rejected key) */
  handlesAsk(text: string): boolean {
    return this.opts.scenario === "pipkey" || this.pipHold || Journey.handles(text);
  }
  private replies() {
    const due = this.asks.filter((a) => a.at <= this.tick);
    this.asks = this.asks.filter((a) => a.at > this.tick);
    for (const a of due) {
      // pipkey: Pip's own model turns its key down; the reply is the fix, with no model's words
      if (this.opts.scenario === "pipkey") {
        this.pip(
          "Your Anthropic key was rejected, so I couldn't answer that. Fix it in Settings → Providers, then ask me again.",
          [{ id: `c_fix_${++this.n.pip}`, type: "fix", action: "fix_key", provider: "anthropic" }],
          false,
        );
        continue;
      }
      // a note while Pip holds the run: a card that starts now (it closes the hold's question)
      if (this.pipHold) {
        const card: Extract<PipCard, { type: "plan" }> = {
          id: "c_hold",
          type: "plan",
          title: "Redo the cast with your note",
          detail: `The Director re-plans the cast with your note: “${a.text.trim()}”. The crew starts as soon as you say so.`,
          who: ["director", "pixel-artist"],
          whoInstances: [
            { instance: "director", label: "Director" },
            { instance: "pixel-artist:founder", label: "Pixel artist · founder" },
          ],
          usd: [0.31, 0.45],
          sec: [120, 240],
          effects: ["Closes Pip's question about the founder.", "The crew starts at once; nothing else changes."],
          confirmLabel: "Start now",
          revision: {
            rev: this.rev + 1,
            ops: [],
            fromUsd: this.approved,
            toUsd: this.approved + 0.31,
            planner: "director",
          },
          status: "proposed",
        };
        this.cards.set(card.id, card);
        this.pip("Here's the change. It starts now, and the crew goes on from the cast.", [card]);
        this.waits.set(`card:${card.id}`, this.tick);
        continue;
      }
      if (/why\b.*pixel artist/i.test(a.text)) {
        this.pip("The library had no founder sprite, so I added one drawing. It was $0.31 of your $3.");
        this.ended = true;
        continue;
      }
      // edits (v0.5.2, PIP-ORCHESTRATION §1.12): a size change on a recipe scene is Pip's own edit, free, done in the
      // turn with an Undo card; the time of day is a rule edit on a free card
      if (this.opts.scenario === "edits" && /\bday-?time\b/i.test(a.text)) {
        const card: Extract<PipCard, { type: "plan" }> = {
          id: "c_free",
          type: "plan",
          title: "I can do this now: free",
          detail: "The video is set at day: every scene draws its sky from the time of day, so nothing is re-made.",
          who: [],
          usd: [0, 0],
          sec: null,
          effects: ["No crew run and no model call.", "You can undo it."],
          confirmLabel: "Do it",
          status: "proposed",
        };
        this.cards.set(card.id, card);
        this.pip("That one's free: every scene follows the time of day.", [card]);
        continue;
      }
      if (this.opts.scenario === "edits") {
        this.edited = true;
        const undo: Extract<PipCard, { type: "plan" }> = {
          id: "c_undo",
          type: "plan",
          title: "Undo: make the hero bigger in scene 2",
          detail: "Change #41 by user (via Pip) goes back: /scenes/1/recipes.",
          who: [],
          usd: [0, 0],
          sec: null,
          effects: [
            "Adds the inverse change to the history; nothing is deleted.",
            "Later work on the same paths may need redoing.",
          ],
          confirmLabel: "Undo it",
          status: "proposed",
        };
        this.cards.set(undo.id, undo);
        this.pip("Done: the hero in scene 2 is twice the size. It cost nothing; undo it if you liked it before.", [
          undo,
        ]);
        continue;
      }
      const card: Extract<PipCard, { type: "plan" }> = {
        id: "c_ch",
        type: "plan",
        title: "Make the hero bigger in scene 2",
        detail: "Animator · scene 2 tunes the size, then the Reviewer checks.",
        who: ["animator", "reviewer"],
        whoInstances: [
          { instance: "animator:s02", label: "Animator · scene 2" },
          { instance: "reviewer", label: "Reviewer" },
        ],
        usd: [0.1, 0.14],
        sec: [90, 150],
        effects: ["Reopens scene 2. Scenes 1, 3 and 4 stay as they are."],
        confirmLabel: "Ask the crew",
        status: "proposed",
      };
      this.cards.set(card.id, card);
      this.pip("Here's the change. The rough cut comes back once the Reviewer has checked it.", [card]);
      this.waits.set(`card:${card.id}`, this.tick);
    }
  }

  /** `auto=1`: each wait resolves 3 ticks after it opens (not a scenario's own); the step 10 and 12 messages are typed too */
  private auto() {
    this.replies();
    if (!this.opts.auto) return;
    for (const [w, since] of [...this.waits]) {
      // a scenario's own moment is the person's: auto drives the run to it and leaves it open
      const stop = this.opts.scenario ? STOPS_AT[this.opts.scenario] : undefined;
      if (this.tick - since < 3 || SCENARIO_WAITS.has(w) || w === stop) continue;
      const [kind, id] = [w.slice(0, w.indexOf(":")), w.slice(w.indexOf(":") + 1)];
      if (kind === "answer") this.also({ type: "answer", qid: id });
      else if (kind === "card") this.also({ type: "card", cardId: id, decision: "confirm" });
      else if (kind === "gate" && id === "g3_rough" && this.g3Opens === 1 && !this.cards.has("c_ch")) {
        this.waits.set(`gate:${id}`, this.tick);
        this.also({ type: "ask", text: JOURNEY.change });
      } else if (kind === "gate" && id === "g3_rough" && this.cards.has("c_ch") && this.g3Opens === 1) {
        // the change card is out: G3 waits until the change comes back
      } else if (kind === "gate") this.also({ type: "gate", gate: id as PlanGate, verdict: "approve" });
    }
    // holdcard: three ticks into the hold, the person types a note instead of answering
    if (this.opts.scenario === "holdcard" && this.pipHold && this.tick - this.holdAt >= 3 && !this.asked.has("hold")) {
      this.asked.add("hold");
      this.also({ type: "ask", text: HOLD_NOTE });
    }
    const g4 = this.nodes.find((n) => n.id === "g4");
    if (g4?.status === "done" && !this.asked.has("why") && this.tick >= this.g4At + 3) {
      this.asked.add("why");
      this.also({ type: "ask", text: JOURNEY.why, about: { instance: "pixel-artist:founder" } });
    }
    if (g4?.status === "done" && this.g4At === Number.POSITIVE_INFINITY) this.g4At = this.tick;
  }
  /** an action taken inside a tick: its events join the tick's (act flushes, so read them before pushing) */
  private also(a: JourneyAction) {
    const ev = this.act(a);
    this.out.push(...ev);
  }
  asked = new Set<string>();
  g4At = Number.POSITIVE_INFINITY;
}

// ---- the person's picks ----
const GATE_ITEMS: Record<Exclude<PlanGate, "rights">, { label: string; ref?: string }[]> = {
  g0_brief: [{ label: "The brief card" }],
  g1_script: [{ label: "Pick a script angle" }],
  g2_animatic: [{ label: "Scene order and timing" }],
  // the server's: the rough cut's contact sheet is the picture (orch rough())
  g3_rough: [{ label: "Rough cut", ref: "out/contact.png" }],
  g4_final: [{ label: "The exported video" }],
};

export const Q_ANGLE = (at: string): QuestionT => ({
  id: "q_angle",
  kind: "single",
  question: "Which script should the crew make?",
  why: "The Writer drafted three angles. The walker is closest to your brief.",
  options: [
    { id: "walker", label: "The walker", detail: "A day of chores turns into a quest, one tap at a time." },
    { id: "board", label: "The quest board", detail: "The app's board, task by task, with a reward at the end." },
    { id: "numbers", label: "The numbers", detail: "What finishing more tasks is worth, for investors." },
  ],
  recommendedId: "walker",
  blocks: ["script"],
  timeoutSec: null,
  from: "writer",
  askedAt: at,
  status: "open",
});

/** the `rights` plan node, as a person question: never passed in code, at any involvement */
export const Q_RIGHTS = (at: string): QuestionT => ({
  id: "q_rights",
  kind: "single",
  question: "Your logo in an achievement toast. Use it in the video?",
  why: "It's imported as is, as a 16 px icon, and stays private to this project.",
  options: [
    { id: "use", label: "Use it", detail: "The end card's toast shows your logo." },
    { id: "leave", label: "Leave it out", detail: "The toast shows a star instead." },
  ],
  recommendedId: "use",
  blocks: ["animate"],
  timeoutSec: null,
  from: "art-director",
  askedAt: at,
  status: "open",
  rights: { asset: "logo", private: true },
});

/** the Librarian's one question about a new drawing (orch `publish`): never asked twice for the same asset */
export const Q_PUBLISH = (at: string): QuestionT => ({
  id: "q_publish",
  kind: "yesno",
  question: 'Add "founder" to your asset library?',
  why: "Your other projects could reuse it. It passed the PAP standard and shows no real person or brand.",
  options: [
    { id: "yes", label: "Yes, add it", detail: "" },
    { id: "no", label: "Keep it in this project", detail: "" },
  ],
  recommendedId: "yes",
  blocks: [],
  timeoutSec: null,
  from: "librarian",
  askedAt: at,
  status: "open",
});

/** Pip's hold on a partial cast (holdFor): from Pip, three real answers, the cheapest that fits recommended */
export const Q_HOLD = (at: string): QuestionT => ({
  id: "q_hold",
  kind: "single",
  question: "The library has no founder sprite. How should the crew go on?",
  why: "The cast came back partly done, so I paused the crew until you choose.",
  options: [
    {
      id: "redo",
      label: "Redo with the Director",
      detail: "The Director re-plans the cast and a Pixel artist draws the founder. About $0.31.",
      costUsd: 0.31,
    },
    { id: "accept", label: "Accept the look", detail: "The crew goes on with a stand-in for the founder. Free." },
    {
      id: "tell",
      label: "Tell Pip what to change",
      detail: "Write what to change; the crew waits for your note.",
    },
  ],
  recommendedId: "redo",
  blocks: ["art"],
  timeoutSec: null,
  from: "pip",
  askedAt: at,
  status: "open",
  hold: true,
});
/** what `holdcard`'s person types during the hold */
export const HOLD_NOTE = "use the owl from the library as the founder's pet and draw only the founder";
const cap = (t: string) => {
  const x = t.trim();
  return x ? `${x.charAt(0).toUpperCase()}${x.slice(1)}${/[.?!]$/.test(x) ? "" : "."}` : "Your change.";
};
