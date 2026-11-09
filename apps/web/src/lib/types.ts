// The server contract (docs/API.md), as the studio UI sees it. Doc types come from @pap/schema (type-only imports, so
// nothing from it is bundled). QuestionT mirrors packages/tools/src/registry.ts, which apps/web does not depend on.
import type { PatchEntryT, PatchOpT, ProjectT, RoleT } from "@pap/schema";

export type { PatchEntryT, PatchOpT, ProjectT, RoleT };
export type Role = RoleT;

export const STAGES = [
  "brief",
  "script",
  "storyboard",
  "art",
  "animate",
  "narrate",
  "sound",
  "review",
  "deliver",
] as const;
export type Stage = (typeof STAGES)[number];

export type ProjectSummary = {
  id: string;
  title: string;
  dir: string;
  rev: number;
  stage: Stage;
  spentUsd: number;
  capUsd: number;
  etaSec: number | null;
  deadline: string | null;
  needsYou: number;
  updatedAt: string;
  // extensions for the overview (optional: an older server sends none of them)
  /** a crew is working on it in this process right now */
  running?: boolean;
  paused?: boolean;
  status?: { line: string; problem?: ProjectStatus["problem"] };
  /** how many milestones are reached */
  milestones?: number;
  /** what it has, Idea … Video, states only (no `why`) */
  parts?: Omit<Part, "why">[];
  /** its latest export, and whether that shows the document as it is now; null before the first */
  version?: { v: number; at: string; upToDate: boolean } | null;
  /** roles with a task in progress */
  working?: Role[];
  /** extension: roles waiting on the person */
  waiting?: Role[];
  /** removing it may also move its folder to the app's trash (it lives in the app's own projects folder) */
  canTrash?: boolean;
  /** a 320×180 frame */
  thumb?: string;
  /** the video, to play in the card (when the server names it) */
  video?: string;
  /** PIP-ORCHESTRATION §4.1: a draft from /new, listed with the projects (its `status.line` is Pip's last question) */
  draft?: true;
  /** "one pick" (as in the Projects line) */
  needs?: string;
  /** extension: when it was made ("Started …" on a draft card) */
  createdAt?: string;
};

export type TaskStatus =
  | "upcoming"
  | "queued"
  | "working"
  | "waiting_user"
  | "waiting"
  | "done"
  /** ended on a stand-in (kept as built, lints only, a library asset): "Redo what failed" redoes it */
  | "partial"
  | "failed"
  | "cancelled";
export type Task = {
  id: string;
  kind: string;
  role: Role;
  title: string;
  status: TaskStatus;
  model?: string;
  usd: number;
  estUsd?: number;
  etaSec?: number;
  startedAt?: string;
  endedAt?: string;
  summary?: string;
  error?: { message: string; fix?: string };
  lastImage?: string;
  parent?: string;
  /** extension: the id of the task that retried this one */
  supersededBy?: string;
  /** extension: 1 for the first try, 2 for the first retry… */
  attempt?: number;
  /** PIP-ORCHESTRATION §4.1: the plan task this row runs, and the crew instance running it */
  planTask?: string;
  instance?: string;
  /** deliver.export: the version the export made */
  v?: number;
};

/** what a project has (partsOf in @pap/tools/parts; docs/API.md) */
export type PartId = "idea" | "story" | "pictures" | "sound" | "video";
export type PartState = "missing" | "partial" | "ready" | "stale";
export type Part = { id: PartId; state: PartState; done: number; of: number; why?: string };
export type Parts = { parts: Part[]; next: Stage | null };
/** one export: v1, v2, … with the document rev it was made from, and the URL that plays it */
export type Version = {
  v: number;
  rev: number;
  at: string;
  file: string;
  sec: number;
  sha1: string;
  delivery?: string;
  url: string;
};

export type GateId = "g0_brief" | "g1_script" | "g2_animatic" | "g3_rough" | "g4_final";
export type Gate = {
  id: GateId;
  status: "locked" | "open" | "passed" | "changes";
  items: { label: string; ref?: string }[];
};

export type NoteCategory = "too_fast" | "too_slow" | "unclear" | "art" | "sound" | "text" | "other";
export type NoteStatus = "open" | "picked_up" | "proposed" | "done" | "declined";
export type NoteTarget = { scene?: string; cue?: string; asset?: string; range?: [number, number]; track?: string };
export type Note = {
  id: string;
  target: NoteTarget;
  category: NoteCategory;
  text: string;
  assignee: Role | "producer";
  status: NoteStatus;
  reason?: string;
  createdAt: string;
};

