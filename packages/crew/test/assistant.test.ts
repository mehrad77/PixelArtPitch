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

// ---------------------------------------------------------------- change requests: routing, re-board, settling
async function changeProject() {
  const w = await setup();
  await w.p.patch(
    [
      { op: "replace", path: "/brief/narration", value: "none" },
      { op: "replace", path: "/brief/involvement", value: "auto" },
    ],
    { reason: "test: no narration, no gates", author: { kind: "user" } },
  );
  for (const s of w.p.doc().scenes) w.p.setSceneStatus(s.id, { version: "render", state: "ready" });
  w.p.setStage("deliver");
  return w;
}
const until = async (f: () => boolean, ms = 30_000) => {
  for (let t = 0; t < ms && !f(); t += 20) await new Promise((r) => setTimeout(r, 20));
};
const review = (blockers: { scene: string; issue: string }[]) => ({
  json: {
    verdict: blockers.length ? "fix" : "ship",
    summary: "checked",
    blockers: blockers.map((b) => ({ t: 1, scene: b.scene, issue: b.issue, fix: "fix it" })),
    polish: [],
  },
});

test("routing: new characters go to the Director, never the Producer; the card says so", async () => {
  const { changeOwner, CHANGE_CATEGORIES } = await import("@pap/tools");
  const npc = "use some NPCs in the video. maybe 2. one is walking and one is telling him about the todo app";
  assert.equal(changeOwner({}, "other", npc), "director");
  assert.equal(changeOwner({}, "art", npc), "director");
  assert.equal(changeOwner({ scene: "s1" }, "story", "x"), "director");
  assert.equal(changeOwner({ scene: "s1" }, "art", "make the hero bigger"), "animator");
  assert.equal(changeOwner({}, "sound", "quieter music"), "sound-designer");
  assert.equal(changeOwner({ cue: "c01" }, "text", "say hello"), "writer");
  for (const c of CHANGE_CATEGORIES)
    for (const t of [{}, { scene: "s1" }, { cue: "c01" }])
      assert.notEqual(changeOwner(t, c, "do something"), "producer");
  const { pip, id } = await setup();
  script([
    { toolCalls: [{ name: "crew_request_change", input: { text: npc, category: "story" } }] },
    { toolCalls: [{ name: "reply", input: { text: "A card." } }] },
  ]);
  const item = (await pip!.ask(id, npc).done) as any;
  const c = item.cards[0];
  assert.deepEqual(c.who, ["director", "animator", "reviewer", "editor"]);
  assert.match(c.detail, /The Director re-plans scenes 1, 2 and 3/);
  assert.match(c.effects[0], /Scene 4 stays as it is/);
});

test("bundled review notes are listed on the card, one line each", async () => {
  const { pip, id, p } = await setup();
  const n = p.addNote({
    target: { scene: "grind" },
    category: "art",
    text: "the headline is cut off",
    assignee: "animator",
    by: "reviewer",
  });
  script([
    {
      toolCalls: [
        {
          name: "crew_request_change",
          input: { text: "make the hero bigger", scene: "1", category: "art", alsoNotes: [n.id] },
        },
      ],
    },
    { toolCalls: [{ name: "reply", input: { text: "A card." } }] },
  ]);
  const item = (await pip!.ask(id, "make the hero bigger in scene 1 and fix that headline").done) as any;
  assert.ok(item.cards[0].effects.includes(`Also fixes ${n.id}: the headline is cut off`));
});

