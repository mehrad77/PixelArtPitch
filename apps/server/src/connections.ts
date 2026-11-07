// The person's own MCP servers ("connections", docs/ASSISTANT.md). Saved in settings.json without their secrets (env
// values and headers go to the SecretStore), started lazily, stopped after 10 minutes idle and when the studio stops.
// Their tools reach Pip as ext_<server>__<tool>; they are never added to the tool registry, so PAP's own MCP server
// never re-exports them, and no crew role has them unless a confirmed card lends them to one task.
import type { ExternalTools, ExternalToolT, FormCard } from "@pap/crew/assistant";
import type { ConnectionT, SecretStore } from "@pap/crew/llm/index";
import { McpClient, type McpTool, resultText, type ServerSpec } from "@pap/mcp-client";
import { z } from "zod";
import { type ConnDoc, connToolDoc, safeRuns } from "./docs.ts";

const IDLE_MS = 10 * 60_000;
type Added = NonNullable<FormCard["result"]>["added"][number];
export type ConnectionPublic = Omit<ConnectionT, "tools"> & {
  status: "connected" | "idle" | "failed" | "off";
  tools: number;
  toolNames: string[];
  error?: string;
  fix?: string;
};

/** one server in the pasted `mcpServers` JSON (Claude Desktop / Claude Code shape) */
const PastedServer = z
  .object({
    type: z.enum(["stdio", "http", "streamable-http", "sse"]).optional(),
    command: z.string().min(1).optional(),
    args: z.array(z.string()).default([]),
    env: z.record(z.string(), z.string()).default({}),
    cwd: z.string().optional(),
    url: z.string().url().optional(),
    headers: z.record(z.string(), z.string()).default({}),
    description: z.string().max(200).optional(),
  })
  .refine((s) => !!s.command !== !!s.url, { message: "give either a command (stdio) or a url (http)" });

const slug = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 32) || "server";
const toolSlug = (s: string) => s.replace(/[^a-zA-Z0-9_-]+/g, "_").slice(0, 40);
export const extName = (server: string, tool: string) => `ext_${server.replace(/-/g, "_")}__${toolSlug(tool)}`;

/**
 * a URL the browser may see: no login, no query, no fragment (a pasted `?key=` or `user:pass@` is a secret, and the
 * browser can write a key but never read one)
 */
