// The HTTP client for the studio server (docs/API.md). Typed fetch, the X-PAP-Token header on every mutation (read
// once from GET /api/session), and an SSE subscription over fetch so it can send Last-Event-ID and reconnect.
import type {
  ActivityEntry,
  AnswerInput,
  ApiErrorBody,
  BuildInfo,
  ChangesPreview,
  ChangesPreviewInput,
  ChannelMsg,
  Client,
  Connection,
  ConnectionTrust,
  ConnState,
  CreateProjectInput,
  Draft,
  DraftComposer,
  DraftRef,
  Gate,
  GateId,
  GateVerdict,
  InstanceLog,
  LibraryIndex,
  ModelRow,
  Note,
  NoteInput,
  PatchEntryT,
  PatchOpT,
  PipAdded,
  PipCard,
  PipContext,
  PipConversation,
  PipDecision,
  PipItem,
  PipSummary,
  PlanRevisionSummary,
  ProjectState,
  ProjectSummary,
  QuestionT,
  RefType,
  ServerEvent,
  Session,
  Settings,
  Stage,
  WorkspaceLine,
} from "./types.ts";

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly fix?: string;
  readonly path?: string;
  constructor(status: number, body: ApiErrorBody) {
    super(body.message);
    this.status = status;
    this.code = body.code;
    this.fix = body.fix;
    this.path = body.path;
  }
}

const enc = encodeURIComponent;

export class HttpClient implements Client {
  readonly mock = false;
  private sessionP: Promise<Session> | null = null;

  session(): Promise<Session> {
    this.sessionP ??= this.get<Session>("/api/session").catch((e) => {
      this.sessionP = null;
      throw e;
    });
    return this.sessionP;
  }

  private async req<T>(method: string, path: string, body?: unknown, raw?: Blob, contentType?: string): Promise<T> {
    const headers: Record<string, string> = { accept: "application/json" };
    if (method !== "GET") headers["x-pap-token"] = (await this.session()).token;
    let payload: BodyInit | undefined;
    if (raw) {
      payload = raw;
      headers["content-type"] = contentType ?? (raw.type || "application/octet-stream");
    } else if (body !== undefined) {
      payload = JSON.stringify(body);
      headers["content-type"] = "application/json";
    }
    const res = await fetch(path, { method, headers, body: payload, credentials: "same-origin" });
    const text = await res.text();
    const json = text ? safeJson(text) : null;
    // a server without this route answers with the studio page (200, HTML): that's a missing route, not an empty answer
    if (res.ok && text && json === null && /^\s*</.test(text))
      throw new ApiError(404, {
        code: "no_route",
        message: "This studio doesn't have that yet",
        fix: "Update the studio server and restart it.",
      });
    if (!res.ok) {
      const err = (json as { error?: ApiErrorBody } | null)?.error;
      throw new ApiError(
        res.status,
        err ?? { code: `http_${res.status}`, message: res.statusText || "Request failed" },
      );
    }
    return json as T;
  }
  private get<T>(path: string) {
    return this.req<T>("GET", path);
  }
  private post<T>(path: string, body?: unknown) {
    return this.req<T>("POST", path, body ?? {});
  }