test("a story change: the Director re-boards only that scene, casts from the library, and the card settles", async () => {
  const w = await changeProject();
  const before = Object.fromEntries(w.p.doc().scenes.map((s) => [s.id, JSON.stringify(s)]));
  const tuned: string[] = [];
  let reboardPrompt = "";
  answer = (req) => {
    const sys = req.system ?? "";
    if (/Re-plan ONLY the listed scenes/.test(sys)) {
      reboardPrompt = JSON.stringify(req.messages);
      return {
        json: {
          scenes: [
            {
              id: "grind",
              recipes: [
                { id: "backdrop_night", params: {} },
                { id: "walk_in", params: { hero: "cast-founder", x: 110 } },
                { id: "spawn_join", params: { who: "cast-developer", x: 200, banner: "Try QuestDay" } },
              ],
            },
          ],
          approximated: "A banner stands in for the conversation.",
        },
      };
    }
    if (/Animator of one scene/.test(sys)) {
      tuned.push(/Scene \\"(\w+)\\"/.exec(JSON.stringify(req.messages))?.[1] ?? "?");
      return { json: { changes: [] } };
    }
    if (/festival judge/.test(sys)) return review([]);
    return { error: new Error(`unexpected call: ${sys.slice(0, 60)}`) };
  };
  const res = w.pip!.planCards(
    "crew_request_change",
    { text: "add two characters, one tells the other about the app", scene: "1", category: "story" },
    w.p,
  );
  assert.ok(!("error" in res));
  // store the card the way a turn would, then confirm it
  const card = (res as any).cards[0];
  (w.pip as any).log(w.p).append({ id: "pip_t", at: new Date().toISOString(), kind: "pip", text: "", cards: [card] });
  const run = w.pip!.decide(w.id, card.id, "confirm");
  const first = (await run.done) as any;
  assert.equal(first.status, "running", "a handoff keeps working until the crew's run ends");
  await until(() => (w.pip!.items(w.id).at(-1) as any).cards?.[0]?.status !== "running", 90_000);
  const settled = (w.pip!.items(w.id).find((i) => i.id === "pip_t") as any).cards[0];
  assert.equal(settled.status, "done", JSON.stringify(settled));
  assert.match(settled.result.text, /The Director re-planned scene 1\./);
  assert.match(settled.result.text, /Approximated: A banner stands in for the conversation\./);
  assert.match(settled.result.text, /A new video is exported/);
  assert.match(reboardPrompt, /one tells the other about the app/);
  assert.deepEqual(tuned, ["grind"]);
  const grind = w.p.doc().scenes.find((s) => s.id === "grind")!;
  assert.ok(grind.kind === "decl" && grind.recipes.some((r) => r.id === "spawn_join"));
  assert.ok(
    w.p.doc().assets.some((a) => a.id === "cast-founder") && w.p.doc().assets.some((a) => a.id === "cast-developer"),
  );
  for (const s of w.p.doc().scenes) if (s.id !== "grind") assert.equal(JSON.stringify(s), before[s.id], s.id);
});

test("blockers left on the changed scene stop the crew at the rough cut, and the card says what's still wrong", async () => {
  const w = await changeProject();
  let reviews = 0;
  answer = (req) => {
    const sys = req.system ?? "";
    if (/Animator of one scene/.test(sys)) return { json: { changes: [] } };
    if (/festival judge/.test(sys)) {
      reviews++;
      return review([
        { scene: "grind", issue: "The hero is still small." },
        { scene: "flag", issue: "Unrelated: the flag is late." },
      ]);
    }
    return { error: new Error("unexpected") };
  };
  const res = w.pip!.planCards(
    "crew_request_change",
    { text: "make the hero bigger", scene: "1", category: "art" },
    w.p,
  ) as any;
  const card = res.cards[0];
  (w.pip as any).log(w.p).append({ id: "pip_g", at: new Date().toISOString(), kind: "pip", text: "", cards: [card] });
  await w.pip!.decide(w.id, card.id, "confirm").done;
  await until(() => (w.pip!.items(w.id).find((i) => i.id === "pip_g") as any).cards[0].status !== "running");
  const settled = (w.pip!.items(w.id).find((i) => i.id === "pip_g") as any).cards[0];
  assert.equal(settled.status, "done");
  assert.match(settled.result.text, /Still wrong: scene 1: The hero is still small\./);
  assert.ok(!/flag is late/.test(settled.result.text), "blockers outside the change aren't the change's");
  assert.match(settled.result.text, /waits for you at the rough cut/);
  assert.equal(reviews, 2, "one fix round, then stop");
  assert.equal(w.p.state.gates.find((g) => g.id === "g3_rough")?.status, "open");
  assert.notEqual(w.p.state.gates.find((g) => g.id === "g4_final")?.status, "passed");
  assert.match(w.p.state.status.line, /Waiting for you/);
  w.crewImpl.pause(w.p, "now");
});

