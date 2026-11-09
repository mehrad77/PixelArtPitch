// Small studio routes (docs/API.md): the change preview passes its body to the crew and checks it first.
import assert from "node:assert/strict";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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

function setup(crew: Record<string, unknown>) {
  const root = join(home, `projects-${Math.random().toString(36).slice(2)}`);
  mkdirSync(root, { recursive: true });
  cpSync(EXAMPLE, join(root, "questday"), { recursive: true, filter: (f) => !f.endsWith(".pap-lock") });
  const workspace = new Workspace(() => [root]);
  const id = workspace.list()[0].id;
  const { app, token } = createApp({ port: 5997, workspace, registry: buildRegistry(), crew: crew as any });
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
  return { id, post, get, workspace };
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

test("GET /api/projects: finished means a video and no crew working; the rough cut's proxy isn't one", async () => {
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
    assert.equal((await row()).finished, false, "a proxy alone isn't a finished video");
    writeFileSync(join(p.dir, "out", "questday.mp4"), "x");
    assert.equal((await row()).finished, true);
    running = true;
    assert.equal((await row()).finished, false, "a live rerun isn't finished");
    // P6: the page's Download took the proxy, listed as a video; it has its own route instead
    const files = ((await (await get(`/api/p/${id}`)).json()) as any).files.map((f: any) => f.name);
    assert.ok(files.includes("questday.mp4"));
    assert.ok(!files.includes("proxy.mp4"), "the proxy isn't in the project's files");
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