  projects() {
    return this.get<ProjectSummary[]>("/api/projects");
  }
  createProject(input: CreateProjectInput) {
    return this.post<{ id: string }>("/api/projects", input);
  }
  project(id: string) {
    return this.get<ProjectState>(`/api/p/${enc(id)}`);
  }
  history(id: string, since?: number) {
    return this.get<PatchEntryT[]>(`/api/p/${enc(id)}/history${since != null ? `?since=${since}` : ""}`);
  }
  patch(id: string, body: { ops: PatchOpT[]; reason: string; baseRev: number }) {
    return this.post<{ rev: number; seq: number }>(`/api/p/${enc(id)}/patch`, body);
  }
  undo(id: string, seq: number, reason: string) {
    return this.post<{ rev: number; seq: number }>(`/api/p/${enc(id)}/undo`, { seq, reason });
  }
  reportUrl(id: string) {
    return `/api/p/${enc(id)}/report/`;
  }
  frameUrl(id: string, t: number, scale = 2, rev?: number) {
    return `/api/p/${enc(id)}/frame?t=${t.toFixed(3)}&scale=${scale}${rev != null ? `&rev=${rev}` : ""}`;
  }
  proxyUrl(id: string) {
    return `/api/p/${enc(id)}/proxy.mp4`;
  }
  fileUrl(id: string, name: string) {
    return `/api/p/${enc(id)}/files/${enc(name)}`;
  }
  answer(id: string, qid: string, a: AnswerInput) {
    return this.post<QuestionT>(`/api/p/${enc(id)}/questions/${enc(qid)}/answer`, a);
  }
  addNote(id: string, n: NoteInput) {
    return this.post<Note>(`/api/p/${enc(id)}/notes`, n);
  }
  gate(id: string, gate: GateId, v: GateVerdict) {
    return this.post<Gate>(`/api/p/${enc(id)}/gates/${gate}`, v);
  }
  async crewRun(id: string, stage?: Stage) {
    await this.post(`/api/p/${enc(id)}/crew/run`, stage ? { stage } : {});
  }
  async crewPause(id: string, mode: "after_step" | "now") {
    await this.post(`/api/p/${enc(id)}/crew/pause`, { mode });
  }
  async crewResume(id: string) {
    await this.post(`/api/p/${enc(id)}/crew/resume`);
  }
  async crewRetry(id: string, taskId: string, stage?: Stage) {
    try {
      await this.post(`/api/p/${enc(id)}/crew/retry`, { taskId });
    } catch (e) {
      // an older server has no retry: run the stage again
      if (e instanceof ApiError && (e.status === 404 || e.status === 405)) await this.crewRun(id, stage);
      else throw e;
    }
  }
  async transcript(id: string, taskId: string) {
    try {
      const res = await fetch(`/api/p/${enc(id)}/tasks/${enc(taskId)}/transcript`);
      return res.ok ? await res.text() : null;
    } catch {
      return null;
    }
  }
  async taskTranscript(id: string, taskId: string) {
    try {
      const j = await this.get<ActivityEntry[] | { entries?: ActivityEntry[] }>(
        `/api/p/${enc(id)}/tasks/${enc(taskId)}/transcript`,
      );
      const list = Array.isArray(j) ? j : j?.entries;
      return Array.isArray(list) ? list : [];
    } catch (e) {
      if (e instanceof ApiError && e.status === 404) return null;
      throw e;
    }
  }
  uploadVo(id: string, body: Blob, take: string) {
    return this.req<{ file: string }>("POST", `/api/p/${enc(id)}/vo?take=${enc(take)}`, undefined, body);
  }
  align(id: string, file: string) {
    return this.post<{ proposal: { cue: string; start: number; end: number }[] }>(`/api/p/${enc(id)}/vo/align`, {
      file,
    });
  }
  settings() {
    return this.get<Settings>("/api/settings");
  }
  saveSettings(partial: Partial<Settings>) {
    return this.req<Settings>("PUT", "/api/settings", partial);
  }
  saveKey(provider: string, key: string) {
    return this.req<{ hasKey: true }>("PUT", `/api/settings/providers/${enc(provider)}/key`, { key });
  }
  testProvider(provider: string) {
    return this.post<{ ok: boolean; models: string[]; error?: string }>(
      `/api/settings/providers/${enc(provider)}/test`,
    );
  }
  models() {
    return this.get<ModelRow[]>("/api/models");
  }
  library() {
    return this.get<LibraryIndex>("/api/library");
  }
  sheetUrl(assetId: string) {
    return `/api/library/${enc(assetId)}/sheet.png`;
  }

