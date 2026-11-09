// /new as a conversation (docs/PIP-ORCHESTRATION.md §3, P3): the field registry, the rules parse, the quote check,
// the one-card rule, the draft lifecycle over the API, Start into a real project, the composer's draft, the Projects
// line, "Make another like this", the rights question (N15) and the Roles page's settings (N20–N22). A fake provider;
// a throwaway PAP_HOME.
import assert from "node:assert/strict";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

const home = mkdtempSync(join(tmpdir(), "pap-drafts-"));
process.env.PAP_HOME = home;
const root = join(home, "projects");
mkdirSync(root, { recursive: true });
const EXAMPLE = new URL("../../../examples/questday/", import.meta.url).pathname;

// store.ts reads PAP_HOME once: import after setting it
const { buildRegistry, Workspace, DraftStore } = await import("@pap/tools");
const { ModelGateway } = await import("../src/gateway-impl.ts");
const { FakeProvider, FAKE_CAPS, Ledger, SecretStore, defaultSettings, setPriceOverride } = await import(
  "../src/llm/index.ts"
);
const R = await import("../src/brief/registry.ts");
const { checkReading, openFields } = await import("../src/brief/read.ts");
const { lineOf, openNeeds } = await import("../src/brief/line.ts");
const { wireCrew } = await import("../../../apps/server/src/wire.ts");
const { createApp } = await import("../../../apps/server/src/app.ts");

type Req = import("../src/llm/types.ts").ChatRequest;
type Step = import("../src/llm/fake.ts").FakeStep;

/** the reading Pip gives next (null: answer like a broken model) */
let reading: unknown = null;
const calls: string[] = [];
function answer(req: Req): Step {
  const sys = req.system ?? "";
  if (/reading a person's idea/.test(sys)) {
    calls.push("brief");
    return reading ? { json: reading, usd: 0.001 } : { text: "not json" };
  }
  if (/deciding who works on this video/.test(sys)) {
    calls.push("plan");
    return { json: { ops: [], summary: "" } };
  }
  if (/You are the Writer/.test(sys)) {
    calls.push("writer");
    return {
      json: {
        angles: [
          { name: "The quest", approach: "a hero", cues: ["Lists feel heavy.", "Tallyfox makes them light."] },
          { name: "The calm", approach: "a night", cues: ["Night falls.", "Tallyfox keeps your day."] },
        ],
        recommended: 0,
      },
    };
  }
  if (/directing a small AI crew/.test(sys)) return { text: "" };
  calls.push(`other: ${sys.slice(0, 40)}`);
  return { error: new Error(`unexpected call: ${sys.slice(0, 60)}`) };
}
const fake = new FakeProvider((req) => answer(req), { id: "fake" });
const local = new FakeProvider((req) => answer(req), { id: "lmstudio" });
local.config = { ...local.config, kind: "lmstudio", baseUrl: "http://127.0.0.1:1234/v1" };
setPriceOverride("fake/model", { inPerMTok: 1, outPerMTok: 5 });

const open: InstanceType<typeof Workspace>[] = [];
after(() => {
  for (const w of open) w.closeAll();
  rmSync(home, { recursive: true, force: true });
});

