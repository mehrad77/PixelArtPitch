// The project store: opens project folders, applies validated patches (with history and undo), keeps the runtime state
// the UI shows (stage, gates, tasks, questions, notes, digest) and an event log the UI follows over SSE.
// One process writes a project at a time: a lock file in the folder holds the writer's pid.
import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";
import { LIBRARY_DIR, type LoadedProject, openDoc, openRenderer, png, type Renderer } from "@pap/render";
import {
  applyPatch,
  overlaps,
  type PatchEntryT,
  type PatchOpT,
  Project,
  type ProjectT,
  resolveTimeline,
} from "@pap/schema";
import { Question, QuestionInput, type QuestionT } from "./registry.ts";
import { cutWords, type PlainCtx, plainText } from "./words.ts";

export const PAP_HOME = process.env.PAP_HOME ?? join(homedir(), ".pixelartpitch");

export type Stage = "brief" | "script" | "storyboard" | "art" | "animate" | "narrate" | "sound" | "review" | "deliver";
export const STAGES: Stage[] = [
  "brief",
  "script",
  "storyboard",
  "art",
  "animate",
  "narrate",
  "sound",
  "review",
  "deliver",
];
export type TaskStatus =
  | "upcoming"
  | "queued"
  | "working"
  | "waiting_user"
  | "waiting"
  | "done"
  /** it ended on a stand-in (kept as built, lints only, a library asset): a retry redoes it */
  | "partial"
  | "failed"
  | "cancelled";
export type Task = {
  id: string;
  kind: string;
  role: string;
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
  transcript?: string;
  /** a later task of the same role and kind replaced this one (a retry); human views hide it */
  supersededBy?: string;
  attempt?: number;
  /** the production plan task this row is an attempt at (docs/PIP-ORCHESTRATION.md §1.2) */
  planTask?: string;
  /** the crew member it belongs to: "writer", "animator:s03", "pixel-artist:founder" */
  instance?: string;
};
export type GateId = "g0_brief" | "g1_script" | "g2_animatic" | "g3_rough" | "g4_final";
export type Gate = {
  id: GateId;
  status: "locked" | "open" | "passed" | "changes";
  items: { label: string; ref?: string }[];
  verdict?: { by: string; verdict: string; reasons?: string[]; note?: string; at: string };
};
export type Note = {
  id: string;
  target: { scene?: string; cue?: string; asset?: string; range?: [number, number]; track?: string };
  category: "too_fast" | "too_slow" | "unclear" | "art" | "sound" | "text" | "other" | "story" | "scene" | "timing";
  text: string;
  assignee: string;
  status: "open" | "picked_up" | "proposed" | "done" | "declined";
  reason?: string;
  createdAt: string;
  by: string;
};
/** one message on the crew channel (runs/channel.jsonl), shown to people as "Behind the scenes" */
export type ChannelMsg = {
  id: string;
  at: string;
  /** "pip" or a role */
  from: string;
  to: string;
  kind: "brief" | "report" | "ask" | "answer";
  text: string;
  /** a scene, cue, note or task id */
  ref?: string;
  replyTo?: string;
};

export type RuntimeState = {
  stage: Stage;
  gates: Gate[];
  tasks: Task[];
  questions: QuestionT[];
  notes: Note[];
  digest: string;
  startedAt: string | null;
  paused: boolean;
  /** a crew run was in progress; if the process dies, the next start resumes it */
  running?: boolean;
  files: { name: string; bytes: number; kind: string }[];
  /** what a person reads: one plain line, the phase (0-4), and an unrecovered problem if any */
  status: {
    line: string;
    phase: number;
    problem?: {
      text: string;
      /** fix_key: Settings → Providers on `provider` (a rejected key, no credit, a provider turned off) */
      action: "retry" | "change_model" | "add_budget" | "fix_key";
      taskId?: string;
      /** the provider the problem is with ("anthropic", "lmstudio") */
      provider?: string;
      /** the failure kind behind it (errorKind: auth, credit, unreachable, …) */
      kind?: string;
    };
    /** the crew waits on a card in Pip's thread (not a problem): the plan change, or the budget */
    waiting?: "plan" | "budget";
  };
  milestones: { id: string; at: string; text: string; image?: string }[];
  /** a person's change the crew is making (kept across restarts, so a resumed run still reports on it) */
  change?: { notes: string[]; scope?: string[]; reboard?: string[]; assets?: string[]; startedAt: string };
  sceneStatus: Record<
    string,
    { version: "slate" | "board" | "animatic" | "render"; state: "planned" | "drafting" | "ready" | "stale" }
  >;
};

