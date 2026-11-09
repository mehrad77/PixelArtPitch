// Small studio routes (docs/API.md): the change preview passes its body to the crew and checks it first.
import assert from "node:assert/strict";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

const home = mkdtempSync(join(tmpdir(), "pap-routes-"));
process.env.PAP_HOME = home;
after(() => rmSync(home, { recursive: true, force: true }));

const { buildRegistry, Workspace } = await import("@pap/tools");
const { createApp } = await import("../src/app.ts");
const EXAMPLE = new URL("../../../examples/questday/", import.meta.url).pathname;
const LIB = new URL("../../../library/", import.meta.url).pathname;

/** set by a test: export_video is answered by a stub (no encode) and its calls are kept here */
let setupCalls: [string, unknown][] | null = null;

function setup(crew: Record<string, unknown>) {
  const root = join(home, `projects-${Math.random().toString(36).slice(2)}`);
  mkdirSync(root, { recursive: true });
  cpSync(EXAMPLE, join(root, "questday"), { recursive: true, filter: (f) => !f.endsWith(".pap-lock") });
  const workspace = new Workspace(() => [root]);
  const id = workspace.list()[0].id;
  const registry = buildRegistry();
  const real = registry.call.bind(registry);
  registry.call = ((name: string, input: unknown, ctx: any) => {
    if (setupCalls && name === "export_video") {
      setupCalls.push([name, input]);
      return Promise.resolve({ ok: true, data: { file: "out/questday.mp4", v: 1 } });
    }
    return real(name, input as any, ctx);
  }) as typeof registry.call;
  const { app, token } = createApp({ port: 5997, workspace, registry, crew: crew as any });
  const post = (path: string, body: unknown) =>
    app.request(path, {
      method: "POST",
      headers: {
        host: "127.0.0.1:5997",
        origin: "http://127.0.0.1:5997",
        cookie: `pap_session=${token}`,
        "x-pap-token": token,
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
    });
  const get = (path: string) =>
    app.request(path, { headers: { host: "127.0.0.1:5997", cookie: `pap_session=${token}`, "x-pap-token": token } });
  const del = (path: string) =>
    app.request(path, {
      method: "DELETE",
      headers: {
        host: "127.0.0.1:5997",
        origin: "http://127.0.0.1:5997",
        cookie: `pap_session=${token}`,
        "x-pap-token": token,
      },
    });
  return { id, post, get, del, workspace };
}

test("POST /api/p/:id/changes/preview: the crew's dry preview, its body checked first", async () => {
  const seen: unknown[] = [];
  const { id, post, workspace } = setup({
    previewChange: (_p: unknown, b: unknown) => {
      seen.push(b);
      return {
        role: "director",
        roles: ["director", "animator"],
        scenes: ["grind"],
        usd: [0.05, 0.12],
        sec: [60, 140],
        summary: "The Director re-plans scene 1, then the Animator tunes it.",
      };
    },
  });
  try {
    const ok = await post(`/api/p/${id}/changes/preview`, { gate: "g3_rough", text: "cast an owl", items: ["x"] });
    assert.equal(ok.status, 200);
    const body = (await ok.json()) as any;
    assert.equal(body.role, "director");
    assert.deepEqual(body.usd, [0.05, 0.12]);
    assert.deepEqual(seen[0], { gate: "g3_rough", text: "cast an owl", items: ["x"] });
    const bad = await post(`/api/p/${id}/changes/preview`, { gate: "g9", text: "x" });
    assert.equal(bad.status, 400);
    assert.ok(((await bad.json()) as any).error.fix);
  } finally {
    workspace.closeAll();
  }
});

test("GET /api/projects: the version is the export, never the rough cut's proxy; running is sent beside it", async () => {
  let running = true;
  const status = () => ({
    budget: { capUsd: 1, spentUsd: 0, reservedUsd: 0, estTotalUsd: null },
    time: { startedAt: null, etaSec: null, deadline: null },
    crew: { running, paused: false, stage: "deliver", lastActiveAt: null, queued: 0 },
  });
  const { id, workspace, get } = setup({ status });
  try {
    const p = workspace.get(id);
    mkdirSync(join(p.dir, "out"), { recursive: true });
    writeFileSync(join(p.dir, "out", "proxy.mp4"), "x");
    const row = async () => ((await (await get("/api/projects")).json()) as any[]).find((x) => x.id === id);
    running = false;
    assert.equal((await row()).version, null, "a proxy alone isn't a version");
    writeFileSync(join(p.dir, "out", "questday.mp4"), "x");
    p.recordVersion(join(p.dir, "out", "questday.mp4"), { rev: p.rev(), sec: 1 });
    assert.equal((await row()).version.v, 1);
    running = true;
    const r = await row();
    assert.equal(r.version.v, 1, "a live rerun keeps its version");
    assert.equal(r.running, true);
    // P6: the page's Download took the proxy, listed as a video; it has its own route instead
    const files = ((await (await get(`/api/p/${id}`)).json()) as any).files.map((f: any) => f.name);
    assert.ok(files.includes("questday.mp4"));
    assert.ok(!files.includes("proxy.mp4"), "the proxy isn't in the project's files");
  } finally {
    workspace.closeAll();
  }
});

test("GET /api/p/:id: parts and versions; GET /api/p/:id/versions/:v.mp4 plays an older one", async () => {
  const { id, workspace, get } = setup({
    status: () => ({
      budget: { capUsd: 1, spentUsd: 0, reservedUsd: 0, estTotalUsd: null },
      time: { startedAt: null, etaSec: null, deadline: null },
      crew: { running: false, paused: false, stage: "brief", lastActiveAt: null, queued: 0 },
    }),
  });
  try {
    const p = workspace.get(id);
    const before = (await (await get(`/api/p/${id}`)).json()) as any;
    assert.deepEqual(
      before.parts.parts.map((x: any) => x.id),
      ["idea", "story", "pictures", "sound", "video"],
    );
    assert.equal(before.parts.parts[4].state, "missing");
    assert.deepEqual(before.versions, []);
    mkdirSync(join(p.dir, "out"), { recursive: true });
    writeFileSync(join(p.dir, "out", "questday.mp4"), "first");
    p.recordVersion(join(p.dir, "out", "questday.mp4"), { rev: p.rev(), sec: 1 });
    writeFileSync(join(p.dir, "out", "questday.mp4"), "second");
    p.recordVersion(join(p.dir, "out", "questday.mp4"), { rev: p.rev(), sec: 1 });
    const after = (await (await get(`/api/p/${id}`)).json()) as any;
    assert.deepEqual(
      after.versions.map((v: any) => [v.v, v.url]),
      [
        [1, `/api/p/${id}/versions/1.mp4`],
        [2, `/api/p/${id}/versions/2.mp4`],
      ],
    );
    assert.equal(after.parts.parts[4].state, "ready");
    assert.ok(!after.files.some((f: any) => f.name === "versions"), "the versions folder isn't a file");
    const v1 = await get(`/api/p/${id}/versions/1.mp4`);
    assert.equal(v1.status, 200);
    assert.equal(v1.headers.get("content-type"), "video/mp4");
    assert.equal(await v1.text(), "first");
    assert.equal((await get(`/api/p/${id}/versions/3.mp4`)).status, 404);
    for (const bad of ["v1.mp4", "0.mp4", "1.5.mp4", "..%2F1.mp4", "1.mov"])
      assert.equal((await get(`/api/p/${id}/versions/${bad}`)).status, 400, bad);
  } finally {
    workspace.closeAll();
  }
});

test("the web build check: stale when dist/index.html is older than the newest source file", async () => {
  const { webBuild } = await import("../src/build.ts");
  const { utimesSync } = await import("node:fs");
  const web = join(home, `web-${Math.random().toString(36).slice(2)}`);
  mkdirSync(join(web, "src", "lib"), { recursive: true });
  mkdirSync(join(web, "dist"), { recursive: true });
  writeFileSync(join(web, "src", "lib", "a.ts"), "x");
  writeFileSync(join(web, "dist", "index.html"), "<html>");
  const at = (f: string, s: number) => utimesSync(f, s, s);
  at(join(web, "src", "lib", "a.ts"), 2_000_000);
  at(join(web, "dist", "index.html"), 1_000_000);
  const stale = webBuild(web);
  assert.equal(stale.webStale, true);
  assert.equal(stale.srcAt, new Date(2_000_000_000).toISOString());
  at(join(web, "dist", "index.html"), 3_000_000);
  assert.equal(webBuild(web).webStale, false);
  assert.deepEqual(webBuild(join(web, "nothing")), { webStale: false, builtAt: null, srcAt: null });
  const { get, workspace } = setup({});
  try {
    const b = (await (await get("/api/build")).json()) as any;
    assert.equal(typeof b.webStale, "boolean");
    assert.ok("builtAt" in b && "srcAt" in b);
  } finally {
    workspace.closeAll();
  }
});

test("GET /api/library: three layers, a project's own assets private to it, with their folders and sheets", async () => {
  const { id, get, workspace } = setup({});
  try {
    const p = workspace.get(id);
    const owl = JSON.parse(readFileSync(join(LIB, "owl", "asset.json"), "utf8"));
    mkdirSync(join(p.dir, "assets"), { recursive: true });
    writeFileSync(join(p.dir, "assets", "hero.json"), JSON.stringify({ ...owl, id: "hero", tags: ["likeness"] }));
    const doc = JSON.parse(readFileSync(join(p.dir, "pitch.json"), "utf8"));
    doc.assets.push({ id: "hero", src: "file:assets/hero.json", flags: { private: true } });
    writeFileSync(join(p.dir, "pitch.json"), JSON.stringify(doc));
    const lib = (await (await get("/api/library")).json()) as any;
    const hero = lib.assets.find((a: any) => a.id === "hero");
    assert.equal(hero.layer, "project");
    assert.equal(hero.scope, "private");
    assert.equal(hero.project.id, id);
    assert.ok(lib.assets.some((a: any) => a.id === "owl" && a.layer === "seed" && a.scope === "public"));
    assert.ok(lib.dirs.seed && lib.dirs.user && typeof lib.dirs.userExists === "boolean");
    assert.deepEqual(
      lib.dirs.projects.map((x: any) => [x.id, x.assets]),
      [[id, 1]],
    );
    // no <name>.png beside it: the sheet is drawn from its grid
    const sheet = await get(hero.sheet);
    assert.equal(sheet.status, 200);
    assert.equal(sheet.headers.get("content-type"), "image/png");
    assert.equal((await get(`/api/library/project/${id}/nope/sheet.png`)).status, 404);
  } finally {
    workspace.closeAll();
  }
});

test("DELETE /api/p/:id: off the list and kept off a scan; the trash only inside the app's projects folder", async () => {
  let running = true;
  const status = () => ({
    budget: { capUsd: 1, spentUsd: 0, reservedUsd: 0, estTotalUsd: null },
    time: { startedAt: null, etaSec: null, deadline: null },
    crew: { running, paused: false, stage: "brief", lastActiveAt: null, queued: 0 },
  });
  const { id, get, workspace, del } = setup({ status });
  try {
    const dir = workspace.list().find((x) => x.id === id)!.dir;
    assert.equal((await del(`/api/p/${id}`)).status, 409, "not while the crew works");
    running = false;
    const outside = await del(`/api/p/${id}?trash=1`);
    assert.equal(outside.status, 400, "a folder outside the app's projects folder never moves");
    assert.ok(existsSync(join(dir, "pitch.json")));
    const ok = await del(`/api/p/${id}`);
    assert.equal(ok.status, 200);
    assert.equal(((await ok.json()) as any).trashed, null);
    assert.ok(existsSync(join(dir, "pitch.json")), "the folder stays");
    const ids = ((await (await get("/api/projects")).json()) as any[]).map((x) => x.id);
    assert.ok(!ids.includes(id), "a scan of its root doesn't bring it back");
    // opening the folder by path is the way back
    assert.equal(workspace.openDir(dir).id, id);
  } finally {
    workspace.closeAll();
  }
});

test("Workspace.remove with trash: a project in the app's own projects folder moves to <PAP_HOME>/trash", async () => {
  const root = join(home, "projects");
  mkdirSync(root, { recursive: true });
  cpSync(EXAMPLE, join(root, "qd"), { recursive: true, filter: (f) => !f.endsWith(".pap-lock") });
  const workspace = new Workspace(() => [root]);
  try {
    const row = workspace.list().find((x) => x.dir === join(root, "qd"))!;
    assert.ok(workspace.canTrash(row.id));
    workspace.get(row.id);
    const r = workspace.remove(row.id, { trash: true });
    assert.ok(r.trashed?.startsWith(join(home, "trash")));
    assert.ok(existsSync(join(r.trashed!, "pitch.json")), "moved, not deleted");
    assert.ok(!existsSync(join(root, "qd")));
    assert.ok(!workspace.list().some((x) => x.id === row.id));
  } finally {
    workspace.closeAll();
  }
});

test("GET /api/projects: parts (states only) and the latest version, no phase or finished", async () => {
  const { id, workspace, get } = setup({
    status: () => ({
      budget: { capUsd: 1, spentUsd: 0, reservedUsd: 0, estTotalUsd: null },
      time: { startedAt: null, etaSec: null, deadline: null },
      crew: { running: false, paused: false, stage: "brief", lastActiveAt: null, queued: 0 },
    }),
  });
  try {
    const row = async () => ((await (await get("/api/projects")).json()) as any[]).find((x) => x.id === id);
    const a = await row();
    assert.equal("phase" in a, false);
    assert.equal("finished" in a, false);
    assert.deepEqual(Object.keys(a.parts[0]).sort(), ["done", "id", "of", "state"]);
    assert.equal(a.version, null);
    assert.equal(a.running, false);
    const p = workspace.get(id);
    mkdirSync(join(p.dir, "out"), { recursive: true });
    writeFileSync(join(p.dir, "out", "questday.mp4"), "v1");
    p.recordVersion(join(p.dir, "out", "questday.mp4"), { rev: p.rev(), sec: 1 });
    const b = await row();
    assert.equal(b.version.v, 1);
    assert.equal(b.version.upToDate, true);
    assert.equal(typeof b.version.at, "string");
  } finally {
    workspace.closeAll();
  }
});

test("SSE: a `parts` event when the parts change (a patch after an export), once per change, not logged", async () => {
  const { id, workspace, get } = setup({});
  try {
    const p = workspace.get(id);
    mkdirSync(join(p.dir, "out"), { recursive: true });
    writeFileSync(join(p.dir, "out", "questday.mp4"), "v1");
    p.recordVersion(join(p.dir, "out", "questday.mp4"), { rev: p.rev(), sec: 1 });
    await get(`/api/p/${id}/history`);
    const seen: any[] = [];
    p.events.on("event", (e: any) => {
      if (e.event === "parts") seen.push(e);
    });
    p.emit("stage", { stage: "art" });
    p.emit("render", { kind: "final", url: "/x" });
    assert.equal(seen.length, 0, "nothing changed: no event");
    await p.patch([{ op: "replace", path: "/title", value: "QuestDay, again" }], {
      reason: "test",
      baseRev: p.rev(),
      author: { kind: "user" },
    });
    assert.equal(seen.length, 1);
    assert.equal(seen[0].seq, 0, "transient");
    assert.equal(seen[0].data.parts.find((x: any) => x.id === "video").state, "stale");
    p.emit("render", { kind: "final", url: "/x" });
    assert.equal(seen.length, 1, "deduped by value");
    assert.ok(!readFileSync(join(p.dir, "runs", "events.jsonl"), "utf8").includes('"parts"'));
  } finally {
    workspace.closeAll();
  }
});

test("POST /api/p/:id/export: runs export_video (local, no model calls); 409 while the crew runs", async () => {
  let running = true;
  const calls: [string, unknown][] = [];
  const { id, workspace, post } = setup({
    status: () => ({
      budget: { capUsd: 1, spentUsd: 0, reservedUsd: 0, estTotalUsd: null },
      time: { startedAt: null, etaSec: null, deadline: null },
      crew: { running, paused: false, stage: "deliver", lastActiveAt: null, queued: 0 },
    }),
  });
  try {
    const busy = await post(`/api/p/${id}/export`, {});
    assert.equal(busy.status, 409);
    assert.equal(((await busy.json()) as any).error.code, "busy");
    running = false;
    setupCalls = calls;
    const res = await post(`/api/p/${id}/export`, { captions: "none", junk: 1 });
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { file: "out/questday.mp4", v: 1 });
    assert.deepEqual(calls, [["export_video", { captions: "none" }]]);
  } finally {
    setupCalls = null;
    workspace.closeAll();
  }
});