let n = 0;
async function setup(opts: { localPip?: boolean; pipUnset?: boolean } = {}) {
  const settings = defaultSettings();
  settings.providers.push({ id: "fake", kind: "custom", label: "Fake", baseUrl: "http://fake.invalid", enabled: true });
  for (const r of Object.keys(settings.roles)) settings.roles[r] = { model: "fake/model" };
  // Pip left unset: the settings must still name its model (N20)
  if (opts.pipUnset) delete (settings.roles as Record<string, unknown>).assistant;
  if (opts.localPip) {
    settings.providers = settings.providers.map((p) => (p.id === "lmstudio" ? { ...p, enabled: true } : p));
    settings.roles.assistant = { model: "lmstudio/small" };
  }
  settings.defaults.concurrency = 1;
  const k = ++n;
  const dir = join(root, `ws_${k}`);
  mkdirSync(dir, { recursive: true });
  const gateway = new ModelGateway({
    ledger: new Ledger(join(home, `ledger-${k}.sqlite`)),
    secrets: new SecretStore({ env: {}, keychain: false, dir: home }),
    settings,
    providers: [fake, local],
    caps: { "fake/model": FAKE_CAPS, "lmstudio/small": { ...FAKE_CAPS, local: true, tools: "failed" } },
  });
  const workspace = new Workspace(() => [dir]);
  open.push(workspace);
  const registry = buildRegistry();
  const store = new DraftStore(join(home, `home_${k}`));
  const wired = await wireCrew({ workspace, registry, gateway, resume: false, drafts: store });
  const port = 6100 + k;
  const { app, token } = createApp({ ...wired, workspace, registry, port });
  const H = { host: `127.0.0.1:${port}`, "content-type": "application/json", "x-pap-token": token };
  const call = async (method: string, path: string, body?: unknown, raw?: { bytes: Uint8Array; type: string }) => {
    const res = await app.fetch(
      new Request(`http://127.0.0.1:${port}${path}`, {
        method,
        headers: raw ? { ...H, "content-type": raw.type } : H,
        ...(raw ? { body: Buffer.from(raw.bytes) } : body !== undefined ? { body: JSON.stringify(body) } : {}),
      }),
    );
    const text = await res.text();
    let json: any = null;
    try {
      json = JSON.parse(text);
    } catch {}
    return { status: res.status, json, text };
  };
  /** a draft turn: POST, then wait until Pip's reply is in */
  const say = async (draft: string, text: string) => {
    const r = await call("POST", "/api/pip", { draft, text });
    assert.equal(r.status, 202, r.text);
    for (let i = 0; i < 200; i++) {
      const c = await call("GET", `/api/pip?draft=${draft}`);
      if (!c.json.busy) return c.json.items.at(-1);
      await new Promise((res) => setTimeout(res, 10));
    }
    throw new Error("the draft turn never finished");
  };
  const events: any[] = [];
  wired.pip!.events.on("event", (e: any) => events.push(e));
  return { ...wired, workspace, registry, gateway, store, call, say, dir, events };
}

const png = () => new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);

// ---------------------------------------------------------------- the registry
test("the registry checks every value: bad ones come back with a fix", () => {
  assert.deepEqual(R.checkValue("lengthSec", "45"), { ok: true, value: 45 });
  assert.deepEqual(R.checkValue("budget", "$2.5"), { ok: true, value: 2.5 });
  for (const [k, v] of [
    ["lengthSec", 400],
    ["lengthSec", "soon"],
    ["budget", 0.2],
    ["budget", 80],
    ["audience", "aliens"],
    ["narration", "tts"],
    ["involvement", "sometimes"],
    ["style", ["loud"]],
    ["style", ["calm", "bold", "retro", "cosy"]],
    ["deadline", "next week"],
    ["nope", 1],
  ] as const) {
    const c = R.checkValue(k, v);
    assert.equal(c.ok, false, `${k}=${JSON.stringify(v)}`);
    if (!c.ok) assert.ok(c.fix.length > 5 && /use|say|pick|give|keep/i.test(c.fix), c.fix);
  }
  // local only when a local provider is on
  assert.equal(R.checkValue("profile", "local").ok, false);
  assert.equal(R.checkValue("profile", "local", { localOn: true }).ok, true);
  // a card's answers: every field it asks, a rights pick for each file, choices from the card's own options
  const fields = [R.askFor("audience"), R.askFor("lengthSec"), R.filesAsk([{ name: "logo.png", type: "logo" }])];
  const miss = R.checkCard(fields, { audience: "investors", lengthSec: "30", references: [{ name: "logo.png" }] });
  assert.ok(!miss.ok && miss.path === "references/logo.png" && /Mine, Licensed or Not sure/.test(miss.fix));
  const good = R.checkCard(fields, {
    audience: "investors",
    lengthSec: "30",
    references: [{ name: "logo.png", rights: "mine" }],
  });
  assert.ok(good.ok);
  if (good.ok) {
    assert.deepEqual(good.fields, { audience: "investors", lengthSec: 30 });
    assert.deepEqual(good.refs, [{ name: "logo.png", rights: "mine" }]);
  }
  const off = R.checkCard([R.askFor("lengthSec")], { lengthSec: "42" });
  assert.ok(!off.ok && /15 s, 30 s, 45 s, 60 s/.test(off.fix), "a choice must be one the card offered");
});