const GATE_ITEMS: Record<GateId, string> = {
  g0_brief: "Brief and budget",
  g1_script: "Script",
  g2_animatic: "Animatic (pacing before art)",
  g3_rough: "Rough cut",
  g4_final: "Final cut",
};
const freshState = (): RuntimeState => ({
  stage: "brief",
  gates: (Object.keys(GATE_ITEMS) as GateId[]).map((id) => ({
    id,
    status: "locked",
    items: [{ label: GATE_ITEMS[id] }],
  })),
  tasks: [],
  questions: [],
  notes: [],
  digest: "",
  startedAt: null,
  paused: false,
  files: [],
  status: { line: "Waiting to start", phase: 0 },
  milestones: [],
  sceneStatus: {},
});

export class StoreError extends Error {
  readonly code: string;
  readonly fix?: string;
  readonly status: number;
  constructor(code: string, message: string, fix?: string, status = 400) {
    super(message);
    this.code = code;
    this.fix = fix;
    this.status = status;
  }
}

const atomicWrite = (file: string, data: string | Uint8Array) => {
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, data);
  renameSync(tmp, file);
};

/** a tiny async mutex: one patch at a time per project */
class Mutex {
  private p: Promise<void> = Promise.resolve();
  run<T>(fn: () => Promise<T> | T): Promise<T> {
    const next = this.p.then(fn, fn) as Promise<T>;
    this.p = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }
}

export type PapEvent = { seq: number; event: string; data: unknown; ts: string };
/** a finished video in out/: an .mp4 that isn't the rough cut's proxy (out/proxy.mp4) */
export const isFinalVideo = (f: { name: string; kind: string }) => f.kind === "video" && f.name !== "proxy.mp4";

/** a line in Pip's chat for something that happened, derived from the event log (times are the events' own) */
export type Marker = {
  id: string;
  at: string;
  kind: "gate" | "answer" | "stage" | "export" | "change" | "plan";
  text: string;
  image?: string;
};
const GATE_WORD: Record<string, string> = {
  g0_brief: "the brief",
  g1_script: "the script",
  g2_animatic: "the animatic",
  g3_rough: "the rough cut",
  g4_final: "the final cut",
};
const READY_WORD: Record<string, string> = {
  g0_brief: "Brief ready for you",
  g1_script: "Script angles ready for you",
  g2_animatic: "Animatic ready",
  g3_rough: "Rough cut ready",
  g4_final: "Final cut ready",
};
/** a marker's words as a person reads them: plain (no ids), cut on a word boundary */
export function plainMarker(m: Marker, ctx: PlainCtx = {}): Marker {
  return { ...m, text: cutWords(plainText(m.text, ctx), 140) };
}
/** one event's marker, if it is one; `prev` is the gate's last status (a repeat of it is no news) */
export function markerOf(e: PapEvent, prev?: string): Marker | null {
  const d = e.data as any;
  if (e.event === "milestone" && d?.text)
    return {
      id: String(d.id).includes("@") ? String(d.id) : `${d.id}@${e.seq}`,
      at: String(d.at ?? e.ts),
      kind: String(d.id).startsWith("deliver.export") ? "export" : String(d.id).startsWith("plan.") ? "plan" : "stage",
      text: String(d.text),
      ...(d.image ? { image: d.image } : {}),
    };
  if (e.event === "gate" && d?.id && d.status !== prev) {
    const by = d.verdict?.by;
    if (d.status === "open")
      return { id: `${d.id}:open@${e.seq}`, at: e.ts, kind: "gate", text: READY_WORD[d.id] ?? d.id };
    if (d.status === "passed" && d.id === "g1_script") {
      const label = String(d.items?.[0]?.label ?? "").replace(/^Script:\s*/, "");
      return {
        id: `${d.id}:passed@${e.seq}`,
        at: e.ts,
        kind: by === "user" ? "answer" : "gate",
        text: by === "user" ? `You picked the script: ${label}` : `Script chosen: ${label}`,
      };
    }
    if (d.status === "passed" && by === "user")
      return { id: `${d.id}:passed@${e.seq}`, at: e.ts, kind: "gate", text: `You approved ${GATE_WORD[d.id] ?? d.id}` };
    if (d.status === "changes")
      return {
        id: `${d.id}:changes@${e.seq}`,
        at: e.ts,
        kind: "gate",
        text: `You asked for changes to ${GATE_WORD[d.id] ?? d.id}`,
      };
    return null;
  }
  if (e.event === "question" && d?.status === "answered" && d.answer?.by !== "timeout") {
    const opt = (d.options ?? []).find((o: any) => o.id === d.answer?.optionId);
    const label = opt?.label ?? d.answer?.optionId ?? "";
    const script = /which script/i.test(String(d.question));
    // the script pick passes G1, whose marker says it: the question's own would be the same line twice
    if (script && (d.blocks ?? []).includes("script")) return null;
    return {
      id: `${d.id}:answer@${e.seq}`,
      at: e.ts,
      kind: "answer",
      text: script ? `You picked the script: ${label}` : `You answered "${d.question}": ${label}`,
    };
  }
  if (
    e.event === "pip" &&
    d?.type === "card" &&
    d.card?.type === "plan" &&
    /^Ask the crew: /.test(d.card.title ?? "")
  ) {
    const what = String(d.card.title).replace(/^Ask the crew: /, "");
    if (d.card.status === "done")
      return { id: `${d.card.id}:done`, at: e.ts, kind: "change", text: `Change done: ${what}` };
    if (d.card.status === "failed")
      return { id: `${d.card.id}:failed`, at: e.ts, kind: "change", text: `Change failed: ${what}` };
  }
  return null;
}

