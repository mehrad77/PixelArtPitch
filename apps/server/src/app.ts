// The studio server: REST + SSE for the UI (docs/API.md), MCP over Streamable HTTP, and the built UI.
// Bound to 127.0.0.1 only. Every request must carry the right Host (against DNS rebinding) and, when it has one, the
// right Origin; the UI authenticates with a cookie from the one-time launch URL plus an X-PAP-Token header on writes.
import { randomBytes, timingSafeEqual } from "node:crypto";
import { createReadStream, existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { extname, join, resolve } from "node:path";
import { Readable } from "node:stream";
import { PHASE } from "@pap/crew/orchestrator";
import type { Registry, ToolContext } from "@pap/tools";
import { type OpenProject, StoreError, type Workspace } from "@pap/tools/store";
import { Hono } from "hono";
import { getCookie, setCookie } from "hono/cookie";
import { streamSSE } from "hono/streaming";
import { McpSession } from "./mcp.ts";

export const VERSION = "0.1.0";
const WEB_DIST = new URL("../../web/dist/", import.meta.url).pathname;

export interface CrewApi {
  run(p: OpenProject, opts: { stage?: string }): Promise<void>;
  pause(p: OpenProject, mode: "after_step" | "now"): void;
  resume(p: OpenProject): void;
  status(p: OpenProject): {
    budget: { capUsd: number; spentUsd: number; reservedUsd: number; estTotalUsd: [number, number] | null };
    time: { startedAt: string | null; etaSec: [number, number] | null; deadline: string | null };
    crew?: { running: boolean; paused: boolean; stage: string; lastActiveAt: string | null; queued: number };
  };
  gate(
    p: OpenProject,
    gate: string,
    verdict: { verdict: string; items?: string[]; reasons?: string[]; by: string },
  ): unknown;
}

export interface Hooks {
  settings?: {
    get(): unknown;
    put(v: unknown): unknown;
    setKey(id: string, key: string): void;
    test(id: string): Promise<unknown>;
    models(): Promise<unknown>;
  };
  ledger?: (q: { project?: string; limit?: number }) => unknown;
}

export type ServerOpts = {
  port: number;
  workspace: Workspace;
  registry: Registry;
  crew?: CrewApi;
  hooks?: Hooks;
  token?: string;
  mcpToken?: string;
  /** allow the Vite dev server's origin (http://localhost:5140) */
  dev?: boolean;
};

const same = (a: string, b: string) => {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
};

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript",
  ".css": "text/css",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".woff2": "font/woff2",
  ".mp4": "video/mp4",
  ".srt": "text/plain; charset=utf-8",
  ".vtt": "text/vtt",
  ".wav": "audio/wav",
  ".webm": "audio/webm",
  ".json": "application/json",
};

/** a file response with Range support (video seeking) */
function fileResponse(file: string, range?: string | null) {
  const size = statSync(file).size;
  const type = MIME[extname(file)] ?? "application/octet-stream";
  const m = range && /bytes=(\d*)-(\d*)/.exec(range);
  if (m) {
    const start = m[1] ? Number(m[1]) : 0;
    const end = m[2] ? Number(m[2]) : size - 1;
    return new Response(Readable.toWeb(createReadStream(file, { start, end })) as any, {
      status: 206,
      headers: {
        "content-type": type,
        "content-range": `bytes ${start}-${end}/${size}`,
        "accept-ranges": "bytes",
        "content-length": String(end - start + 1),
      },
    });
  }
  return new Response(Readable.toWeb(createReadStream(file)) as any, {
    headers: { "content-type": type, "content-length": String(size), "accept-ranges": "bytes" },
  });
}