test("the rules parse (§3.3 step 4): what the words say, nothing invented", () => {
  const r = R.rulesRead("A 30 s pitch for Tallyfox, my budgeting app, for investors. No voice. Keep it under $4.");
  assert.equal(r.lengthSec, 30);
  assert.equal(r.narration, "none");
  assert.equal(r.budget, 4);
  assert.equal(r.audience, "investors");
  assert.equal(r.title, "Tallyfox pitch");
  assert.equal(r.idea, "A 30 s pitch for Tallyfox, my budgeting app, for investors.");
  assert.equal(r.involvement, undefined);
  const table: [string, Partial<Record<string, unknown>>][] = [
    ["half a minute about tea", { lengthSec: 30 }],
    ["a minute long, silent", { lengthSec: 60, narration: "none" }],
    ["15 seconds, I'll narrate it", { lengthSec: 15, narration: "user" }],
    ["for our customers, let the crew run", { audience: "users", involvement: "auto" }],
    ["a launch teaser, every step please, budget 2.5", { audience: "launch", involvement: "every", budget: 2.5 }],
    ["captions only, max $3", { narration: "none", budget: 3 }],
  ];
  for (const [text, want] of table) {
    const got = R.rulesRead(text);
    for (const [k, v] of Object.entries(want)) assert.equal(got[k as never], v, `${text}: ${k}`);
  }
  // nothing said, nothing set
  const none = R.rulesRead("a video about the night market");
  for (const k of ["lengthSec", "narration", "budget", "audience", "involvement"])
    assert.equal(none[k as never], undefined);
  assert.equal(none.title, "a video about the night market");
  assert.equal(R.guessType("questday-logo.png"), "logo");
  assert.equal(R.guessType("my-voice.wav", "audio/wav"), "voice");
  assert.equal(R.guessType("headshot.jpg"), "likeness");
});

test("the quote check: a value Pip can't point to in the person's words is dropped", () => {
  const out = checkReading(
    {
      fields: [
        { key: "lengthSec", value: 30, quote: "a 30 s pitch" },
        // invented: the person never said a budget
        { key: "budget", value: 5, quote: "under $5" },
        // the right words, a bad value
        { key: "audience", value: "aliens", quote: "for investors" },
        { key: "idea", value: "something", quote: "a 30 s pitch" },
      ],
      ask: [
        { key: "narration", question: "Should someone speak?", options: ["none", "user", "tts"], recommended: "tts" },
        { key: "lengthSec", question: "How long?" },
        { key: "deadline", question: "When?" },
      ],
      title: "Tallyfox pitch",
      say: "A 30 second pitch for investors.",
    },
    "A 30 s PITCH for Tallyfox,   for investors",
  );
  assert.deepEqual(out.fields, { lengthSec: 30 });
  assert.deepEqual(
    out.dropped.map((d) => d.key),
    ["budget", "audience", "idea"],
  );
  // only open, askable fields keep Pip's wording
  assert.deepEqual(Object.keys(out.wording), ["narration"]);
  const asks = openFields({ lengthSec: 30 }, out.wording, 3, 3);
  assert.equal(asks.length, 3, "at most 3 fields");
  assert.equal(asks[0].key, "narration");
  assert.equal(asks[0].label, "Should someone speak?");
  // options stay registry ids; a recommendation that isn't one falls back to the registry default
  assert.deepEqual(
    asks[0].options!.map((o) => o.id),
    ["none", "user"],
  );
  assert.equal(asks[0].recommended, "none");
  assert.deepEqual(
    asks.map((a) => a.key),
    ["narration", "audience", "involvement"],
  );
});

test("the Projects line (D7): finished → working → waiting, at most 3 clauses, from state", () => {
  const t = Date.now();
  const line = lineOf(
    [
      { id: "a", title: "QuestDay teaser", finishedAt: t - 3600_000, version: 1 },
      { id: "old", title: "Old one", finishedAt: t - 3 * 86400_000, version: 4 },
      { id: "b", title: "Lantern", questions: 1, gates: [], running: true, stage: "script" },
      { id: "c", title: "Harbor", running: true, stage: "animate" },
      { id: "d", title: "Moth", gates: ["g3_rough"] },
    ],
    t,
  );
  assert.deepEqual(
    line.parts.map((p) => p.kind),
    ["working", "waiting", "waiting"],
  );
  assert.equal(
    line.text,
    "Harbor is being animated. Lantern is waiting on one pick from you. Moth is waiting on your OK on the rough cut from you.",
  );
  const two = lineOf(
    [
      { id: "a", title: "QuestDay teaser", finishedAt: t - 60_000, version: 2 },
      { id: "x", title: "X", questions: 2, gates: ["g1_script"] },
    ],
    t,
  );
  assert.equal(two.text, "QuestDay teaser has v2. X is waiting on 3 things from you.");
  // a change to a video that has a version makes the next one, while the last keeps playing
  assert.equal(
    lineOf(
      [{ id: "a", title: "QuestDay teaser", finishedAt: t - 60_000, version: 2, running: true, stage: "animate" }],
      t,
    ).text,
    "QuestDay teaser is making v3.",
  );
  assert.equal(lineOf([{ id: "a", title: "Old", finishedAt: t - 60_000 }], t).text, "Old has a video.");
  assert.equal(lineOf([], t).text, "Nothing needs you right now.");
});