test("a failed run fails its card; a card a dead process left running settles on start", async () => {
  const w = await setup();
  const mk = (id: string, noteId: string) => ({
    id: `pip_${id}`,
    at: new Date().toISOString(),
    kind: "pip",
    text: "",
    cards: [
      {
        id: `card_${id}`,
        type: "plan",
        status: "running",
        title: "Ask the crew: x",
        detail: "",
        who: ["animator"],
        usd: null,
        sec: null,
        effects: [],
        confirmLabel: "Ask the crew",
        action: { tool: "crew_request_change", input: {}, projectId: w.id, handoff: { noteId } },
      },
    ],
  });
  const log = (w.pip as any).log(w.p);
  log.append(mk("a", "n90"));
  w.pip!.settle(w.p, {
    status: "failed",
    error: "the animator's model is unreachable",
    notes: ["n90"],
    redone: [],
    reboarded: [],
    approximated: [],
    openBlockers: [],
    exported: false,
  });
  const a = (w.pip!.items(w.id).find((i) => i.id === "pip_a") as any).cards[0];
  assert.equal(a.status, "failed");
  assert.match(a.result.error, /unreachable/);
  // a restart: nothing is running, the note is still open
  w.p.addNote({ target: {}, category: "other", text: "x", assignee: "animator", by: "user" });
  log.append(mk("b", w.p.state.notes.at(-1)!.id));
  w.pip!.settleStale(() => false);
  const b = (w.pip!.items(w.id).find((i) => i.id === "pip_b") as any).cards[0];
  assert.equal(b.status, "failed");
  assert.match(b.result.text, /stopped before this finished/);
});

// ---------------------------------------------------------------- slash commands and the summary
test("/why, /budget and /undo answer without a model call", async () => {
  const { pip, id, p } = await setup();
  script([
    { toolCalls: [{ name: "files_list", input: {} }], usage: { inputTokens: 500, outputTokens: 40 }, usd: 0.002 },
    { toolCalls: [{ name: "reply", input: { text: "Here." } }], usd: 0.001 },
  ]);
  await pip!.ask(id, "what files are there").done;
  const k0 = fake.calls.length;
  const why = (await pip!.ask(id, "/why").done) as any;
  assert.match(why.text, /fake\/model in agent mode \(prompt assistant\/system@2\)/);
  assert.match(why.text, /files_list → ok/);
  assert.match(why.text, /cost \$0\.00/);
  const show = (await pip!.ask(id, "/budget").done) as any;
  assert.match(show.text, /^The cap is \$5\. \$0\.00\d? spent|^The cap is \$5\. Nothing spent yet\./);
  const raise = (await pip!.ask(id, "/budget 10").done) as any;
  assert.equal(raise.cards[0].title, "Raise the cap to $10");
  // a Pip-made patch to undo
  await p.patch([{ op: "replace", path: "/title", value: "Renamed" }], {
    reason: "rename it",
    author: { kind: "user", via: "pip" },
  });
  const undo = (await pip!.ask(id, "/undo").done) as any;
  assert.match(undo.cards[0].title, /Undo: rename it/);
  assert.equal(fake.calls.length, k0, "no model call for /why, /budget, /undo");
  await pip!.decide(id, raise.cards[0].id, "confirm").done;
  assert.equal(p.doc().budget.capUsd, 10);
  await pip!.decide(id, undo.cards[0].id, "confirm").done;
  assert.notEqual(p.doc().title, "Renamed");
  // anything else that starts with / is a message
  script([{ toolCalls: [{ name: "reply", input: { text: "ok" } }] }]);
  await pip!.ask(id, "/dance").done;
  assert.equal(fake.calls.length, k0 + 1);
});