export type QuestionOption = { id: string; label: string; detail: string; costUsd?: number; timeSec?: number };
export type QuestionT = {
  id: string;
  kind: "single" | "multi" | "yesno" | "number" | "image";
  question: string;
  why: string;
  options: QuestionOption[];
  recommendedId: string;
  blocks: string[];
  timeoutSec: number | null;
  from: string;
  askedAt: string;
  status: "open" | "answered" | "defaulted" | "withdrawn";
  answer?: { optionId?: string; value?: unknown; note?: string; by: string };
  /** PIP-JOURNEY N15: the plan's `rights` node for a likeness or logo; only the person answers it */
  rights?: { asset: string; private: true };
  /** v0.3: Pip holds the run until this is answered (from "pip", kind "single"); the crew can't decide it for you */
  hold?: boolean;
};

/** the resolved timeline as JSON (the server's Timeline without its `at` function) */
export type TimelineJSON = {
  cues: { id: string; text: string; start: number; end: number }[];
  hold: number;
  endHold: number;
  duration: number;
  scenes: { id: string; from: number; to: number }[];
  events: Record<string, number>;
};

export type FileRow = { name: string; url: string; bytes: number; kind: "video" | "subtitles" | "audio" | "image" };

// ---- optional extensions: not in API.md v1. The mock fills them; every view works without them. ----
export type SceneVersion = "render" | "animatic" | "board" | "slate";
export type ClipState = "planned" | "drafting" | "ready" | "stale" | "approval" | "locked";
export type SceneStatus = { version: SceneVersion; stale: boolean; state: ClipState; by?: Role };
export type Finding = {
  id: string;
  t: number;
  scene?: string;
  severity: "error" | "warning" | "info";
  text: string;
  fix?: string;
};
export type ArtAsset = {
  id: string;
  label: string;
  chosen?: string;
  variants: { id: string; img: string; score?: number; reason?: string }[];
};
export type CrewState = "idle" | "running" | "pausing" | "paused";
export type CrewInfo = {
  state?: CrewState;
  running?: boolean;
  paused?: boolean;
  stage?: Stage;
  lastActiveAt?: string | null;
  queued?: number;
  /** docs/API.md: the slots per endpoint, plus "render" (PIP-JOURNEY N6: the ghost popover's "3 are working") */
  slots?: Record<string, { size: number; used: number }>;
  /** when the current (or last) run started: failures before it belong to an older run */
  runStartedAt?: string | null;
  /** the run is held for the person, and why (a rejected key, Pip's hold) */
  held?: string | null;
};
/** fix_key: open Settings → Providers on `provider` (a rejected key, no credit, a provider turned off) */
export type ProblemAction = "retry" | "change_model" | "add_budget" | "fix_key";
/** extension: the one sentence the person sees, and the one problem the crew can't fix alone */
export type ProjectStatus = {
  line: string;
  /** no longer read: older servers and drafts still send it */
  phase?: number;
  etaSec?: number;
  problem?: { text: string; action: ProblemAction; taskId: string; provider?: string };
  /** the crew waits on a card in Pip's thread (not a problem): the plan change, or the budget */
  waiting?: "plan" | "budget";
};
export type Milestone = {
  id: string;
  at: string;
  text: string;
  image?: string;
  /** PIP-ORCHESTRATION §4.1 ("plan" is new); optional: older servers send none */
  kind?: "gate" | "answer" | "stage" | "export" | "change" | "plan";
};
/** one line of a task's transcript (GET …/tasks/:tid/transcript, and live as the `activity` event) */
export type ActivityKind = "step" | "model" | "tool" | "patch" | "answer" | "error";
export type ActivityEntry = {
  at: string;
  kind: ActivityKind;
  title: string;
  detail?: unknown;
  thinking?: string;
  /** a data: URL */
  image?: string;
};

/** a model call as it streams (docs/API.md, the `progress` event); tokens are estimated from characters */
export type TaskProgress = {
  taskId: string;
  phase: "thinking" | "writing";
  tokens: number;
  seconds: number;
  /** the newest part of the answer so far */
  tail: string;
  /** a drawing's raw answer so far (DrawOut JSON), for the live canvas */
  draft?: string;
  /** the drawing's palette letters → colours */
  palette?: Record<string, string>;
};