test("a gate opened for an open question counts once (the script pick)", () => {
  const state = {
    questions: [
      { id: "q1", status: "open" },
      { id: "q0", status: "answered" },
    ],
    gates: [
      { id: "g1_script", status: "open", items: [{ label: "Pick a script angle", ref: "q1" }] },
      { id: "g3_rough", status: "open", items: [{ label: "Watch the rough cut" }] },
      { id: "g0_brief", status: "passed", items: [] },
    ],
  } as any;
  assert.deepEqual(openNeeds({ state }), { questions: 1, gates: ["g3_rough"], cards: [], waiting: 0 });
  const n = openNeeds({ state: { ...state, gates: [state.gates[0]] } });
  assert.equal(
    lineOf([{ id: "l", title: "Lumenbook pitch", ...n }]).text,
    "Lumenbook pitch is waiting on one pick from you.",
  );
});

// ---------------------------------------------------------------- the draft over the API
test("a draft: made on the first send, files with rights chips, listed and removable, never in a project root", async () => {
  const w = await setup({ localPip: true });
  // opening /new makes nothing: no draft until the first send or drop (N8)
  assert.equal(w.store.list().length, 0);
  const c = await w.call("POST", "/api/drafts", {});
  assert.equal(c.status, 200);
  const id = c.json.draft.id as string;
  assert.match(id, /^draft_[a-z0-9]+$/, "N18");
  assert.equal(c.json.items[0].kind, "pip");
  assert.equal(c.json.items[0].text, "What are we making?");
  assert.ok(existsSync(join(w.store.dir, id, "draft.json")));
  assert.ok(!readdirSync(w.dir).length, "nothing in the project root");
  // a file: rights start unsure, the type is guessed, the name is made safe, the URL serves it
  const f = await w.call(
    "POST",
    `/api/drafts/${id}/files?name=${encodeURIComponent("../questday logo.png")}`,
    undefined,
    {
      bytes: png(),
      type: "image/png",
    },
  );
  assert.equal(f.status, 200, f.text);
  assert.deepEqual(
    { ...f.json.ref, url: undefined },
    { name: "questday logo.png", url: undefined, bytes: 11, type: "logo", rights: "unsure", private: true },
  );
  const got = await w.call("GET", f.json.ref.url);
  assert.equal(got.status, 200);
  const exe = await w.call("POST", `/api/drafts/${id}/files?name=run.sh`, undefined, {
    bytes: png(),
    type: "text/x-sh",
  });
  assert.equal(exe.status, 415);
  assert.ok(exe.json.error.fix);
  // the rights chip
  const chip = await w.call("PATCH", `/api/drafts/${id}/refs/${encodeURIComponent("questday logo.png")}`, {
    rights: "maybe",
  });
  assert.equal(chip.status, 400);
  assert.match(chip.json.error.fix, /Mine, Licensed or Not sure/);
  // listed with the projects (N14)
  const list = await w.call("GET", "/api/projects");
  const row = list.json.find((x: any) => x.id === id);
  assert.equal(row.draft, true);
  assert.equal(row.title, "New video");
  assert.equal(row.status.line, "What are we making?");
  assert.ok(row.createdAt && row.capUsd === 0 && row.needsYou === 0);
  // removable; gone is a 404 with a fix; a bad id never reaches the disk
  assert.equal((await w.call("DELETE", `/api/drafts/${id}`)).status, 200);
  assert.ok(!existsSync(join(w.store.dir, id)));
  const gone = await w.call("GET", `/api/drafts/${id}`);
  assert.equal(gone.status, 404);
  assert.equal(gone.json.error.fix, "Start a new video from Projects.");
  assert.equal((await w.call("DELETE", "/api/drafts/..%2F..%2Fprojects")).status, 404);
});

