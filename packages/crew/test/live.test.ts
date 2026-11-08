// What the crew drawer shows live and in its log (docs/API.md `progress`, docs/PIP-JOURNEY.md): a model call streams a
// throttled, transient `progress` event (a drawing's raw JSON and palette too), its log entry names the task kind, the
// Anthropic stream forwards a tool call's JSON as it arrives, code-only steps leave a line, the judge points the face
// at the chosen variant, and a revision card names its planner and says what really waits. Over the fictional
// QuestDay example and temp folders only; no model is called.
import assert from "node:assert/strict";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { z } from "zod";

const home = mkdtempSync(join(tmpdir(), "pap-live-"));
process.env.PAP_HOME = home;
const root = join(home, "projects");
mkdirSync(root, { recursive: true });
const EXAMPLE = new URL("../../../examples/questday/", import.meta.url).pathname;

const { buildRegistry, Workspace } = await import("@pap/tools");
const { ModelGateway } = await import("../src/gateway-impl.ts");
const { FakeProvider, FAKE_CAPS, Ledger, SecretStore, defaultSettings } = await import("../src/llm/index.ts");
const { AnthropicProvider } = await import("../src/llm/anthropic.ts");
const { templateFor } = await import("../src/outputs.ts");
const rules = await import("../src/plan/rules.ts");
const { wireCrew } = await import("../../../apps/server/src/wire.ts");

const open: InstanceType<typeof Workspace>[] = [];
after(() => {
  for (const w of open) w.closeAll();
  rmSync(home, { recursive: true, force: true });
});

let n = 0;
async function crewOn() {
  const dir = join(root, `q_${++n}`);
  cpSync(EXAMPLE, dir, { recursive: true, filter: (f) => !f.endsWith(".pap-lock") });
  const settings = defaultSettings();
  settings.providers.push({ id: "fake", kind: "custom", label: "Fake", baseUrl: "http://fake.invalid", enabled: true });
  for (const r of Object.keys(settings.roles)) settings.roles[r] = { model: "fake/model" };
  const gateway = new ModelGateway({
    ledger: new Ledger(join(home, `ledger-${n}.sqlite`)),
    secrets: new SecretStore({ env: {}, keychain: false, dir: home }),
    settings,
    providers: [new FakeProvider(() => ({ error: new Error("unexpected call") }), { id: "fake" })],
    caps: { "fake/model": FAKE_CAPS },
  });
  const workspace = new Workspace(() => [dir]);
  open.push(workspace);
  const wired = await wireCrew({ workspace, registry: buildRegistry(), gateway, resume: false });
  const p = workspace.get(workspace.list().find((x) => x.dir === dir)!.id);
  return { c: wired.crewImpl as any, p };
}
const fakeRun = () =>
  ({
    abort: new AbortController(),
    paused: false,
    startedAt: new Date().toISOString(),
    done: { redone: new Set(), reboarded: [], approximated: [], exported: false },
    triggers: [],
    redos: new Map(),
    id: "run_test",
    revisions: 0,
  }) as any;
const transcript = (p: any, id: string) =>
  readFileSync(join(p.dir, "runs", "transcripts", `${id}.jsonl`), "utf8")
    .trim()
    .split("\n")
    .map((l) => JSON.parse(l));