test("auto-compact folds the oldest items before they leave the window; the summary reaches the prompt; edits are used", async () => {
  const { pip, id, p } = await setup();
  // 24 old items: past the 20-item window
  const log = (pip as any).log(p);
  for (let i = 0; i < 12; i++) {
    log.append({ id: `u_old${i}`, at: new Date().toISOString(), kind: "user", text: `old question ${i}` });
    log.append({ id: `pip_old${i}`, at: new Date().toISOString(), kind: "pip", text: `old answer ${i}`, cards: [] });
  }
  const seen: Req[] = [];
  answer = (req) => {
    seen.push(req);
    if (/keep the memory of a long conversation/.test(req.system ?? ""))
      return { json: { text: "The person prefers short videos.\nThey asked for Persian subtitles." }, usd: 0.0005 };
    return { toolCalls: [{ name: "reply", input: { text: "ok" } }] };
  };
  await pip!.ask(id, "next question").done;
  const compactCall = seen.find((r) => /keep the memory/.test(r.system ?? ""))!;
  assert.ok(compactCall, "a compact call ran");
  assert.match(JSON.stringify(compactCall.messages), /old question 0/);
  assert.ok(!/old answer 11/.test(JSON.stringify(compactCall.messages)), "the last 6 items stay out of the fold");
  const main = seen.at(-1)!;
  const shown = JSON.stringify(main.messages);
  assert.match(shown, /The person prefers short videos/);
  assert.ok(!/old question 0/.test(shown), "folded items aren't sent again");
  assert.match(shown, /old answer 11/);
  const sum = pip!.summary(id)!;
  assert.equal(sum.upTo, "u_old9");
  assert.equal(sum.freed?.items, 19);
  assert.equal(sum.freed?.method, "estimate");
  assert.ok(sum.freed!.before > sum.freed!.after && sum.freed!.freed === sum.freed!.before - sum.freed!.after);
  // the person edits the summary: the next turn uses it
  pip!.editSummary(id, "The person wants a 30 s cut.");
  await pip!.ask(id, "and now?").done;
  assert.match(JSON.stringify(seen.at(-1)!.messages), /The person wants a 30 s cut/);
  assert.ok(!/prefers short videos/.test(JSON.stringify(seen.at(-1)!.messages)));
  // /compact folds now
  const before = seen.length;
  const r = (await pip!.ask(id, "/compact").done) as any;
  assert.match(
    r.text,
    /Folded \d+ messages into my summary\. That freed about [\d,]+ tokens of my context \([\d,]+ → [\d,]+\)\.|nothing old enough/,
  );
  assert.ok(seen.length - before <= 1, "at most one call");
});

// ---------------------------------------------------------------- the crew channel: Pip as the orchestrator
const isConduct = (req: Req) => /directing a small AI crew/.test(req.system ?? "");
const askIdOf = (req: Req) => /askId (m_[0-9a-f]+)/.exec(JSON.stringify(req.messages))?.[1] ?? "";

