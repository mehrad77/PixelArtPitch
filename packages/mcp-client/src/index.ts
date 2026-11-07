// A plain MCP client (no SDK, no dependencies): stdio (newline-delimited JSON-RPC) and Streamable HTTP (POST, with a
// JSON or SSE answer), the initialize handshake, tools/list with pagination, tools/call and
// notifications/tools/list_changed. 15 s to connect, 60 s per call. Errors carry a `fix` a person can act on.
import { type ChildProcess, spawn } from "node:child_process";

export const PROTOCOL_VERSION = "2025-06-18";

export type StdioSpec = { type: "stdio"; command: string; args?: string[]; env?: Record<string, string>; cwd?: string };
export type HttpSpec = { type: "http"; url: string; headers?: Record<string, string> };
export type ServerSpec = StdioSpec | HttpSpec;

export type McpTool = {
  name: string;
  title?: string;
  description?: string;
  inputSchema: Record<string, unknown>;
  annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean; title?: string; [k: string]: unknown };
};
export type McpContent =
  | { type: "text"; text: string }
  | { type: "image"; data: string; mimeType: string }
  | { type: string; [k: string]: unknown };
export type McpCallResult = { content: McpContent[]; isError?: boolean; structuredContent?: unknown };

export class McpError extends Error {
  readonly code: string;
  readonly fix?: string;
  constructor(code: string, message: string, fix?: string) {
    super(message);
    this.code = code;
    this.fix = fix;
  }
}

type Pending = { resolve: (v: any) => void; reject: (e: Error) => void; timer: NodeJS.Timeout };
type Msg = { jsonrpc: "2.0"; id?: number | string | null; method?: string; params?: any; result?: any; error?: any };

export type ClientOpts = {
  connectTimeoutMs?: number;
  callTimeoutMs?: number;
  /** the server said its tool list changed */
  onToolsChanged?: () => void;
  clientName?: string;
  clientVersion?: string;
  /** stdio only: the env a child gets besides its declared env (default PATH and HOME, nothing else) */
  baseEnv?: Record<string, string | undefined>;
};

export class McpClient {
  readonly spec: ServerSpec;
  private opts: Required<Pick<ClientOpts, "connectTimeoutMs" | "callTimeoutMs">> & ClientOpts;
  private nextId = 1;
  private pending = new Map<number, Pending>();
  private child: ChildProcess | null = null;
  private stderr = "";
  private buf = "";
  private session: string | null = null;
  private closed = false;
  serverInfo: { name?: string; version?: string } = {};
  capabilities: Record<string, unknown> = {};

  constructor(spec: ServerSpec, opts: ClientOpts = {}) {
    this.spec = spec;
    this.opts = { connectTimeoutMs: 15_000, callTimeoutMs: 60_000, ...opts };
  }

  get running() {
    return this.spec.type === "http" ? !!this.session || !this.closed : !!this.child && this.child.exitCode === null;
  }