export type ProjectState = {
  doc: ProjectT;
  rev: number;
  timeline: TimelineJSON;
  stage: Stage;
  gates: Gate[];
  tasks: Task[];
  questions: QuestionT[];
  notes: Note[];
  budget: { capUsd: number; spentUsd: number; reservedUsd: number; estTotalUsd: [number, number] | null };
  time: { startedAt: string | null; etaSec: [number, number] | null; deadline: string | null };
  files: FileRow[];
  digest: string;
  // extensions (optional)
  sceneStatus?: Record<string, SceneStatus>;
  findings?: Finding[];
  art?: ArtAsset[];
  /** the crew's run: `state` is the older shape; the server now sends running / paused / stage / lastActiveAt / queued */
  crew?: CrewInfo;
  status?: ProjectStatus;
  milestones?: Milestone[];
  /** client only: live activity per task id, the newest ~500 each */
  activity?: Record<string, ActivityEntry[]>;
  /** client only: each working task's live model call (the `progress` event), dropped when its answer lands */
  progress?: Record<string, TaskProgress>;
  /** PIP-ORCHESTRATION §4.1: the production plan and the crew instances (optional until the server sends them) */
  plan?: PlanView | null;
  instances?: Instance[];
  /** what waits on the person, cards included, as last fetched (older servers send none); `waiting` is the plan's
   * waits on the person that no gate or question stands for */
  needs?: { count: number; words: string | null; waiting?: number };
  /** what the project has, and every export oldest first (optional until every server and the mock send them) */
  parts?: Parts;
  versions?: Version[];
};

export type Session = {
  version: string;
  token: string;
  /** libraryDir: where publish writes (the person's library); seedDir: the repo's read-only seed */
  workspace: { roots: string[]; libraryDir: string; seedDir?: string };
};

export type ProviderKind = "anthropic" | "openai" | "openrouter" | "lmstudio" | "ollama" | "llamacpp" | "custom";
export type Provider = {
  id: string;
  kind: ProviderKind;
  label: string;
  baseUrl: string;
  hasKey: boolean;
  enabled: boolean;
};
export type Profile = "best" | "balanced" | "local" | "custom";
export type Involvement = "every" | "key" | "auto";
export type Effort = "low" | "medium" | "high";
export type Settings = {
  providers: Provider[];
  profile: Profile;
  roles: Record<Role, { model: string; fallback?: string }>;
  defaults: {
    capUsd: number;
    askAtFraction: number;
    involvement: Involvement;
    concurrency: number;
    /** Pip's revision of the rules plan: applied, logged only, or not called */
    pipPlan?: "on" | "shadow" | "off";
    /** review rounds per crew run: 2 = one review plus one round that checks the fixes */
    reviewRounds?: 1 | 2;
    /** the highest thinking effort any call may send (a prompt card picks its own, up to this); default medium */
    effortCeiling?: Effort;
    /** drawings per new asset: 1 = no judge (the drawing is cast), 2-3 = the Art Director picks; default 2 */
    variants?: number;
  };
  paths: { roots: string[]; library: string; ffmpeg: string };
};
export type Cap = "passed" | "claimed" | "failed" | "unknown";
export type ModelRow = {
  id: string;
  provider: string;
  label: string;
  local: boolean;
  caps: { vision: Cap; structured: Cap; tools: Cap; longOutput: Cap };
  ctx: number;
  maxOut: number;
  price: { inPerMTok: number; outPerMTok: number; source: "table" | "provider" | "manual" } | null;
  speed: { ttftMs: number; tokPerSec: number; samples: number } | null;
  spend30dUsd: number;
  fit?: Record<Role, number>;
};

export type LibraryAsset = {
  id: string;
  kind: string;
  w: number;
  h: number;
  frames: number;
  tags: string[];
  /** missing means public */
  scope?: "public" | "private";
  description?: string;
  /** where it lives: the repo's seed, the person's own library, or one project's assets/ (missing: from scope) */
  layer?: LibraryLayer;
  /** the project a "project" asset belongs to */
  project?: { id: string; title: string };
  /** its preview sheet's URL, when it isn't the library's /api/library/:id/sheet.png */
  sheet?: string;
};
export type LibraryLayer = "seed" | "user" | "project";
/** the three folders assets come from */
export type LibraryDirs = {
  seed: string;
  user: string;
  userExists: boolean;
  projects: { id: string; title: string; dir: string; assets: number }[];
};
export type LibraryIndex = { palette: string; assets: LibraryAsset[]; dirs?: LibraryDirs };