export class OpenProject {
  readonly id: string;
  readonly dir: string;
  private _doc: ProjectT;
  private loaded: LoadedProject | null = null;
  private renderer: Promise<Renderer> | null = null;
  private rendererRev = -1;
  private stills = new Map<string, Uint8Array>();
  private mutex = new Mutex();
  private seqHist: number;
  private evSeq: number;
  private waiters = new Map<string, (q: QuestionT) => void>();
  /**
   * the crew's word on an answer to a hold question (`hold: true`), asked before it is recorded: "keep" leaves the
   * question open (an option that can't act yet). Set by the Workspace from `Workspace.onAnswer`.
   */
  answerHook?: (q: QuestionT, a: { optionId?: string; value?: unknown; note?: string }, by: string) => "keep" | void;
  readonly events = new EventEmitter();
  state: RuntimeState;

  constructor(dir: string, id: string) {
    this.dir = dir;
    this.id = id;
    this._doc = Project.parse(JSON.parse(readFileSync(join(dir, "pitch.json"), "utf8")));
    mkdirSync(join(dir, "history"), { recursive: true });
    mkdirSync(join(dir, "runs"), { recursive: true });
    mkdirSync(join(dir, "out"), { recursive: true });
    this.seqHist = this.readHistory().at(-1)?.seq ?? 0;
    const sf = join(dir, "runs", "state.json");
    this.state = existsSync(sf) ? { ...freshState(), ...JSON.parse(readFileSync(sf, "utf8")) } : freshState();
    // tasks that were running when the last process died are not running now
    for (const t of this.state.tasks) if (t.status === "working" || t.status === "queued") t.status = "cancelled";
    this.evSeq = this.lastEventSeq();
    this.events.setMaxListeners(50);
  }

  doc() {
    return this._doc;
  }
  rev() {
    return this._doc.rev;
  }
  timeline() {
    return resolveTimeline(this._doc);
  }
  project(): LoadedProject {
    if (!this.loaded || this.loaded.doc.rev !== this._doc.rev) this.loaded = openDoc(this.dir, this._doc);
    return this.loaded;
  }