export function createApp(o: ServerOpts) {
  const token = o.token ?? randomBytes(24).toString("base64url");
  const mcpToken = o.mcpToken ?? randomBytes(24).toString("base64url");
  const hosts = new Set([
    `127.0.0.1:${o.port}`,
    `localhost:${o.port}`,
    ...(o.dev ? ["127.0.0.1:5140", "localhost:5140"] : []),
  ]);
  const origins = new Set([...hosts].map((h) => `http://${h}`));
  const app = new Hono();
  const mcpSessions = new Map<string, McpSession>();

  // ---- security ----
  app.use("*", async (c, next) => {
    const host = c.req.header("host") ?? "";
    if (!hosts.has(host)) return c.text("bad host", 421);
    const origin = c.req.header("origin");
    if (origin && !origins.has(origin)) return c.text("bad origin", 403);
    c.header("x-content-type-options", "nosniff");
    c.header("referrer-policy", "no-referrer");
    await next();
  });
  app.get("/", async (c, next) => {
    const t = c.req.query("t");
    if (t && same(t, token)) {
      setCookie(c, "pap_session", token, { httpOnly: true, sameSite: "Strict", path: "/" });
      return c.redirect("/");
    }
    return next();
  });
  app.use("/api/*", async (c, next) => {
    const cookie = getCookie(c, "pap_session") ?? "";
    const header = c.req.header("x-pap-token") ?? "";
    const authed = (cookie && same(cookie, token)) || (header && same(header, token));
    if (!authed)
      return c.json(
        { ok: false, error: { code: "unauthorized", message: "open the launch URL printed by `pap serve`" } },
        401,
      );
    if (c.req.method !== "GET" && c.req.method !== "HEAD" && !(header && same(header, token)))
      return c.json({ ok: false, error: { code: "unauthorized", message: "missing X-PAP-Token" } }, 401);
    await next();
  });
  app.onError((e: any, c) => {
    const status = e instanceof StoreError ? e.status : 500;
    return c.json(
      { ok: false, error: { code: e.code ?? "error", message: String(e.message ?? e), fix: e.fix } },
      status as any,
    );
  });

  const proj = (id: string) => o.workspace.get(id);
  const ctxFor = (p: OpenProject | undefined): ToolContext => ({
    author: { kind: "user" },
    project: p,
    workspace: o.workspace,
    emit: (e) => p?.emit(e.type, e),
  });
  const stateOf = (p: OpenProject) => {
    const { at: _at, ...timeline } = p.timeline();
    const st = o.crew?.status(p);
    return {
      doc: p.doc(),
      rev: p.rev(),
      timeline,
      stage: p.state.stage,
      gates: p.state.gates,
      tasks: p.state.tasks.map(({ transcript: _x, ...t }) => t),
      questions: p.state.questions,
      notes: p.state.notes,
      budget: st?.budget ?? { capUsd: p.doc().budget.capUsd, spentUsd: 0, reservedUsd: 0, estTotalUsd: null },
      time: st?.time ?? { startedAt: p.state.startedAt, etaSec: null, deadline: p.doc().brief.deadline ?? null },
      files: p.files().map((f) => ({ ...f, url: `/api/p/${p.id}/files/${encodeURIComponent(f.name)}` })),
      digest: p.state.digest,
      paused: p.state.paused,
      status: p.state.status,
      crew: st?.crew ?? { running: false, paused: p.state.paused, stage: p.state.stage, lastActiveAt: null, queued: 0 },
      milestones: p.state.milestones,
      sceneStatus: p.state.sceneStatus,
    };
  };

  // ---- session, projects ----
  app.get("/api/session", (c) =>
    c.json({
      version: VERSION,
      token,
      mcpToken,
      cli: new URL("./cli.ts", import.meta.url).pathname,
      workspace: { roots: [], libraryDir: o.workspace.libraryDir },
    }),
  );
  app.get("/api/projects", (c) =>
    c.json(
      o.workspace.list().map((x) => {
        let extra: any = { stage: "brief", spentUsd: 0, etaSec: null, deadline: null, needsYou: 0, updatedAt: null };
        try {
          const p = proj(x.id);
          const st = o.crew?.status(p);
          extra = {
            stage: p.state.stage,
            spentUsd: st?.budget.spentUsd ?? 0,
            etaSec: st?.time.etaSec?.[0] ?? null,
            deadline: p.doc().brief.deadline ?? null,
            needsYou:
              p.state.questions.filter((q) => q.status === "open").length +
              p.state.gates.filter((g) => g.status === "open").length,
            updatedAt: statSync(join(p.dir, "pitch.json")).mtime.toISOString(),
            // a glanceable card: is a crew working, what it says, where it is, and a frame to show
            running: st?.crew?.running ?? false,
            paused: p.state.paused,
            status: p.state.status,
            // projects made before status tracking only have a stage
            phase: Math.max(p.state.status?.phase ?? 0, PHASE[p.state.stage] ?? 0),
            milestones: p.state.milestones.length,
            finished: p.files().some((f) => f.kind === "video"),
            working: p.state.tasks.filter((t) => t.status === "working").map((t) => t.role),
            thumb: `/api/p/${p.id}/frame?t=${Math.max(0.5, Math.min(p.timeline().duration - 0.5, p.timeline().duration * 0.4)).toFixed(2)}&scale=1`,
          };
          if (!extra.running) extra.etaSec = null;
        } catch {}
        return { ...x, ...extra };
      }),
    ),
  );
  app.post("/api/projects", async (c) => {
    const b = await c.req.json();
    const res = await o.registry.call("project_create", b, ctxFor(undefined));
    return res.ok ? c.json(res.data) : c.json(res, 400);
  });
  app.post("/api/projects/open", async (c) => {
    const { dir } = await c.req.json();
    const p = o.workspace.openDir(resolve(String(dir)));
    return c.json({ id: p.id });
  });
  app.get("/api/p/:id", (c) => c.json(stateOf(proj(c.req.param("id")))));
  app.get("/api/p/:id/history", async (c) =>
    c.json(await proj(c.req.param("id")).history(Number(c.req.query("since") ?? 0))),
  );
  app.post("/api/p/:id/patch", async (c) => {
    const b = await c.req.json();
    return c.json(
      await proj(c.req.param("id")).patch(b.ops, { reason: b.reason, baseRev: b.baseRev, author: { kind: "user" } }),
    );
  });
  app.post("/api/p/:id/undo", async (c) => {
    const b = await c.req.json();
    return c.json(await proj(c.req.param("id")).undo(Number(b.seq), String(b.reason ?? "undo"), { kind: "user" }));
  });
  app.get("/api/p/:id/frame", async (c) => {
    const p = proj(c.req.param("id"));
    const t = Number(c.req.query("t") ?? 0);
    const scale = Math.max(1, Math.min(6, Number(c.req.query("scale") ?? 2) | 0));
    const img = await p.still(Number.isFinite(t) ? t : 0, scale);
    return new Response(Buffer.from(img), {
      headers: { "content-type": "image/png", "cache-control": "private, max-age=60" },
    });
  });
  app.get("/api/p/:id/contact", async (c) => {
    const res = await o.registry.call(
      "render_contact",
      { every: Number(c.req.query("every") ?? 1) },
      ctxFor(proj(c.req.param("id"))),
    );
    if (!res.ok || !res.images?.[0]) return c.json(res, 500);
    return new Response(Buffer.from(res.images[0].data), { headers: { "content-type": "image/png" } });
  });
  app.get("/api/p/:id/files/:name", (c) => {
    const p = proj(c.req.param("id"));
    const name = c.req.param("name");
    if (!/^[A-Za-z0-9_.-]+$/.test(name)) return c.text("bad name", 400);
    const f = join(p.dir, "out", name);
    if (!existsSync(f)) return c.text("not found", 404);
    return fileResponse(f, c.req.header("range"));
  });
  app.get("/api/p/:id/proxy.mp4", (c) => {
    const p = proj(c.req.param("id"));
    const f = join(p.dir, "out", "proxy.mp4");
    if (!existsSync(f)) return c.text("no preview yet", 404);
    return fileResponse(f, c.req.header("range"));
  });
  app.post("/api/p/:id/tools/:name", async (c) => {
    const b = await c.req.json().catch(() => ({}));
    const res = await o.registry.call(c.req.param("name"), b.input ?? {}, ctxFor(proj(c.req.param("id"))));
    if (!res.ok) return c.json(res, 400);
    return c.json({
      ...res,
      images: res.images?.map((i) => ({
        mediaType: i.mediaType,
        caption: i.caption,
        data: Buffer.from(i.data).toString("base64"),
      })),
    });
  });
  app.post("/api/p/:id/questions/:qid/answer", async (c) => {
    const b = await c.req.json();
    return c.json(await proj(c.req.param("id")).answer(c.req.param("qid"), b, "user"));
  });
  app.post("/api/p/:id/notes", async (c) => {
    const b = await c.req.json();
    const res = await o.registry.call("note_add", b, { ...ctxFor(proj(c.req.param("id"))), author: { kind: "user" } });
    return res.ok ? c.json(res.data) : c.json(res, 400);
  });
  app.post("/api/p/:id/gates/:gate", async (c) => {
    const b = await c.req.json();
    const p = proj(c.req.param("id"));
    if (o.crew) return c.json(o.crew.gate(p, c.req.param("gate"), { ...b, by: "user" }));
    const g = p.setGate(c.req.param("gate") as any, {
      status: b.verdict === "changes" ? "changes" : "passed",
      verdict: { by: "user", verdict: b.verdict, reasons: b.reasons, at: new Date().toISOString() },
    });
    return c.json(g);
  });
  app.post("/api/p/:id/crew/run", async (c) => {
    if (!o.crew) return c.json({ ok: false, error: { code: "no_crew", message: "the crew is not configured" } }, 503);
    const b = await c.req.json().catch(() => ({}));
    const p = proj(c.req.param("id"));
    o.crew.run(p, { stage: b.stage }).catch((e) => p.emit("log", { level: "error", text: String(e?.message ?? e) }));
    return c.json({ ok: true });
  });
  app.get("/api/p/:id/tasks/:tid/transcript", (c) => c.json(proj(c.req.param("id")).transcript(c.req.param("tid"))));
  app.post("/api/p/:id/crew/retry", async (c) => {
    if (!o.crew) return c.json({ ok: false, error: { code: "no_crew", message: "the crew is not configured" } }, 503);
    const p = proj(c.req.param("id"));
    o.crew
      .run(p, { stage: p.state.stage })
      .catch((e) => p.emit("log", { level: "error", text: String(e?.message ?? e) }));
    return c.json({ ok: true });
  });
  app.post("/api/p/:id/crew/pause", async (c) => {
    const b = await c.req.json().catch(() => ({}));
    o.crew?.pause(proj(c.req.param("id")), b.mode === "now" ? "now" : "after_step");
    return c.json({ ok: true });
  });
  app.post("/api/p/:id/crew/resume", (c) => {
    o.crew?.resume(proj(c.req.param("id")));
    return c.json({ ok: true });
  });
  app.post("/api/p/:id/vo", async (c) => {
    const p = proj(c.req.param("id"));
    const take = (c.req.query("take") ?? `take-${Date.now()}`).replace(/[^a-zA-Z0-9_-]/g, "");
    const ext = (c.req.header("content-type") ?? "").includes("webm") ? "webm" : "wav";
    const buf = Buffer.from(await c.req.arrayBuffer());
    if (buf.length > 200 * 1024 * 1024)
      return c.json({ ok: false, error: { code: "too_big", message: "max 200 MB" } }, 413);
    const { mkdirSync } = await import("node:fs");
    mkdirSync(join(p.dir, "private", "vo"), { recursive: true });
    const rel = `private/vo/${take}.${ext}`;
    writeFileSync(join(p.dir, rel), buf);
    p.emit("log", { level: "info", text: `narration take saved: ${rel}` });
    return c.json({ file: rel });
  });
  app.post("/api/p/:id/vo/align", async (c) => {
    const b = await c.req.json();
    const res = await o.registry.call("vo_align", { file: b.file, apply: !!b.apply }, ctxFor(proj(c.req.param("id"))));
    return res.ok ? c.json(res.data) : c.json(res, 400);
  });
  app.get("/api/p/:id/events", (c) => {
    const p = proj(c.req.param("id"));
    const last = Number(c.req.header("last-event-id") ?? c.req.query("since") ?? 0);
    return streamSSE(c, async (stream) => {
      for (const e of p.eventsSince(last))
        await stream.writeSSE({ id: String(e.seq), event: e.event, data: JSON.stringify(e.data) });
      const on = (e: { seq: number; event: string; data: unknown }) => {
        stream.writeSSE({ id: String(e.seq), event: e.event, data: JSON.stringify(e.data) }).catch(() => {});
      };
      p.events.on("event", on);
      const ping = setInterval(() => stream.writeSSE({ event: "ping", data: "{}" }).catch(() => {}), 20000);
      await new Promise<void>((res) => stream.onAbort(() => res()));
      clearInterval(ping);
      p.events.off("event", on);
    });
  });

  // ---- settings, models, ledger, library ----
  app.get("/api/settings", (c) => c.json(o.hooks?.settings?.get() ?? {}));
  app.put("/api/settings", async (c) => c.json(o.hooks?.settings?.put(await c.req.json()) ?? {}));
  app.put("/api/settings/providers/:id/key", async (c) => {
    const { key } = await c.req.json();
    o.hooks?.settings?.setKey(c.req.param("id"), String(key ?? ""));
    return c.json({ hasKey: !!key });
  });
  app.post("/api/settings/providers/:id/test", async (c) =>
    c.json((await o.hooks?.settings?.test(c.req.param("id"))) ?? { ok: false }),
  );
  app.get("/api/models", async (c) => c.json((await o.hooks?.settings?.models()) ?? []));
  app.get("/api/ledger", (c) =>
    c.json(o.hooks?.ledger?.({ project: c.req.query("project"), limit: Number(c.req.query("limit") ?? 200) }) ?? []),
  );
  app.get("/api/library", (c) => c.json(JSON.parse(readFileSync(join(o.workspace.libraryDir, "index.json"), "utf8"))));
  app.get("/api/library/:id", (c) => {
    const f = join(o.workspace.libraryDir, c.req.param("id").replace(/[^a-z0-9-]/g, ""), "asset.json");
    return existsSync(f) ? c.json(JSON.parse(readFileSync(f, "utf8"))) : c.text("not found", 404);
  });
  app.get("/api/library/:id/sheet.png", (c) => {
    const f = join(o.workspace.libraryDir, c.req.param("id").replace(/[^a-z0-9-]/g, ""), "sheet.png");
    return existsSync(f) ? fileResponse(f) : c.text("not found", 404);
  });

  // ---- MCP over Streamable HTTP ----
  app.all("/mcp", async (c) => {
    const auth = c.req.header("authorization") ?? "";
    if (!auth.startsWith("Bearer ") || !same(auth.slice(7), mcpToken)) return c.text("unauthorized", 401);
    if (c.req.method === "GET") return c.text("server-initiated streams are not offered", 405);
    if (c.req.method === "DELETE") {
      mcpSessions.delete(c.req.header("mcp-session-id") ?? "");
      return c.body(null, 204);
    }
    if (c.req.method !== "POST") return c.text("method not allowed", 405);
    const body = await c.req.json().catch(() => null);
    if (!body) return c.json({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "parse error" } }, 400);
    const msgs = Array.isArray(body) ? body : [body];
    let sid = c.req.header("mcp-session-id") ?? "";
    let s = mcpSessions.get(sid);
    if (!s) {
      if (!msgs.some((m) => m.method === "initialize") && sid) return c.text("unknown session", 404);
      sid = randomBytes(16).toString("hex");
      s = new McpSession({ registry: o.registry, workspace: o.workspace, version: VERSION });
      mcpSessions.set(sid, s);
    }
    const outs = (await Promise.all(msgs.map((m) => s!.handle(m)))).filter(Boolean);
    c.header("mcp-session-id", sid);
    if (!outs.length) return c.body(null, 202);
    return c.json(Array.isArray(body) ? outs : outs[0]);
  });

  // ---- the built UI ----
  app.get("*", (c) => {
    if (!existsSync(WEB_DIST))
      return c.text("PixelArtPitch server is running. Build the UI with: pnpm --filter @pap/web build", 200);
    const path = c.req.path.replace(/\.\.+/g, "");
    const f = join(WEB_DIST, path);
    if (path !== "/" && existsSync(f) && statSync(f).isFile()) return fileResponse(f);
    return fileResponse(join(WEB_DIST, "index.html"));
  });

  return { app, token, mcpToken };
}