test("one reading, one card: menu mode parses by rules, ≤ 3 fields, rights inline, then the brief", async () => {
  const w = await setup({ localPip: true });
  calls.length = 0;
  const id = (await w.call("POST", "/api/drafts", {})).json.draft.id;
  await w.call("POST", `/api/drafts/${id}/files?name=questday-logo.png`, undefined, {
    bytes: png(),
    type: "image/png",
  });
  const item = await w.say(id, "A pitch for QuestDay, a todo app that turns tasks into quests.");
  assert.deepEqual(calls, [], "a local model reads by rules: no call");
  assert.equal(item.kind, "pip");
  const card = item.cards[0];
  assert.equal(card.type, "form");
  assert.equal(card.form, "brief_fields");
  assert.ok(card.fields.length <= 3);
  assert.deepEqual(
    card.fields.map((f: any) => f.key),
    ["audience", "involvement", "references"],
  );
  assert.equal(card.fields[2].label, "Is the logo yours to use?");
  assert.match(item.text, /Three quick picks/);
  // the user item carries the file sent with it (N17)
  const conv = (await w.call("GET", `/api/pip?draft=${id}`)).json;
  const user = conv.items.find((i: any) => i.kind === "user");
  assert.deepEqual(user.files, ["questday-logo.png"]);
  // the draft's events go out on the workspace stream with `draft`
  assert.ok(w.events.some((e) => e.event === "pip" && e.data.draft === id && e.data.type === "item"));
  // a bad answer: 400 with a fix, the card stays open
  const bad = await w.call("POST", `/api/pip/cards/${card.id}`, {
    draft: id,
    decision: "confirm",
    values: { audience: "investors", involvement: "key", references: [{ name: "questday-logo.png" }] },
  });
  assert.equal(bad.status, 400);
  assert.equal(bad.json.error.path, "references/questday-logo.png");
  assert.match(bad.json.error.fix, /Pick one/);
  const still = (await w.call("GET", `/api/pip?draft=${id}`)).json.items.find((i: any) => i.cards?.[0]?.id === card.id);
  assert.equal(still.cards[0].status, "open");
  // a good answer: the card is done, and the brief comes (no second card for a logo that is mine)
  const ok = await w.call("POST", `/api/pip/cards/${card.id}`, {
    draft: id,
    decision: "confirm",
    values: { audience: "investors", involvement: "key", references: [{ name: "questday-logo.png", rights: "mine" }] },
  });
  assert.equal(ok.status, 200, ok.text);
  assert.equal(ok.json.card.status, "done");
  const after1 = (await w.call("GET", `/api/drafts/${id}`)).json;
  const last = after1.items.at(-1);
  assert.equal(last.text, "Here's the brief.");
  const brief = last.cards[0];
  assert.equal(brief.type, "brief");
  assert.equal(brief.title, "QuestDay pitch");
  assert.equal(brief.fields.find((f: any) => f.key === "lengthSec").value, "30 s");
  assert.ok(brief.estimate.usd[1] >= brief.estimate.usd[0] && brief.estimate.sec[0] > 0);
  assert.ok(brief.preview.crew >= 5, `crew ${brief.preview.crew}`);
  assert.match(brief.preview.line, /^About \d+ crew members over the run; most art comes from the library/);
  assert.match(brief.preview.line, /your logo in an achievement toast/);
  assert.equal(brief.picks, "You'll pick 3 times: the script, your logo and the rough cut.");
  assert.equal(brief.refs[0].label, "Private to this project");
  assert.equal(after1.draft.source.lengthSec, "default");
  assert.equal(after1.draft.source.audience, "asked");
  assert.equal(after1.draft.refs[0].rights, "mine");
  // typing instead reads again and supersedes the open brief card
  const again = await w.say(id, "make it 45 s");
  assert.equal(again.cards[0].type, "brief");
  assert.equal(again.cards[0].fields.find((f: any) => f.key === "lengthSec").value, "45 s");
  const items = (await w.call("GET", `/api/pip?draft=${id}`)).json.items;
  assert.equal(items.find((i: any) => i.cards?.[0]?.id === brief.id).cards[0].status, "superseded");
  // the composer's prefill and "Back to the conversation" (N7): no model call
  const comp = (await w.call("GET", `/api/drafts/${id}/composer`)).json;
  assert.equal(comp.brief.lengthSec, 45);
  assert.equal(comp.brief.purpose, "pitch");
  assert.equal(comp.title, "QuestDay pitch");
  assert.equal((await w.call("PATCH", `/api/drafts/${id}`, { fields: { lengthSec: 500 } })).status, 400);
  const patched = await w.call("PATCH", `/api/drafts/${id}`, { fields: { lengthSec: 15, style: ["calm"] } });
  assert.equal(patched.json.fields.lengthSec, 15);
  assert.deepEqual(calls, []);
});