test("a model call streams progress: transient, throttled, a drawing's JSON and palette; its log names the kind", async () => {
  const { c, p } = await crewOn();
  const seen: any[] = [];
  p.events.on("event", (e: any) => e.event === "progress" && seen.push(e));
  const draft = '{"notes":"ship","frames":[{"name":"idle0","rows":["..kk..",".kPPk."]}]}';
  // the gateway, stubbed: thinking, then the answer's JSON in three pieces, as a provider streams it
  c.deps.gateway.json = async (spec: any) => {
    spec.onEvent({ type: "thinking", text: "light from the upper left" });
    spec.onEvent({ type: "tool_call", name: "answer" });
    for (const part of [draft.slice(0, 20), draft.slice(20, 50), draft.slice(50)]) {
      spec.onEvent({ type: "json", text: part });
      await new Promise((r) => setTimeout(r, 300));
    }
    return {
      data: JSON.parse(draft),
      model: "fake/model",
      result: { usage: { outputTokens: 40 }, usd: 0 },
    };
  };
  const t = c.task(p, { kind: "asset.draw", role: "pixel-artist", title: "Drawing moth, variant 1" });
  await c.ask(p, fakeRun(), t, {
    role: "pixel-artist",
    kind: "asset.draw",
    prompt: "pixel-artist/draw",
    vars: {
      palette: "",
      name: "moth",
      w: 6,
      h: 2,
      frames: "idle0",
      letters: "kP",
      spec: "a moth",
      example: "",
      variant: 1,
    },
    schema: z.object({ notes: z.string(), frames: z.array(z.object({ name: z.string(), rows: z.array(z.string()) })) }),
  });
  assert.ok(seen.length >= 2, "more than one event over the call");
  assert.ok(seen.length <= 6, "throttled: not one per delta");
  for (const e of seen) assert.equal(e.seq, 0, "transient: no seq, never replayed");
  const last = seen.at(-1).data;
  assert.equal(last.what, "task");
  assert.equal(last.taskId, t.id);
  assert.equal(last.phase, "writing");
  assert.ok(last.tokens > 0);
  assert.equal(last.draft, draft, "the drawing's raw answer so far");
  assert.match(last.palette.k, /^#[0-9a-f]{6}$/i, "the palette's letters, as colours");
  assert.equal(seen[0].data.phase, "thinking");
  const stored = readFileSync(join(p.dir, "runs", "events.jsonl"), "utf8");
  assert.ok(!stored.includes('"progress"'), "never in the event log");
  const model = transcript(p, t.id).find((e) => e.kind === "model");
  assert.equal(model.detail.kind, "asset.draw", "the drawer names the step from the card and the kind");
});

test("the Anthropic stream forwards a tool call's JSON as it arrives", async () => {
  const enc = new TextEncoder();
  const events: [string, unknown][] = [
    ["message_start", { type: "message_start", message: { id: "m", model: "claude-opus-5-5", usage: {} } }],
    [
      "content_block_start",
      { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "t1", name: "x", input: {} } },
    ],
    [
      "content_block_delta",
      { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: '{"rows": ["..' } },
    ],
    [
      "content_block_delta",
      { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: 'AB"]}' } },
    ],
    ["content_block_stop", { type: "content_block_stop", index: 0 }],
    ["message_delta", { type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 5 } }],
    ["message_stop", { type: "message_stop" }],
  ];
  const body = events.map(([ev, d]) => `event: ${ev}\ndata: ${JSON.stringify(d)}\n\n`).join("");
  const p = new AnthropicProvider(
    { id: "anthropic", kind: "anthropic", label: "Anthropic", baseUrl: "https://api.anthropic.com", enabled: true },
    {
      getKey: () => "sk-test",
      sleep: async () => {},
      fetch: async () =>
        new Response(
          new ReadableStream({
            start(ctl) {
              ctl.enqueue(enc.encode(body));
              ctl.close();
            },
          }),
          { status: 200, headers: { "content-type": "text/event-stream" } },
        ),
    },
  );
  let json = "";
  await p.chat(
    { model: "anthropic/claude-opus-5-5", system: "s", messages: [{ role: "user", content: "x" }], maxOut: 100 },
    {
      onEvent: (e) => {
        if (e.type === "json") json += e.text;
      },
    },
  );
  assert.equal(json, '{"rows": ["..AB"]}');
});

