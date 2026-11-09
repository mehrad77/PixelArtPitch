// The studio server: REST + SSE for the UI (docs/API.md), MCP over Streamable HTTP, and the built UI.
// Bound to 127.0.0.1 only. Every request must carry the right Host (against DNS rebinding) and, when it has one, the
// right Origin; the UI authenticates with a cookie from the one-time launch URL plus an X-PAP-Token header on writes.
import { randomBytes, timingSafeEqual } from "node:crypto";
import { createReadStream, existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { extname, join, resolve } from "node:path";
import { Readable } from "node:stream";
import type { Pip } from "@pap/crew/assistant";
import type { DraftConversations } from "@pap/crew/brief/drafts";
import { lineOf, lineRows, needsCount, needsWords, openNeeds } from "@pap/crew/brief/line";
import { PHASE } from "@pap/crew/orchestrator";
import { InstanceKey } from "@pap/crew/plan/instances";
import { libraryAssetDir, libraryFile, libraryIndex, renderSheet, userLibraryDir } from "@pap/render";
import { buildReport, type Report } from "@pap/report";
import type { GateId, Registry, ToolContext } from "@pap/tools";
import { isFinalVideo, type OpenProject, StoreError, type Workspace } from "@pap/tools/store";
import { Hono } from "hono";
import { getCookie, setCookie } from "hono/cookie";
import { streamSSE } from "hono/streaming";
import { z } from "zod";
import { webBuild } from "./build.ts";
import { type Connections, redact } from "./connections.ts";
import { listDocs, REPO_ROOT, readDoc, toolDocs } from "./docs.ts";
import { McpSession } from "./mcp.ts";

export const VERSION = "0.1.0";
const WEB_DIR = new URL("../../web/", import.meta.url).pathname;
const WEB_DIST = join(WEB_DIR, "dist/");

/** POST /api/p/:id/changes/preview */
const ChangesPreview = z.object({
  gate: z.enum(["g0_brief", "g1_script", "g2_animatic", "g3_rough", "g4_final"]).optional(),
  text: z.string().max(2000),
  items: z.array(z.string().max(300)).max(12).optional(),
});
/** POST /api/pip's `about` ("Ask Pip about this", docs/PIP-ORCHESTRATION.md §2) */
const PipAbout = z.object({ instance: InstanceKey }).strict().optional();

export interface CrewApi {
  run(p: OpenProject, opts: { stage?: string; retry?: boolean }): Promise<void>;
  /** "Try again" / "Redo what failed": lifts a hold, or reruns the failed and fallback tasks (one with `taskId`) */
  retry?(p: OpenProject, o: { taskId?: string }): { started: boolean; resumed: boolean; busy?: boolean };
  pause(p: OpenProject, mode: "after_step" | "now"): void;
  resume(p: OpenProject): void;
  status(p: OpenProject): {
    budget: { capUsd: number; spentUsd: number; reservedUsd: number; estTotalUsd: [number, number] | null };
    time: { startedAt: string | null; etaSec: [number, number] | null; deadline: string | null };
    crew?: {
      running: boolean;
      paused: boolean;
      stage: string;
      lastActiveAt: string | null;
      queued: number;
      slots?: Record<string, { size: number; used: number }>;
    };
  };
  /** who a change would go to and what it would cost, nothing written (docs/PIP-ORCHESTRATION.md §1.12) */
  previewChange?(
    p: OpenProject,
    b: { gate?: GateId; text: string; items?: string[] },
  ): {
    role: string;
    roles: string[];
    scenes: string[];
    usd: [number, number];
    sec: [number, number];
    summary: string;
  };
  /** the production plan as the wire carries it (docs/PIP-ORCHESTRATION.md §4.2); null before the first run */
  planView?(p: OpenProject): unknown;
  /** every plan revision, as summaries */
  planRevisions?(p: OpenProject): unknown[];
  /** the crew instances (§2); the first call starts the project's `instance` events */
  instances?(p: OpenProject): unknown[];
  /** one instance's kept log, or null for an unknown id */
  instanceLog?(p: OpenProject, iid: string): unknown | null;
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
    /** each profile's role assignments (PIP-JOURNEY N22) */
    profiles?(): Promise<unknown>;
    /** probe one model's skills on request (N21); null for an unknown model */
    probe?(id: string): Promise<unknown | null>;
  };
  ledger?: (q: { project?: string; limit?: number }) => unknown;
}