test("a second card only for an unsure likeness; never more than two before the brief", async () => {
  const w = await setup({ localPip: true });
  const id = (await w.call("POST", "/api/drafts", {})).json.draft.id;
  await w.call("POST", `/api/drafts/${id}/files?name=headshot.jpg`, undefined, { bytes: png(), type: "image/jpeg" });
  const item = await w.say(id, "A 30 s pitch for Lumen for investors, no voice, under $3.");
  const card = item.cards[0];
  assert.deepEqual(
    card.fields.map((f: any) => f.key),
    ["involvement", "references"],
  );
  const r1 = await w.call("POST", `/api/pip/cards/${card.id}`, {
    draft: id,
    decision: "confirm",
    values: { involvement: "auto", references: [{ name: "headshot.jpg", rights: "unsure" }] },
  });
  assert.equal(r1.status, 200, r1.text);
  const second = (await w.call("GET", `/api/drafts/${id}`)).json.items.at(-1).cards[0];
  assert.equal(second.type, "form");
  assert.deepEqual(
    second.fields.map((f: any) => f.key),
    ["references"],
  );
  assert.equal(second.fields[0].label, "Do you have their OK to use their likeness?");
  const r2 = await w.call("POST", `/api/pip/cards/${second.id}`, {
    draft: id,
    decision: "confirm",
    values: { references: [{ name: "headshot.jpg", rights: "unsure" }] },
  });
  assert.equal(r2.status, 200);
  const brief = (await w.call("GET", `/api/drafts/${id}`)).json.items.at(-1).cards[0];
  assert.equal(brief.type, "brief", "two question cards at most");
  // unsure is left out of the plan: no rights pick, and the warning says so
  assert.equal(brief.picks, "The crew runs on its own and shows you the finished video.");
  assert.match(brief.warning, /Not sure blocks the likeness/);
  assert.doesNotMatch(brief.preview.line, /from your photo/);
  // a logo that is mine never opens a second card (the previous test); nothing open at all: the brief at once
  const id2 = (await w.call("POST", "/api/drafts", {})).json.draft.id;
  const direct = await w.say(id2, "A 15 s launch teaser for Lumen, no voice, let the crew run, budget 2");
  assert.equal(direct.cards[0].type, "brief");
});

test("agent mode: one metered assistant.brief call; invented values are dropped; a failed read falls back to rules", async () => {
  const w = await setup();
  calls.length = 0;
  reading = {
    fields: [
      { key: "lengthSec", value: 30, quote: "30 s" },
      { key: "budget", value: 9, quote: "nine dollars" },
    ],
    ask: [{ key: "audience", question: "Who will watch it?", options: ["investors", "users"], recommended: "users" }],
    title: "Tallyfox pitch",
    say: "A 30 second pitch for Tallyfox.",
  };
  const id = (await w.call("POST", "/api/drafts", {})).json.draft.id;
  calls.length = 0;
  const item = await w.say(id, "a 30 s pitch for Tallyfox, my budgeting app");
  assert.deepEqual(calls, ["brief"]);
  assert.match(item.text, /^A 30 second pitch for Tallyfox\. Three quick picks/);
  const card = item.cards[0];
  assert.equal(card.fields[0].label, "Who will watch it?");
  assert.deepEqual(
    card.fields[0].options.map((o: any) => o.id),
    ["investors", "users"],
  );
  assert.equal(card.fields[0].recommended, "users");
  const d = (await w.call("GET", `/api/drafts/${id}`)).json.draft;
  assert.equal(d.fields.lengthSec, 30);
  assert.equal(d.fields.budget, undefined, "no quote, no value");
  assert.equal(d.title, "Tallyfox pitch");
  // metered on the workspace guard, as assistant.brief
  const rows = w.gateway.ledger.query({ project: "_workspace" } as any);
  assert.ok(rows.some((r: any) => r.taskKind === "assistant.brief"));
  // a broken answer: the rules parse stands in
  reading = null;
  const id2 = (await w.call("POST", "/api/drafts", {})).json.draft.id;
  const it2 = await w.say(id2, "A 45 s pitch for Lumen, no voice");
  const d2 = (await w.call("GET", `/api/drafts/${id2}`)).json.draft;
  assert.equal(d2.fields.lengthSec, 45);
  assert.equal(d2.fields.narration, "none");
  assert.equal(it2.cards[0].type, "form");
});