test("channel: a member's ask is answered by Pip without the person", async () => {
  const w = await setup();
  await w.p.patch([{ op: "replace", path: "/brief/involvement", value: "key" }], {
    reason: "t",
    author: { kind: "user" },
  });
  w.p.setStage("brief");
  let pipCalls = 0;
  answer = (req) => {
    const sys = req.system ?? "";
    if (isConduct(req)) {
      pipCalls++;
      return {
        toolCalls: [
          { name: "crew_answer", input: { askId: askIdOf(req), optionId: "calm", text: "The brief says calm." } },
        ],
      };
    }
    if (/Producer/.test(sys))
      return {
        json: {
          digest: "A calm launch video for QuestDay, made by the crew.",
          assumptions: [],
          questions: [
            {
              question: "Should the music feel calm or upbeat?",
              why: "it sets the pace",
              options: [
                { id: "calm", label: "Calm", detail: "" },
                { id: "upbeat", label: "Upbeat", detail: "" },
              ],
              recommendedId: "upbeat",
            },
          ],
          report: { status: "done", did: "planned" },
        },
      };
    return { error: new Error("unexpected") };
  };
  w.crewImpl.run(w.p, { stage: "brief" }).catch(() => {});
  await until(() => w.p.state.gates.find((g) => g.id === "g0_brief")?.status === "open");
  assert.equal(pipCalls, 1);
  assert.equal(w.p.state.questions.filter((q) => q.from === "producer").length, 0, "the person wasn't asked");
  assert.ok(w.p.doc().notes.some((n) => n.by === "pip" && /calm or upbeat\? → Calm/.test(n.text)));
  const ch = w.p.channel();
  const ask = ch.find((m) => m.kind === "ask" && m.from === "producer")!;
  assert.ok(ask);
  assert.ok(ch.some((m) => m.kind === "answer" && m.from === "pip" && m.replyTo === ask.id && /calm/i.test(m.text)));
  assert.ok(ch.some((m) => m.kind === "report" && m.from === "producer" && /^done: planned/.test(m.text)));
  w.crewImpl.pause(w.p, "now");
});

