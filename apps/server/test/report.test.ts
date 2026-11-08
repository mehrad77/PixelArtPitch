// The run report over HTTP (docs/API.md, docs/REPORT.md): the page under the same auth and Host/Origin checks as every
// route, its relative images resolving to …/report/img/, images only from the build's own list, and a title that
// tries to close the page's data script stays data. Over the report package's fictional fixture.
import assert from "node:assert/strict";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

const home = mkdtempSync(join(tmpdir(), "pap-report-route-"));
process.env.PAP_HOME = home;
after(() => rmSync(home, { recursive: true, force: true }));

const { buildRegistry, Workspace } = await import("@pap/tools");
const { createApp } = await import("../src/app.ts");

const FIX = new URL("../../../packages/report/test/fixtures/nightkite/", import.meta.url).pathname;

function setup() {
  const root = join(home, "projects");
  mkdirSync(root, { recursive: true });
  const dir = join(root, "nightkite");
  cpSync(FIX, dir, { recursive: true });
  // a task title that tries to end the page's data script early
  const ev = join(dir, "runs", "events.jsonl");
  const lines = readFileSync(ev, "utf8").trim().split("\n");
  const evil = lines.map((l) => l.replace(/"title":"[^"]*"/, '"title":"</script><script>alert(1)</script>"'));
  writeFileSync(ev, `${evil.join("\n")}\n`);
  const workspace = new Workspace(() => [root]);
  const id = workspace.list()[0].id;
  const { app, token } = createApp({ port: 5998, workspace, registry: buildRegistry() });
  const get = (path: string, h: Record<string, string> = { host: "127.0.0.1:5998", cookie: `pap_session=${token}` }) =>
    app.request(path, { headers: h });
  return { id, get, token, workspace };
}

test("GET /api/p/:id/report: the page, signed in only, with its images beside it", async () => {
  const { id, get, token, workspace } = setup();
  try {
    assert.equal((await get(`/api/p/${id}/report/`, { host: "127.0.0.1:5998" })).status, 401, "not signed in");
    assert.equal(
      (await get(`/api/p/${id}/report/`, { host: "evil.test", cookie: `pap_session=${token}` })).status,
      421,
      "a wrong Host",
    );
    assert.equal(
      (
        await get(`/api/p/${id}/report/`, {
          host: "127.0.0.1:5998",
          origin: "http://evil.test",
          cookie: `pap_session=${token}`,
        })
      ).status,
      403,
      "a wrong Origin",
    );
    // the bare path goes to the folder, so the page's relative `img/…` resolve under it
    const bare = await get(`/api/p/${id}/report`);
    assert.equal(bare.status, 302);
    assert.equal(bare.headers.get("location"), `/api/p/${id}/report/`);
    const page = await get(`/api/p/${id}/report/`);
    assert.equal(page.status, 200);
    assert.match(page.headers.get("content-type") ?? "", /text\/html/);
    assert.match(page.headers.get("content-security-policy") ?? "", /default-src 'none'/);
    const html = await page.text();
    assert.ok(!html.includes("</script><script>alert(1)"), "a title never closes the data script");
    const srcs = [...html.matchAll(/"(img\/[A-Za-z0-9_.-]+\.png)"/g)].map((m) => m[1]);
    assert.ok(srcs.length > 0, "the page names its images");
    for (const src of new Set(srcs)) {
      const url = new URL(src, `http://127.0.0.1:5998/api/p/${id}/report/`).pathname;
      const r = await get(url);
      assert.equal(r.status, 200, `${src} resolves at ${url}`);
      assert.equal(r.headers.get("content-type"), "image/png");
    }
    // only the build's own images: no other file of the project, no path tricks
    assert.equal((await get(`/api/p/${id}/report/img/pitch.json`)).status, 404);
    assert.equal((await get(`/api/p/${id}/report/img/..%2Fpitch.json`)).status, 400);
    assert.equal((await get(`/api/p/${id}/report/img/.hidden.png`)).status, 400);
    assert.equal((await get("/api/p/nope/report/")).status, 404, "an unknown project");
  } finally {
    workspace.closeAll();
  }
});