test("Start: a real project under the root, refs and conversation moved, the draft gone, G0 passed, the crew runs", async () => {
  const w = await setup({ localPip: true });
  calls.length = 0;
  const id = (await w.call("POST", "/api/drafts", {})).json.draft.id;
  await w.call("POST", `/api/drafts/${id}/files?name=tallyfox-logo.png`, undefined, {
    bytes: png(),
    type: "image/png",
  });
  const first = await w.say(id, "A 15 s pitch for Tallyfox for investors. No voice. Under $3.");
  const q = first.cards[0];
  await w.call("POST", `/api/pip/cards/${q.id}`, {
    draft: id,
    decision: "confirm",
    values: { involvement: "key", references: [{ name: "tallyfox-logo.png", rights: "mine" }] },
  });
  const brief = (await w.call("GET", `/api/drafts/${id}`)).json.items.at(-1).cards[0];
  assert.equal(brief.type, "brief");
  const s = await w.call("POST", `/api/pip/cards/${brief.id}`, { draft: id, decision: "confirm" });
  assert.equal(s.status, 200, s.text);
  assert.equal(s.json.card.status, "started");
  const pid = s.json.card.result.projectId;
  const p = w.workspace.get(pid);
  assert.ok(p.dir.startsWith(w.dir), "under the configured project root");
  assert.equal(p.doc().title, "Tallyfox pitch");
  assert.equal(p.doc().brief.source, "pip");
  assert.equal(p.doc().brief.lengthSec, 15);
  assert.equal(p.doc().budget.capUsd, 3);
  assert.deepEqual(p.doc().brief.references, [
    { file: "private/refs/tallyfox-logo.png", type: "logo", rights: "mine", note: "" },
  ]);
  assert.ok(existsSync(join(p.dir, "private", "refs", "tallyfox-logo.png")));
  assert.ok(!existsSync(join(w.store.dir, id)), "the draft folder is deleted");
  assert.equal((await w.call("GET", `/api/drafts/${id}`)).status, 404);
  // the conversation moved: the project's Pip has it, the started card included
  const conv = readFileSync(join(p.dir, "runs", "pip.jsonl"), "utf8");
  assert.match(conv, /What are we making\?/);
  assert.match(conv, /"status":"started"/);
  assert.ok((await w.call("GET", `/api/pip?project=${pid}`)).json.items.length >= 4);
  assert.equal(p.state.gates.find((g) => g.id === "g0_brief")?.status, "passed");
  // the crew runs the plan: rev 0 from the rules (no producer.plan: C4), then the Writer, then it waits at G1
  for (let i = 0; i < 300 && !p.state.questions.some((x) => x.status === "open"); i++)
    await new Promise((r) => setTimeout(r, 20));
  const plan = JSON.parse(readFileSync(join(p.dir, "runs", "plan.json"), "utf8"));
  assert.ok(!plan.tasks.some((t: any) => t.kind === "producer.plan"));
  assert.ok(
    plan.tasks.some((t: any) => t.kind === "asset.import"),
    "the logo is imported",
  );
  assert.ok(calls.includes("writer"));
  w.crewImpl.pause(p, "now");
  for (let i = 0; i < 200 && w.crewImpl.status(p).crew.running; i++) await new Promise((r) => setTimeout(r, 10));
  // the project is listed; the draft is not
  const list = (await w.call("GET", "/api/projects")).json;
  assert.ok(list.some((x: any) => x.id === pid && !x.draft));
  assert.ok(!list.some((x: any) => x.draft));
  // a Start already pressed: the draft is gone (404 with a fix)
  assert.equal((await w.call("POST", `/api/pip/cards/${brief.id}`, { draft: id, decision: "confirm" })).status, 404);
});

test("the composer starts a draft: files and conversation move, producer.plan stays, no model call", async () => {
  const w = await setup({ localPip: true });
  calls.length = 0;
  const id = (await w.call("POST", "/api/drafts", {})).json.draft.id;
  await w.call("POST", `/api/drafts/${id}/files?name=moodboard.png`, undefined, { bytes: png(), type: "image/png" });
  await w.say(id, "a calm 30 s video about a tea shop");
  const comp = (await w.call("GET", `/api/drafts/${id}/composer`)).json;
  const r = await w.call("POST", "/api/projects", {
    title: "Tea shop",
    brief: { ...comp.brief, lengthSec: 30 },
    budgetUsd: comp.budgetUsd,
    draft: id,
  });
  assert.equal(r.status, 200, r.text);
  const p = w.workspace.get(r.json.id);
  assert.equal(p.doc().brief.source, "composer");
  assert.equal(p.doc().brief.references[0].file, "private/refs/moodboard.png");
  assert.ok(existsSync(join(p.dir, "private", "refs", "moodboard.png")));
  assert.ok(existsSync(join(p.dir, "runs", "pip.jsonl")));
  assert.ok(!w.store.exists(id));
  assert.deepEqual(calls, []);
});