test("channel: a blocked report gets at most 2 redo rounds, then Pip holds and tells the person", async () => {
  const w = await changeProject();
  let tunes = 0;
  let pipCalls = 0;
  answer = (req) => {
    const sys = req.system ?? "";
    if (isConduct(req)) {
      pipCalls++;
      return { toolCalls: [{ name: "crew_redo", input: { scenes: ["grind"], why: "try the walk again" } }] };
    }
    if (/Animator of one scene/.test(sys)) {
      tunes++;
      return {
        json: { changes: [], report: { status: "blocked", did: "nothing", couldnt: "no recipe makes him fly" } },
      };
    }
    return { error: new Error("unexpected") };
  };
  const ctx = { author: { kind: "user" as const, via: "pip" }, project: w.p, workspace: w.workspace, emit: () => {} };
  const res = await w.registry.call(
    "crew_request_change",
    { text: "make the hero fly", scene: "1", category: "art" },
    ctx,
  );
  assert.ok(res.ok);
  await until(() => /Waiting for you/.test(w.p.state.status.line));
  assert.equal(tunes, 3, "the first try plus 2 redo rounds");
  assert.equal(pipCalls, 3);
  assert.match(w.p.state.status.line, /already had 2 redo rounds/);
  const ch = w.p.channel();
  assert.equal(ch.filter((m) => m.from === "pip" && /^Redo grind/.test(m.text)).length, 2);
  assert.ok(ch.some((m) => m.from === "pip" && /^Hold:/.test(m.text)));
  assert.ok(ch.some((m) => m.from === "animator" && /^blocked: .*Couldn't: no recipe makes him fly/.test(m.text)));
  w.crewImpl.pause(w.p, "now");
  w.crewImpl.resume(w.p);
});

test("channel: routine done reports cost no Pip call", async () => {
  const w = await changeProject();
  let pipCalls = 0;
  let reviewed = false;
  answer = (req) => {
    const sys = req.system ?? "";
    if (isConduct(req)) {
      pipCalls++;
      return { toolCalls: [{ name: "crew_next", input: {} }] };
    }
    if (/Animator of one scene/.test(sys)) return { json: { changes: [], report: { status: "done", did: "tuned" } } };
    if (/festival judge/.test(sys)) {
      reviewed = true;
      w.crewImpl.pause(w.p, "after_step");
      return { json: { verdict: "ship", summary: "fine", blockers: [], polish: [] } };
    }
    return { error: new Error("unexpected") };
  };
  const ctx = { author: { kind: "user" as const, via: "pip" }, project: w.p, workspace: w.workspace, emit: () => {} };
  await w.registry.call("crew_request_change", { text: "make the hero bigger", scene: "1", category: "art" }, ctx);
  await until(() => reviewed && w.p.channel().some((m) => m.from === "reviewer"));
  await new Promise((r) => setTimeout(r, 200));
  assert.equal(pipCalls, 0);
  const ch = w.p.channel();
  assert.ok(
    ch.some((m) => m.from === "pip" && m.kind === "brief" && /The person asked: make the hero bigger/.test(m.text)),
  );
  assert.ok(ch.some((m) => m.from === "animator" && m.kind === "report" && /^done: tuned/.test(m.text)));
  w.crewImpl.pause(w.p, "now");
});

test("channel: Pip's brief goes on the member's next task card; weak models fall back to rules", async () => {
  const { rules } = await import("../src/conductor.ts");
  const redos = new Map<string, number>();
  assert.equal(
    rules(
      {
        kind: "ask",
        from: "producer",
        askId: "m1",
        question: "What is the founder's name?",
        options: [
          { id: "a", label: "A" },
          { id: "b", label: "B" },
        ],
        recommendedId: "a",
      },
      { redos },
    )[0].kind,
    "escalate",
  );
  assert.equal(
    rules(
      {
        kind: "ask",
        from: "producer",
        askId: "m1",
        question: "Calm or upbeat music?",
        options: [
          { id: "a", label: "Calm" },
          { id: "b", label: "Up" },
        ],
        recommendedId: "b",
      },
      { redos },
    )[0].kind,
    "answer",
  );
  assert.equal(
    rules(
      { kind: "report", from: "animator", task: "t1", ref: "s01", report: { status: "blocked", did: "x" } },
      { redos },
    )[0].kind,
    "redo",
  );
  redos.set("s01", 1);
  assert.equal(
    rules(
      { kind: "report", from: "animator", task: "t1", ref: "s01", report: { status: "blocked", did: "x" } },
      { redos },
    )[0].kind,
    "hold",
  );
});

test("budget words never say $0 cap or $0-0", async () => {
  const { budgetWords } = await import("../src/assistant.ts");
  assert.equal(budgetWords({ capUsd: 0, spentUsd: 0 }), "No budget cap is set. Nothing spent yet.");
  assert.equal(budgetWords({ capUsd: 5, spentUsd: 0, est: [0, 0] }), "The cap is $5. Nothing spent yet.");
  assert.equal(
    budgetWords({ capUsd: 5, spentUsd: 0.59, est: [0.8, 1.2] }),
    "The cap is $5. $0.59 spent, $4.41 left. Finishing is estimated at $0.80-$1.20 in all.",
  );
  assert.equal(budgetWords({ capUsd: 0, spentUsd: 1.5 }), "No budget cap is set. $1.50 spent.");
  for (const t of [budgetWords({ capUsd: 0, spentUsd: 0, est: [0, 0] }), budgetWords({ capUsd: 0, spentUsd: 2 })])
    assert.ok(!/\$0 cap|\$0-0|\$0\.00-\$0\.00|asks before going over/.test(t), t);
});

test("chat markers come from the event log, with the events' own times", async () => {
  const { p } = await setup();
  const t0 = new Date().toISOString();
  p.milestone("producer.plan", "Plan ready");
  const q = p.ask(
    {
      question: "Which script should the crew make?",
      options: [
        { id: "angle_0", label: "The walker", detail: "" },
        { id: "angle_1", label: "The quest", detail: "" },
      ],
      recommendedId: "angle_0",
    },
    "writer",
  );
  await p.answer(q.id, { optionId: "angle_0" }, "user");
  p.setGate("g3_rough", { status: "open" });
  p.setGate("g3_rough", { status: "open" }); // a repeat is no news
  p.milestone("deliver.export", "Your video is ready");
  p.state.milestones = p.state.milestones.filter((m) => m.id !== "deliver.export");
  p.milestone("deliver.export", "Your video is ready"); // a second export is its own marker
  p.emit("pip", {
    type: "card",
    itemId: "x",
    card: { id: "card_1", type: "plan", status: "done", title: "Ask the crew: add two NPCs" },
  });
  const ms = p.markers();
  assert.deepEqual(
    ms.map((m) => `${m.kind}: ${m.text}`),
    [
      "stage: Plan ready",
      "answer: You picked the script: The walker",
      "gate: Rough cut ready",
      "export: Your video is ready",
      "export: Your video is ready",
      "change: Change done: add two NPCs",
    ],
  );
  for (const m of ms) assert.ok(m.at >= t0 && Number.isFinite(Date.parse(m.at)));
  const log = p.eventsSince(0);
  assert.equal(ms[1].at, log.find((e) => e.event === "question" && (e.data as any).status === "answered")!.ts);
});

test("/context measures the next call without a model call and leaves nothing in the history", async () => {
  const w = await setup();
  script([{ toolCalls: [{ name: "reply", input: { text: "hello there" } }] }]);
  await w.pip!.ask(w.id, "hi").done;
  const k0 = fake.calls.length;
  const before = w.pip!.items(w.id).length;
  const ctx = await w.pip!.context(w.id);
  assert.equal(fake.calls.length, k0, "no model call");
  assert.deepEqual(
    ctx.parts.map((x) => x.id),
    ["system", "facts", "tools", "summary", "messages", "reserve"],
  );
  assert.equal(ctx.mode, "agent");
  assert.equal(ctx.method, "estimate");
  assert.equal(ctx.window, null, "the fake provider reports no window");
  assert.equal(ctx.windowSource, "unknown");
  assert.match(ctx.countSource, /^chars\/3\.5 \(no calls/);
  assert.equal(
    ctx.total,
    ctx.parts.reduce((n, x) => n + x.tokens, 0),
  );
  assert.equal(ctx.parts[0].detail, undefined);
  assert.match(ctx.parts[2].detail ?? "", /^\d+ tools$/);
  assert.equal(ctx.parts[4].detail, "2 messages kept");
  assert.equal(ctx.parts[5].tokens, 4000);
  // the API: GET and a /context POST, neither stored
  const { app, token } = createApp({ ...w, port: 5998 });
  const H = { host: "127.0.0.1:5998", "content-type": "application/json", "x-pap-token": token };
  const g = await (
    await app.fetch(new Request(`http://127.0.0.1:5998/api/pip/context?project=${w.id}`, { headers: H }))
  ).json();
  assert.equal(g.parts.length, 6);
  const r = await app.fetch(
    new Request("http://127.0.0.1:5998/api/pip", {
      method: "POST",
      headers: H,
      body: JSON.stringify({ project: w.id, text: "/context" }),
    }),
  );
  assert.equal(r.status, 200);
  assert.equal((await r.json()).context.parts.length, 6);
  assert.equal(w.pip!.items(w.id).length, before, "nothing stored");
  // past calls calibrate the estimate
  const turnCtx = (await w.pip!.context(w.id)).total;
  void turnCtx;
  for (let i = 0; i < 3; i++)
    w.gateway.ledger.insert({
      project: w.id,
      task: "t",
      taskKind: "assistant.turn",
      role: "assistant",
      attempt: 0,
      provider: "fake",
      model: "fake/model",
      promptVersion: "",
      usage: { inputTokens: 1200, outputTokens: 10 },
      usd: 0,
      usdSource: "zero",
      ttftMs: 1,
      durationMs: 1,
      stop: "end",
      estUsd: null,
      estInTokens: 1000,
    });
  const cal = await w.pip!.context(w.id);
  assert.match(cal.countSource, /^chars\/3\.5 × \d\.\d\d from \d+ calls$/);
  // a provider that counts and reports its window gives exact numbers
  (fake as any).countTokens = async () => ({ tokens: 1234, source: "fake count" });
  (fake as any).contextWindow = async () => ({ window: 8192, source: "fake loaded length" });
  try {
    const exact = await w.pip!.context(w.id);
    assert.equal(exact.method, "count");
    assert.equal(exact.countSource, "fake count");
    assert.equal(exact.total - exact.parts[5].tokens, 1234);
    assert.deepEqual([exact.window, exact.windowSource, exact.windowDetail], [8192, "provider", "fake loaded length"]);
  } finally {
    delete (fake as any).countTokens;
    delete (fake as any).contextWindow;
  }
});