export type ApiErrorBody = { code: string; message: string; fix?: string; path?: string };

// ---- SSE ----
export type ServerEvent =
  | { event: "patch"; data: PatchEntryT }
  | { event: "task"; data: Task }
  | { event: "question"; data: QuestionT }
  | { event: "note"; data: Note }
  | { event: "gate"; data: Gate }
  | { event: "ledger"; data: { usd: number; spentUsd: number; reservedUsd: number; model: string; role: Role } }
  | { event: "digest"; data: { text: string } }
  | { event: "render"; data: { kind: "proxy" | "still" | "final"; url: string } }
  | { event: "log"; data: { level: string; text: string; role?: Role } }
  | { event: "stage"; data: { stage: Stage } }
  /** extension: the plain status line and the problem, if any */
  | { event: "status"; data: ProjectStatus }
  /** extension: one more thing finished, in plain words */
  | { event: "milestone"; data: Milestone }
  /** one more transcript line for a task, as it happens (no persisted id) */
  | { event: "activity"; data: ActivityEntry & { task: string } }
  /** transient: a working task's model call as it streams (`what: "task"`), or the export's share done */
  | { event: "progress"; data: ({ what: "task" } & TaskProgress) | { what: "export"; fraction: number } }
  /** extension: merge these top-level fields (the mock uses it for sceneStatus, findings, art, crew, files, time) */
  | { event: "x-state"; data: Partial<ProjectState> }
  /** Pip's progress on this project's conversation (or the workspace one on /api/events) */
  | { event: "pip"; data: PipEvent }
  /** one more message between Pip and the crew */
  | { event: "channel"; data: ChannelMsg }
  /** PIP-ORCHESTRATION §4.3: the plan view; `revision` only on a new revision */
  | { event: "plan"; data: { view: PlanView; revision?: PlanRevisionSummary } }
  /** PIP-ORCHESTRATION §4.3: one instance changed (derived, transient) */
  | { event: "instance"; data: { instance: Instance; change: InstanceChange } }
  /** what the project has, sent (transient) when it changes: after a patch, a scene's status, a stage or an export */
  | { event: "parts"; data: Parts };

export type ConnState = "connecting" | "open" | "retrying";

// ---- Pip, the assistant (docs/ASSISTANT.md) ----
export type PipFile = { name: string; kind: string; sizeBytes: number; url: string };
export type PipAdded = { name: string; status: "connected" | "failed"; tools: string[]; error?: string; fix?: string };
export type PipCard =
  | { id: string; type: "files"; files: PipFile[] }
  | {
      id: string;
      type: "plan";
      title: string;
      detail: string;
      who: RoleT[];
      usd: [number, number] | null;
      sec: [number, number] | null;
      effects: string[];
      warning?: string;
      confirmLabel: string;
      editable?: { field: string; label: string; value: string };
      /** external tools lent to the crew for this task: "server.tool" */
      lend?: string[];
      status: "proposed" | "running" | "done" | "declined" | "failed";
      /** `draftId` (PIP-JOURNEY N25): "Make another like this" made this draft; the stage goes to /new/:draftId */
      result?: { text: string; files?: PipFile[]; projectId?: string; error?: string; draftId?: string };
      /** PIP-JOURNEY N2: the instances, when `who` can't say which ("Animator · scene 2") */
      whoInstances?: { instance: string; label: string }[];
      /** PIP-ORCHESTRATION §4.4: a revision over the 20% line, or a change */
      revision?: {
        rev: number;
        ops: PlanRevisionSummary["ops"];
        fromUsd: number;
        toUsd: number;
        /** who re-planned: the Director when the storyboard expanded, Pip, the Producer (budget), the Reviewer */
        planner?: Role | "pip";
      };
    }
  | { id: string; type: "cant"; text: string; nearest?: string }
  /** v0.3: a problem only the person can fix, as a card in Pip's reply (a rejected key: "Fix the key") */
  // `action` may be missing: the server's publicCard strips a card's `action`; a fix card without one is "fix_key"
  | { id: string; type: "fix"; text?: string; action?: ProblemAction; fix?: ProblemAction; provider?: string }
  | {
      id: string;
      type: "form";
      form: "mcp_add";
      title: string;
      detail: string;
      status: "open" | "submitted" | "done" | "failed";
      result?: { added: PipAdded[] };
    }
  /** PIP-ORCHESTRATION §4.4: the one question card on /new (3 fields or fewer) */
  | {
      id: string;
      type: "form";
      form: "brief_fields";
      title: string;
      detail?: string;
      fields: BriefFieldAsk[];
      status: "open" | "submitted" | "done" | "superseded";
      values?: Partial<Record<BriefFieldKey, unknown>>;
    }
  /** PIP-ORCHESTRATION §4.4: the brief card; its confirm is Start */
  | {
      id: string;
      type: "brief";
      title: string;
      fields: { key: BriefFieldKey; label: string; value: string }[];
      refs: (DraftRef & { label: string })[];
      estimate: { usd: [number, number]; sec: [number, number]; rough: boolean };
      eta: { readyAt: string; deadline: string | null; late: boolean };
      preview: { crew: number; roles: Role[]; tasks: number; newArt: number; fromLibrary: boolean; line: string };
      /** extension: the picks line ("You'll pick 3 times: …"); the UI builds one from `preview` when missing */
      picks?: string;
      warning?: string;
      status: "open" | "started" | "superseded";
      result?: { projectId: string };
    };