  // ---- events ----
  private lastEventSeq() {
    const f = join(this.dir, "runs", "events.jsonl");
    if (!existsSync(f)) return 0;
    const lines = readFileSync(f, "utf8").trimEnd().split("\n");
    const last = lines.at(-1);
    return last ? (JSON.parse(last).seq ?? 0) : 0;
  }
  emit(event: string, data: unknown) {
    const e: PapEvent = { seq: ++this.evSeq, event, data, ts: new Date().toISOString() };
    if (event !== "log" && event !== "progress")
      appendFileSync(join(this.dir, "runs", "events.jsonl"), `${JSON.stringify(e)}\n`);
    this.events.emit("event", e);
    // the chat's markers, live: a derived `milestone` event (not stored; GET derives them from the log again)
    if (event !== "milestone") {
      const prev = event === "gate" ? this.gateSeen.get((data as any)?.id) : undefined;
      const m0 = markerOf(e, prev);
      if (event === "gate") this.gateSeen.set((data as any)?.id, (data as any)?.status);
      const m = m0 ? plainMarker(m0, this.plainCtx()) : null;
      const key = m ? `${m.kind}|${m.text}` : "";
      if (m && key !== this.lastMarker) this.events.emit("event", { seq: 0, event: "milestone", data: m, ts: e.ts });
      if (m) this.lastMarker = key;
    }
    return e;
  }
  private gateSeen = new Map<string, string>();
  /** the last live marker's kind and words: the same again in a row isn't news */
  private lastMarker = "";
  /** every marker in the event log, oldest first */
  markers(): Marker[] {
    const out: Marker[] = [];
    const last = new Map<string, string>();
    const seen = new Set<string>();
    const ctx = this.plainCtx();
    for (const e of this.eventsSince(0)) {
      const m = markerOf(e, e.event === "gate" ? last.get((e.data as any)?.id) : undefined);
      if (e.event === "gate") last.set((e.data as any)?.id, (e.data as any)?.status);
      if (!m || seen.has(m.id)) continue;
      seen.add(m.id);
      const plain = plainMarker(m, ctx);
      // the same words twice in a row are one marker (a pick and the gate it passes)
      const prev = out.at(-1);
      if (prev && prev.kind === plain.kind && prev.text === plain.text) continue;
      out.push(plain);
    }
    return out;
  }
  eventsSince(seq: number): PapEvent[] {
    const f = join(this.dir, "runs", "events.jsonl");
    if (!existsSync(f)) return [];
    return readFileSync(f, "utf8")
      .trimEnd()
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l) as PapEvent)
      .filter((e) => e.seq > seq);
  }
  saveState() {
    atomicWrite(join(this.dir, "runs", "state.json"), JSON.stringify(this.state, null, 1));
  }

  // ---- patches ----
  readHistory(): PatchEntryT[] {
    const f = join(this.dir, "history", "patches.jsonl");
    if (!existsSync(f)) return [];
    return readFileSync(f, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l));
  }
  async history(since = 0) {
    return this.readHistory().filter((h) => h.seq > since);
  }

  patch(
    ops: PatchOpT[],
    opts: {
      reason: string;
      author: PatchEntryT["author"];
      baseRev?: number;
      opId?: string;
      note?: string;
      undoes?: number;
    },
  ): Promise<{ rev: number; seq: number }> {
    return this.mutex.run(() => {
      const hist = this.readHistory();
      if (opts.opId) {
        const prev = hist.find((h) => h.opId === opts.opId);
        if (prev) return { rev: prev.baseRev + 1, seq: prev.seq };
      }
      if (opts.baseRev !== undefined && opts.baseRev < this._doc.rev) {
        const later = hist.filter((h) => h.baseRev >= opts.baseRev!);
        const clash = later.find((h) => overlaps(h.ops, ops));
        if (clash)
          throw new StoreError(
            "stale",
            `the document changed since rev ${opts.baseRev} (${clash.author.role ?? clash.author.kind}: ${clash.reason})`,
            "read the project again and redo the change on the current version",
            409,
          );
      }
      const forbidden = ops.find((o) => o.path === "/rev" || o.path === "/pap" || o.path === "" || o.path === "/id");
      if (forbidden) throw new StoreError("forbidden_path", `can't change ${forbidden.path || "the whole document"}`);
      let next: any;
      let inverse: PatchOpT[];
      try {
        ({ doc: next, inverse } = applyPatch(this._doc, ops));
      } catch (e: any) {
        throw new StoreError("bad_patch", e.message, e.fix ?? `check that ${e.path} exists (read it first)`);
      }
      next.rev = this._doc.rev + 1;
      const parsed = Project.safeParse(next);
      if (!parsed.success) {
        const iss = parsed.error.issues.slice(0, 8);
        throw new StoreError(
          "invalid_document",
          `the change would make the project invalid: ${iss.map((i) => `/${i.path.join("/")}: ${i.message}`).join("; ")}`,
          "fix the listed fields; values must match the project schema",
        );
      }
      try {
        resolveTimeline(parsed.data);
      } catch (e: any) {
        throw new StoreError("bad_time", e.message, e.fix);
      }
      const entry: PatchEntryT = {
        seq: ++this.seqHist,
        opId: opts.opId ?? randomUUID(),
        ts: new Date().toISOString(),
        baseRev: this._doc.rev,
        author: opts.author,
        reason: opts.reason,
        ops,
        inverse,
        ...(opts.undoes !== undefined ? { undoes: opts.undoes } : {}),
        ...(opts.note ? { note: opts.note } : {}),
      };
      atomicWrite(join(this.dir, "pitch.json"), `${JSON.stringify(parsed.data, null, 2)}\n`);
      appendFileSync(join(this.dir, "history", "patches.jsonl"), `${JSON.stringify(entry)}\n`);
      this._doc = parsed.data;
      this.stills.clear();
      this.emit("patch", entry);
      if (opts.author.task)
        this.log(opts.author.task, { kind: "patch", title: `Changed the project: ${opts.reason}`, detail: ops });
      return { rev: this._doc.rev, seq: entry.seq };
    });
  }

  async undo(seq: number, reason: string, author: PatchEntryT["author"]) {
    const e = this.readHistory().find((h) => h.seq === seq);
    if (!e) throw new StoreError("not_found", `no change #${seq}`);
    return this.patch(e.inverse, { reason: `undo #${seq}: ${reason}`, author, undoes: seq });
  }

  // ---- rendering ----
  private async ren(): Promise<Renderer> {
    if (this.renderer && this.rendererRev === this._doc.rev) return this.renderer;
    const old = this.renderer;
    this.rendererRev = this._doc.rev;
    this.renderer = openRenderer(this.project());
    // tasks run side by side: one may still be drawing frames on the old document's renderer, so it closes later
    if (old) {
      const t = setTimeout(() => old.then((r) => r.close()).catch(() => {}), 30_000);
      t.unref();
      this.retired.push({ r: old, t });
    }
    return this.renderer;
  }
  async still(t: number, scale = 4): Promise<Uint8Array> {
    const key = `${this._doc.rev}:${t.toFixed(3)}:${scale}`;
    const hit = this.stills.get(key);
    if (hit) return hit;
    const r = await this.ren();
    const img = png(await r.frame(t), scale);
    if (this.stills.size > 400) this.stills.clear();
    this.stills.set(key, img);
    return img;
  }
  async renderer_(): Promise<Renderer> {
    return this.ren();
  }
  private retired: { r: Promise<Renderer>; t: ReturnType<typeof setTimeout> }[] = [];
  close() {
    for (const x of this.retired.splice(0)) {
      clearTimeout(x.t);
      x.r.then((r) => r.close()).catch(() => {});
    }
    this.renderer?.then((r) => r.close()).catch(() => {});
  }

  // ---- questions ----
  ask(input: QuestionInput, by: string): QuestionT {
    const q = Question.parse({
      ...QuestionInput.parse(input),
      id: `q${this.state.questions.length + 1}`,
      askedAt: new Date().toISOString(),
      status: "open",
    });
    if (!q.options.some((o) => o.id === q.recommendedId))
      throw new StoreError(
        "bad_question",
        `recommendedId ${q.recommendedId} is not one of the options`,
        "set recommendedId to an option id",
      );
    q.from = by;
    this.state.questions.push(q);
    this.saveState();
    this.emit("question", q);
    if (q.timeoutSec && !q.rights)
      setTimeout(
        () => this.answer(q.id, { optionId: q.recommendedId }, "timeout").catch(() => {}),
        q.timeoutSec * 1000,
      ).unref();
    return q;
  }
  waitAnswer(id: string, signal?: AbortSignal): Promise<QuestionT> {
    const q = this.state.questions.find((x) => x.id === id);
    if (q && q.status !== "open") return Promise.resolve(q);
    return new Promise((res, rej) => {
      this.waiters.set(id, res);
      signal?.addEventListener("abort", () => {
        this.waiters.delete(id);
        rej(new Error("cancelled"));
      });
    });
  }
  /** the question no longer applies (a hold lifted another way): it leaves Needs you, and its waiter gets it */
  withdraw(id: string): QuestionT | undefined {
    const q = this.state.questions.find((x) => x.id === id);
    if (!q || q.status !== "open") return q;
    q.status = "withdrawn";
    this.saveState();
    this.emit("question", q);
    this.waiters.get(id)?.(q);
    this.waiters.delete(id);
    return q;
  }
  async answer(id: string, a: { optionId?: string; value?: unknown; note?: string }, by: string) {
    const q = this.state.questions.find((x) => x.id === id);
    if (!q) throw new StoreError("not_found", `no question ${id}`);
    if (q.status !== "open") return q;
    // a likeness or logo is the person's claim: nobody else answers its rights question (PIP-JOURNEY N15)
    if (q.rights && by !== "user")
      throw new StoreError(
        "person_only",
        `only the person can answer the rights question for ${q.rights.asset}`,
        "ask the person in the studio; the crew waits for them",
        403,
      );
    if (a.optionId && !q.options.some((o) => o.id === a.optionId))
      throw new StoreError(
        "bad_answer",
        `unknown option ${a.optionId}`,
        `options: ${q.options.map((o) => o.id).join(", ")}`,
      );
    // a hold's question: the crew acts on the choice, or keeps it open when that option can't act yet
    if (q.hold && this.answerHook?.(q, a, by) === "keep") return q;
    q.status = by === "timeout" ? "defaulted" : "answered";
    q.answer = { ...a, by };
    this.saveState();
    this.emit("question", q);
    this.waiters.get(id)?.(q);
    this.waiters.delete(id);
    return q;
  }

  // ---- notes, gates, tasks ----
  addNote(n: Omit<Note, "id" | "status" | "createdAt">) {
    const note: Note = {
      ...n,
      id: `n${this.state.notes.length + 1}`,
      status: "open",
      createdAt: new Date().toISOString(),
    };
    this.state.notes.push(note);
    this.saveState();
    this.emit("note", note);
    return note;
  }
  updateNote(id: string, patch: Partial<Note>) {
    const n = this.state.notes.find((x) => x.id === id);
    if (!n) throw new StoreError("not_found", `no note ${id}`);
    Object.assign(n, patch);
    this.saveState();
    this.emit("note", n);
    return n;
  }
  setGate(id: GateId, patch: Partial<Gate>) {
    const g = this.state.gates.find((x) => x.id === id)!;
    Object.assign(g, patch);
    this.saveState();
    this.emit("gate", g);
    return g;
  }
  upsertTask(t: Task) {
    const i = this.state.tasks.findIndex((x) => x.id === t.id);
    if (i < 0) {
      // a new attempt at the same job supersedes earlier failed ones (the same plan task, when it has one)
      const prev = this.state.tasks.filter((x) =>
        t.planTask
          ? x.planTask === t.planTask
          : x.role === t.role && x.kind === t.kind && (x.parent ?? "") === (t.parent ?? ""),
      );
      t.attempt = prev.length + 1;
      for (const x of prev)
        if ((x.status === "failed" || x.status === "cancelled" || x.status === "partial") && !x.supersededBy) {
          x.supersededBy = t.id;
          this.emit("task", x);
        }
      this.state.tasks.push(t);
    } else this.state.tasks[i] = t;
    this.saveState();
    this.emit("task", t);
    return t;
  }
  setStage(stage: Stage) {
    this.state.stage = stage;
    this.saveState();
    this.emit("stage", { stage });
  }
  /** a task's activity log: what it asked, which tools it called with what, what came back */
  log(
    taskId: string,
    entry: {
      kind: "step" | "model" | "tool" | "patch" | "answer" | "error";
      title: string;
      detail?: unknown;
      thinking?: string;
      image?: string;
    },
  ) {
    const dir = join(this.dir, "runs", "transcripts");
    mkdirSync(dir, { recursive: true });
    const e = { at: new Date().toISOString(), ...entry };
    appendFileSync(join(dir, `${taskId.replace(/[^a-z0-9_-]/gi, "")}.jsonl`), `${JSON.stringify(e)}\n`);
    this.events.emit("event", { seq: 0, event: "activity", data: { task: taskId, ...e }, ts: e.at });
  }
  /**
   * A model call's live progress (docs/API.md, the `progress` event): transient like `activity` (seq 0, never stored
   * or replayed), throttled by the caller. `draft` is the raw answer so far, for a drawing's live canvas, and
   * `palette` its letters' colours.
   */
  progress(
    taskId: string,
    p: {
      phase: "thinking" | "writing";
      tokens: number;
      seconds: number;
      tail: string;
      draft?: string;
      palette?: Record<string, string>;
    },
  ) {
    const ts = new Date().toISOString();
    this.events.emit("event", { seq: 0, event: "progress", data: { what: "task", taskId, ...p }, ts });
  }
  transcript(taskId: string) {
    const f = join(this.dir, "runs", "transcripts", `${taskId.replace(/[^a-z0-9_-]/gi, "")}.jsonl`);
    if (!existsSync(f)) return [];
    return readFileSync(f, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l));
  }
  setStatus(patch: Partial<RuntimeState["status"]>) {
    this.state.status = { ...this.state.status, ...patch };
    if ("problem" in patch && !patch.problem) delete this.state.status.problem;
    this.saveState();
    this.emit("status", this.state.status);
  }
  milestone(id: string, text: string, image?: string) {
    if (this.state.milestones.some((m) => m.id === id)) return;
    const m = { id, at: new Date().toISOString(), text, ...(image ? { image } : {}) };
    this.state.milestones.push(m);
    this.saveState();
    // each time it is reached is its own marker
    this.emit("milestone", { ...m, id: `${m.id}@${this.evSeq + 1}` });
  }
  setSceneStatus(id: string, v: RuntimeState["sceneStatus"][string]) {
    this.state.sceneStatus[id] = v;
    this.saveState();
    this.emit("scene", { id, ...v });
  }
  /** post on the crew channel: appended to runs/channel.jsonl and sent as a `channel` event */
  /** what plainText may name in this project: its scenes and assets */
  plainCtx(): PlainCtx {
    const d = this._doc;
    return { scenes: d.scenes.map((s) => ({ id: s.id, title: s.title })), assets: d.assets.map((a) => a.id) };
  }
  say(m: Omit<ChannelMsg, "id" | "at">): ChannelMsg {
    // the channel is read by people: no library refs, task ids or scene ids (§1.14)
    const msg: ChannelMsg = {
      id: `m_${randomUUID().slice(0, 8)}`,
      at: new Date().toISOString(),
      ...m,
      text: plainText(m.text, this.plainCtx()),
    };
    appendFileSync(join(this.dir, "runs", "channel.jsonl"), `${JSON.stringify(msg)}\n`);
    this.emit("channel", msg);
    return msg;
  }
  channel(): ChannelMsg[] {
    const f = join(this.dir, "runs", "channel.jsonl");
    if (!existsSync(f)) return [];
    return readFileSync(f, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l) as ChannelMsg);
  }
  setDigest(text: string) {
    this.state.digest = text;
    this.saveState();
    this.emit("digest", { text });
  }
  files() {
    const out = join(this.dir, "out");
    if (!existsSync(out)) return [];
    return readdirSync(out)
      .filter((f) => !f.startsWith("."))
      .map((name) => {
        const kind = /\.mp4$/.test(name)
          ? "video"
          : /\.(srt|vtt)$/.test(name)
            ? "subtitles"
            : /\.wav$/.test(name)
              ? "audio"
              : "image";
        return { name, bytes: statSync(join(out, name)).size, kind };
      });
  }
}