  pip(project?: string, opts: { draft?: string } = {}) {
    const q = project ? `?project=${enc(project)}` : opts.draft ? `?draft=${enc(opts.draft)}` : "";
    return this.get<PipConversation>(`/api/pip${q}`);
  }
  pipAsk(project: string | undefined, text: string, opts: { draft?: string; about?: { instance: string } } = {}) {
    return this.post<{ turnId: string }>("/api/pip", {
      ...(project ? { project } : {}),
      ...(opts.draft ? { draft: opts.draft } : {}),
      ...(opts.about ? { about: opts.about } : {}),
      text,
    });
  }

  // ---- /new as a conversation (PIP-ORCHESTRATION §4.5; the server answers these from P3) ----
  createDraft(from?: string) {
    return this.post<{ draft: Draft; items: PipItem[] }>("/api/drafts", from ? { from } : {});
  }
  draft(id: string) {
    return this.get<{ draft: Draft; items: PipItem[] }>(`/api/drafts/${enc(id)}`);
  }
  async deleteDraft(id: string) {
    await this.req("DELETE", `/api/drafts/${enc(id)}`);
  }
  draftFile(id: string, name: string, body: Blob) {
    return this.req<{ ref: DraftRef }>("POST", `/api/drafts/${enc(id)}/files?name=${enc(name)}`, undefined, body);
  }
  draftRef(id: string, name: string, patch: { type?: RefType; rights?: DraftRef["rights"] }) {
    return this.req<DraftRef>("PATCH", `/api/drafts/${enc(id)}/refs/${enc(name)}`, patch);
  }
  draftFields(id: string, fields: Draft["fields"]) {
    return this.req<Draft>("PATCH", `/api/drafts/${enc(id)}`, { fields });
  }
  draftComposer(id: string) {
    return this.get<DraftComposer>(`/api/drafts/${enc(id)}/composer`);
  }
  workspaceLine() {
    return this.get<WorkspaceLine>("/api/workspace/line");
  }
  async pipCard(cardId: string, d: PipDecision) {
    // the server may answer with the card or with nothing; the `card` event settles it either way
    const res = await this.post<PipCard | { card?: PipCard } | null>(`/api/pip/cards/${enc(cardId)}`, d);
    if (res && "type" in res) return res;
    return (res as { card?: PipCard } | null)?.card ?? null;
  }
  pipContext(project?: string) {
    return this.get<PipContext>(`/api/pip/context${project ? `?project=${enc(project)}` : ""}`);
  }
  pipSummary(project: string | undefined, text: string) {
    return this.req<PipSummary>("PUT", "/api/pip/summary", project ? { project, text } : { text });
  }
  async instanceLog(id: string, iid: string) {
    try {
      return await this.get<InstanceLog>(`/api/p/${enc(id)}/instances/${enc(iid)}/log`);
    } catch (e) {
      if (e instanceof ApiError && e.status === 404) return null;
      throw e;
    }
  }
  async changesPreview(id: string, body: ChangesPreviewInput) {
    try {
      const res = await this.post<ChangesPreview>(`/api/p/${enc(id)}/changes/preview`, body);
      return res && typeof res === "object" && Array.isArray(res.usd) ? res : null;
    } catch (e) {
      // an older server: the route isn't there (404, or the studio page); the card keeps its own words
      if (e instanceof ApiError && (e.status === 404 || e.status === 405)) return null;
      throw e;
    }
  }
  async build() {
    try {
      const res = await this.get<BuildInfo>("/api/build");
      return res && typeof res.webStale === "boolean" ? res : null;
    } catch {
      return null;
    }
  }
  async planRevisions(id: string) {
    try {
      const res = await this.get<PlanRevisionSummary[]>(`/api/p/${enc(id)}/plan/revisions`);
      return Array.isArray(res) ? res : [];
    } catch (e) {
      if (e instanceof ApiError && e.status === 404) return [];
      throw e;
    }
  }
  async channel(project: string) {
    try {
      const res = await this.get<ChannelMsg[] | { messages: ChannelMsg[] }>(`/api/p/${enc(project)}/channel`);
      return Array.isArray(res) ? res : (res?.messages ?? []);
    } catch (e) {
      if (e instanceof ApiError && e.status === 404) return [];
      throw e;
    }
  }
  subscribeWorkspace(on: (e: ServerEvent) => void, onConn?: (s: ConnState) => void) {
    return subscribeSse("/api/events", on, onConn);
  }
  async connections() {
    const res = await this.get<Connection[] | { connections: Connection[] }>("/api/connections");
    return Array.isArray(res) ? res : (res?.connections ?? []);
  }
  addConnections(json: string) {
    return this.post<{ added: PipAdded[] }>("/api/connections", { json });
  }
  updateConnection(name: string, patch: { enabled?: boolean; trust?: ConnectionTrust }) {
    return this.req<Connection | null>("PATCH", `/api/connections/${enc(name)}`, patch);
  }
  async removeConnection(name: string) {
    await this.req("DELETE", `/api/connections/${enc(name)}`);
  }
  testConnection(name: string) {
    return this.post<Connection | null>(`/api/connections/${enc(name)}/test`);
  }