/** how a Pip turn ran, stored on its item (for /why) */
export type PipTrace = {
  tools: { name: string; ok: boolean; ms?: number }[];
  model?: string;
  mode?: "agent" | "menu" | "command";
  usage?: { inTok?: number; outTok?: number; in?: number; out?: number };
  usd?: number;
  promptVersion?: string;
  /** which cards it made and why */
  cards?: { title: string; why?: string }[];
};
export type PipItem =
  | {
      id: string;
      at: string;
      kind: "user";
      text: string;
      /** extension: the names of the files sent with it (a draft's first message), shown as chips */
      files?: string[];
    }
  | {
      id: string;
      at: string;
      kind: "pip";
      text: string;
      cards: PipCard[];
      model?: string;
      usd?: number;
      trace?: PipTrace;
      /** a /why reply: the trace of the answer it explains */
      why?: PipTrace & { about?: string };
      /** v0.3: Pip couldn't answer, and the fix is the person's (a rejected key): rendered as its one button */
      problem?: { text?: string; action: ProblemAction; provider?: string };
    }
  | { id: string; at: string; kind: "thinking" };
/** Pip's summary of the earlier conversation: everything up to `upTo` is folded into `text` */
export type PipSummary = {
  text: string;
  upTo: string;
  at: string;
  /** what the compact freed in Pip's context, in tokens */
  freed?: { items: number; before: number; after: number; freed: number; method: "count" | "estimate" };
};
/** the `pip` SSE event (assumed shape: the spec names only `type`) */
export type PipEvent =
  | { type: "thinking"; done?: boolean }
  | { type: "item"; item: PipItem }
  | { type: "card"; card: PipCard; itemId?: string }
  | { type: "error"; message: string }
  /** after /compact or an auto-compact (assumed shape) */
  | { type: "summary"; summary: PipSummary };
/** GET /api/pip/context: what Pip's model holds right now */
export type PipContextPart = {
  id: "system" | "facts" | "tools" | "summary" | "messages" | "reserve";
  label: string;
  tokens: number;
  detail?: string;
};
export type PipContext = {
  model: string;
  provider?: string;
  window: number | null;
  method: "count" | "estimate";
  mode?: "agent" | "menu";
  total: number;
  parts: PipContextPart[];
  /** where the window size came from */
  windowSource?: "provider" | "table" | "unknown";
  /** how the tokens were counted: "anthropic count_tokens", "llama.cpp /tokenize", "chars/4 × 1.12 from 40 calls" */
  countSource?: string;
};
export type PipConversation = {
  items: PipItem[];
  name: string;
  model?: string;
  mode?: "agent" | "menu";
  /** a turn is running (the page opened mid-answer) */
  busy?: boolean;
  /** assumed: the current summary, when the conversation was compacted */
  summary?: PipSummary | null;
};
export type PipDecision = {
  project?: string;
  decision: "confirm" | "decline";
  edit?: string;
  /** PIP-ORCHESTRATION §4.5: a draft's conversation, and a brief_fields card's answers */
  draft?: string;
  values?: Partial<Record<BriefFieldKey, unknown>>;
};