/** a title as a folder and id stem: "QuestDay pitch" -> "questday_pitch" */
export const projectSlug = (title: string) =>
  title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 40) || "pitch";

/**
 * The document a new project starts with (pure: no folder). `Workspace.create` writes it, and `/new`'s brief card
 * plans and prices the very same document before anything is made.
 */
export function newProjectDoc(input: { title: string; brief: ProjectT["brief"]; budgetUsd: number }): ProjectT {
  const slug = projectSlug(input.title);
  const id = /^[a-z]/.test(slug) ? slug : `p_${slug}`;
  return Project.parse({
    pap: 1,
    rev: 0,
    id,
    title: input.title,
    canvas: { w: 320, h: 180, fps: 30, palette: "pap-night@1" },
    brief: input.brief,
    script: { cues: [{ id: "c01", text: "Placeholder: the Writer replaces this." }], timing: { mode: "estimate" } },
    composition: { hold: 1, endHold: 3, duration: "E(c01)+endHold" },
    scenes: [
      {
        id: "s01",
        title: "Placeholder",
        kind: "decl",
        from: 0,
        to: "duration",
        recipes: [{ id: "backdrop_night", params: {} }],
      },
    ],
    audio: { sfx: {}, music: { generator: "chip-bed" } },
    delivery: [{ id: "hd", scale: 6, crf: 16, out: `${slug}.mp4` }],
    // what the night backdrop and the common recipes draw, so a new project never shows missing-asset boxes
    assets: [
      { id: "font", src: "lib:font-5x8@1" },
      ...["moon", "skyline", "tiles", "props", "qblock", "items", "powerups", "castle", "gamers"].map((id) => ({
        id,
        src: `lib:${id}@1`,
      })),
    ],
    budget: { capUsd: input.budgetUsd },
  });
}

