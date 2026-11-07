// Pip (docs/ASSISTANT.md): the propose-don't-act gate, cards, the busy conversation, change requests, translation and
// forks, over a fake provider and a copy of the public example project.
import assert from "node:assert/strict";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

const home = mkdtempSync(join(tmpdir(), "pap-pip-"));
process.env.PAP_HOME = home;
const root = join(home, "projects");
mkdirSync(root, { recursive: true });
const EXAMPLE = new URL("../../../examples/questday/", import.meta.url).pathname;

// store.ts reads PAP_HOME once: import after setting it
const { buildRegistry, Workspace } = await import("@pap/tools");
const { ModelGateway } = await import("../src/gateway-impl.ts");
const { FakeProvider, FAKE_CAPS, Ledger, SecretStore, defaultSettings, setPriceOverride } = await import(
  "../src/llm/index.ts"
);
const { wireCrew } = await import("../../../apps/server/src/wire.ts");
const { createApp } = await import("../../../apps/server/src/app.ts");

type Step = import("../src/llm/fake.ts").FakeStep;
type Req = import("../src/llm/types.ts").ChatRequest;

/** the fake model answers from whichever handler the test set */
let answer: (req: Req, i: number) => Step = () => ({ text: "hello" });
const fake = new FakeProvider((req, i) => answer(req, i), { id: "fake" });
const local = new FakeProvider((req, i) => answer(req, i), { id: "lmstudio" });
// a local server: its calls are free
local.config = { ...local.config, kind: "lmstudio", baseUrl: "http://127.0.0.1:1234/v1" };
setPriceOverride("fake/model", { inPerMTok: 1, outPerMTok: 5 });

const settings = defaultSettings();
settings.providers.push({ id: "fake", kind: "custom", label: "Fake", baseUrl: "http://fake.invalid", enabled: true });
settings.providers = settings.providers.map((p) => (p.id === "lmstudio" ? { ...p, enabled: true } : p));
for (const r of Object.keys(settings.roles)) settings.roles[r] = { model: "fake/model" };
settings.roles.assistant = { model: "fake/model" };

let n = 0;
const open: InstanceType<typeof Workspace>[] = [];
async function setup(opts: { localPip?: boolean } = {}) {
  const dir = join(root, `questday_${++n}`);
  cpSync(EXAMPLE, dir, { recursive: true, filter: (f) => !f.endsWith(".pap-lock") });
  // an "export" so the project has a video and subtitles to hand out
  writeOut(dir, "questday.mp4", "fake video");
  writeOut(dir, "questday.srt", "1\n00:00:01,000 --> 00:00:02,000\nhi\n");
  const s = structuredClone(settings);
  if (opts.localPip) s.roles.assistant = { model: "lmstudio/small" };
  const gateway = new ModelGateway({
    ledger: new Ledger(join(home, `ledger-${n}.sqlite`)),
    secrets: new SecretStore({ env: {}, keychain: false, dir: home }),
    settings: s,
    providers: [fake, local],
    caps: { "fake/model": FAKE_CAPS, "lmstudio/small": { ...FAKE_CAPS, local: true, tools: "failed" } },
  });
  const workspace = new Workspace(() => [dir]);
  const registry = buildRegistry();
  const wired = await wireCrew({ workspace, registry, gateway, resume: false });
  const id = workspace.list().find((x) => x.dir === dir)!.id;
  const p = workspace.get(id);
  await p.patch([{ op: "replace", path: "/budget/capUsd", value: 5 }], {
    reason: "test budget",
    author: { kind: "user" },
  });
  open.push(workspace);
  return { ...wired, workspace, registry, p, id, dir };
}
function writeOut(dir: string, name: string, body: string) {
  mkdirSync(join(dir, "out"), { recursive: true });
  writeFileSync(join(dir, "out", name), body);
}

/** script: a list of steps, the rest "hello" */
const script = (steps: Step[]) => {
  let k = 0;
  answer = () => steps[k++] ?? { text: "hello" };
};

after(() => {
  for (const w of open) w.closeAll();
  rmSync(home, { recursive: true, force: true });
});