  // ---------------------------------------------------------------- lifecycle
  async connect(): Promise<void> {
    if (this.spec.type === "stdio") this.spawn(this.spec);
    const res = await this.request(
      "initialize",
      {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: this.opts.clientName ?? "pixelartpitch", version: this.opts.clientVersion ?? "0.1.0" },
      },
      this.opts.connectTimeoutMs,
    ).catch((e) => {
      this.close();
      throw e;
    });
    this.serverInfo = res?.serverInfo ?? {};
    this.capabilities = res?.capabilities ?? {};
    await this.notify("notifications/initialized", {});
  }

  close() {
    this.closed = true;
    for (const [, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(new McpError("closed", "the connection closed"));
    }
    this.pending.clear();
    if (this.child && this.child.exitCode === null) {
      this.child.stdin?.end();
      this.child.kill("SIGTERM");
      const c = this.child;
      setTimeout(() => c.exitCode === null && c.kill("SIGKILL"), 2000).unref();
    }
    this.child = null;
    if (this.spec.type === "http" && this.session) {
      const s = this.session;
      this.session = null;
      fetch(this.spec.url, { method: "DELETE", headers: { ...this.spec.headers, "mcp-session-id": s } }).catch(
        () => {},
      );
    }
  }

  // ---------------------------------------------------------------- tools
  async listTools(): Promise<McpTool[]> {
    const out: McpTool[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 50; page++) {
      const r = await this.request("tools/list", cursor ? { cursor } : {}, this.opts.callTimeoutMs);
      out.push(...((r?.tools ?? []) as McpTool[]));
      cursor = r?.nextCursor;
      if (!cursor) break;
    }
    return out;
  }

  async callTool(name: string, args: unknown, signal?: AbortSignal): Promise<McpCallResult> {
    const r = await this.request("tools/call", { name, arguments: args ?? {} }, this.opts.callTimeoutMs, signal);
    return { content: r?.content ?? [], isError: !!r?.isError, structuredContent: r?.structuredContent };
  }

  // ---------------------------------------------------------------- JSON-RPC
  private request(method: string, params: unknown, timeoutMs: number, signal?: AbortSignal): Promise<any> {
    if (this.closed && method !== "initialize")
      return Promise.reject(new McpError("closed", "the connection is closed"));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(
          new McpError(
            "timeout",
            `${method}: no answer in ${Math.round(timeoutMs / 1000)} s`,
            method === "initialize"
              ? "the server didn't start in time: run its command in a terminal to see why"
              : "try again, or check the server",
          ),
        );
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      signal?.addEventListener("abort", () => {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(new McpError("aborted", "cancelled"));
      });
      this.send({ jsonrpc: "2.0", id, method, params }).catch((e) => {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(e);
      });
    });
  }
  private notify(method: string, params: unknown) {
    return this.send({ jsonrpc: "2.0", method, params });
  }

  private handle(m: Msg) {
    if (m.method && m.id !== undefined && m.id !== null) {
      // a request from the server: answer pings, refuse the rest (no sampling, roots or elicitation)
      const reply =
        m.method === "ping"
          ? { jsonrpc: "2.0" as const, id: m.id, result: {} }
          : { jsonrpc: "2.0" as const, id: m.id, error: { code: -32601, message: `${m.method} is not supported` } };
      this.send(reply).catch(() => {});
      return;
    }
    if (m.method) {
      if (m.method === "notifications/tools/list_changed") this.opts.onToolsChanged?.();
      return;
    }
    const p = typeof m.id === "number" ? this.pending.get(m.id) : undefined;
    if (!p) return;
    clearTimeout(p.timer);
    this.pending.delete(m.id as number);
    if (m.error) p.reject(new McpError(`rpc_${m.error.code ?? "error"}`, String(m.error.message ?? "error")));
    else p.resolve(m.result);
  }

  private async send(m: Msg): Promise<void> {
    if (this.spec.type === "stdio") {
      if (!this.child?.stdin?.writable) throw new McpError("closed", "the server process is not running", this.why());
      this.child.stdin.write(`${JSON.stringify(m)}\n`);
      return;
    }
    await this.post(this.spec, m);
  }

  // ---------------------------------------------------------------- stdio
  private spawn(s: StdioSpec) {
    const base = this.opts.baseEnv ?? { PATH: process.env.PATH, HOME: process.env.HOME };
    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries({ ...base, ...s.env })) if (v !== undefined) env[k] = v;
    this.closed = false;
    const child = spawn(s.command, s.args ?? [], { env, cwd: s.cwd, stdio: ["pipe", "pipe", "pipe"] });
    this.child = child;
    child.stdout!.setEncoding("utf8");
    child.stdout!.on("data", (chunk: string) => {
      this.buf += chunk;
      let nl = this.buf.indexOf("\n");
      while (nl >= 0) {
        const line = this.buf.slice(0, nl).trim();
        this.buf = this.buf.slice(nl + 1);
        if (line)
          try {
            this.handle(JSON.parse(line));
          } catch {}
        nl = this.buf.indexOf("\n");
      }
    });
    child.stderr!.setEncoding("utf8");
    child.stderr!.on("data", (c: string) => {
      this.stderr = (this.stderr + c).slice(-2000);
    });
    const fail = (e: McpError) => {
      for (const [, p] of this.pending) {
        clearTimeout(p.timer);
        p.reject(e);
      }
      this.pending.clear();
    };
    child.on("error", (e: any) => {
      fail(
        e?.code === "ENOENT"
          ? new McpError(
              "not_found",
              `command not found: ${s.command}`,
              `install it, or give the full path to ${s.command}`,
            )
          : new McpError("spawn", String(e?.message ?? e)),
      );
    });
    child.on("exit", (code) => {
      if (this.child === child) this.child = null;
      if (this.pending.size)
        fail(
          new McpError(
            "exited",
            `the server exited (code ${code})${this.stderr ? `: ${this.stderr.trim().slice(-300)}` : ""}`,
            this.why(),
          ),
        );
    });
  }
  private why() {
    return this.spec.type === "stdio"
      ? `run "${[this.spec.command, ...(this.spec.args ?? [])].join(" ")}" in a terminal to see its error`
      : undefined;
  }

  // ---------------------------------------------------------------- Streamable HTTP
  private async post(s: HttpSpec, m: Msg) {
    const headers: Record<string, string> = {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      "mcp-protocol-version": PROTOCOL_VERSION,
      ...s.headers,
      ...(this.session ? { "mcp-session-id": this.session } : {}),
    };
    let res: Response;
    try {
      res = await fetch(s.url, { method: "POST", headers, body: JSON.stringify(m) });
    } catch (e: any) {
      throw new McpError(
        "unreachable",
        `can't reach ${s.url}: ${e?.cause?.code ?? e?.message ?? e}`,
        "check the URL and that the server is up",
      );
    }
    const sid = res.headers.get("mcp-session-id");
    if (sid) this.session = sid;
    if (res.status === 401 || res.status === 403)
      throw new McpError(
        "unauthorized",
        `${s.url} answered ${res.status}`,
        "check the Authorization header (the token or key)",
      );
    if (res.status === 404 && this.session && m.method !== "initialize") {
      this.session = null;
      throw new McpError("session", "the server forgot the session", "test the connection again to reconnect");
    }
    if (res.status === 202 || res.status === 204) return;
    if (!res.ok) throw new McpError("http", `${s.url} answered ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const type = res.headers.get("content-type") ?? "";
    if (type.includes("text/event-stream")) {
      // read the stream; each `data:` event is a JSON-RPC message
      const reader = res.body!.getReader();
      const dec = new TextDecoder();
      let buf = "";
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let k = buf.indexOf("\n\n");
        while (k >= 0) {
          const ev = buf.slice(0, k);
          buf = buf.slice(k + 2);
          const data = ev
            .split("\n")
            .filter((l) => l.startsWith("data:"))
            .map((l) => l.slice(5).trimStart())
            .join("\n");
          if (data)
            try {
              const msg = JSON.parse(data);
              for (const x of Array.isArray(msg) ? msg : [msg]) this.handle(x);
            } catch {}
          k = buf.indexOf("\n\n");
        }
        if (typeof m.id === "number" && !this.pending.has(m.id)) {
          reader.cancel().catch(() => {});
          break;
        }
      }
      return;
    }
    const text = await res.text();
    if (!text.trim()) return;
    const msg = JSON.parse(text);
    for (const x of Array.isArray(msg) ? msg : [msg]) this.handle(x);
  }
}

/** the text of a tool result, with images and other parts named; capped */
export function resultText(
  r: McpCallResult,
  maxChars = 8000,
): { text: string; images: { mediaType: string; data: string }[] } {
  const parts: string[] = [];
  const images: { mediaType: string; data: string }[] = [];
  for (const c of r.content) {
    if (c.type === "text") parts.push(String((c as any).text));
    else if (c.type === "image" && images.length < 2 && String((c as any).data).length < 1_500_000)
      images.push({ mediaType: String((c as any).mimeType), data: String((c as any).data) });
    else parts.push(`[${c.type}]`);
  }
  if (!parts.length && r.structuredContent !== undefined) parts.push(JSON.stringify(r.structuredContent));
  let text = parts.join("\n");
  if (text.length > maxChars)
    text = `${text.slice(0, maxChars)}\n… (truncated: ${text.length - maxChars} more characters)`;
  return { text, images };
}