/** All projects this process knows: the roots it scans plus folders opened by path. */
export class Workspace {
  /** the repo's read-only seed library; reads go through @pap/render's two layers (libraryIndex, libraryAssetDir) */
  readonly libraryDir = LIBRARY_DIR;
  private open = new Map<string, OpenProject>();
  private known = new Map<string, string>(); // id -> dir
  private roots: () => string[];
  /** the crew's hook on an answer to a hold question (OpenProject.answerHook), for every project this opens */
  onAnswer?: (
    p: OpenProject,
    q: QuestionT,
    a: { optionId?: string; value?: unknown; note?: string },
    by: string,
  ) => "keep" | void;
  constructor(roots: () => string[]) {
    this.roots = roots;
    const recent = join(PAP_HOME, "projects.json");
    if (existsSync(recent)) for (const d of JSON.parse(readFileSync(recent, "utf8")) as string[]) this.remember(d);
    this.scan();
  }
  private persist() {
    mkdirSync(PAP_HOME, { recursive: true });
    writeFileSync(join(PAP_HOME, "projects.json"), JSON.stringify([...this.known.values()], null, 1));
  }
  private remember(dir: string) {
    dir = resolve(dir);
    if (!existsSync(join(dir, "pitch.json"))) return null;
    try {
      const id0 = JSON.parse(readFileSync(join(dir, "pitch.json"), "utf8")).id ?? basename(dir);
      for (const [id, d] of this.known) if (d === dir) return id;
      let id = id0;
      for (let n = 2; this.known.has(id); n++) id = `${id0}_${n}`;
      this.known.set(id, dir);
      return id;
    } catch {
      return null;
    }
  }
  scan() {
    for (const root of this.roots()) {
      if (!existsSync(root)) continue;
      if (existsSync(join(root, "pitch.json"))) this.remember(root);
      for (const d of readdirSync(root, { withFileTypes: true }))
        if (d.isDirectory() && existsSync(join(root, d.name, "pitch.json"))) this.remember(join(root, d.name));
    }
  }
  list() {
    this.scan();
    return [...this.known.entries()].map(([id, dir]) => {
      try {
        const d = JSON.parse(readFileSync(join(dir, "pitch.json"), "utf8"));
        return { id, dir, title: d.title as string, rev: d.rev as number, capUsd: d.budget?.capUsd ?? 0 };
      } catch {
        return { id, dir, title: "(unreadable)", rev: 0, capUsd: 0 };
      }
    });
  }
  get(id: string): OpenProject {
    const hit = this.open.get(id);
    if (hit) return hit;
    const dir = this.known.get(id);
    if (!dir) throw new StoreError("not_found", `no project ${id}`, `known: ${[...this.known.keys()].join(", ")}`, 404);
    lock(dir);
    const p = new OpenProject(dir, id);
    p.answerHook = (q, a, by) => this.onAnswer?.(p, q, a, by);
    this.open.set(id, p);
    return p;
  }
  openDir(dir: string): OpenProject {
    const id = this.remember(dir);
    if (!id) throw new StoreError("not_found", `no pitch.json in ${dir}`);
    this.persist();
    return this.get(id);
  }
  create(input: { title: string; brief: ProjectT["brief"]; budgetUsd: number; dir?: string }): OpenProject {
    const slug = projectSlug(input.title);
    const root = this.roots()[0] ?? join(PAP_HOME, "projects");
    let dir = input.dir ?? join(root, slug);
    for (let n = 2; !input.dir && existsSync(dir); n++) dir = join(root, `${slug}_${n}`);
    if (existsSync(join(dir, "pitch.json"))) throw new StoreError("exists", `a project already lives in ${dir}`);
    mkdirSync(join(dir, "assets"), { recursive: true });
    const doc = newProjectDoc(input);
    writeFileSync(join(dir, "pitch.json"), `${JSON.stringify(doc, null, 2)}\n`);
    writeFileSync(join(dir, ".gitignore"), "out/\nruns/\nprivate/\nhistory/blobs/\n");
    return this.openDir(dir);
  }
  closeAll() {
    for (const [, p] of this.open) {
      p.close();
      unlock(p.dir);
    }
  }
}

// ---- single-writer lock ----
const LOCK = ".pap-lock";
function lock(dir: string) {
  const f = join(dir, LOCK);
  if (existsSync(f)) {
    const pid = Number(readFileSync(f, "utf8").split("\n")[0]);
    let alive = false;
    try {
      process.kill(pid, 0);
      alive = pid !== process.pid;
    } catch {}
    if (alive)
      throw new StoreError(
        "locked",
        `another PixelArtPitch process (pid ${pid}) has this project open`,
        "use that server (MCP over HTTP) or close it",
        423,
      );
  }
  writeFileSync(f, `${process.pid}\n`);
}
function unlock(dir: string) {
  rmSync(join(dir, LOCK), { force: true });
}
