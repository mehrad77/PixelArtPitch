// Small studio routes (docs/API.md): the change preview passes its body to the crew and checks it first.
import assert from "node:assert/strict";
import { cpSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

const home = mkdtempSync(join(tmpdir(), "pap-routes-"));
process.env.PAP_HOME = home;
after(() => rmSync(home, { recursive: true, force: true }));

const { buildRegistry, Workspace } = await import("@pap/tools");
const { createApp } = await import("../src/app.ts");
const EXAMPLE = new URL("../../../examples/questday/", import.meta.url).pathname;

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
  return { id, post, workspace };
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