test("agent mode: reads run, the files card lists real files, and only Pip's turn is spent", async () => {
  const { pip, p, id } = await setup();
  script([
    { toolCalls: [{ name: "files_list", input: {} }], usd: 0.001 },
    {
      toolCalls: [
        { name: "reply", input: { text: "Here they are.", files: ["questday.mp4", "questday.srt", "nope.mp4"] } },
      ],
      usd: 0.001,
    },
  ]);
  assert.equal(pip!.pick(id).mode, "agent");
  const { done } = pip!.ask(id, "give me the video and the srt");
  const item = await done;
  assert.equal(item.kind, "pip");
  if (item.kind !== "pip") return;
  assert.equal(item.text, "Here they are.");
  const files = item.cards.find((c) => c.type === "files");
  assert.ok(files && files.type === "files");
  assert.deepEqual(
    files.files.map((f) => f.name),
    ["questday.mp4", "questday.srt"],
  );
  assert.equal(files.files[0].url, `/api/p/${id}/files/questday.mp4`);
  assert.ok(Math.abs((item.usd ?? 0) - 0.002) < 1e-9);
  // the conversation is stored in runs/pip.jsonl, user then Pip
  assert.deepEqual(
    pip!.items(id).map((i) => i.kind),
    ["user", "pip"],
  );
  assert.ok(existsSync(join(p.dir, "runs", "pip.jsonl")));
});