test("Make another like this: a draft from the project wins over a direct fork; private art stays behind", async () => {
  const w = await setup({ localPip: true });
  const dir = join(w.dir, "questday");
  cpSync(EXAMPLE, dir, { recursive: true, filter: (f) => !f.endsWith(".pap-lock") });
  const src = w.workspace.list().find((x) => x.dir === dir)!;
  const sp = w.workspace.get(src.id);
  // Pip's menu answer "new_from_this" proposes the draft, not a project
  const made = await w.pip!.menuCards({ intent: "new_from_this", params: {}, reply: "Sure." }, sp, "another one");
  const card = made.cards[0] as any;
  assert.equal(card.type, "plan");
  assert.equal(card.action.tool, "draft_create");
  assert.equal(card.confirmLabel, "Open it");
  const res = await w.registry.call("draft_create", card.action.input, {
    author: { kind: "user", via: "pip" },
    workspace: w.workspace,
    emit: () => {},
  });
  assert.ok(res.ok, JSON.stringify(res));
  const draftId = (res.data as any).draftId;
  const before = w.workspace.list().length;
  const got = (await w.call("GET", `/api/drafts/${draftId}`)).json;
  assert.equal(got.draft.from, src.id);
  assert.equal(
    got.items[0].text,
    `Another one like ${sp.doc().title}: same style, cast and settings. What's this one about?`,
  );
  assert.equal(got.draft.fields.lengthSec, sp.doc().brief.lengthSec);
  assert.equal(got.draft.fields.idea, undefined, "never the idea");
  assert.equal(w.workspace.list().length, before, "no project yet");
  // over the API too
  const api = await w.call("POST", "/api/drafts", { from: src.id });
  assert.equal(api.json.draft.from, src.id);
  assert.equal((await w.call("POST", "/api/drafts", { from: "nope" })).status, 404);
});

test("the rights question is the person's alone (N15); the Roles page's settings (N20–N22)", async () => {
  const w = await setup({ pipUnset: true });
  const dir = join(w.dir, "qd_rights");
  cpSync(EXAMPLE, dir, { recursive: true, filter: (f) => !f.endsWith(".pap-lock") });
  const p = w.workspace.get(w.workspace.list().find((x) => x.dir === dir)!.id);
  const q = p.ask(
    {
      question: "Your logo (logo) in the video. Use it?",
      options: [
        { id: "use", label: "Use it" },
        { id: "leave", label: "Leave it out" },
      ],
      recommendedId: "use",
      from: "pip",
      timeoutSec: 1,
      rights: { asset: "logo", private: true },
    },
    "pip",
  );
  assert.deepEqual(q.rights, { asset: "logo", private: true });
  await assert.rejects(p.answer(q.id, { optionId: "use" }, "claude-desktop"), /only the person/);
  await new Promise((r) => setTimeout(r, 1100));
  assert.equal(p.state.questions.find((x) => x.id === q.id)?.status, "open", "never a timeout");
  assert.equal((await p.answer(q.id, { optionId: "use" }, "user")).status, "answered");
  // N20: every role names its model, Pip's too, though it was never saved
  const s = (await w.call("GET", "/api/settings")).json;
  assert.equal(s.roles.assistant.model, "anthropic/claude-sonnet-5-5");
  assert.equal(s.effective.assistant.source, "default");
  assert.equal(s.effective.assistant.fallback, "fake/model", "Pip falls back to the Producer's model");
  assert.equal(s.effective.writer.source, "saved");
  // N22: each profile's assignments from the server's rule
  const prof = (await w.call("GET", "/api/settings/profiles")).json;
  assert.equal(prof.best.director.model, "anthropic/claude-opus-5-5");
  assert.equal(prof.balanced.director.model, "anthropic/claude-sonnet-5-5");
  assert.equal(prof.local, null);
  // an unknown API route is a JSON 404 with a fix, not the UI's page
  const nf = await w.call("GET", "/api/nope");
  assert.equal(nf.status, 404);
  assert.ok(nf.json.error.fix);
  // N21: the probe route takes a model id with slashes, encoded or not
  for (const path of ["/api/models/fake%2Fnope/probe", "/api/models/openrouter/a/b/probe"]) {
    const r = await w.call("POST", path);
    assert.equal(r.status, 404, path);
    assert.match(r.json.error.message, /no model .*nope|no model openrouter\/a\/b/);
  }
});