export function safeUrl(url: string): string {
  try {
    const u = new URL(url);
    const hidden = u.search || u.hash ? " (query hidden)" : "";
    return `${u.protocol}//${u.host}${u.pathname}${hidden}`;
  } catch {
    return "(a URL)";
  }
}
/** an error message with every URL in it cut down to safeUrl, and any of the connection's secret values masked */
export function redact(message: string, secrets: string[] = []): string {
  let out = message.replace(/\b[a-z][a-z0-9+.-]*:\/\/[^\s"'<>)]+/gi, (m) => safeUrl(m));
  for (const s of secrets) if (s && s.length >= 4) out = out.split(s).join("•••");
  return out;
}

/** parse pasted JSON into named servers, or throw with a fix */
export function parseServers(json: string): { name: string; server: z.infer<typeof PastedServer> }[] {
  let raw: any;
  try {
    raw = JSON.parse(json);
  } catch (e: any) {
    throw Object.assign(new Error(`that isn't valid JSON: ${e.message}`), {
      fix: 'paste the whole block, starting with { and ending with }, e.g. {"mcpServers": {"name": {"command": "npx", "args": ["some-mcp"]}}}',
    });
  }
  const map =
    raw?.mcpServers ?? (raw?.command || raw?.url ? { [slug(raw.command ?? new URL(raw.url).hostname)]: raw } : raw);
  if (!map || typeof map !== "object" || Array.isArray(map) || !Object.keys(map).length)
    throw Object.assign(new Error("no servers in it"), {
      fix: 'use the "mcpServers" shape: {"mcpServers": {"name": {...}}}',
    });
  return Object.entries(map).map(([name, v]) => {
    const r = PastedServer.safeParse(v);
    if (!r.success)
      throw Object.assign(
        new Error(`${name}: ${r.error.issues.map((i) => `${i.path.join(".") || "(server)"} ${i.message}`).join("; ")}`),
        {
          fix: 'a stdio server needs "command" (and "args"); an HTTP server needs "url"',
        },
      );
    return { name: slug(name), server: r.data };
  });
}

const CHECK_FIX = "open Settings › Connections and press Test to see the whole error";
/** a failed connect, in words that carry no secret (see Connections.docs) */
function failWords(code: unknown, runs: string): string {
  const c = String(code ?? "");
  if (c.startsWith("timeout_")) return `It didn't answer within ${c.slice(8)} s.`;
  const words: Record<string, string> = {
    not_found: `The program ${runs} isn't installed on this computer.`,
    spawn: `The program ${runs} didn't start.`,
    exited: "The server stopped while it was starting.",
    unreachable: `Can't reach ${runs}.`,
    unauthorized: `${runs} turned the key down.`,
    http: `${runs} answered with an error.`,
    closed: "The connection closed.",
  };
  return words[c] ?? "It didn't connect.";
}

type Live = { client: McpClient | null; tools: McpTool[] | null; idle?: NodeJS.Timeout; error?: string; fix?: string };

export class Connections implements ExternalTools {
  private load: () => ConnectionT[];
  private save: (c: ConnectionT[]) => void;
  private secrets: SecretStore;
  private idleMs: number;
  private live = new Map<string, Live>();
  /** a spawn/connect counter, for tests ("nothing is spawned before you confirm") */
  connects = 0;

  constructor(o: {
    load: () => ConnectionT[];
    save: (c: ConnectionT[]) => void;
    secrets: SecretStore;
    idleMs?: number;
  }) {
    this.load = o.load;
    this.save = o.save;
    this.secrets = o.secrets;
    this.idleMs = o.idleMs ?? IDLE_MS;
  }

  private secretId = (name: string, kind: "env" | "header", key: string) =>
    `mcp-${name}-${kind}-${key.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`;
  private get(name: string) {
    const c = this.load().find((x) => x.name === name);
    if (!c) throw Object.assign(new Error(`no connection ${name}`), { code: "not_found", status: 404 });
    return c;
  }
  /** the connection's own secret values, so an error that echoes one can mask it */
  private secretValues(c: ConnectionT): string[] {
    const get = (kind: "env" | "header", k: string) =>
      this.secrets.getKey({ id: this.secretId(c.name, kind, k), kind: "custom" }) ?? "";
    return [...c.envKeys.map((k) => get("env", k)), ...c.headerKeys.map((k) => get("header", k))].filter(Boolean);
  }
  private spec(c: ConnectionT): ServerSpec {
    const val = (kind: "env" | "header", k: string) =>
      this.secrets.getKey({ id: this.secretId(c.name, kind, k), kind: "custom" }) ?? "";
    return c.transport === "stdio"
      ? {
          type: "stdio",
          command: c.command!,
          args: c.args,
          cwd: c.cwd,
          env: Object.fromEntries(c.envKeys.map((k) => [k, val("env", k)])),
        }
      : { type: "http", url: c.url!, headers: Object.fromEntries(c.headerKeys.map((k) => [k, val("header", k)])) };
  }

  // ---------------------------------------------------------------- the REST surface
  list(): ConnectionPublic[] {
    return this.load().map((c) => {
      const l = this.live.get(c.name);
      return {
        ...c,
        ...(c.url ? { url: safeUrl(c.url) } : {}),
        status: !c.enabled ? "off" : l?.error ? "failed" : l?.client ? "connected" : "idle",
        tools: l?.tools?.length ?? c.tools,
        toolNames: (l?.tools ?? []).map((t) => t.name),
        ...(l?.error ? { error: l.error, fix: l.fix } : {}),
      };
    });
  }

  /** the person confirmed the pasted JSON: validate, save (secrets to the SecretStore), connect, list tools */
  async add(json: string): Promise<{ added: Added[] }> {
    const servers = parseServers(json);
    const all = this.load();
    for (const { name, server } of servers) {
      for (const [k, v] of Object.entries(server.env)) this.secrets.setKey(this.secretId(name, "env", k), v);
      for (const [k, v] of Object.entries(server.headers)) this.secrets.setKey(this.secretId(name, "header", k), v);
      const c: ConnectionT = {
        name,
        transport: server.url ? "http" : "stdio",
        ...(server.command ? { command: server.command } : {}),
        args: server.args,
        ...(server.cwd ? { cwd: server.cwd } : {}),
        ...(server.url ? { url: server.url } : {}),
        envKeys: Object.keys(server.env),
        headerKeys: Object.keys(server.headers),
        enabled: true,
        trust: all.find((x) => x.name === name)?.trust ?? "ask",
        description: server.description ?? (server.url ? new URL(server.url).hostname : server.command!),
        tools: 0,
      };
      const k = all.findIndex((x) => x.name === name);
      if (k >= 0) {
        this.stop(name);
        all[k] = c;
      } else all.push(c);
    }
    this.save(all);
    const added: Added[] = [];
    for (const { name } of servers) {
      const r = await this.test(name);
      added.push(r);
    }
    return { added };
  }

  patch(name: string, v: { enabled?: boolean; trust?: "ask" | "read" }) {
    const all = this.load();
    const c = all.find((x) => x.name === name);
    if (!c) throw Object.assign(new Error(`no connection ${name}`), { code: "not_found", status: 404 });
    if (v.enabled !== undefined) c.enabled = v.enabled;
    if (v.trust) c.trust = v.trust;
    this.save(all);
    if (!c.enabled) this.stop(name);
    return this.list().find((x) => x.name === name)!;
  }

  remove(name: string) {
    const c = this.get(name);
    this.stop(name);
    for (const k of c.envKeys) this.secrets.deleteKey(this.secretId(name, "env", k));
    for (const k of c.headerKeys) this.secrets.deleteKey(this.secretId(name, "header", k));
    this.save(this.load().filter((x) => x.name !== name));
    this.live.delete(name);
  }

  async test(name: string): Promise<Added> {
    this.stop(name);
    try {
      const tools = await this.toolsRaw(name);
      return { name, status: "connected", tools: tools.map((t) => t.name) };
    } catch (e: any) {
      const c = this.load().find((x) => x.name === name);
      const error = redact(String(e?.message ?? e), c ? this.secretValues(c) : []);
      return { name, status: "failed", tools: [], error, ...(e?.fix ? { fix: e.fix } : {}) };
    }
  }

  // ---------------------------------------------------------------- lazy clients
  private async client(name: string): Promise<{ client: McpClient; live: Live }> {
    const c = this.get(name);
    if (!c.enabled)
      throw Object.assign(new Error(`${name} is turned off`), { fix: "turn it on in Settings › Connections" });
    let l = this.live.get(name);
    if (!l?.client) {
      l = { client: null, tools: null };
      this.live.set(name, l);
      const client = new McpClient(this.spec(c), {
        onToolsChanged: () => {
          if (l) l.tools = null;
        },
      });
      this.connects++;
      try {
        await client.connect();
      } catch (e: any) {
        l.error = redact(String(e?.message ?? e), this.secretValues(c));
        l.fix = e?.fix;
        throw e;
      }
      l.client = client;
      l.error = undefined;
      l.fix = undefined;
    }
    this.touch(name, l);
    return { client: l.client!, live: l };
  }
  private touch(name: string, l: Live) {
    if (l.idle) clearTimeout(l.idle);
    l.idle = setTimeout(() => this.stop(name), this.idleMs);
    l.idle.unref();
  }
  private stop(name: string) {
    const l = this.live.get(name);
    if (!l) return;
    if (l.idle) clearTimeout(l.idle);
    l.client?.close();
    l.client = null;
  }
  closeAll() {
    for (const name of this.live.keys()) this.stop(name);
  }

  private async toolsRaw(name: string, o: { save?: boolean } = {}): Promise<McpTool[]> {
    const { client, live } = await this.client(name);
    if (!live.tools) {
      live.tools = await client.listTools();
      if (o.save === false) return live.tools;
      const all = this.load();
      const c = all.find((x) => x.name === name);
      if (c && c.tools !== live.tools.length) {
        c.tools = live.tools.length;
        this.save(all);
      }
    }
    return live.tools;
  }

  /** the Docs page: each connection's safe face (never args, env, headers or a URL's path/query) and its tools. An
   * enabled connection is connected (or reused) to list them, each within `timeoutMs`; an off one never starts. */
  async docs(timeoutMs = 8000): Promise<ConnDoc[]> {
    return Promise.all(
      this.load().map(async (c): Promise<ConnDoc> => {
        const base = {
          name: c.name,
          description: c.description,
          transport: c.transport,
          runs: safeRuns(c.transport, c.command, c.url),
          trust: c.trust,
        };
        if (!c.enabled) return { ...base, status: "off", tools: [] };
        let timer: NodeJS.Timeout | undefined;
        try {
          const tools = await Promise.race([
            this.toolsRaw(c.name, { save: false }),
            new Promise<never>((_, rej) => {
              timer = setTimeout(
                () => rej(Object.assign(new Error("timeout"), { code: `timeout_${Math.round(timeoutMs / 1000)}` })),
                timeoutMs,
              );
            }),
          ]);
          return { ...base, status: "connected", tools: tools.map((t) => connToolDoc(t, c.trust)) };
        } catch (e: any) {
          // words by error code, never the raw message: it can echo a URL's query, the arguments or the server's stderr
          return { ...base, status: "failed", error: failWords(e?.code, base.runs), fix: CHECK_FIX, tools: [] };
        } finally {
          if (timer) clearTimeout(timer);
        }
      }),
    );
  }

  // ---------------------------------------------------------------- ExternalTools (Pip)
  catalogue() {
    return this.list()
      .filter((c) => c.enabled)
      .map((c) => ({ server: c.name, description: c.description, tools: c.tools, status: c.status }));
  }
  private ext(c: ConnectionT, t: McpTool): ExternalToolT {
    return {
      name: extName(c.name, t.name),
      server: c.name,
      tool: t.name,
      description: `${t.description ?? t.title ?? t.name}`.slice(0, 600),
      inputSchema: t.inputSchema && typeof t.inputSchema === "object" ? t.inputSchema : { type: "object" },
      readOnlyHint: t.annotations?.readOnlyHint === true,
      trust: c.trust,
    };
  }
  async tools(server: string): Promise<ExternalToolT[]> {
    const c = this.get(server);
    return (await this.toolsRaw(server)).map((t) => this.ext(c, t));
  }
  find(name: string): ExternalToolT | undefined {
    for (const c of this.load()) {
      const t = this.live.get(c.name)?.tools?.find((x) => extName(c.name, x.name) === name);
      if (t) return this.ext(c, t);
    }
    return undefined;
  }
  /** "server.tool" (the card's lend form) to the model-facing name */
  resolve(ref: string): ExternalToolT | undefined {
    const dot = ref.indexOf(".");
    if (dot < 0) return this.find(ref);
    return this.find(extName(slug(ref.slice(0, dot)), ref.slice(dot + 1)));
  }
  async call(name: string, input: unknown, signal?: AbortSignal) {
    // after a restart (or a list_changed) the tool list is loaded again from the connection the name points at
    if (!this.find(name))
      for (const c of this.load())
        if (c.enabled && name.startsWith(`${extName(c.name, "")}`)) await this.toolsRaw(c.name).catch(() => {});
    const t = this.find(name);
    if (!t) return { ok: false, text: `${name} is not loaded; list the connection's tools first` };
    try {
      const { client, live } = await this.client(t.server);
      const r = await client.callTool(t.tool, input, signal);
      this.touch(t.server, live);
      const { text, images } = resultText(r);
      return { ok: !r.isError, text, images };
    } catch (e: any) {
      return { ok: false, text: `${String(e?.message ?? e)}${e?.fix ? ` (fix: ${e.fix})` : ""}` };
    }
  }
}
