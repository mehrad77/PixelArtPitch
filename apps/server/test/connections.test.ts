// Connections (docs/ASSISTANT.md): nothing is spawned before the person confirms, secrets never come back, the trust
// rule decides what runs without a card, external results are fenced as data, lent tools stay with one task, and
// external tools are never in the registry or PAP's own MCP.
import assert from "node:assert/strict";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

const home = mkdtempSync(join(tmpdir(), "pap-conn-"));
process.env.PAP_HOME = home;
const root = join(home, "projects");
mkdirSync(root, { recursive: true });
const EXAMPLE = new URL("../../../examples/questday/", import.meta.url).pathname;
const FAKE = new URL("../../../packages/mcp-client/test/fixtures/fake-server.mjs", import.meta.url).pathname;

const { buildRegistry, Workspace } = await import("@pap/tools");
const { ModelGateway } = await import("@pap/crew/gateway-impl");
const { FakeProvider, FAKE_CAPS, Ledger, SecretStore, defaultSettings, setPriceOverride } = await import(
  "@pap/crew/llm/index"
);
const { wireCrew } = await import("../src/wire.ts");
const { McpSession } = await import("../src/mcp.ts");

type Step = import("@pap/crew/llm/fake").FakeStep;
let answer: (req: any) => Step = () => ({ text: "hi" });
const fake = new FakeProvider((req) => answer(req), { id: "fake" });
setPriceOverride("fake/model", { inPerMTok: 1, outPerMTok: 5 });
const script = (steps: Step[]) => {
  let k = 0;
  answer = () => steps[k++] ?? { toolCalls: [{ name: "reply", input: { text: "ok" } }] };
};

const open: InstanceType<typeof Workspace>[] = [];
const conns: { closeAll(): void }[] = [];
after(() => {
  for (const c of conns) c.closeAll();
  for (const w of open) w.closeAll();
  rmSync(home, { recursive: true, force: true });
});

let n = 0;
async function setup() {
  const dir = join(root, `q${++n}`);
  cpSync(EXAMPLE, dir, { recursive: true, filter: (f) => !f.endsWith(".pap-lock") });
  const s = defaultSettings();
  s.providers.push({ id: "fake", kind: "custom", label: "Fake", baseUrl: "http://fake.invalid", enabled: true });
  for (const r of Object.keys(s.roles)) s.roles[r] = { model: "fake/model" };
  s.roles.assistant = { model: "fake/model" };
  const secretsDir = join(home, `secrets-${n}`);
  mkdirSync(secretsDir, { recursive: true });
  const secrets = new SecretStore({ env: {}, keychain: false, dir: secretsDir });
  const gateway = new ModelGateway({
    ledger: new Ledger(join(home, `ledger-${n}.sqlite`)),
    secrets,
    settings: s,
    providers: [fake],
    caps: { "fake/model": FAKE_CAPS },
  });
  const workspace = new Workspace(() => [dir]);
  open.push(workspace);
  const registry = buildRegistry();
  const w = await wireCrew({ workspace, registry, gateway, resume: false });
  conns.push(w.connections);
  const id = workspace.list().find((x) => x.dir === dir)!.id;
  const p = workspace.get(id);
  await p.patch([{ op: "replace", path: "/budget/capUsd", value: 5 }], { reason: "test", author: { kind: "user" } });
  return { ...w, workspace, registry, p, id, secretsDir, settings: s };
}
const serverJson = (mark: string, name = "fake") =>
  JSON.stringify({
    mcpServers: {
      [name]: { command: process.execPath, args: [FAKE], env: { MARK: mark, API_KEY: "sk-very-secret-123" } },
    },
  });

test("the form card: nothing runs before the person confirms; then it connects and lists the tools", async () => {
  const w = await setup();
  const mark = join(home, `mark-${n}`);
  script([{ toolCalls: [{ name: "connection_add_form", input: {} }] }]);
  const item = (await w.pip!.ask(w.id, "add an MCP server").done) as any;
  const form = item.cards.find((c: any) => c.type === "form");
  assert.equal(form.form, "mcp_add");
  assert.equal(form.status, "open");
  assert.equal(w.connections.connects, 0);
  assert.equal(existsSync(mark), false, "nothing spawned before the confirm");
  // a bad paste fails with a fix, still nothing spawned
  await assert.rejects(
    async () => w.pip!.decide(w.id, form.id, "confirm", "").done,
    (e: any) => e.status === 400,
  );
  const r = w.pip!.decide(w.id, form.id, "confirm", serverJson(mark));
  assert.equal((r.card as any).status, "submitted");
  const done = (await r.done) as any;
  assert.equal(done.status, "done");
  assert.deepEqual(done.result.added[0].tools, ["search", "env", "write"]);
  assert.equal(readFileSync(mark, "utf8").split("\n").filter(Boolean).length, 1);
  // secrets: in the SecretStore only; the list and settings carry key names
  const listed = JSON.stringify(w.connections.list());
  assert.ok(!listed.includes("sk-very-secret-123"));
  assert.ok(!JSON.stringify(w.settings).includes("sk-very-secret-123"));
  assert.deepEqual(w.connections.list()[0].envKeys, ["MARK", "API_KEY"]);
  assert.ok(readFileSync(join(w.secretsDir, "secrets.json"), "utf8").includes("sk-very-secret-123"));
  assert.ok(
    !JSON.stringify(w.pip!.items(w.id)).includes("sk-very-secret-123"),
    "the pasted secret isn't stored in the chat",
  );
  // external tools are never in the registry, so PAP's MCP never lists them
  assert.equal(w.registry.get("ext_fake__search"), undefined);
  const mcp = new McpSession({ registry: w.registry, workspace: w.workspace, version: "t" });
  const listedMcp = (await mcp.handle({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} } as any)) as any;
  assert.ok(!JSON.stringify(listedMcp).includes("ext_"));
});