// ---- the crew channel: Pip directing the crew ("Behind the scenes") ----
export type ChannelKind = "brief" | "report" | "ask" | "answer";
export type ChannelMsg = {
  id: string;
  at: string;
  /** "pip" or a role */
  from: string;
  to: string;
  kind: ChannelKind;
  text: string;
  ref?: string;
  replyTo?: string;
};

// ---- connections: the person's own MCP servers ----
export type ConnectionTrust = "ask" | "read_only";
export type Connection = {
  name: string;
  transport: "stdio" | "http";
  command?: string;
  args?: string[];
  url?: string;
  status: "connected" | "failed" | "off";
  error?: string;
  fix?: string;
  tools: string[];
  enabled: boolean;
  trust: ConnectionTrust;
  /** names only: values never come back */
  envKeys?: string[];
  headerKeys?: string[];
};

export type CreateProjectInput = {
  title: string;
  brief: ProjectT["brief"];
  budgetUsd: number;
  dir?: string;
  /** PIP-ORCHESTRATION §4.5: start this draft (moves its files and conversation) */
  draft?: string;
};

export type AnswerInput = { optionId?: string; value?: unknown; note?: string };
export type GateVerdict = { verdict: "approve" | "approve_notes" | "changes"; items?: string[]; reasons?: string[] };
export type NoteInput = { target: NoteTarget; category: NoteCategory; text?: string; assignee?: Role | "producer" };

