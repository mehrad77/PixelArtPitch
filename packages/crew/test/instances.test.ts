// Crew instances (docs/PIP-ORCHESTRATION.md §2): the fold over recorded events.jsonl fixtures (spawn, the ghost
// horizon, D4 at one slot, the D5 return, outcomes, the usd sums, the member waiting on the person), the live tracker's
// event order (N3), and a whole crew run on a fake provider: replay against live, the kept log and "Ask Pip about
// this". Fictional projects only.
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

const home = mkdtempSync(join(tmpdir(), "pap-instances-"));
process.env.PAP_HOME = home;
const root = join(home, "projects");
mkdirSync(root, { recursive: true });

// store.ts reads PAP_HOME once: import after setting it
const { buildRegistry, Workspace } = await import("@pap/tools");
const { ModelGateway } = await import("../src/gateway-impl.ts");
const { FakeProvider, FAKE_CAPS, Ledger, SecretStore, defaultSettings, setPriceOverride } = await import(
  "../src/llm/index.ts"
);
const { InstanceFold, InstanceSchema, InstanceTracker, foldInstances, parseReport } = await import(
  "../src/plan/instances.ts"
);
const { wireCrew } = await import("../../../apps/server/src/wire.ts");
const { createApp } = await import("../../../apps/server/src/app.ts");

type Instance = import("../src/plan/instances.ts").Instance;
type FoldEvent = import("../src/plan/instances.ts").FoldEvent;
type Req = import("../src/llm/types.ts").ChatRequest;
type Step = import("../src/llm/fake.ts").FakeStep;

const open: InstanceType<typeof Workspace>[] = [];
after(() => {
  for (const w of open) w.closeAll();
  rmSync(home, { recursive: true, force: true });
});