test("one passing variant is picked by the rules: a short row says so, and the face shows the chosen variant", async () => {
  const { c, p } = await crewOn();
  const spec = { letters: "kS", description: "A small pale moth with soft wings.", reads: "a moth" };
  const moth = { name: "moth", kind: "creature", description: spec.description };
  writeFileSync(
    c.artFile(p, "moth", "spec"),
    JSON.stringify({ ...moth, size: "16x16", motion: "fly", spec, letters: "kS", row: "x" }),
  );
  const tpl = templateFor("creature", { size: "16x16", motion: "fly" });
  const rows = Array.from({ length: 16 }, () => "kkkkkkkkkkkkkkkk");
  // variant 2 passed; variant 1 failed and left nothing
  writeFileSync(
    c.artFile(p, "moth", "v2"),
    JSON.stringify({
      frames: { notes: "ship", frames: tpl.frames.map((name) => ({ name, rows })) },
      std: { ok: true },
      model: "fake/model",
    }),
  );
  writeFileSync(join(p.dir, "runs", "moth-v2.png"), Buffer.from("png"));
  const env = {
    modelFor: () => "fake/model",
    fallbackFor: () => undefined,
    caps: () => FAKE_CAPS,
    laneSize: () => 3,
    local: () => false,
  };
  const judge = rules.mkTask(
    { id: "t_judge_moth", kind: "asset.judge", dependsOn: [], asset: "moth" } as any,
    { env, rev: 0 } as any,
  );
  const out = await c.assetJudge(p, fakeRun(), { ...judge, status: "running" });
  assert.equal(out.status, "done");
  const row = p.state.tasks.find((t: any) => t.kind === "asset.judge");
  assert.ok(row, "a row, so the drawer shows the pick");
  assert.equal(row.status, "done");
  assert.equal(row.lastImage, `/api/p/${p.id}/variants/moth-v2.png`, "the chosen variant, not the last one drawn");
  assert.match(transcript(p, row.id)[0].title, /^Picked variant 2/);
  assert.ok(existsSync(join(p.dir, "assets", "moth.json")));
});

test("a revision card names who re-planned and says when the rest of the video waits on it", async () => {
  const { c, p } = await crewOn();
  const cards: any[] = [];
  c.onPlanCard = (_p: any, card: any) => {
    cards.push(card);
    return "card_1";
  };
  const env = {
    modelFor: () => "fake/model",
    fallbackFor: () => undefined,
    caps: () => FAKE_CAPS,
    laneSize: () => 3,
    local: () => false,
  };
  const mk = (id: string, kind: string, deps: string[], extra: Record<string, unknown> = {}) =>
    rules.mkTask({ id, kind, dependsOn: deps, ...extra } as any, { env, rev: 0 } as any);
  const prev = {
    rev: 2,
    approvedUsd: 0.5,
    estimate: { usd: [0.5, 0.7], sec: [60, 90], rough: false },
    tasks: [{ ...mk("t_review_r1", "review.final", [], { round: 1 }), status: "pending" }],
    ops: [],
  };
  const added = {
    ...mk("t_tune_s02_r2", "scene.tune", [], { scene: "s02", round: 2 }),
    status: "pending",
    estUsd: [2, 3],
  };
  const next = {
    ...prev,
    rev: 3,
    reason: "The storyboard is done.",
    estimate: { usd: [2.5, 3.7], sec: [60, 90], rough: false },
    // the review waits on the added tune: nothing else can run while the card waits
    tasks: [{ ...prev.tasks[0], dependsOn: ["t_tune_s02_r2"] }, added],
    ops: [{ op: "add", task: "t_tune_s02_r2", reason: "a new scene" }],
  };
  c.overTwenty(p, next, prev, { by: "code", trigger: "expand", reason: "The storyboard is done." }, ["t_tune_s02_r2"]);
  assert.equal(cards.length, 1);
  assert.equal(cards[0].planner, "director", "the Director re-planned (the storyboard expanded)");
  assert.equal(cards[0].othersRun, false, "every task left needs the held one");
});