/** One client, two backends: HTTP against the server, or the in-browser mock. */
export interface Client {
  readonly mock: boolean;
  session(): Promise<Session>;
  projects(): Promise<ProjectSummary[]>;
  createProject(input: CreateProjectInput): Promise<{ id: string }>;
  project(id: string): Promise<ProjectState>;
  history(id: string, since?: number): Promise<PatchEntryT[]>;
  patch(id: string, body: { ops: PatchOpT[]; reason: string; baseRev: number }): Promise<{ rev: number; seq: number }>;
  undo(id: string, seq: number, reason: string): Promise<{ rev: number; seq: number }>;
  /** an image URL for the frame at scene time t; `rev` asks for an older revision (extension, for before/after) */
  frameUrl(id: string, t: number, scale?: number, rev?: number): string;
  /** the project's run report page (`GET /api/p/:id/report/`, docs/REPORT.md), opened in a new tab */
  reportUrl(id: string): string;
  proxyUrl(id: string): string;
  fileUrl(id: string, name: string): string;
  answer(id: string, qid: string, a: AnswerInput): Promise<QuestionT>;
  addNote(id: string, n: NoteInput): Promise<Note>;
  gate(id: string, gate: GateId, v: GateVerdict): Promise<Gate>;
  crewRun(id: string, stage?: Stage): Promise<void>;
  /** POST …/export: the local render of the next version (no model calls); 409 while a crew runs */
  exportVideo(id: string): Promise<{ file: string; v: number }>;
  crewPause(id: string, mode: "after_step" | "now"): Promise<void>;
  crewResume(id: string): Promise<void>;
  /** extension: POST …/crew/retry { taskId }; falls back to crew/run for `stage` when the server has no retry */
  crewRetry(id: string, taskId: string, stage?: Stage): Promise<void>;
  /** extension: the agent transcript of a task; null when the server has none */
  transcript(id: string, taskId: string): Promise<string | null>;
  /** a task's transcript as entries, oldest first; null when the server keeps none */
  taskTranscript(id: string, taskId: string): Promise<ActivityEntry[] | null>;
  uploadVo(id: string, body: Blob, take: string): Promise<{ file: string }>;
  align(id: string, file: string): Promise<{ proposal: { cue: string; start: number; end: number }[] }>;
  settings(): Promise<Settings>;
  saveSettings(partial: Partial<Settings>): Promise<Settings>;
  saveKey(provider: string, key: string): Promise<{ hasKey: true }>;
  testProvider(provider: string): Promise<{ ok: boolean; models: string[]; error?: string }>;
  models(): Promise<ModelRow[]>;
  library(): Promise<LibraryIndex>;
  sheetUrl(assetId: string): string;
  /** Pip: the conversation for a project, or the workspace one when project is omitted */
  pip(project?: string, opts?: { draft?: string }): Promise<PipConversation>;
  /** 202 { turnId }; a busy conversation rejects with an ApiError of status 409 */
  pipAsk(
    project: string | undefined,
    text: string,
    opts?: { draft?: string; about?: { instance: string } },
  ): Promise<{ turnId: string }>;
  pipCard(cardId: string, d: PipDecision): Promise<PipCard | null>;
  /** the workspace stream (/api/events): Pip's workspace-level events */
  subscribeWorkspace(on: (e: ServerEvent) => void, onConn?: (s: ConnState) => void): () => void;
  /** GET /api/pip/context: what Pip's model holds right now (the /context view) */
  pipContext(project?: string): Promise<PipContext>;
  /** PUT /api/pip/summary: the person's correction to Pip's summary */
  pipSummary(project: string | undefined, text: string): Promise<PipSummary>;
  /** the crew channel's history */
  channel(project: string): Promise<ChannelMsg[]>;
  connections(): Promise<Connection[]>;
  addConnections(json: string): Promise<{ added: PipAdded[] }>;
  updateConnection(name: string, patch: { enabled?: boolean; trust?: ConnectionTrust }): Promise<Connection | null>;
  removeConnection(name: string): Promise<void>;
  testConnection(name: string): Promise<Connection | null>;
  /** subscribe to a project's events; returns an unsubscribe */
  subscribe(id: string, on: (e: ServerEvent) => void, onConn?: (s: ConnState) => void): () => void;
  // ---- /new as a conversation (PIP-ORCHESTRATION §3.1, §4.5; the server has these from P3, the mock now) ----
  /** POST /api/drafts { from? }: the first item is Pip's "What are we making?" */
  createDraft(from?: string): Promise<{ draft: Draft; items: PipItem[] }>;
  /** GET /api/drafts/:id */
  draft(id: string): Promise<{ draft: Draft; items: PipItem[] }>;
  /** DELETE /api/drafts/:id: the folder goes too */
  deleteDraft(id: string): Promise<void>;
  /** DELETE /api/p/:id[?trash=1]: off the list; the folder stays, or moves to the app's trash */
  removeProject(id: string, opts?: { trash?: boolean }): Promise<{ dir: string; trashed: string | null }>;
  /** POST /api/drafts/:id/files?name= (raw body) */
  draftFile(id: string, name: string, body: Blob): Promise<{ ref: DraftRef }>;
  /** PATCH /api/drafts/:id/refs/:name: the rights chips */
  draftRef(id: string, name: string, patch: { type?: RefType; rights?: DraftRef["rights"] }): Promise<DraftRef>;
  /** PATCH /api/drafts/:id { fields } (PIP-JOURNEY N7): the composer's edits, no model call */
  draftFields(id: string, fields: Draft["fields"]): Promise<Draft>;
  /** GET /api/drafts/:id/composer: the composer's prefill */
  draftComposer(id: string): Promise<DraftComposer>;
  /** GET /api/workspace/line: Pip's line on Projects, built from state */
  workspaceLine(): Promise<WorkspaceLine>;
  // ---- Pip runs the show, P2 (PIP-ORCHESTRATION §4.5) ----
  /** GET /api/p/:id/instances/:iid/log: a member's kept log; null when the server has none (404) */
  instanceLog(id: string, iid: string): Promise<InstanceLog | null>;
  /** GET /api/p/:id/plan/revisions: every plan revision, oldest first; [] when the server has none */
  planRevisions(id: string): Promise<PlanRevisionSummary[]>;
  // ---- v0.3 ----
  /** POST /api/p/:id/changes/preview: who a change goes to and what it costs, with no model call; null when the
   * server has no such route */
  changesPreview(id: string, body: ChangesPreviewInput): Promise<ChangesPreview | null>;
  /** GET /api/build: whether the served web build is older than its sources; null when the server can't say */
  build(): Promise<BuildInfo | null>;
}

export type ChangesPreviewInput = { gate?: GateId; text: string; items?: string[] };
/** the routed change, dry: the member it goes to (and every role it touches), the scenes, the price and the time */
export type ChangesPreview = {
  role: Role;
  roles: Role[];
  scenes: string[];
  usd: [number, number];
  sec: [number, number];
  summary: string;
};
export type BuildInfo = { webStale: boolean; builtAt: string | null; srcAt: string | null };

// ---- Pip runs the show (PIP-ORCHESTRATION §4.2, the wire contract; PIP-JOURNEY for what the UI does with it) ----
export type PlanGate = "g0_brief" | "g1_script" | "g2_animatic" | "rights" | "g3_rough" | "g4_final";
export type Tier = "role" | "strong" | "light";
export type PlanTaskStatus =
  | "pending"
  | "ready"
  | "running"
  | "waiting_person"
  | "done"
  | "skipped"
  | "failed"
  | "dropped";