// ---------------------------------------------------------------- recorded logs
const FIX = new URL("./fixtures/instances/", import.meta.url).pathname;
const SCENES = ["s01", "s02", "s03", "s04"];
/** a fixture; `p1` drops the `plan_status` lines, as a log written before them (P1) has none */
const read = (name: string, p1 = false): FoldEvent[] =>
  readFileSync(join(FIX, name), "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l))
    .filter((e) => !p1 || e.event !== "plan_status");
/** the instances at each `checkpoint: <name>` log line of a fixture */
function checkpoints(name: string, opts: ConstructorParameters<typeof InstanceFold>[0] = {}, p1 = false) {
  const f = new InstanceFold({ sceneIds: () => SCENES, ...opts });
  const out = new Map<string, Instance[]>();
  for (const e of read(name, p1)) {
    f.apply(e);
    const text = (e.data as { text?: string })?.text ?? "";
    if (e.event === "log" && text.startsWith("checkpoint: ")) out.set(text.slice(12), f.view());
  }
  return out;
}
const live = (v: Instance[]) => v.filter((i) => i.state === "live").map((i) => i.label);
const ghosts = (v: Instance[]) => v.filter((i) => i.ghost).map((i) => i.label);
const get = (v: Instance[], id: string) => v.find((i) => i.id === id)!;

test("journey: spawn, the horizon from the first task, and the spawn line", () => {
  const at = checkpoints("journey.jsonl").get("writer working")!;
  assert.deepEqual(live(at), ["Writer"]);
  // angles → [G1] (gates are free) → storyboard (1) → cast (2); the Mixer is 3 hops off
  assert.deepEqual(ghosts(at), ["Director", "Art director"]);
  const w = get(at, "writer");
  assert.equal(w.reason, "Pip brought in the Writer for three script angles");
  assert.equal(w.running, 1);
  assert.equal(w.lives.length, 1);
  assert.equal(w.lives[0].to, null);
  assert.equal(get(at, "director").state, "planned");
  // the placeholder (scene tunes before the storyboard) has no face
  assert.ok(!at.some((i) => i.id === "animator"));
  for (const i of at) InstanceSchema.parse(i);
});

test("journey: the member who asks stays live while the pick is open (N19), and no ghosts then (N11)", () => {
  const cp = checkpoints("journey.jsonl");
  const open = cp.get("g1 open")!;
  const w = get(open, "writer");
  assert.equal(w.state, "live");
  assert.equal(w.running, 0, "its task is done: the face waits on the person, it isn't working");
  assert.equal(w.outcome, null);
  assert.deepEqual(ghosts(open), [], "only a person's pick is open: nothing is running or ready");
  // once picked, it is finished
  const next = cp.get("director working")!;
  const done = get(next, "writer");
  assert.equal(done.state, "finished");
  assert.equal(done.outcome, "done");
  assert.ok(done.endedAt && done.endedAt >= w.lives[0].from);
  assert.equal(done.lives[0].to, done.endedAt);
  assert.equal(done.lastReport?.did, "three angles: the walker, the quest board, the numbers");
  assert.equal(done.endReason, done.lastReport?.did);
});

test("journey: one slot (D4): one Animator is live and the other three are ghosts, waiting for it", () => {
  const at = checkpoints("journey.jsonl").get("one slot")!;
  assert.deepEqual(live(at), ["Animator · scene 1"]);
  assert.deepEqual(ghosts(at), ["Animator · scene 2", "Animator · scene 3", "Animator · scene 4"]);
  assert.ok(!get(at, "mixer").ghost, "at most 3 ghosts, nearest first: the ready ones");
  assert.equal(get(at, "animator:s02").state, "planned");
  assert.equal(at.filter((i) => i.running > 0).length, 1, "the row never shows more faces than are working");
});

test("journey: a redo brings the same instance back with a new life and its reason (D5, N1)", () => {
  const cp = checkpoints("journey.jsonl");
  const back = cp.get("scene 1 back")!;
  const s1 = get(back, "animator:s01");
  assert.equal(s1.state, "idle", "it left Finished: a pending task of its own");
  assert.equal(s1.outcome, null);
  assert.ok(s1.ghost);
  assert.deepEqual(ghosts(back), ["Animator · scene 1", "Reviewer", "Editor"]);
  assert.equal(back.filter((i) => i.id.startsWith("animator:s01")).length, 1, "never a second Animator · scene 1");
  const working = get(cp.get("scene 1 working again")!, "animator:s01");
  assert.equal(working.state, "live");
  assert.equal(working.lives.length, 2);
  assert.equal(working.lives[0].reason, "Pip brought in an Animator for scene 1");
  assert.equal(working.lives[1].reason, "Pip brought the Animator back to fix scene 1: the headline is clipped");
  assert.equal(working.reason, working.lives[0].reason, "the spawn line stays the first life's");
  assert.deepEqual(working.tasks, ["t_tune_s01", "t_tune_s01_r2"]);
  const end = get(cp.get("end")!, "animator:s01");
  assert.equal(end.state, "finished");
  assert.equal(end.lives[1].to, end.endedAt);
  // the reviewer's round 2 is a return too, with the short line
  assert.equal(get(cp.get("end")!, "reviewer").lives[1].reason, "Pip brought the Reviewer back to check the fixes");
});

test("journey: outcomes and the usd sums, every attempt counted", () => {
  const end = checkpoints("journey.jsonl").get("end")!;
  assert.ok(end.every((i) => i.state === "finished" && !i.ghost));
  const usd = Object.fromEntries(end.map((i) => [i.id, i.usd]));
  assert.deepEqual(usd, {
    writer: 0.22,
    director: 0.18,
    "art-director": 0,
    "animator:s01": 0.24,
    "animator:s02": 0.2,
    "animator:s03": 0.19,
    "animator:s04": 0.12,
    mixer: 0.1,
    reviewer: 0.14,
    editor: 0,
  });
  const total = read("journey.jsonl")
    .filter((e) => e.event === "task")
    .reduce((m, e) => m.set((e.data as any).id, (e.data as any).usd), new Map<string, number>());
  assert.equal(
    +end.reduce((a, i) => a + i.usd, 0).toFixed(6),
    +[...total.values()].reduce((a, b) => a + b, 0).toFixed(6),
    "the instances' $ add up to the rows'",
  );
  const s3 = get(end, "animator:s03");
  assert.equal(s3.outcome, "partial");
  assert.deepEqual(s3.lastReport, {
    status: "partial",
    did: "used a toast for the line",
    couldnt: "no recipe for two people talking",
  });
  // a retry row inside the same task is no return: the plan task stays running, so one life
  assert.equal(s3.lives.length, 1);
  assert.equal(s3.tasks.length, 1);
  assert.equal(get(end, "art-director").outcome, "partial");
  assert.equal(get(end, "writer").outcome, "done");
  // join order: spawn order, so the Writer first and the Editor last
  assert.equal(end[0].id, "writer");
  assert.equal(end.at(-1)?.id, "editor");
  for (const i of end) InstanceSchema.parse(i);
});

test("endings: two drawings at once, the ghost cap, stopped, failed, and a task dropped before it ran", () => {
  const cp = checkpoints("endings.jsonl", { humanize: (e) => `Plain words: ${e.message}` });
  const board = cp.get("board working")!;
  // five candidates (the Art director and four Animators at 1 hop): the 3 nearest, in plan order
  assert.deepEqual(ghosts(board), ["Art director", "Animator · scene 1", "Animator · scene 2"]);
  const two = cp.get("two drawings")!;
  assert.equal(get(two, "pixel-artist:hero").running, 2);
  assert.equal(get(two, "pixel-artist:hero").label, "Pixel artist · hero");
  assert.deepEqual(get(two, "pixel-artist:hero").subject, { asset: "hero" });
  const end = cp.get("end")!;
  const hero = get(end, "pixel-artist:hero");
  assert.equal(hero.outcome, "stopped");
  assert.equal(hero.endReason, "One drawing is enough.");
  assert.equal(hero.usd, 0.31);
  const s1 = get(end, "animator:s01");
  assert.equal(s1.outcome, "failed");
  assert.equal(s1.endReason, "Plain words: the model answered garbled JSON");
  assert.ok(!end.some((i) => i.id === "animator:s02"), "dropped before it ran: it never had a face");
  assert.equal(get(end, "animator:s03").state, "planned");
});

test("legacy: a project from before the plan gets one member per role from its rows", () => {
  const cp = checkpoints("legacy.jsonl");
  const two = cp.get("two animating")!;
  assert.deepEqual(live(two), ["Animator"]);
  assert.equal(get(two, "animator").running, 2);
  const end = cp.get("end")!;
  const w = get(end, "writer");
  assert.equal(w.reason, "Pip brought in the Writer for three script angles");
  assert.equal(w.usd, 0.2);
  assert.equal(w.outcome, "done", "the failed attempt was retried");
  assert.deepEqual(w.tasks, ["a1", "a2"]);
  assert.deepEqual(foldInstances(read("legacy.jsonl")), end);
});

test("a log from before plan_status (P1) folds to the same members, outcomes and $", () => {
  for (const name of ["journey.jsonl", "endings.jsonl"]) {
    const now = checkpoints(name, {}, false);
    const p1 = checkpoints(name, {}, true);
    const shape = (v: Instance[]) =>
      v.map((i) => ({ id: i.id, state: i.state, ghost: i.ghost, running: i.running, outcome: i.outcome, usd: i.usd }));
    for (const [at, v] of now) assert.deepEqual(shape(p1.get(at)!), shape(v), `${name} at "${at}"`);
  }
  // what it can't tell: a retry row inside one task reads as an end and a new life
  const s3 = get(checkpoints("journey.jsonl", {}, true).get("end")!, "animator:s03");
  assert.equal(s3.lives.length, 2);
  assert.equal(s3.lives[1].reason, undefined, "no newer revision: a new life, but no return line");
});

test("a cancelled run (N24): a life ends when its run died, at the last thing the run said", () => {
  // a log from before the plan: two scenes tuning, the process dies, the next run cancels them 97 minutes later
  const cp = checkpoints("crashed.jsonl");
  assert.equal(get(cp.get("tuning")!, "animator").state, "live");
  const a = get(cp.get("end")!, "animator");
  assert.equal(a.state, "finished");
  assert.equal(a.lives.length, 2);
  assert.deepEqual(a.lives[0], {
    from: "2026-11-07T13:27:02.000Z",
    to: "2026-11-07T13:27:05.000Z",
    reason: "Pip brought in the Animator for the scenes",
  });
  const alive = a.lives.reduce((n, l) => n + Date.parse(l.to!) - Date.parse(l.from), 0);
  assert.ok(alive < 60_000, `alive ${alive} ms, not the 97 minutes the run was dead`);
  assert.equal(a.usd, 0.03);
  assert.deepEqual(foldInstances(read("crashed.jsonl")), cp.get("end"));
});

test("a stopped run (N24): its open rows end at the run's stop, and the next attempt is a new life", () => {
  const cp = checkpoints("stopped.jsonl");
  assert.equal(get(cp.get("tuning")!, "animator:s01").state, "live");
  const stopped = get(cp.get("stopped")!, "animator:s01");
  assert.equal(stopped.state, "idle", "its task waits for the next run");
  assert.equal(stopped.running, 0);
  assert.equal(stopped.lives[0].to, "2026-11-07T20:00:35.000Z", "the run's stop, since the row has no endedAt");
  const end = get(cp.get("end")!, "animator:s01");
  assert.equal(end.state, "finished");
  assert.equal(end.outcome, "done");
  assert.equal(end.lives.length, 2);
  assert.equal(end.lives[1].from, "2026-11-07T21:00:37.000Z", "when the task took its slot again");
  assert.equal(end.lives[1].reason, undefined, "the same task resumed: no return line");
  assert.equal(end.usd, 0.03);
  // the live tracker, attached after the stop with no run active, closes them where the log ends, not now
  const events = new EventEmitter();
  const upTo = read("stopped.jsonl").slice(0, 5);
  const t = new InstanceTracker(
    { events, eventsSince: () => upTo },
    {
      now: () => ({
        rows: [{ ...(upTo[3].data as any), status: "cancelled" }],
        plan: [{ id: "t_tune_s01", status: "running" }],
      }),
      idle: () => true,
    },
  );
  const v = get(t.view(), "animator:s01");
  assert.equal(v.state, "idle");
  assert.equal(v.lives[0].to, upTo.at(-1)!.ts);
  t.close();
});

test("reports parse as Crew.done says them", () => {
  assert.deepEqual(parseReport("done: drew the hero"), { status: "done", did: "drew the hero" });
  assert.deepEqual(parseReport("blocked: tried Couldn't: no recipe Needs: a sign recipe"), {
    status: "blocked",
    did: "tried",
    couldnt: "no recipe",
  });
  assert.equal(parseReport("hello"), null);
});

// ---------------------------------------------------------------- the live tracker's order (N3)
test("tracker: a spawn comes before its task's working row, an end after its last task event", () => {
  const events = new EventEmitter();
  let seq = 0;
  const seen: FoldEvent[] = [];
  // the SSE route subscribes after the tracker; here the recorder goes first, so each instance event follows its cause
  events.on("event", (e: FoldEvent) => seen.push(e));
  const tracker = new InstanceTracker({ events, eventsSince: () => [] }, { sceneIds: () => SCENES, idle: () => false });
  const task = (status: string) => ({
    id: "t_tune_s01",
    kind: "scene.tune",
    role: "animator",
    scene: "s01",
    instance: "animator:s01",
    dependsOn: [],
    status,
    taskIds: status === "pending" ? [] : ["r1"],
    addedIn: 0,
  });
  const ev = (event: string, data: unknown, transient = false) =>
    events.emit("event", {
      seq: transient ? 0 : ++seq,
      event,
      data,
      ts: new Date(Date.UTC(2026, 10, 7, 21, 0, seq)).toISOString(),
    });
  const row = (status: string, usd = 0) => ({
    id: "r1",
    kind: "scene.tune",
    role: "animator",
    title: "Tuning",
    status,
    usd,
    planTask: "t_tune_s01",
    instance: "animator:s01",
  });
  ev("plan", {
    view: { rev: 0, tasks: [task("pending")] },
    revision: { rev: 0, by: "rules", trigger: "start", reason: "r", ops: [] },
  });
  // the executor (Executor.start → setPlanStatus → touch): running is stored, then the view, then the handler's row
  ev("plan_status", { rev: 0, tasks: [{ id: "t_tune_s01", status: "running" }] });
  ev("plan", { view: { rev: 0, tasks: [task("running")] } }, true);
  ev("task", row("working"));
  ev("task", row("done", 0.1));
  ev("plan_status", { rev: 0, tasks: [{ id: "t_tune_s01", status: "done", taskIds: ["r1"] }] });
  ev("plan", { view: { rev: 0, tasks: [task("done")] } }, true);
  const order = seen.map((e) =>
    e.event === "instance"
      ? `instance:${(e.data as any).change}`
      : e.event === "task"
        ? `task:${(e.data as any).status}`
        : e.event,
  );
  assert.deepEqual(order, [
    "plan",
    "instance:ghost",
    "plan_status",
    "instance:spawn",
    "plan",
    "task:working",
    "task:done",
    "plan_status",
    "instance:end",
    "plan",
  ]);
  const end = seen.findLast((e) => e.event === "instance")!.data as { instance: Instance };
  assert.equal(end.instance.usd, 0.1);
  assert.equal(end.instance.outcome, "done");
  assert.equal(end.instance.lives.length, 1);
  assert.equal(tracker.view()[0].state, "finished");
  tracker.close();
});

// ---------------------------------------------------------------- a whole run on a fake provider
/** the parity test's crew: every role answers well enough; the Pixel Artist fails (library fallback) */
function crewAnswer(req: Req): Step {
  const sys = req.system ?? "";
  const last = String(req.messages.at(-1)?.content ?? "");
  if (/asking about one crew member/.test(last)) {
    asked.push(last);
    return { toolCalls: [{ name: "reply", input: { text: "From the record: it read the brief." } }], usd: 0.001 };
  }
  if (/You are the Producer/.test(sys))
    return {
      json: { digest: "A short launch video for a fictional app.", assumptions: ["calm music"], questions: [] },
    };
  if (/You are the Writer/.test(sys))
    return {
      json: {
        angles: [
          {
            name: "The quest",
            approach: "a hero clears a day",
            cues: ["Lists feel heavy.", "Lumen makes them light."],
          },
          { name: "The calm", approach: "a calm night", cues: ["Night falls.", "Lumen keeps your day."] },
        ],
        recommended: 0,
      },
    };
  if (/turn the script into scenes/.test(sys)) return { error: new Error("no board today") };
  if (/You are the Art Director. You write a precise drawing spec/.test(sys))
    return { json: { letters: "kKwW", description: "A small hero with a scarf, facing right.", reads: "a hero" } };
  if (/senior pixel artist/.test(sys)) return { error: new Error("no pixels today") };
  if (/Animator of one scene/.test(sys)) return { json: { changes: [] }, usd: 0.002 };
  if (/festival judge/.test(sys)) return { json: { verdict: "ship", summary: "fine", blockers: [], polish: [] } };
  return { error: new Error(`unexpected call: ${sys.slice(0, 60)}`) };
}
const asked: string[] = [];

test("a whole run at one slot: live events in order, replay equals live, the kept log, Ask Pip about this", async () => {
  const fake = new FakeProvider((req) => crewAnswer(req), { id: "fake" });
  setPriceOverride("fake/model", { inPerMTok: 1, outPerMTok: 5 });
  const settings = defaultSettings();
  settings.providers.push({ id: "fake", kind: "custom", label: "Fake", baseUrl: "http://fake.invalid", enabled: true });
  for (const r of Object.keys(settings.roles)) settings.roles[r] = { model: "fake/model" };
  settings.roles.assistant = { model: "fake/model" };
  settings.defaults.concurrency = 1;
  settings.defaults.pipPlan = "off";
  const dir = join(root, "lumen");
  const workspace = new Workspace(() => [dir]);
  open.push(workspace);
  const p0 = workspace.create({
    title: "Lumen",
    dir,
    budgetUsd: 5,
    brief: {
      idea: "Lumen is a fictional to-do app that makes a list feel light.",
      purpose: "launch",
      audience: "",
      ask: "",
      lengthSec: 15,
      tone: [],
      mustSay: [],
      mustAvoid: [],
      narration: "none",
      involvement: "auto",
      references: [],
    },
  });
  const gateway = new ModelGateway({
    ledger: new Ledger(join(home, "ledger.sqlite")),
    secrets: new SecretStore({ env: {}, keychain: false, dir: home }),
    settings,
    providers: [fake],
    caps: { "fake/model": FAKE_CAPS },
  });
  const registry = buildRegistry();
  const w = await wireCrew({ workspace, registry, gateway, resume: false });
  const crew = w.crewImpl;
  const p = workspace.get(p0.id);
  const seen: FoldEvent[] = [];
  p.events.on("event", (e: FoldEvent) => seen.push(e));
  await crew.run(p, {});
  const now = crew.instances(p);
  assert.ok(now.length >= 6, `members: ${now.map((i) => i.id).join(", ")}`);
  for (const i of now) {
    InstanceSchema.parse(i);
    assert.equal(i.state, "finished", `${i.id} is finished`);
    assert.ok(i.outcome);
  }
  // the instances' $ is the rows' $
  const rowsUsd = p.state.tasks.reduce((a, t) => a + t.usd, 0);
  assert.ok(Math.abs(now.reduce((a, i) => a + i.usd, 0) - rowsUsd) < 1e-6);

  // the run's bounds are in the log, and no row of it is left open
  assert.deepEqual(
    seen.filter((e) => e.event === "run").map((e) => (e.data as { status: string }).status),
    ["start", "done"],
  );
  assert.ok(!p.state.tasks.some((t) => t.planTask && ["working", "queued", "waiting_user"].includes(t.status)));
  // N3: every working row comes after its member's face went live; nothing of a member follows its end
  const lastInstance = new Map<string, Instance>();
  for (const e of seen) {
    if (e.event === "instance") {
      const d = e.data as { instance: Instance; change: string };
      lastInstance.set(d.instance.id, d.instance);
    }
    if (e.event === "task") {
      const t = e.data as { status: string; instance?: string };
      if (!t.instance || t.instance === "person") continue;
      const i = lastInstance.get(t.instance);
      if (t.status === "working") assert.equal(i?.state, "live", `${t.instance}'s face before its working row`);
      else assert.notEqual(i?.state, "finished", `${t.instance}: no task event after its end`);
    }
  }
  // one slot (D4): never two Animators working at once
  for (const e of seen.filter((x) => x.event === "instance")) {
    const at = (e.data as { instance: Instance }).instance;
    if (at.role === "animator") assert.ok(at.running <= 1);
  }
  const animatorsLive = new Set<string>();
  let maxLive = 0;
  for (const e of seen.filter((x) => x.event === "instance")) {
    const at = (e.data as { instance: Instance }).instance;
    if (at.role !== "animator") continue;
    if (at.running > 0) animatorsLive.add(at.id);
    else animatorsLive.delete(at.id);
    maxLive = Math.max(maxLive, animatorsLive.size);
  }
  assert.equal(maxLive, 1, "the slot holds one Animator at a time");

  // the replay of the stored log (no status-only views) says what the live tracker says
  const replay = foldInstances(p.eventsSince(0), { sceneIds: () => p.doc().scenes.map((s) => s.id) });
  const shape = (v: Instance[]) =>
    v.map((i) => ({
      id: i.id,
      state: i.state,
      ghost: i.ghost,
      outcome: i.outcome,
      usd: i.usd,
      tasks: i.tasks,
      reason: i.reason,
      lives: i.lives.map((l) => l.reason ?? null),
      lastReport: i.lastReport ?? null,
    }));
  assert.deepEqual(shape(replay), shape(now));

  // the HTTP side: state.instances, the kept log, about
  const { app, token } = createApp({ ...w, workspace, registry, port: 5997 });
  const H = { host: "127.0.0.1:5997", "content-type": "application/json", "x-pap-token": token };
  const st = await (await app.fetch(new Request(`http://127.0.0.1:5997/api/p/${p.id}`, { headers: H }))).json();
  assert.deepEqual(
    st.instances.map((i: Instance) => i.id),
    now.map((i) => i.id),
  );
  const log = await (
    await app.fetch(new Request(`http://127.0.0.1:5997/api/p/${p.id}/instances/writer/log`, { headers: H }))
  ).json();
  assert.equal(log.instance.id, "writer");
  assert.ok(log.entries.some((x: any) => x.source === "task"));
  assert.ok(log.entries.some((x: any) => x.source === "channel" && x.msg.from === "writer"));
  assert.deepEqual(
    log.entries.map((x: any) => x.at),
    [...log.entries.map((x: any) => x.at)].sort(),
  );
  // the UI encodes the key ("animator%3Ahook")
  const anim = now.find((i) => i.role === "animator")!;
  const alog = await (
    await app.fetch(
      new Request(`http://127.0.0.1:5997/api/p/${p.id}/instances/${encodeURIComponent(anim.id)}/log`, { headers: H }),
    )
  ).json();
  assert.equal(alog.instance.id, anim.id);
  assert.ok(alog.entries.length > 0);
  const miss = await app.fetch(new Request(`http://127.0.0.1:5997/api/p/${p.id}/instances/nobody/log`, { headers: H }));
  assert.equal(miss.status, 404);
  assert.ok((await miss.json()).error.fix);

  const bad = await app.fetch(
    new Request("http://127.0.0.1:5997/api/pip", {
      method: "POST",
      headers: H,
      body: JSON.stringify({ project: p.id, text: "why?", about: { instance: "Not An Id" } }),
    }),
  );
  assert.equal(bad.status, 400);
  const unknown = await app.fetch(
    new Request("http://127.0.0.1:5997/api/pip", {
      method: "POST",
      headers: H,
      body: JSON.stringify({ project: p.id, text: "why?", about: { instance: "pixel-artist:dragon" } }),
    }),
  );
  assert.equal(unknown.status, 404);
  const producer = now.find((i) => i.id === "producer")!;
  const { done } = w.pip!.ask(p.id, "why did you bring in the Producer?", { about: { instance: "producer" } });
  const item = await done;
  assert.equal(item.kind, "pip");
  assert.equal(asked.length, 1, "the record went into that turn's context");
  assert.match(asked[0], /Producer \(producer\), finished, outcome done/);
  assert.ok(asked[0].includes(producer.reason));
  assert.match(asked[0], /added in plan rev 0 by rules \(start\)/);
  assert.match(asked[0], /of the project's \$5\.00 cap/);
  const user = w.pip!.items(p.id).find((i) => i.kind === "user");
  assert.deepEqual(user && "about" in user ? user.about : null, { instance: "producer", label: "Producer" });

  // a throwing view never fails the run: the crew runs again from the sound stage while the fold throws on every event
  const failedBefore = p.state.tasks.filter((t) => t.status === "failed" && !t.supersededBy).length;
  const tracker = (crew as any).trackers.get(p.id).t as InstanceType<typeof InstanceTracker>;
  const said: string[] = [];
  const err = console.error;
  console.error = (...a: unknown[]) => said.push(a.map(String).join(" "));
  tracker.fold.apply = () => {
    throw new TypeError(`broken view, secret-ish text: ${p.doc().brief.idea}`);
  };
  try {
    await crew.run(p, { stage: "sound" });
  } finally {
    console.error = err;
  }
  assert.ok(
    p.state.tasks.filter((t) => t.kind === "sound.mix").length >= 2,
    "the rerun made its tasks while the view threw",
  );
  assert.equal(
    p.state.tasks.filter((t) => t.status === "failed" && !t.supersededBy).length,
    failedBefore,
    "no new failure (the Pixel artist's fake failures are the first run's)",
  );
  assert.equal(p.state.status?.line, "Your video is ready");
  const warned = said.filter((x) => x.startsWith("instances:"));
  assert.equal(warned.length, 1, "it says so once");
  assert.match(
    warned[0],
    /^instances: the crew view failed on a \w+ event \(TypeError\); the crew goes on without it$/,
  );
  assert.ok(!warned[0].includes("Lumen"), "no project text in the line");
});

test("tracker: a fault in the fold stays inside the listener", () => {
  const events = new EventEmitter();
  const tracker = new InstanceTracker({ events, eventsSince: () => [] }, { idle: () => false });
  tracker.fold.apply = () => {
    throw new Error("boom");
  };
  const said: string[] = [];
  const err = console.error;
  console.error = (...a: unknown[]) => said.push(a.map(String).join(" "));
  try {
    for (let i = 1; i <= 3; i++)
      assert.doesNotThrow(() =>
        events.emit("event", { seq: i, event: "task", data: { id: "r" }, ts: "2026-11-07T21:00:00.000Z" }),
      );
  } finally {
    console.error = err;
  }
  assert.deepEqual(said, ["instances: the crew view failed on a task event (Error); the crew goes on without it"]);
  tracker.close();
});