test("propose, don't act: a write the model asks for becomes a card and does not run", async () => {
  const { pip, p, id } = await setup();
  const rev = p.rev();
  const notes = p.state.notes.length;
  script([
    {
      toolCalls: [
        { name: "crew_request_change", input: { text: "make the hero bigger", scene: "2", category: "art" } },
        { name: "note_add", input: { target: { scene: "intro" }, category: "art", text: "x" } },
        // not one of Pip's tools at all
        {
          name: "project_patch",
          input: { ops: [{ op: "replace", path: "/title", value: "hacked" }], reason: "no", baseRev: rev },
        },
        { name: "ask_user", input: {} },
      ],
    },
    { toolCalls: [{ name: "reply", input: { text: "I'll ask the crew." } }] },
  ]);
  const item = await pip!.ask(id, "make the hero bigger in scene 2").done;
  assert.equal(p.rev(), rev, "the document is unchanged");
  assert.equal(p.state.notes.length, notes, "no note was added");
  assert.equal(p.doc().title === "hacked", false);
  if (item.kind !== "pip") return assert.fail();
  const plans = item.cards.filter((c) => c.type === "plan");
  assert.deepEqual(
    plans.map((c) => c.type === "plan" && c.status),
    ["proposed", "proposed"],
  );
  const change = plans[0];
  assert.ok(change.type === "plan");
  assert.match(change.title, /Ask the crew/);
  assert.deepEqual(change.who.slice(0, 1), ["animator"]);
  assert.equal(change.confirmLabel, "Ask the crew");
  // the tool results told the model what happened
  const last = fakeCallsSince(0).at(-1)!;
  const toolTexts = last.messages.filter((m) => m.role === "tool").map((m) => String(m.content));
  assert.ok(toolTexts.some((t) => /Proposed to the person as a card/.test(t)));
  assert.ok(toolTexts.some((t) => /isn't one of your tools/.test(t)));
  // no server-only fields leave the server
  const json = JSON.stringify(pip!.items(id));
  assert.ok(!/"action"|"tool"|"input"|"projectId"/.test(json), json.slice(0, 400));
});
const fakeCallsSince = (k: number) => fake.calls.slice(k);

test("cards: decline, confirm runs as the user via Pip, and a decided card can't run again", async () => {
  const { pip, p, id } = await setup();
  script([
    {
      toolCalls: [
        { name: "note_add", input: { target: { scene: "intro" }, category: "art", text: "brighter sky" } },
        { name: "crew_pause", input: {} },
      ],
    },
    { toolCalls: [{ name: "reply", input: { text: "Two cards." } }] },
  ]);
  const item = await pip!.ask(id, "leave a note and pause").done;
  if (item.kind !== "pip") return assert.fail();
  const [note, pause] = item.cards;
  const d = pip!.decide(id, pause.id, "decline");
  assert.equal(((await d.done) as any).status, "declined");
  assert.equal(p.state.paused, false);
  const c = pip!.decide(id, note.id, "confirm");
  assert.equal((c.card as any).status, "running");
  const doneCard = (await c.done) as any;
  assert.equal(doneCard.status, "done");
  assert.equal(p.state.notes.at(-1)?.text, "brighter sky");
  assert.equal(p.state.notes.at(-1)?.assignee, "animator");
  assert.throws(
    () => pip!.decide(id, note.id, "confirm"),
    (e: any) => e.status === 409,
  );
  assert.throws(
    () => pip!.decide(id, "card_nope", "confirm"),
    (e: any) => e.status === 404,
  );
  // the stored conversation shows the final states
  const stored = pip!.items(id).at(-1) as any;
  assert.deepEqual(
    stored.cards.map((x: any) => x.status),
    ["done", "declined"],
  );
});

test("the API: 202 then 409 while a turn runs, writes need the token, no server-only keys over SSE", async () => {
  const w = await setup();
  const { app, token } = createApp({ ...w, port: 5999 });
  const H = { host: "127.0.0.1:5999", "content-type": "application/json", "x-pap-token": token };
  let release!: () => void;
  const gate = new Promise<void>((r) => {
    release = r;
  });
  let k = 0;
  answer = () => {
    k++;
    return k === 1
      ? { toolCalls: [{ name: "subtitles_translate", input: { lang: "fa" } }], delayMs: 0 }
      : { toolCalls: [{ name: "reply", input: { text: "A card for Persian." } }] };
  };
  const seen: unknown[] = [];
  w.p.events.on("event", (e: any) => e.event === "pip" && seen.push(e.data));
  // hold the first model call until the second POST is in
  const orig = fake.chat.bind(fake);
  fake.chat = async (req, o) => {
    await gate;
    return orig(req, o);
  };
  const post = (text: string, headers: Record<string, string> = H) =>
    app.fetch(
      new Request("http://127.0.0.1:5999/api/pip", {
        method: "POST",
        headers,
        body: JSON.stringify({ project: w.id, text }),
      }),
    );
  const r1 = await post("subtitles in Persian too");
  assert.equal(r1.status, 202);
  assert.ok((await r1.json()).turnId);
  const r2 = await post("again");
  assert.equal(r2.status, 409);
  const { "x-pap-token": _t, ...noToken } = H;
  assert.equal((await post("no token", noToken)).status, 401);
  release();
  // wait for the turn to finish
  for (let i = 0; i < 100 && w.pip!.isBusy(w.id); i++) await new Promise((r) => setTimeout(r, 10));
  fake.chat = orig;
  const g = await app.fetch(new Request(`http://127.0.0.1:5999/api/pip?project=${w.id}`, { headers: H }));
  const body = await g.json();
  assert.equal(body.name, "Pip");
  assert.equal(body.mode, "agent");
  const card = body.items.at(-1).cards[0];
  assert.equal(card.type, "plan");
  assert.match(card.title, /Persian/);
  assert.match(card.warning, /can't draw Persian/);
  const all = JSON.stringify(body) + JSON.stringify(seen);
  assert.ok(!/"action"|"tool"|"input"|"projectId"/.test(all));
  assert.ok(seen.some((s: any) => s.type === "thinking"));
  assert.ok(seen.some((s: any) => s.type === "item" && s.item.kind === "pip"));
  // decline over the API emits a card event
  const d = await app.fetch(
    new Request(`http://127.0.0.1:5999/api/pip/cards/${card.id}`, {
      method: "POST",
      headers: H,
      body: JSON.stringify({ project: w.id, decision: "decline" }),
    }),
  );
  assert.equal((await d.json()).card.status, "declined");
  assert.ok(seen.some((s: any) => s.type === "card" && s.card.status === "declined"));
});

test("crew_request_change while the crew works: queued, nothing touched", async () => {
  const { crewImpl, registry, p, workspace } = await setup();
  for (const s of p.doc().scenes) p.setSceneStatus(s.id, { version: "render", state: "ready" });
  p.setStage("deliver");
  const before = JSON.stringify({ scene: p.state.sceneStatus, stage: p.state.stage, gates: p.state.gates });
  // the producer's call hangs: the crew is working
  answer = () => ({ json: {}, delayMs: 10_000 });
  const run = crewImpl.run(p, { stage: "brief" }).catch(() => {});
  await new Promise((r) => setTimeout(r, 50));
  const ctx = { author: { kind: "user" as const, via: "pip" }, project: p, workspace, emit: () => {} };
  // the stage moved to brief when the run started: compare after that
  const mid = JSON.stringify({ scene: p.state.sceneStatus, stage: p.state.stage, gates: p.state.gates });
  const res = await registry.call("crew_request_change", { text: "make the hero bigger", scene: "2" }, ctx);
  assert.ok(res.ok, JSON.stringify(res));
  const data = res.data as any;
  assert.equal(data.queued, true);
  assert.equal(data.owner, "animator");
  assert.equal(data.stage, "animate");
  assert.equal(JSON.stringify({ scene: p.state.sceneStatus, stage: p.state.stage, gates: p.state.gates }), mid);
  assert.notEqual(before, "");
  assert.equal(p.state.notes.find((x) => x.id === data.noteId)?.status, "open");
  crewImpl.pause(p, "now");
  await run;
});

test("crew_request_change when idle reopens the scene, the gates and the stage, and supersedes the export", async () => {
  const { registry, p, workspace } = await setup();
  const d = p.doc();
  for (const s of d.scenes) p.setSceneStatus(s.id, { version: "render", state: "ready" });
  for (const g of p.state.gates) p.setGate(g.id, { status: "passed" });
  p.upsertTask({ id: "exp1", kind: "deliver.export", role: "editor", title: "Export", status: "done", usd: 0 });
  p.milestone("deliver.export", "Your video is ready");
  p.setStage("deliver");
  p.state.paused = true; // don't start a real run in the test
  const ctx = { author: { kind: "user" as const, via: "pip" }, project: p, workspace, emit: () => {} };
  const res = await registry.call("crew_request_change", { text: "make the hero bigger", scene: "2" }, ctx);
  assert.ok(res.ok, JSON.stringify(res));
  const data = res.data as any;
  const second = d.scenes[1].id;
  assert.deepEqual([data.queued, data.started, data.stage], [false, false, "animate"]);
  assert.equal(p.state.sceneStatus[second].state, "stale");
  assert.equal(p.state.sceneStatus[d.scenes[0].id].state, "ready");
  assert.equal(p.state.stage, "animate");
  assert.deepEqual(
    p.state.gates.filter((g) => g.status === "locked").map((g) => g.id),
    ["g3_rough", "g4_final"],
  );
  assert.ok(p.state.tasks.find((t) => t.id === "exp1")?.supersededBy);
  assert.ok(!p.state.milestones.some((m) => m.id === "deliver.export"));
  const note = p.state.notes.find((x) => x.id === data.noteId)!;
  assert.deepEqual([note.assignee, note.target.scene, note.status], ["animator", second, "open"]);
});

test("the note reaches the Animator's prompt, only that scene is redone, and the hero gets bigger", async () => {
  const { crewImpl, registry, p, workspace } = await setup();
  const d = p.doc();
  for (const s of d.scenes) p.setSceneStatus(s.id, { version: "render", state: "ready" });
  p.setStage("deliver");
  p.state.paused = true;
  const ctx = { author: { kind: "user" as const, via: "pip" }, project: p, workspace, emit: () => {} };
  await registry.call("crew_request_change", { text: "make the hero twice as big", scene: "1" }, ctx);
  const tl = p.timeline();
  const mid = (tl.scenes[0].from + tl.scenes[0].to) / 2 + 0.6;
  const before = Buffer.from(await p.still(mid, 1)).toString("base64");
  const k0 = fake.calls.length;
  let animated = false;
  answer = (req) => {
    if (/Animator of one scene/.test(req.system ?? "")) {
      animated = true;
      // stop after this step: the rest of the pipeline isn't under test
      crewImpl.pause(p, "after_step");
      return { json: { changes: [{ recipe: 1, params: { scale: 2 }, why: "the person asked for a bigger hero" }] } };
    }
    return { error: new Error("unexpected call") };
  };
  p.state.paused = false;
  crewImpl.run(p, { stage: "animate" }).catch(() => {});
  for (let i = 0; i < 1500 && !(animated && p.state.sceneStatus.grind?.state === "ready"); i++)
    await new Promise((r) => setTimeout(r, 10));
  const animatorCalls = fake.calls.slice(k0).filter((c) => /Animator of one scene/.test(c.system ?? ""));
  assert.equal(animatorCalls.length, 1, "only the stale scene is redone");
  assert.match(JSON.stringify(animatorCalls[0].messages), /make the hero twice as big/);
  const sc = p.doc().scenes[0];
  assert.ok(sc.kind === "decl" && sc.recipes[1].params.scale === 2);
  const after = Buffer.from(await p.still(mid, 1)).toString("base64");
  assert.notEqual(after, before, "the frame changed");
  assert.equal(p.state.notes.find((n) => n.text === "make the hero twice as big")?.status, "done");
  crewImpl.pause(p, "now");
});

test("a change run redoes only the changed scene: a Reviewer blocker elsewhere stays a note", async () => {
  const { crewImpl, registry, p, workspace } = await setup();
  await p.patch(
    [
      { op: "replace", path: "/brief/narration", value: "none" },
      { op: "replace", path: "/brief/involvement", value: "auto" },
    ],
    { reason: "test: no narration, no gates", author: { kind: "user" } },
  );
  const d = p.doc();
  for (const s of d.scenes) p.setSceneStatus(s.id, { version: "render", state: "ready" });
  p.setStage("deliver");
  const flagBefore = JSON.stringify(p.doc().scenes.find((s) => s.id === "flag"));
  let reviewed = false;
  const tuned: string[] = [];
  answer = (req) => {
    const sys = req.system ?? "";
    if (/Animator of one scene/.test(sys)) {
      tuned.push(JSON.stringify(req.messages).match(/Scene \\"(\w+)\\"/)?.[1] ?? "?");
      return { json: { changes: [] } };
    }
    if (/festival judge/.test(sys)) {
      reviewed = true;
      // stop before the export: the rest isn't under test
      crewImpl.pause(p, "after_step");
      return {
        json: {
          verdict: "fix",
          summary: "one blocker outside the change",
          blockers: [{ t: 9, scene: "flag", issue: "the flag is off screen", fix: "move it" }],
          polish: [],
        },
      };
    }
    return { error: new Error("unexpected call") };
  };
  const ctx = { author: { kind: "user" as const, via: "pip" }, project: p, workspace, emit: () => {} };
  const res = await registry.call("crew_request_change", { text: "make the hero bigger", scene: "1" }, ctx);
  assert.ok(res.ok && (res.data as any).started, JSON.stringify(res));
  for (let i = 0; i < 3000 && !(reviewed && p.state.notes.some((n) => n.by === "reviewer")); i++)
    await new Promise((r) => setTimeout(r, 10));
  await new Promise((r) => setTimeout(r, 200));
  assert.ok(reviewed, "the review ran");
  assert.deepEqual(tuned, ["grind"], "only the changed scene was animated");
  assert.equal(p.state.sceneStatus.flag.state, "ready");
  assert.equal(JSON.stringify(p.doc().scenes.find((s) => s.id === "flag")), flagBefore);
  assert.equal(p.state.notes.find((n) => n.by === "reviewer" && n.target.scene === "flag")?.status, "open");
  crewImpl.pause(p, "now");
});

test("subtitles_translate keeps ids and timings, writes no plainText, flags burnInPossible", async () => {
  const { registry, p, workspace } = await setup();
  const cues = p.timeline().cues;
  let calls = 0;
  answer = () => {
    calls++;
    const fa = cues.map((c, i) => ({
      id: c.id,
      text: i === 0 && calls === 1 ? "خیلی ".repeat(80) : `ترجمه «${i}» — خط`,
    }));
    // the repair call gets only the too-long line
    return {
      json: {
        cues:
          calls === 1
            ? fa
            : fa
                .filter((c) => /ترجمه/.test(c.text))
                .slice(0, 1)
                .map((c) => ({ ...c, id: cues[0].id })),
      },
    };
  };
  const ctx = { author: { kind: "user" as const, via: "pip" }, project: p, workspace, emit: () => {} };
  const res = await registry.call("subtitles_translate", { lang: "fa" }, ctx);
  assert.ok(res.ok, JSON.stringify(res));
  const data = res.data as any;
  assert.equal(calls, 2, "one repair for the too-long line");
  assert.equal(data.burnInPossible, false);
  assert.ok(data.missingGlyphs.length > 0);
  const srt = readFileSync(join(p.dir, "out", data.files.find((f: any) => f.name.endsWith(".fa.srt")).name), "utf8");
  // the same blocks and timings as the project's own subtitles
  const { subtitles } = await import("@pap/render");
  const orig = subtitles(p.project()).srt;
  const times = (s: string) => s.split("\n").filter((l) => l.includes("-->"));
  assert.deepEqual(times(srt), times(orig));
  assert.equal(srt.split("\n\n").length, cues.length);
  // typographic marks kept as written: no plainText swap
  assert.ok(srt.includes("«") && srt.includes("—"));
  assert.ok(existsSync(join(p.dir, "out", data.files.find((f: any) => f.name.endsWith(".fa.vtt")).name)));
  // a Latin translation the font can draw
  answer = () => ({ json: { cues: cues.map((c) => ({ id: c.id, text: c.text.toUpperCase() })) } });
  const en = await registry.call("subtitles_translate", { lang: "es" }, ctx);
  assert.ok(en.ok);
  assert.equal((en.data as any).burnInPossible, true);
});

test("project_fork copies settings and cast, not the script, storyboard or renders", async () => {
  const { registry, p, workspace } = await setup();
  const ctx = { author: { kind: "user" as const, via: "pip" }, project: p, workspace, emit: () => {} };
  const res = await registry.call(
    "project_fork",
    { title: "Bakery launch", brief: "A 20 s launch for a small bakery's sourdough." },
    ctx,
  );
  assert.ok(res.ok, JSON.stringify(res));
  const np = workspace.get((res.data as any).projectId);
  assert.deepEqual(readdirSync(join(np.dir, "out")), []);
  assert.deepEqual(
    np.doc().assets.map((a) => a.id),
    p.doc().assets.map((a) => a.id),
  );
  assert.equal(np.doc().brief.idea, "A 20 s launch for a small bakery's sourdough.");
  assert.notDeepEqual(np.doc().script.cues, p.doc().script.cues);
  assert.equal(np.doc().scenes.length, 1);
  assert.equal(np.state.gates.find((g) => g.id === "g0_brief")?.status, "open");
  assert.equal(np.state.stage, "brief");
});

test("menu mode (a local model): one structured call, deterministic cards", async () => {
  const { pip, id } = await setup({ localPip: true });
  assert.equal(pip!.pick(id).mode, "menu");
  const k0 = local.calls.length;
  answer = () => ({ json: { intent: "translate_subtitles", params: { lang: "fa" }, reply: "I can do that." } });
  const item = await pip!.ask(id, "subtitles in Persian too").done;
  assert.equal(local.calls.length - k0, 1);
  assert.ok(!local.calls.at(-1)!.tools?.some((t) => t.name === "render_still"), "no tools in menu mode");
  if (item.kind !== "pip") return assert.fail();
  const c = item.cards[0];
  assert.ok(c.type === "plan");
  assert.match(c.title, /Persian/);
  assert.deepEqual(c.who, ["writer"]);
  answer = () => ({ json: { intent: "other", params: {}, reply: "Vertical video isn't possible yet." } });
  const no = await pip!.ask(id, "make it vertical for stories").done;
  if (no.kind !== "pip") return assert.fail();
  assert.equal(no.cards[0].type, "cant");
  const fr = readFileSync(join(home, "feature-requests.jsonl"), "utf8");
  assert.match(fr, /vertical/);
});

test("every role is listed for Pip, and the assistant role has a model in each profile", async () => {
  const { Role } = await import("@pap/schema");
  const { PROFILES, ROLE_NEEDS } = await import("../src/llm/index.ts");
  const { ROLE_LINE } = await import("../src/assistant.ts");
  assert.ok(Role.options.includes("assistant"));
  for (const r of Role.options) {
    assert.ok(ROLE_LINE[r], r);
    assert.ok(ROLE_NEEDS[r], r);
    assert.ok(PROFILES.best[r] && PROFILES.balanced[r], r);
  }
  assert.equal(PROFILES.best.assistant.model, "anthropic/claude-sonnet-5-5");
});