export type ServerOpts = {
  port: number;
  workspace: Workspace;
  registry: Registry;
  crew?: CrewApi;
  hooks?: Hooks;
  /** Pip, the assistant (docs/ASSISTANT.md) */
  pip?: Pip;
  /** the person's MCP servers */
  connections?: Connections;
  /** /new as a conversation: the drafts and their side of Pip (docs/PIP-ORCHESTRATION.md §3) */
  drafts?: DraftConversations;
  token?: string;
  mcpToken?: string;
  /** allow the Vite dev server's origin (http://localhost:5140) */
  dev?: boolean;
  /** the repo the Docs page reads (tests point it elsewhere) */
  docsRoot?: string;
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
  // Opening the studio yourself (typed address, bookmark, reload, or a link inside the studio) signs the window in,
  // on 127.0.0.1 and localhost alike. Browsers mark such top-level navigations `Sec-Fetch-Site: none|same-origin`;
  // a page on another site can't (it gets `cross-site`), so other sites still can't reach the API.
  app.use("*", async (c, next) => {
    const path = c.req.path;
    if (
      c.req.method === "GET" &&
      !path.startsWith("/api/") &&
      path !== "/mcp" &&
      c.req.header("sec-fetch-mode") === "navigate" &&
      c.req.header("sec-fetch-dest") === "document" &&
      ["none", "same-origin"].includes(c.req.header("sec-fetch-site") ?? "") &&
      !same(getCookie(c, "pap_session") ?? "", token)
    ) {
      await next();
      // the page is a raw Response (fileResponse), so the cookie goes on it after it's built
      const res = new Response(c.res.body, c.res);
      res.headers.append("set-cookie", `pap_session=${token}; Path=/; HttpOnly; SameSite=Strict`);
      c.res = res;
      return;
    }
    await next();
  });
  app.use("/api/*", async (c, next) => {
    const cookie = getCookie(c, "pap_session") ?? "";
    const header = c.req.header("x-pap-token") ?? "";
    const authed = (cookie && same(cookie, token)) || (header && same(header, token));
    if (!authed)
      return c.json(
        {
          ok: false,
          error: { code: "unauthorized", message: "This window isn't signed in to the studio. Reload the page" },
        },
        401,
      );
    if (c.req.method !== "GET" && c.req.method !== "HEAD" && !(header && same(header, token)))
      return c.json({ ok: false, error: { code: "unauthorized", message: "missing X-PAP-Token" } }, 401);
    await next();
  });
  app.onError((e: any, c) => {
    const status = e instanceof StoreError ? e.status : 500;
    return c.json(
      {
        ok: false,
        error: {
          code: e.code ?? "error",
          message: String(e.message ?? e),
          fix: e.fix,
          ...(e.path ? { path: e.path } : {}),
        },
      },
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
  /** what waits on the person: questions, gates, the crew's open Pip cards and the plan's other waits (§1.8) */
  const needsOpts = (p: OpenProject) => {
    const plan = (o.crew?.planView?.(p) ?? null) as {
      tasks: { kind: string; status: string; gate?: string }[];
      pending?: { cardId: string };
    } | null;
    const budget = (o.crew?.status(p).crew?.running ?? false) && p.state.status.waiting === "budget";
    return {
      cards: o.pip?.crewCards(p, { pendingCardId: plan?.pending?.cardId, budget }) ?? [],
      plan: plan?.tasks ?? null,
    };
  };
  const needsOf = (p: OpenProject) => openNeeds(p, needsOpts(p));
  const stateOf = (p: OpenProject) => {
    const { at: _at, ...timeline } = p.timeline();
    const st = o.crew?.status(p);
    const needs = needsOf(p);
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
      // the rough-cut proxy has its own route (proxy.mp4) and is never "the video": listed, the page's Download took it
      files: p
        .files()
        .filter((f) => f.kind !== "video" || isFinalVideo(f))
        .map((f) => ({ ...f, url: `/api/p/${p.id}/files/${encodeURIComponent(f.name)}` })),
      digest: p.state.digest,
      paused: p.state.paused,
      status: p.state.status,
      crew: st?.crew ?? { running: false, paused: p.state.paused, stage: p.state.stage, lastActiveAt: null, queued: 0 },
      // what happened, as markers in Pip's chat: derived from the event log, with the events' own times
      milestones: p.markers(),
      sceneStatus: p.state.sceneStatus,
      // what the project has (Idea, Story, Pictures, Sound, Video) and every export, oldest first
      parts: p.parts(),
      versions: p.versions().map((v) => ({ ...v, url: `/api/p/${p.id}/versions/${v.v}.mp4` })),
      // the production plan (null until a crew first runs) and the crew members that come and go (N4)
      plan: o.crew?.planView?.(p) ?? null,
      instances: o.crew?.instances?.(p) ?? [],
      // "Needs you": the count and its words, cards included (the web adds its live questions and gates to `waiting`)
      needs: {
        count: needsCount(needs),
        words: needsWords(needs.questions, needs.gates, needs.cards, needs.waiting),
        waiting: needs.waiting,
      },
    };
  };

  // ---- session, projects ----
  app.get("/api/session", (c) =>
    c.json({
      version: VERSION,
      token,
      mcpToken,
      cli: new URL("./cli.ts", import.meta.url).pathname,
      // where publish writes (the person's library); the repo's seed is read-only
      workspace: { roots: [], libraryDir: userLibraryDir(), seedDir: o.workspace.libraryDir },
    }),
  );
  const noDrafts = (c: any) =>
    c.json({ ok: false, error: { code: "no_drafts", message: "/new is not configured" } }, 503);
  app.get("/api/projects", (c) =>
    c.json([
      ...o.workspace.list().map((x) => {
        let extra: any = { stage: "brief", spentUsd: 0, etaSec: null, deadline: null, needsYou: 0, updatedAt: null };
        try {
          const p = proj(x.id);
          const st = o.crew?.status(p);
          const needs = needsOf(p);
          extra = {
            stage: p.state.stage,
            spentUsd: st?.budget.spentUsd ?? 0,
            etaSec: st?.time.etaSec?.[0] ?? null,
            deadline: p.doc().brief.deadline ?? null,
            // what it waits on, each pick once (the script pick is a question and a gate), cards included
            needsYou: needsCount(needs),
            // in the Projects line's words ("one pick", "your OK on the rough cut")
            needs: needsWords(needs.questions, needs.gates, needs.cards, needs.waiting) ?? undefined,
            updatedAt: statSync(join(p.dir, "pitch.json")).mtime.toISOString(),
            // a glanceable card: is a crew working, what it says, where it is, and a frame to show
            running: st?.crew?.running ?? false,
            paused: p.state.paused,
            status: p.state.status,
            // projects made before status tracking only have a stage
            phase: Math.max(p.state.status?.phase ?? 0, PHASE[p.state.stage] ?? 0),
            milestones: p.state.milestones.length,
            // a finished video (not the rough cut's proxy) and no crew working on it now: a live rerun isn't finished
            finished: p.files().some(isFinalVideo) && !(st?.crew?.running ?? false),
            working: p.state.tasks.filter((t) => t.status === "working").map((t) => t.role),
            // removing it may also move its folder to the app's trash (only inside the app's own projects folder)
            canTrash: o.workspace.canTrash(x.id),
            thumb: `/api/p/${p.id}/frame?t=${Math.max(0.5, Math.min(p.timeline().duration - 0.5, p.timeline().duration * 0.4)).toFixed(2)}&scale=1`,
          };
          if (!extra.running) extra.etaSec = null;
        } catch {}
        return { ...x, ...extra };
      }),
      // drafts from /new are listed too (§4.5): zeroed fields, `status.line` is Pip's last question (N14)
      ...(o.drafts?.summaries() ?? []),
    ]),
  );
  app.post("/api/projects", async (c) => {
    const b = await c.req.json();
    // "Show all options", then submit: the composer starts the draft (its files and conversation move in)
    const draft = typeof b?.draft === "string" ? b.draft : undefined;
    if (draft) {
      if (!o.drafts) return noDrafts(c);
      o.drafts.get(draft);
    }
    const res = await o.registry.call("project_create", b, ctxFor(undefined));
    if (!res.ok) return c.json(res, 400);
    if (draft && o.drafts) await o.drafts.adopt(draft, proj((res.data as { id: string }).id));
    return c.json(res.data);
  });
  app.post("/api/projects/open", async (c) => {
    const { dir } = await c.req.json();
    const p = o.workspace.openDir(resolve(String(dir)));
    return c.json({ id: p.id });
  });
  // off the list; the folder stays, or with ?trash=1 moves to <PAP_HOME>/trash when it's in the app's own projects folder
  app.delete("/api/p/:id", (c) => {
    const id = c.req.param("id");
    const p = proj(id);
    if (o.crew?.status(p).crew?.running)
      throw new StoreError(
        "busy",
        "the crew is working on this project",
        "pause it (Pause now) and wait for it to stop, then remove it",
        409,
      );
    const trash = c.req.query("trash") === "1";
    return c.json(o.workspace.remove(id, { trash }));
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
  // the run report (docs/REPORT.md), built from what is on disk, no model call. The page names its images `img/<file>`
  // relative to itself, so it is served at …/report/ (the bare path redirects there) and its images at …/report/img/.
  // Images come only from the build's own list; the page's fetch rebuilds it, its images reuse that build.
  const reports = new Map<string, Report>();
  const report = (id: string, fresh: boolean) => {
    // by the listing, as `pap report` does: read-only, without opening the project or taking its lock
    const dir = o.workspace.list().find((x) => x.id === id)?.dir;
    if (!dir) throw new StoreError("not_found", `no project ${id}`, "use a project id from GET /api/projects", 404);
    let r = fresh ? undefined : reports.get(id);
    if (!r) {
      r = buildReport(dir);
      reports.set(id, r);
    }
    return r;
  };
  app.get("/api/p/:id/report", (c) => c.redirect(`/api/p/${encodeURIComponent(c.req.param("id"))}/report/`, 302));
  app.get("/api/p/:id/report/", (c) => {
    const r = report(c.req.param("id"), true);
    c.header("cache-control", "no-store");
    // the page runs on the studio's origin: it may run its own inline script and show its own images, nothing else
    c.header(
      "content-security-policy",
      "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src 'self'; base-uri 'none'; form-action 'none'",
    );
    return c.html(r.html);
  });
  app.get("/api/p/:id/report/img/:name", (c) => {
    const name = c.req.param("name");
    if (!/^[A-Za-z0-9_.-]+$/.test(name) || name.startsWith(".")) return c.text("bad name", 400);
    const img = report(c.req.param("id"), false).images.find((i) => i.name === `img/${name}`);
    if (!img) return c.text("not found", 404);
    return new Response(Buffer.from(img.data), {
      headers: { "content-type": "image/png", "cache-control": "no-store" },
    });
  });
  // a drawn variant's sheet (runs/<asset>-v<n>.png): the crew row's "latest image" while an asset is drawn.
  // `/runs/:name` is what older logs' `files/../runs/…` resolves to in the browser, so their images show too.
  const variant = (c: any) => {
    const p = proj(c.req.param("id"));
    const name = c.req.param("name");
    if (!/^[a-z][a-z0-9_-]*-v\d+\.png$/.test(name)) return c.text("bad name", 400);
    const f = join(p.dir, "runs", name);
    if (!existsSync(f)) return c.text("not found", 404);
    return fileResponse(f, c.req.header("range"));
  };
  app.get("/api/p/:id/variants/:name", variant);
  app.get("/api/p/:id/runs/:name", variant);
  // an exported version (out/versions/v<N>.mp4): the latest is also out/<name>.mp4, older ones only here
  app.get("/api/p/:id/versions/:name", (c) => {
    const p = proj(c.req.param("id"));
    const m = /^([1-9]\d{0,5})\.mp4$/.exec(c.req.param("name"));
    if (!m) return c.text("bad version", 400);
    const f = join(p.dir, "out", "versions", `v${m[1]}.mp4`);
    if (!existsSync(f)) return c.text("no such version", 404);
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
  // the crew channel ("Behind the scenes"): Pip's briefs and answers, the members' reports and asks
  app.get("/api/p/:id/channel", (c) => c.json(proj(c.req.param("id")).channel()));
  // the production plan's revisions (runs/plan.jsonl), oldest first
  app.get("/api/p/:id/plan/revisions", (c) => c.json(o.crew?.planRevisions?.(proj(c.req.param("id"))) ?? []));
  // a crew member's kept log (read-only): its attempts' transcripts and its channel messages, by time
  app.get("/api/p/:id/instances/:iid/log", (c) => {
    const p = proj(c.req.param("id"));
    const iid = c.req.param("iid");
    const log = InstanceKey.safeParse(iid).success ? o.crew?.instanceLog?.(p, iid) : null;
    if (!log)
      return c.json(
        {
          ok: false,
          error: {
            code: "not_found",
            message: `no crew member ${iid.slice(0, 60)} in this project`,
            fix: "use an id from the project's state.instances, such as writer or animator:s01",
          },
        },
        404,
      );
    return c.json(log);
  });
  app.get("/api/p/:id/tasks/:tid/transcript", (c) => c.json(proj(c.req.param("id")).transcript(c.req.param("tid"))));
  app.post("/api/p/:id/crew/retry", async (c) => {
    if (!o.crew) return c.json({ ok: false, error: { code: "no_crew", message: "the crew is not configured" } }, 503);
    const p = proj(c.req.param("id"));
    const b = (await c.req.json().catch(() => ({}))) as { taskId?: unknown };
    const taskId = typeof b?.taskId === "string" && b.taskId ? b.taskId.slice(0, 80) : undefined;
    // a held run goes on; else the failed and fallback tasks run again (only taskId's when given); with none, the
    // current stage reruns
    if (o.crew.retry) {
      const r = o.crew.retry(p, { taskId });
      if (r.busy)
        return c.json(
          {
            ok: false,
            error: {
              code: "busy",
              message: "the crew is working on this project",
              fix: "wait for the run to end, or pause it first",
            },
          },
          409,
        );
      return c.json({ ok: true, started: r.started, resumed: r.resumed });
    }
    o.crew.run(p, { retry: true }).catch((e) => p.emit("log", { level: "error", text: String(e?.message ?? e) }));
    return c.json({ ok: true, started: true, resumed: false });
  });
  // is the studio UI older than its source (PIP-ORCHESTRATION §1.15): the page shows a banner when it is
  app.get("/api/build", (c) => c.json(webBuild(WEB_DIR)));
  // what a change would do before it runs: the gate's "Change something" and Pip's change card read the same router
  app.post("/api/p/:id/changes/preview", async (c) => {
    if (!o.crew?.previewChange)
      return c.json({ ok: false, error: { code: "no_crew", message: "the crew is not configured" } }, 503);
    const p = proj(c.req.param("id"));
    const b = ChangesPreview.safeParse(await c.req.json().catch(() => null));
    if (!b.success)
      return c.json(
        {
          ok: false,
          error: {
            code: "bad_request",
            message: b.error.issues[0]?.message ?? "bad body",
            fix: 'send { "text": "what to change", "gate"?: "g3_rough", "items"?: ["…"] }',
          },
        },
        400,
      );
    return c.json(o.crew.previewChange(p, b.data));
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
    // the instance events start with the project's tracker
    o.crew?.instances?.(p);
    // a transient event (seq 0) has no id: an "id: 0" would make the client's reconnect replay the whole log
    const sse = (e: { seq: number; event: string; data: unknown }) => ({
      ...(e.seq ? { id: String(e.seq) } : {}),
      event: e.event,
      data: JSON.stringify(e.data),
    });
    return streamSSE(c, async (stream) => {
      for (const e of p.eventsSince(last)) await stream.writeSSE(sse(e));
      const on = (e: { seq: number; event: string; data: unknown }) => {
        stream.writeSSE(sse(e)).catch(() => {});
      };
      p.events.on("event", on);
      const ping = setInterval(() => stream.writeSSE({ event: "ping", data: "{}" }).catch(() => {}), 20000);
      await new Promise<void>((res) => stream.onAbort(() => res()));
      clearInterval(ping);
      p.events.off("event", on);
    });
  });

  // ---- Pip ----
  const noPip = (c: any) => c.json({ ok: false, error: { code: "no_pip", message: "Pip is not configured" } }, 503);
  const projectArg = (v: unknown) => (typeof v === "string" && v ? v : undefined);
  app.get("/api/pip", (c) => {
    if (!o.pip) return noPip(c);
    const draft = projectArg(c.req.query("draft"));
    if (draft) return o.drafts ? c.json(o.drafts.conversation(draft)) : noDrafts(c);
    const project = projectArg(c.req.query("project"));
    const { model, mode } = o.pip.pick(project);
    return c.json({
      items: o.pip.items(project),
      name: "Pip",
      model,
      mode,
      busy: o.pip.isBusy(project),
      summary: o.pip.summary(project),
    });
  });
  app.post("/api/pip", async (c) => {
    if (!o.pip) return noPip(c);
    const b = await c.req.json().catch(() => ({}));
    // a draft's turn (/new): one reading, one card; it streams on /api/events with `draft`
    const draft = projectArg(b.draft);
    if (draft) {
      if (!o.drafts) return noDrafts(c);
      const { turnId, done } = o.drafts.ask(draft, String(b.text ?? ""));
      done.catch((e) => console.error(`pip draft: ${e?.message ?? e}`));
      return c.json({ turnId }, 202);
    }
    const project = projectArg(b.project);
    // /context is measured, not said: nothing is stored
    if (/^\s*\/context\b/i.test(String(b.text ?? ""))) return c.json({ context: await o.pip.context(project) });
    // "Ask Pip about this": the instance's record goes into this turn's context
    const about = PipAbout.safeParse(b.about);
    if (b.about !== undefined && !about.success)
      return c.json(
        {
          ok: false,
          error: {
            code: "bad_about",
            message: "about is { instance: <an instance id> }",
            fix: 'send about: { instance: "pixel-artist:founder" } with an id from state.instances, or leave it out',
          },
        },
        400,
      );
    const { turnId, done } = o.pip.ask(
      project,
      String(b.text ?? ""),
      about.success && about.data ? { about: about.data } : {},
    );
    done.catch((e) => console.error(`pip: ${e?.message ?? e}`));
    return c.json({ turnId }, 202);
  });
  // what Pip's next call would send, measured on the real request (no model call)
  app.get("/api/pip/context", async (c) => {
    if (!o.pip) return noPip(c);
    return c.json(await o.pip.context(projectArg(c.req.query("project"))));
  });
  // the person corrects Pip's summary; Pip uses it from the next turn
  app.put("/api/pip/summary", async (c) => {
    if (!o.pip) return noPip(c);
    const b = await c.req.json().catch(() => ({}));
    if (typeof b.text !== "string")
      return c.json({ ok: false, error: { code: "bad_text", message: "text is a string" } }, 400);
    return c.json({ summary: o.pip.editSummary(projectArg(b.project), b.text) });
  });
  app.post("/api/pip/cards/:cardId", async (c) => {
    if (!o.pip) return noPip(c);
    const b = await c.req.json().catch(() => ({}));
    if (b.decision !== "confirm" && b.decision !== "decline")
      return c.json({ ok: false, error: { code: "bad_decision", message: 'decision is "confirm" or "decline"' } }, 400);
    // a draft's card: a brief_fields answer (checked with the field registry), or Start on the brief card
    const draft = projectArg(b.draft);
    if (draft) {
      if (!o.drafts) return noDrafts(c);
      const values = b.values && typeof b.values === "object" && !Array.isArray(b.values) ? b.values : {};
      const r = await o.drafts.decide(draft, c.req.param("cardId"), b.decision, values);
      return c.json({ card: r.card });
    }
    const { card, done } = o.pip.decide(
      projectArg(b.project),
      c.req.param("cardId"),
      b.decision,
      typeof b.edit === "string" ? b.edit : undefined,
    );
    done.catch((e) => console.error(`pip card: ${e?.message ?? e}`));
    return c.json({ card });
  });
  // the workspace stream: Pip's events when no project is open
  app.get("/api/events", (c) => {
    if (!o.pip) return noPip(c);
    const pip = o.pip;
    return streamSSE(c, async (stream) => {
      const on = (e: { seq: number; event: string; data: unknown }) => {
        stream.writeSSE({ id: String(e.seq), event: e.event, data: JSON.stringify(e.data) }).catch(() => {});
      };
      pip.events.on("event", on);
      const ping = setInterval(() => stream.writeSSE({ event: "ping", data: "{}" }).catch(() => {}), 20000);
      await new Promise<void>((res) => stream.onAbort(() => res()));
      clearInterval(ping);
      pip.events.off("event", on);
    });
  });

  // ---- /new as a conversation: drafts (docs/PIP-ORCHESTRATION.md §3, §4.5) ----
  app.post("/api/drafts", async (c) => {
    if (!o.drafts) return noDrafts(c);
    const b = await c.req.json().catch(() => ({}));
    const from = projectArg(b?.from);
    return c.json(o.drafts.create(from));
  });
  app.get("/api/drafts/:id", (c) => (o.drafts ? c.json(o.drafts.get(c.req.param("id"))) : noDrafts(c)));
  app.delete("/api/drafts/:id", (c) => {
    if (!o.drafts) return noDrafts(c);
    o.drafts.remove(c.req.param("id"));
    return c.json({ ok: true });
  });
  app.patch("/api/drafts/:id", async (c) => {
    if (!o.drafts) return noDrafts(c);
    const b = await c.req.json().catch(() => ({}));
    const fields = b?.fields && typeof b.fields === "object" && !Array.isArray(b.fields) ? b.fields : null;
    if (!fields)
      return c.json(
        {
          ok: false,
          error: {
            code: "bad_fields",
            message: "send { fields: { … } }",
            fix: 'e.g. { "fields": { "lengthSec": 45 } }',
          },
        },
        400,
      );
    return c.json(o.drafts.setFields(c.req.param("id"), fields));
  });
  app.get("/api/drafts/:id/composer", async (c) =>
    o.drafts ? c.json(await o.drafts.composer(c.req.param("id"))) : noDrafts(c),
  );
  app.post("/api/drafts/:id/files", async (c) => {
    if (!o.drafts) return noDrafts(c);
    const id = c.req.param("id");
    o.drafts.get(id);
    const len = Number(c.req.header("content-length") ?? 0);
    if (len > 20 * 1024 * 1024)
      return c.json({ ok: false, error: { code: "too_big", message: "max 20 MB", fix: "send a smaller file" } }, 413);
    const buf = new Uint8Array(await c.req.arrayBuffer());
    const ref = o.drafts.addFile(id, c.req.query("name") ?? "", buf, c.req.header("content-type") ?? "");
    return c.json({ ref });
  });
  app.get("/api/drafts/:id/files/:name", (c) => {
    if (!o.drafts) return noDrafts(c);
    const f = o.drafts.filePath(c.req.param("id"), c.req.param("name"));
    return existsSync(f) ? fileResponse(f) : c.text("not found", 404);
  });
  app.patch("/api/drafts/:id/refs/:name", async (c) => {
    if (!o.drafts) return noDrafts(c);
    const b = await c.req.json().catch(() => ({}));
    return c.json(o.drafts.patchRef(c.req.param("id"), c.req.param("name"), { type: b?.type, rights: b?.rights }));
  });
  // Pip's line over the Projects page, from state (D7): no model call
  app.get("/api/workspace/line", (c) =>
    c.json(lineOf(lineRows(o.workspace, (p) => o.crew?.status(p).crew?.running ?? false, needsOpts))),
  );

  // ---- connections (the person's MCP servers); secrets are never echoed ----
  const noConn = (c: any) =>
    c.json({ ok: false, error: { code: "no_connections", message: "connections are not configured" } }, 503);
  const connErr = (c: any, e: any) =>
    c.json(
      { ok: false, error: { code: e?.code ?? "error", message: redact(String(e?.message ?? e)), fix: e?.fix } },
      (e?.status ?? 400) as any,
    );
  app.get("/api/connections", (c) => (o.connections ? c.json(o.connections.list()) : noConn(c)));
  app.post("/api/connections", async (c) => {
    if (!o.connections) return noConn(c);
    const b = await c.req.json().catch(() => ({}));
    try {
      return c.json(await o.connections.add(typeof b.json === "string" ? b.json : JSON.stringify(b.json ?? "")));
    } catch (e) {
      return connErr(c, e);
    }
  });
  app.patch("/api/connections/:name", async (c) => {
    if (!o.connections) return noConn(c);
    const b = await c.req.json().catch(() => ({}));
    try {
      return c.json(
        o.connections.patch(c.req.param("name"), {
          ...(typeof b.enabled === "boolean" ? { enabled: b.enabled } : {}),
          ...(b.trust === "ask" || b.trust === "read" ? { trust: b.trust } : {}),
        }),
      );
    } catch (e) {
      return connErr(c, e);
    }
  });
  app.delete("/api/connections/:name", (c) => {
    if (!o.connections) return noConn(c);
    try {
      o.connections.remove(c.req.param("name"));
      return c.json({ ok: true });
    } catch (e) {
      return connErr(c, e);
    }
  });
  app.post("/api/connections/:name/test", async (c) => {
    if (!o.connections) return noConn(c);
    try {
      return c.json(await o.connections.test(c.req.param("name")));
    } catch (e) {
      return connErr(c, e);
    }
  });

  // ---- docs: the repo's Markdown (a fixed allow-list, read-only) and every tool; never a connection's secrets ----
  const docsRoot = o.docsRoot ?? REPO_ROOT;
  app.get("/api/docs", (c) => c.json({ docs: listDocs(docsRoot) }));
  app.get("/api/docs/file", (c) => {
    try {
      return c.json(readDoc(docsRoot, { path: c.req.query("path") }));
    } catch (e: any) {
      if (!e?.fix) throw e;
      return c.json({ ok: false, error: { code: e.code, message: e.message, fix: e.fix } }, e.status);
    }
  });
  app.get("/api/docs/tools", (c) => c.json({ tools: toolDocs(o.registry) }));
  app.get("/api/docs/connections", async (c) => c.json({ connections: (await o.connections?.docs()) ?? [] }));

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
  // each profile's role assignments, as the server would set them (N22)
  app.get("/api/settings/profiles", async (c) => c.json((await o.hooks?.settings?.profiles?.()) ?? {}));
  // check one model's skills now (N21); a model id has slashes: send it encoded, or as is
  app.post("/api/models/:id{.+}/probe", async (c) => {
    const id = decodeURIComponent(c.req.param("id"));
    const row = await o.hooks?.settings?.probe?.(id);
    if (!row)
      return c.json(
        {
          ok: false,
          error: {
            code: "not_found",
            message: `no model ${id.slice(0, 80)} on an enabled provider`,
            fix: "use an id from GET /api/models, such as anthropic/claude-sonnet-5-5",
          },
        },
        404,
      );
    return c.json(row);
  });
  app.get("/api/ledger", (c) =>
    c.json(o.hooks?.ledger?.({ project: c.req.query("project"), limit: Number(c.req.query("limit") ?? 200) }) ?? []),
  );
  // the library's two layers: the person's own first, then the repo's seed (§1.9); `layer` says which. A project's own
  // assets ("file:assets/…", likenesses and logos) are a third layer, listed read-only and never copied anywhere.
  const projectAssets = () =>
    o.workspace.list().flatMap((x) => {
      try {
        const refs: { id: string; src: string; flags?: { private?: boolean } }[] =
          JSON.parse(readFileSync(join(x.dir, "pitch.json"), "utf8")).assets ?? [];
        return refs.flatMap((r) => {
          const m = /^file:assets\/([a-zA-Z0-9_.-]+)\.json$/.exec(r.src);
          const f = m && join(x.dir, "assets", `${m[1]}.json`);
          if (!m || !f || !existsSync(f)) return [];
          const a = JSON.parse(readFileSync(f, "utf8"));
          if (typeof a?.kind !== "string" || !Array.isArray(a.frames)) return [];
          return [
            {
              id: r.id,
              kind: a.kind,
              w: a.w,
              h: a.h,
              frames: a.frames.length,
              tags: Array.isArray(a.tags) ? a.tags : [],
              description: typeof a.description === "string" ? a.description : undefined,
              layer: "project" as const,
              scope: "private" as const,
              project: { id: x.id, title: x.title },
              sheet: `/api/library/project/${encodeURIComponent(x.id)}/${encodeURIComponent(m[1])}/sheet.png`,
            },
          ];
        });
      } catch {
        return [];
      }
    });
  app.get("/api/library", (c) => {
    const lib = libraryIndex();
    const own = projectAssets();
    const user = userLibraryDir();
    return c.json({
      palette: lib.palette,
      assets: [...lib.assets.map((a) => ({ ...a, scope: "public" as const })), ...own],
      dirs: {
        seed: resolve(o.workspace.libraryDir),
        user,
        userExists: existsSync(user),
        projects: o.workspace
          .list()
          .map((x) => ({
            id: x.id,
            title: x.title,
            dir: x.dir,
            assets: own.filter((a) => a.project.id === x.id).length,
          }))
          .filter((x) => x.assets > 0),
      },
    });
  });
  // a project asset's sheet: its own <name>.png when the project keeps one, else drawn from its grid
  app.get("/api/library/project/:pid/:name/sheet.png", (c) => {
    const row = o.workspace.list().find((x) => x.id === c.req.param("pid"));
    const name = c.req.param("name");
    if (!row || !/^[a-zA-Z0-9_.-]+$/.test(name)) return c.text("not found", 404);
    const png = join(row.dir, "assets", `${name}.png`);
    if (existsSync(png)) return fileResponse(png);
    const f = join(row.dir, "assets", `${name}.json`);
    if (!existsSync(f)) return c.text("not found", 404);
    try {
      const a = JSON.parse(readFileSync(f, "utf8"));
      const pal = JSON.parse(readFileSync(libraryFile("palettes", `${String(a.palette).split("@")[0]}.json`), "utf8"));
      const colours = Object.fromEntries(Object.entries<any>(pal.colours).map(([k, v]) => [k, v.hex]));
      const body = renderSheet(a.grid, { colours, bg: pal.sky, scale: 4, columns: a.frames.length, gap: 8 });
      return c.body(new Uint8Array(body), 200, { "content-type": "image/png" });
    } catch {
      return c.text("not found", 404);
    }
  });
  const libDir = (id: string) => libraryAssetDir(id.replace(/[^a-z0-9_-]/g, "")) ?? join(o.workspace.libraryDir, "_");
  app.get("/api/library/:id", (c) => {
    const f = join(libDir(c.req.param("id")), "asset.json");
    return existsSync(f) ? c.json(JSON.parse(readFileSync(f, "utf8"))) : c.text("not found", 404);
  });
  app.get("/api/library/:id/sheet.png", (c) => {
    const f = join(libDir(c.req.param("id")), "sheet.png");
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

  // an unknown API route is a JSON 404 with a fix, never the UI's page
  app.all("/api/*", (c) =>
    c.json(
      {
        ok: false,
        error: {
          code: "not_found",
          message: `no route ${c.req.method} ${c.req.path.slice(0, 120)}`,
          fix: "see docs/API.md for the studio's routes",
        },
      },
      404,
    ),
  );

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