  subscribe(id: string, on: (e: ServerEvent) => void, onConn?: (s: ConnState) => void) {
    return subscribeSse(`/api/p/${enc(id)}/events`, on, onConn);
  }
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/**
 * Server-sent events over fetch: parses the stream, remembers the last `id`, and on a drop reconnects with
 * `Last-Event-ID` after a backoff (1 s doubling to 15 s). EventSource can't set that header on a fresh connection.
 */
export function subscribeSse(url: string, on: (e: ServerEvent) => void, onConn?: (s: ConnState) => void) {
  let lastId: string | null = null;
  let stopped = false;
  let ctrl: AbortController | null = null;
  let delay = 1000;
  let timer: ReturnType<typeof setTimeout> | null = null;

  const connect = async () => {
    if (stopped) return;
    onConn?.("connecting");
    ctrl = new AbortController();
    try {
      const headers: Record<string, string> = { accept: "text/event-stream" };
      if (lastId) headers["last-event-id"] = lastId;
      const res = await fetch(url, { headers, signal: ctrl.signal, credentials: "same-origin" });
      if (!res.ok || !res.body) throw new Error(`events: ${res.status}`);
      onConn?.("open");
      delay = 1000;
      const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
      let buf = "";
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += value;
        let cut = buf.indexOf("\n\n");
        while (cut >= 0) {
          const block = buf.slice(0, cut);
          buf = buf.slice(cut + 2);
          dispatch(block);
          cut = buf.indexOf("\n\n");
        }
      }
    } catch (e) {
      if (stopped || (e as Error).name === "AbortError") return;
    }
    if (stopped) return;
    onConn?.("retrying");
    timer = setTimeout(connect, delay);
    delay = Math.min(15000, delay * 2);
  };

  const dispatch = (block: string) => {
    let event = "message";
    let id: string | null = null;
    const data: string[] = [];
    for (const raw of block.split("\n")) {
      const line = raw.replace(/\r$/, "");
      if (!line || line.startsWith(":")) continue;
      const i = line.indexOf(":");
      const field = i < 0 ? line : line.slice(0, i);
      const val = i < 0 ? "" : line.slice(i + 1).replace(/^ /, "");
      if (field === "event") event = val;
      else if (field === "data") data.push(val);
      else if (field === "id") id = val;
    }
    if (id) lastId = id;
    if (!data.length) return;
    const parsed = safeJson(data.join("\n"));
    if (parsed !== null) on({ event, data: parsed } as ServerEvent);
  };

  connect();
  return () => {
    stopped = true;
    ctrl?.abort();
    if (timer) clearTimeout(timer);
  };
}
