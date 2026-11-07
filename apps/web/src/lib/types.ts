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
};

export type TaskStatus =
  | "upcoming"
  | "queued"
  | "working"
  | "waiting_user"
  | "waiting"
  | "done"
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
  crew?: { state: CrewState };
};

export type Session = { version: string; token: string; workspace: { roots: string[]; libraryDir: string } };

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
export type Settings = {
  providers: Provider[];
  profile: Profile;
  roles: Record<Role, { model: string; fallback?: string }>;
  defaults: { capUsd: number; askAtFraction: number; involvement: Involvement; concurrency: number };
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
  /** not in library/index.json yet; missing means public */
  scope?: "public" | "private";
  description?: string;
};
export type LibraryIndex = { palette: string; assets: LibraryAsset[] };

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
  /** extension: merge these top-level fields (the mock uses it for sceneStatus, findings, art, crew, files, time) */
  | { event: "x-state"; data: Partial<ProjectState> };

export type ConnState = "connecting" | "open" | "retrying";

export type CreateProjectInput = {
  title: string;
  brief: ProjectT["brief"];
  budgetUsd: number;
  dir?: string;
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
  proxyUrl(id: string): string;
  fileUrl(id: string, name: string): string;
  answer(id: string, qid: string, a: AnswerInput): Promise<QuestionT>;
  addNote(id: string, n: NoteInput): Promise<Note>;
  gate(id: string, gate: GateId, v: GateVerdict): Promise<Gate>;
  crewRun(id: string, stage?: Stage): Promise<void>;
  crewPause(id: string, mode: "after_step" | "now"): Promise<void>;
  crewResume(id: string): Promise<void>;
  /** extension: the agent transcript of a task; null when the server has none */
  transcript(id: string, taskId: string): Promise<string | null>;
  uploadVo(id: string, body: Blob, take: string): Promise<{ file: string }>;
  align(id: string, file: string): Promise<{ proposal: { cue: string; start: number; end: number }[] }>;
  settings(): Promise<Settings>;
  saveSettings(partial: Partial<Settings>): Promise<Settings>;
  saveKey(provider: string, key: string): Promise<{ hasKey: true }>;
  testProvider(provider: string): Promise<{ ok: boolean; models: string[]; error?: string }>;
  models(): Promise<ModelRow[]>;
  library(): Promise<LibraryIndex>;
  sheetUrl(assetId: string): string;
  /** subscribe to a project's events; returns an unsubscribe */
  subscribe(id: string, on: (e: ServerEvent) => void, onConn?: (s: ConnState) => void): () => void;
}