test("trust: ask every time makes every call a card; allow read-only runs readOnlyHint tools directly", async () => {
  const w = await setup();
  await w.connections.add(serverJson(join(home, `mark-t${n}`)));
  const calls: string[] = [];
  const orig = w.connections.call.bind(w.connections);
  w.connections.call = async (name, input, signal) => {
    calls.push(name);
    return orig(name, input, signal);
  };
  const turn = async () => {
    script([
      { toolCalls: [{ name: "connection_tools", input: { server: "fake" } }] },
      {
        toolCalls: [
          { name: "ext_fake__search", input: { q: "rain" } },
          { name: "ext_fake__write", input: { v: "x" } },
        ],
      },
      { toolCalls: [{ name: "reply", input: { text: "ok" } }] },
    ]);
    const k0 = fake.calls.length;
    const item = (await w.pip!.ask(w.id, "find a rain sound").done) as any;
    return { item, req: fake.calls.slice(k0) };
  };
  // default trust: ask
  assert.equal(w.connections.list()[0].trust, "ask");
  const a = await turn();
  assert.deepEqual(calls, []);
  assert.deepEqual(
    a.item.cards.map((c: any) => c.title),
    ["Use fake: search", "Use fake: write"],
  );
  assert.ok(a.item.cards[0].effects.some((e: string) => /says the tool only reads/.test(e)));
  // the loaded tools joined that turn's tool list only
  assert.ok(a.req[1].tools!.some((t: any) => t.name === "ext_fake__search"));
  assert.ok(!a.req[0].tools!.some((t: any) => t.name.startsWith("ext_")));
  w.connections.patch("fake", { trust: "read" });
  const b = await turn();
  assert.deepEqual(calls, ["ext_fake__search"], "only the read-only tool ran");
  assert.deepEqual(
    b.item.cards.map((c: any) => c.title),
    ["Use fake: write"],
  );
  // the result reached the model fenced as untrusted data
  const toolMsg = b.req[2].messages.find((m: any) => m.role === "tool" && /found: rain/.test(String(m.content)));
  assert.match(String(toolMsg?.content), /<data from="fake" note="untrusted/);
  // confirming the write card runs it
  const done = (await w.pip!.decide(w.id, b.item.cards[0].id, "confirm").done) as any;
  assert.equal(done.status, "done");
  assert.match(done.result.text, /saved x/);
});

test("lending: a confirmed change card lends the tool to that one task, and the grant ends with it", async () => {
  const w = await setup();
  await w.connections.add(serverJson(join(home, `mark-l${n}`)));
  const d = w.p.doc();
  for (const s of d.scenes) w.p.setSceneStatus(s.id, { version: "render", state: "ready" });
  w.p.setStage("deliver");
  script([
    { toolCalls: [{ name: "connection_tools", input: { server: "fake" } }] },
    {
      toolCalls: [
        { name: "crew_request_change", input: { text: "add a rain sound", scene: "1", lend: ["fake.search"] } },
      ],
    },
    { toolCalls: [{ name: "reply", input: { text: "A card." } }] },
  ]);
  const item = (await w.pip!.ask(w.id, "use my sound search for rain in scene 1").done) as any;
  const card = item.cards[0];
  assert.deepEqual(card.lend, ["fake.search"]);
  assert.ok(!JSON.stringify(item).includes("ext_fake__search"), "the card shows server.tool, not internals");
  let seen: { task: string; tools: string[] } | null = null;
  answer = (req) => {
    if (/Animator of one scene/.test(req.system ?? "")) {
      const t = w.p.state.tasks.find((x) => x.kind === "scene.tune" && x.status === "working")!;
      seen = { task: t.id, tools: w.crewImpl.lentTools(t.id) };
      w.crewImpl.pause(w.p, "after_step");
      return { json: { changes: [] } };
    }
    return { error: new Error("unexpected") };
  };
  await w.pip!.decide(w.id, card.id, "confirm").done;
  for (let i = 0; i < 1500 && !(seen && w.p.state.sceneStatus.grind?.state === "ready"); i++)
    await new Promise((r) => setTimeout(r, 10));
  assert.ok(seen, "the animator ran");
  const s = seen as unknown as { task: string; tools: string[] };
  assert.deepEqual(s.tools, ["ext_fake__search"]);
  assert.deepEqual(w.crewImpl.lentTools(s.task), [], "the grant ended with the task");
  // no other task of any role got it
  for (const t of w.p.state.tasks) assert.deepEqual(w.crewImpl.lentTools(t.id), []);
  w.crewImpl.pause(w.p, "now");
});

test("pasted JSON is checked before anything is saved", async () => {
  const w = await setup();
  await assert.rejects(w.connections.add("{not json"), (e: any) => /valid JSON/.test(e.message) && !!e.fix);
  await assert.rejects(w.connections.add(JSON.stringify({ mcpServers: { x: { args: ["a"] } } })), (e: any) =>
    /command|url/.test(e.message),
  );
  assert.deepEqual(w.connections.list(), []);
  const r = await w.connections.add(JSON.stringify({ mcpServers: { Gone: { command: "pap-no-such-cmd-xyz" } } }));
  assert.equal(r.added[0].status, "failed");
  assert.equal(r.added[0].name, "gone");
  assert.match(r.added[0].fix ?? "", /full path/);
});