export type PlanTaskView = {
  id: string;
  kind: string;
  role: Role | "person";
  gate?: PlanGate;
  scene?: string;
  asset?: string;
  round?: number;
  instance: string;
  label: string;
  stage: Stage;
  dependsOn: string[];
  tier: Tier;
  /** resolved */
  model: string | null;
  estUsd: [number, number];
  conditional: boolean;
  status: PlanTaskStatus;
  taskIds: string[];
  addedIn: number;
  reason?: string;
};
export type PlanView = {
  rev: number;
  at: string;
  by: "rules" | "pip" | "person" | "code";
  reason: string;
  tasks: PlanTaskView[];
  /** spent + remaining */
  estimate: { usd: [number, number]; sec: [number, number]; rough: boolean };
  approvedUsd: number | null;
  pip: { mode: "on" | "shadow" | "off"; proposals: number; max: 6 };
  pending?: { rev: number; cardId: string; tasks: string[] };
};
export type PlanRevisionSummary = {
  rev: number;
  at: string;
  by: PlanView["by"];
  trigger: string;
  reason: string;
  ops: { op: "add" | "drop" | "retier" | "expand" | "trim"; task: string; label: string; reason: string }[];
  deltaUsd: [number, number];
};
export type InstanceChange = "spawn" | "ghost" | "live" | "idle" | "end" | "revive";
export type Instance = {
  /** the key: "animator:s03" */
  id: string;
  role: Role;
  /** "Animator · scene 3" */
  label: string;
  subject?: { scene?: string; asset?: string };
  model: string | null;
  state: "planned" | "live" | "idle" | "finished";
  /** the server's horizon rule (PIP-ORCHESTRATION §2) */
  ghost: boolean;
  running: number;
  spawnedAt: string | null;
  endedAt: string | null;
  /** D5: a return opens a new life; `reason` is PIP-JOURNEY N1 (the return's line) */
  lives: { from: string; to: string | null; reason?: string }[];
  /** the spawn line, in Pip's words */
  reason: string;
  endReason?: string;
  tasks: string[];
  usd: number;
  outcome: "done" | "partial" | "stopped" | "failed" | null;
  lastReport?: { status: "done" | "partial" | "blocked"; did: string; couldnt?: string };
};
export type BriefFieldKey =
  | "idea"
  | "title"
  | "audience"
  | "lengthSec"
  | "narration"
  | "budget"
  | "deadline"
  | "involvement"
  | "profile"
  | "style"
  | "references";
export type BriefFieldAsk = {
  key: BriefFieldKey;
  label: string;
  type: "choice" | "number" | "text" | "date" | "tags" | "files";
  options?: { id: string; label: string; detail?: string }[];
  recommended?: string | number;
  min?: number;
  max?: number;
  step?: number;
  unit?: string;
  /** for `files`: the draft's refs (DraftRef[]) whose rights the card asks */
  value?: unknown;
};
export type RefType = "likeness" | "logo" | "style" | "as-is" | "sound" | "voice";
export type DraftRef = {
  name: string;
  url: string;
  bytes: number;
  type: RefType;
  rights: "mine" | "licensed" | "unsure";
  private: true;
};
export type Draft = {
  id: string;
  createdAt: string;
  updatedAt: string;
  title: string | null;
  fields: Partial<Record<BriefFieldKey, unknown>>;
  source: Partial<Record<BriefFieldKey, "said" | "asked" | "default">>;
  refs: DraftRef[];
  from?: string;
};
export type DraftComposer = { title: string; brief: Partial<ProjectT["brief"]>; budgetUsd: number; profile: Profile };
export type WorkspaceLine = {
  text: string;
  parts: { projectId: string; kind: "finished" | "working" | "waiting" | "failed"; text: string }[];
};
/** a `pip` event on /api/events carries the draft it belongs to (PIP-ORCHESTRATION §4.3) */
export type PipEventOnWire = PipEvent & { draft?: string };
/** GET /api/p/:id/instances/:iid/log (PIP-ORCHESTRATION §4.5): its tasks' transcripts and its messages with Pip */
export type InstanceLogEntry =
  | ({ at: string; source: "task"; taskId: string } & ActivityEntry)
  | { at: string; source: "channel"; msg: ChannelMsg };
export type InstanceLog = { instance: Instance; entries: InstanceLogEntry[] };
