// Plan revisions, gates and publish (docs/PIP-ORCHESTRATION.md §1.9): a change reopens only what it touches, a stand-in
// is redrawn on retry, sprite sizes scale estimates, a person's change moves what they approved, slash commands are
// never changes, the conductor's plan changes are checked (and the refusal goes back to it), reruns ask at the gates
// again, publish writes to the person's library once, and promote refuses private art. Over FakeProvider, the fictional
// QuestDay example and temp folders only: the repo's library/ is read, never written.
import assert from "node:assert/strict";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

const home = mkdtempSync(join(tmpdir(), "pap-revisions-"));
process.env.PAP_HOME = home;
const root = join(home, "projects");
mkdirSync(root, { recursive: true });
const EXAMPLE = new URL("../../../examples/questday/", import.meta.url).pathname;
const SEED = new URL("../../../library/", import.meta.url).pathname;

const { Project } = await import("@pap/schema");
const { buildRegistry, Workspace } = await import("@pap/tools");
const { ModelGateway } = await import("../src/gateway-impl.ts");
const { FakeProvider, FAKE_CAPS, Ledger, SecretStore, defaultSettings, setPriceOverride } = await import(
  "../src/llm/index.ts"
);
const { Crew } = await import("../src/orchestrator.ts");
const rules = await import("../src/plan/rules.ts");
const { estimatePlanTask } = await import("../src/plan/estimate.ts");
const { validate, idsIn } = await import("../src/plan/validate.ts");
const { PipConductor } = await import("../src/conductor.ts");
const { ABOUT_PREFIX } = await import("../src/assistant.ts");
const lib = await import("@pap/render");
const { wireCrew } = await import("../../../apps/server/src/wire.ts");

type PlanTaskT = import("../src/plan/schema.ts").PlanTaskT;
type Req = import("../src/llm/types.ts").ChatRequest;

const open: InstanceType<typeof Workspace>[] = [];
after(() => {
  for (const w of open) w.closeAll();
  rmSync(home, { recursive: true, force: true });
});

const env = {
  modelFor: () => "anthropic/claude-sonnet-5-5",
  fallbackFor: () => undefined,
  caps: () => FAKE_CAPS,
  laneSize: () => 3,
  local: () => false,
};
const ctx = (rev = 0) => ({ env, rev }) as any;
const mk = (id: string, kind: string, deps: string[] = [], extra: Record<string, unknown> = {}) =>
  rules.mkTask({ id, kind, dependsOn: deps, ...extra } as any, ctx());
const done = (t: PlanTaskT) => ({ ...t, status: "done" as const });
const wait = async (ok: () => boolean, ms = 15000) => {
  for (let i = 0; i < ms / 10 && !ok(); i++) await new Promise((r) => setTimeout(r, 10));
  assert.ok(ok(), "timed out waiting");
};
const exampleDoc = () => Project.parse(JSON.parse(readFileSync(join(EXAMPLE, "pitch.json"), "utf8")));

let n = 0;
async function crewOn(answer: (req: Req) => any = () => ({ error: new Error("unexpected") })) {
  const dir = join(root, `q_${++n}`);
  cpSync(EXAMPLE, dir, { recursive: true, filter: (f) => !f.endsWith(".pap-lock") });
  setPriceOverride("fake/model", { inPerMTok: 1, outPerMTok: 5 });
  const fake = new FakeProvider((req) => answer(req), { id: "fake" });
  const settings = defaultSettings();
  settings.providers.push({ id: "fake", kind: "custom", label: "Fake", baseUrl: "http://fake.invalid", enabled: true });
  for (const r of Object.keys(settings.roles)) settings.roles[r] = { model: "fake/model" };
  const workspace = new Workspace(() => [dir]);
  open.push(workspace);
  const gateway = new ModelGateway({
    ledger: new Ledger(join(home, `ledger-${n}.sqlite`)),
    secrets: new SecretStore({ env: {}, keychain: false, dir: home }),
    settings,
    providers: [fake],
    caps: { "fake/model": FAKE_CAPS },
  });
  const registry = buildRegistry();
  const crew = new Crew({ workspace, registry, gateway });
  const id = workspace.list().find((x) => x.dir === dir)!.id;
  const p = workspace.get(id);
  await p.patch([{ op: "replace", path: "/budget/capUsd", value: 5 }], { reason: "t", author: { kind: "user" } });
  return { crew, p, workspace, registry, gateway, dir };
}
/** a Run the handlers accept, outside crew.run */
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

// ---------------------------------------------------------------- 1. revisions
test("freshId keeps a variant's suffix: t_draw_owl_v1 copies are t_draw_owl_v1_v<rev>, never t_draw_owl_v4_2", () => {
  const taken = new Set(["t_draw_owl_v1", "t_draw_owl_v2", "t_tune_a_r1"]);
  assert.equal(rules.freshId("t_draw_owl_v1", 4, taken, 1), "t_draw_owl_v1_v4");
  assert.equal(rules.freshId("t_draw_owl_v2", 4, taken, 2), "t_draw_owl_v2_v4");
  assert.equal(rules.freshId("t_draw_owl_v1_v4", 5, taken, 1), "t_draw_owl_v1_v5");
  assert.equal(rules.freshId("t_tune_a_r1", 7, taken), "t_tune_a_r1_v7", "other ids as before");
  const tasks = [done(mk("t_draw_owl_v1", "asset.draw", [], { asset: "owl", variant: 1 }))];
  tasks.push(done(mk("t_draw_owl_v2", "asset.draw", [], { asset: "owl", variant: 2 })));
  const r = rules.rerun(tasks, ["t_draw_owl_v1", "t_draw_owl_v2"], 4, { reason: "again" });
  assert.deepEqual([...r.map.values()], ["t_draw_owl_v1_v4", "t_draw_owl_v2_v4"]);
});

test("a change with a scope re-adds nothing the project already has: other scenes, drawn art, a publish answered", () => {
  const d = exampleDoc();
  d.assets.push({ id: "lamp", src: "file:assets/lamp.json", flags: { private: false }, publish: "no" } as any);
  const ss: any = Object.fromEntries(d.scenes.map((s) => [s.id, { version: "render", state: "ready" }]));
  let ts = rules.startPlan(d, { tasks: [], gates: [], sceneStatus: ss } as any, ctx());
  for (const t of ts) if (t.status === "pending") t.status = "done";
  const g2 = ts.find((t) => t.gate === "g2_animatic")!.id;
  const chain = [
    done(mk("t_spec_lamp", "asset.spec", [g2], { asset: "lamp", assetKind: "prop" })),
    done(mk("t_draw_lamp_v1", "asset.draw", ["t_spec_lamp"], { asset: "lamp", variant: 1 })),
    done(mk("t_draw_lamp_v2", "asset.draw", ["t_spec_lamp"], { asset: "lamp", variant: 2 })),
    done(mk("t_judge_lamp", "asset.judge", ["t_draw_lamp_v1", "t_draw_lamp_v2"], { asset: "lamp" })),
    done(mk("t_publish_lamp", "lib.publish", ["t_g4"], { asset: "lamp", conditional: true })),
  ];
  ts = [...ts, ...chain];
  // the person changes how scene grind moves: its tune comes back, the rest of the art stage does not
  ss.grind = { version: "animatic", state: "stale" };
  const keep = (t: PlanTaskT) =>
    t.kind === "lib.publish" || (!!t.asset && t.kind.startsWith("asset.") && rules.hasArt(d, t.asset));
  const out = rules.changeRevision(ts, { scope: ["grind"] }, "art", ctx(1), ss, keep);
  const added = out.tasks.filter((t) => t.addedIn === 1);
  assert.ok(!added.some((t) => t.asset), "no chain task for art already in the project, no second publish question");
  assert.deepEqual(
    added.filter((t) => t.kind === "scene.tune").map((t) => t.scene),
    ["grind"],
    "only the scene in scope is tuned again",
  );
  assert.ok(added.some((t) => t.kind === "review.final") && added.some((t) => t.gate === "g3_rough"));
  // without the project's keep, the whole chain came back (the P4 run's $12.50 estimate)
  const all = rules.changeRevision(ts, {}, "art", ctx(1), ss);
  assert.ok(all.tasks.filter((t) => t.addedIn === 1 && t.asset === "lamp").length >= 4);
});

test("a stand-in is not the drawing: a retry of the judge redraws its variants and replaces the stand-in in place", async () => {
  const { crew, p } = await crewOn();
  const c = crew as any;
  // the earlier run: both variants failed, so the library's items stood in for "lamp"
  await p.patch([{ op: "add", path: "/assets/-", value: { id: "lamp", src: "lib:items@1", standIn: true } }], {
    reason: "t",
    author: { kind: "user" },
  });
  assert.ok(!rules.hasArt(p.doc(), "lamp"), "a stand-in doesn't count as the art");
  assert.ok(rules.hasArt(p.doc(), "hero"), "a library cast under its own name does");
  const spec = {
    letters: "kS",
    description: "A small glowing lamp on a post, light from the upper left.",
    reads: "a lamp",
  };
  writeFileSync(
    c.artFile(p, "lamp", "spec"),
    JSON.stringify({ name: "lamp", kind: "icon", description: spec.description, spec, letters: "kS", row: "x" }),
  );
  const tasks = [
    { ...mk("t_draw_lamp_v1", "asset.draw", [], { asset: "lamp", variant: 1 }), status: "done", outcome: "fallback" },
    { ...mk("t_draw_lamp_v2", "asset.draw", [], { asset: "lamp", variant: 2 }), status: "done", outcome: "fallback" },
    {
      ...mk("t_judge_lamp", "asset.judge", ["t_draw_lamp_v1", "t_draw_lamp_v2"], { asset: "lamp" }),
      status: "done",
      outcome: "fallback",
    },
  ] as PlanTaskT[];
  c.plans.set(p.id, { tasks, runs: [], rev: 3 });
  assert.deepEqual(
    crew.retryTargets(p, "t_judge_lamp").map((t) => t.id),
    ["t_draw_lamp_v1", "t_draw_lamp_v2", "t_judge_lamp"],
    "a judge's retry brings its fallen-back variants with it",
  );
  const keep = crew.keepOf(p);
  assert.equal(keep(tasks[0]), false, "a rerun draws a stand-in's chain again");
  // the redraw: the draw is not skipped as "already in the project"
  const rows = Array.from({ length: 16 }, () => "kkkkkkkkkkkkkkkk");
  c.drawVariant = async (
    _p: any,
    _r: any,
    a: { name: string },
    _t: any,
    _s: any,
    _l: any,
    _tb: any,
    _pl: any,
    v: number,
  ) => {
    writeFileSync(join(p.dir, "runs", `${a.name}-v${v}.png`), Buffer.from("png"));
    return { frames: { notes: "", frames: [{ name: "icon", rows }] }, std: { ok: true }, model: "fake/model" };
  };
  const r = fakeRun();
  const drew = await c.assetDraw(p, r, { ...tasks[0], id: "t_draw_lamp_v1_v4", status: "running" });
  assert.equal(drew.status, "done");
  assert.notEqual(drew.note, "already in the project");
  writeFileSync(c.artFile(p, "lamp", "v2"), "null");
  const judged = await c.assetJudge(p, r, { ...tasks[2], id: "t_judge_lamp_v4", status: "running" });
  assert.equal(judged.status, "done");
  assert.equal(judged.outcome, undefined, "no stand-in this time");
  const refs = p.doc().assets.filter((a) => a.id === "lamp");
  assert.equal(refs.length, 1, "one ref per name: the stand-in is replaced, not duplicated");
  assert.equal(refs[0].src, "file:assets/lamp.json");
  assert.ok(!refs[0].standIn);
  assert.ok(rules.hasArt(p.doc(), "lamp"));
});

// ---------------------------------------------------------------- 2. estimates
test("sprite size scales the estimate: an icon's draw costs less than an 8-frame hero's", () => {
  const icon = estimatePlanTask(
    { kind: "asset.draw", role: "pixel-artist", tier: "role", assetKind: "icon" } as any,
    env,
  );
  const hero = estimatePlanTask(
    { kind: "asset.draw", role: "pixel-artist", tier: "role", assetKind: "character" } as any,
    env,
  );
  assert.ok(icon.usd[0] > 0 && icon.usd[0] < hero.usd[0] * 0.6, `${icon.usd[0]} vs ${hero.usd[0]}`);
  // the task-level path carries assetKind (mkTask fills estUsd from it)
  assert.ok(mk("t_draw_x_v1", "asset.draw", [], { asset: "x", assetKind: "icon" }).estUsd[0] < hero.usd[0]);
});

test("a person's change moves what they approved; its card prices the change's own revision", async () => {
  const { crew, p } = await crewOn();
  const before = (crew as any).ensurePlan(p, null);
  (before as any).approvedUsd = 0.01;
  const cost = crew.changeCost(p, { assignee: "animator", scene: "grind" });
  assert.ok(cost && cost.usd[0] > 0, "the change has a cost of its own");
  const note = p.addNote({
    target: { scene: "grind" },
    category: "art",
    text: "slower walk",
    assignee: "animator",
    by: "user",
  });
  p.state.paused = true; // write the revision, don't run it
  crew.requestChange(p, note);
  const plan = crew.planNow(p)!;
  assert.equal(plan.by, "person");
  assert.equal(plan.trigger, "change");
  assert.equal(plan.approvedUsd, plan.estimate.usd[1], "the top of the range the person said yes to");
  assert.ok(Math.abs(plan.estimate.usd[0] - before.estimate.usd[0] - cost!.usd[0]) < 1e-6, "the card's figure");
  assert.ok(!plan.tasks.some((t) => t.addedIn === plan.rev && t.kind === "scene.tune" && t.scene !== "grind"));
});

// ---------------------------------------------------------------- 3. slash commands
test("a slash command is never a change: the scope prefix is stripped for commands, and the tool refuses '/'", async () => {
  assert.equal("About the moth: /context".replace(ABOUT_PREFIX, ""), "/context");
  const { p, registry, workspace, crew } = await crewOn();
  const { crewRequestChangeTool } = await import("@pap/tools");
  registry.add(crewRequestChangeTool((pp, note, extra) => crew.requestChange(pp, note, extra)));
  const res = await registry.call(
    "crew_request_change",
    { text: "About the moth: /context" },
    { author: { kind: "user" as const }, project: p, workspace, emit: () => {} },
  );
  assert.equal(res.ok, false);
  assert.equal(!res.ok && res.error.code, "not_a_change");
  assert.equal(p.state.notes.length, 0, "no note was made");
});

test("Pip: 'About the moth: /context' is the /context command, and its card for '/budget' is refused", async () => {
  const dir = join(root, `pip_${++n}`);
  cpSync(EXAMPLE, dir, { recursive: true, filter: (f) => !f.endsWith(".pap-lock") });
  const settings = defaultSettings();
  settings.providers.push({ id: "fake", kind: "custom", label: "Fake", baseUrl: "http://fake.invalid", enabled: true });
  for (const r of Object.keys(settings.roles)) settings.roles[r] = { model: "fake/model" };
  let calls = 0;
  const gateway = new ModelGateway({
    ledger: new Ledger(join(home, `ledger-pip-${n}.sqlite`)),
    secrets: new SecretStore({ env: {}, keychain: false, dir: home }),
    settings,
    providers: [
      new FakeProvider(
        () => {
          calls++;
          return { text: "hello" };
        },
        { id: "fake" },
      ),
    ],
    caps: { "fake/model": FAKE_CAPS },
  });
  const workspace = new Workspace(() => [dir]);
  open.push(workspace);
  const wired = await wireCrew({ workspace, registry: buildRegistry(), gateway, resume: false });
  const id = workspace.list().find((x) => x.dir === dir)!.id;
  const item: any = await wired.pip!.ask(id, "About the moth: /context").done;
  assert.equal(item.kind, "context");
  assert.equal(calls, 0, "no model call, no turn");
  assert.ok(!wired.pip!.items(id).some((i: any) => i.kind === "user"), "nothing in the history");
  const res = wired.pip!.planCards("crew_request_change", { text: "/budget 4" }, workspace.get(id));
  assert.ok("error" in res && /slash command/.test(res.error));
});

test("a note no crew stage owns is closed when the run ends, never rerun", async () => {
  const { crew, p } = await crewOn((req) =>
    /Animator of one scene/.test(req.system ?? "")
      ? { json: { changes: [] } }
      : /festival judge/.test(req.system ?? "")
        ? { json: { verdict: "ship", summary: "ok", blockers: [], polish: [] } }
        : { error: new Error("unexpected") },
  );
  await p.patch([{ op: "replace", path: "/brief/involvement", value: "auto" }], {
    reason: "t",
    author: { kind: "user" },
  });
  const running = crew.run(p, {});
  const stray = p.addNote({ target: {}, category: "other", text: "/context", assignee: "pip", by: "user" });
  await running;
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(p.state.notes.find((x) => x.id === stray.id)!.status, "declined");
  assert.equal(crew.status(p).crew.running, false, "no second run for it");
});

// ---------------------------------------------------------------- 4. the conductor
test("the conductor's plan changes are checked: unknown names, invented assets, one per trigger, no repeats", async () => {
  const { crew, p } = await crewOn();
  const c = crew as any;
  const r = fakeRun();
  c.ensurePlan(p, r);
  assert.equal(c.checkChange(p, r, { kind: "redo", scenes: ["grind"], why: "the walk is stiff" }), null);
  assert.match(c.checkChange(p, r, { kind: "redo", scenes: ["s09"], why: "redo it" }), /no scene s09/);
  assert.match(
    c.checkChange(p, r, { kind: "reboard", scenes: ["quest"], direction: "use owl_reading in the middle" }),
    /owl_reading/,
    "a reason names only ids the project has",
  );
  const invent = {
    kind: "replan",
    diff: {
      ops: [
        {
          op: "add",
          kind: "asset.spec",
          asset: "growth_coin",
          assetKind: "icon",
          description: "a shiny coin that grows",
          after: [],
          reason: "a coin for the growth beat",
        },
      ],
      summary: "Added a coin.",
    },
  };
  assert.match(c.checkChange(p, r, invent), /no asset growth_coin/, "an asset the script never names");
  // the same change again, while the first one hasn't run, is dropped
  await c.apply(p, r, [{ kind: "redo", scenes: ["grind"], why: "the walk is stiff" }]);
  assert.match(c.checkChange(p, r, { kind: "redo", scenes: ["grind"], why: "still stiff" }), /same plan change/);
  // one plan change per trigger: the second is refused through the conductor's check
  const seen: (string | null)[] = [];
  c.conductor = {
    think: async (_p: any, _t: any, k: any) => {
      seen.push(k.check({ kind: "redo", scenes: ["flag"], why: "late flag" }));
      seen.push(k.check({ kind: "redo", scenes: ["quest"], why: "quest is slow" }));
      return [];
    },
  };
  await c.think(p, r, { kind: "stage", stage: "animate", notes: [] });
  assert.equal(seen[0], null);
  assert.match(seen[1]!, /one plan change per trigger/);
  // apply() keeps one too, for the fixed rules' decisions
  const rev = crew.planNow(p)!.rev;
  await c.apply(p, r, [
    { kind: "redo", scenes: ["end"], why: "first" },
    { kind: "redo", scenes: ["quest"], why: "second" },
  ]);
  assert.equal(crew.planNow(p)!.rev, rev + 1, "only the first one was applied");
  assert.deepEqual(idsIn("redo t_tune_grind_r2 and owl_reading, not end-card"), ["t_tune_grind_r2", "owl_reading"]);
});

test("a refused plan change goes back to the conductor as a tool error, and it can correct itself", async () => {
  const { p } = await crewOn();
  const reqs: Req[] = [];
  const steps = [
    { toolCalls: [{ id: "c1", name: "crew_redo", input: { scenes: ["nope"], why: "redo the missing one" } }] },
    { toolCalls: [{ id: "c2", name: "crew_redo", input: { scenes: ["grind"], why: "the walk is stiff" } }] },
  ];
  const gateway = {
    modelFor: () => "fake/model",
    chat: async (req: Req) => {
      reqs.push(structuredClone(req));
      const s = steps[reqs.length - 1] ?? { toolCalls: [] };
      return { result: { toolCalls: s.toolCalls, assistant: null, usage: {}, usd: 0 } };
    },
  } as any;
  const cond = new PipConductor({ gateway, modeFor: () => "agent" });
  const out = await cond.think(
    p,
    { kind: "stage", stage: "animate", notes: [] },
    {
      redos: new Map(),
      check: (d) => (d.kind === "redo" && d.scenes.includes("nope") ? "no scene nope (fix: use grind)" : null),
    },
  );
  assert.equal(reqs.length, 2, "Pip got a second step");
  const err = reqs[1].messages.find((m: any) => m.role === "tool" && m.isError);
  assert.ok(err && /no scene nope/.test(String((err as any).content)), "with the refusal as the tool's error");
  assert.deepEqual(out, [{ kind: "redo", scenes: ["grind"], why: "the walk is stiff" }]);
});

test("V4: a conductor's diff may add only art the project names; Pip's first revision may add what the brief needs", () => {
  const d = exampleDoc();
  const ts = rules.startPlan(d, { tasks: [], gates: [], sceneStatus: {} } as any, ctx());
  const spec = mk("t_spec_owl_reading", "asset.spec", [], {
    asset: "owl_reading",
    assetKind: "icon",
    description: "x",
  });
  const vctx = { doc: d, library: new Set<string>(), env, spentUsd: 0, by: "pip" as const, before: ts };
  const strict = validate([...ts, spec], { ...vctx, strictNames: true });
  assert.ok(strict.errors.some((e) => e.rule === "V4" && /owl_reading/.test(e.message)));
  assert.ok(!validate([...ts, spec], vctx).errors.some((e) => e.rule === "V4"));
});

// ---------------------------------------------------------------- 5. gates
test("gates on a rerun: changes is never a pass, reruns lock G3/G4 again, a copied G3 at key asks the person", async () => {
  let reviews = 0;
  const { crew, p } = await crewOn((req) => {
    const sys = req.system ?? "";
    if (/Animator of one scene/.test(sys)) return { json: { changes: [] } };
    if (/festival judge/.test(sys)) {
      reviews++;
      return { json: { verdict: "ship", summary: "ok", blockers: [], polish: [] } };
    }
    return { error: new Error(`unexpected: ${sys.slice(0, 40)}`) };
  });
  await p.patch([{ op: "replace", path: "/brief/involvement", value: "key" }], {
    reason: "t",
    author: { kind: "user" },
  });
  const gate = (id: string) => p.state.gates.find((g) => g.id === id)!;
  const exported = () => p.state.tasks.filter((t) => t.kind === "deliver.export" && t.status === "done").length;
  // a verdict on a gate nobody opened is refused (an old card can't pass a locked gate)
  assert.throws(() => crew.gate(p, "g4_final", { verdict: "approve", by: "user" }), /isn't waiting/);
  crew.run(p, {}).catch(() => {});
  await wait(() => gate("g3_rough").status === "open");
  crew.gate(p, "g3_rough", { verdict: "changes", reasons: ["the hero walks too fast"], by: "user" });
  // the run ends at the gate; its end starts the change, which asks at the rough cut again
  await wait(() => p.state.notes.some((x) => x.text === "the hero walks too fast"));
  await wait(() => gate("g3_rough").status === "open" && reviews >= 2);
  assert.equal(exported(), 0, "changes didn't let the export run");
  assert.equal(p.state.notes.find((x) => x.text === "the hero walks too fast")!.assignee, "animator");
  crew.gate(p, "g3_rough", { verdict: "approve", by: "user" });
  await wait(() => !crew.status(p).crew.running && exported() === 1);
  assert.equal(gate("g4_final").status, "passed", "Looks good at the rough cut passes the final at key (D2)");
  // a rerun from the review stage locks G3 and G4 again; its copied G3 asks, never passes on the old approval
  crew.run(p, { stage: "review" }).catch(() => {});
  await wait(() => gate("g3_rough").status === "open");
  assert.equal(gate("g4_final").status, "locked");
  assert.equal(exported(), 1);
  crew.gate(p, "g3_rough", { verdict: "approve", by: "user" });
  await wait(() => !crew.status(p).crew.running && exported() === 2);
  // a retry of a fallback review: the same, through the retry path
  const plan = crew.planNow(p)!;
  const review = plan.tasks.filter((t) => t.kind === "review.final" && t.status === "done").at(-1)!;
  review.outcome = "fallback";
  crew.retry(p, { taskId: review.id });
  await wait(() => gate("g3_rough").status === "open");
  assert.equal(gate("g4_final").status, "locked");
  crew.pause(p, "now");
});

// ---------------------------------------------------------------- 6. publish and promote
const lampAsset = (id: string, rights = { likeness: false, brand: false, trademark: false, public: true }) => ({
  id,
  version: 1,
  kind: "icon",
  w: 16,
  h: 16,
  frames: ["icon"],
  palette: "pap-night@1",
  tags: ["icon"],
  description: "A small lamp.",
  licence: "LicenseRef-PAP-Library",
  rights,
  provenance: { source: "generated", role: "pixel-artist", origin: "test" },
  hash: "abc",
  standard: null,
  grid: { icon: Array.from({ length: 16 }, () => "................") },
});

test("publish writes to the person's library, remembers the answer and never asks twice", async () => {
  const user = mkdtempSync(join(tmpdir(), "pap-userlib-"));
  lib.setUserLibrary(user);
  try {
    const { crew, p } = await crewOn();
    const c = crew as any;
    await p.patch([{ op: "replace", path: "/brief/involvement", value: "key" }], {
      reason: "t",
      author: { kind: "user" },
    });
    mkdirSync(join(p.dir, "assets"), { recursive: true });
    for (const id of ["test-lamp", "test-kite"]) {
      writeFileSync(join(p.dir, "assets", `${id}.json`), JSON.stringify(lampAsset(id)));
      writeFileSync(join(p.dir, "assets", `${id}.png`), Buffer.from("png"));
      await p.patch([{ op: "add", path: "/assets/-", value: { id, src: `file:assets/${id}.json` } }], {
        reason: "t",
        author: { kind: "user" },
      });
    }
    const pt = (asset: string) => ({ ...mk(`t_publish_${asset}`, "lib.publish", [], { asset }), status: "running" });
    c.plans.set(p.id, { tasks: [pt("test-lamp"), pt("test-kite")], runs: [], rev: 1 });
    const r = fakeRun();
    // yes: the Librarian's row waits on the person, then the asset lands in the user library
    const yes = c.publish(p, r, pt("test-lamp"));
    await wait(() => p.state.questions.some((q) => q.status === "open"));
    assert.ok(
      p.state.tasks.some((t) => t.kind === "lib.publish" && t.status === "waiting_user"),
      "needs you",
    );
    const q = p.state.questions.find((x) => x.status === "open")!;
    await p.answer(q.id, { optionId: "yes" }, "user");
    assert.equal((await yes).status, "done");
    assert.ok(existsSync(join(user, "test-lamp", "asset.json")) && existsSync(join(user, "test-lamp", "sheet.png")));
    assert.ok(lib.readIndex(user).assets.some((a) => a.id === "test-lamp"));
    assert.ok(!existsSync(join(SEED, "test-lamp")), "the repo's seed is never written");
    assert.equal(lib.libraryAssetDir("test-lamp"), join(user, "test-lamp"), "search and cast read the user library");
    assert.equal(p.doc().assets.find((a) => a.id === "test-lamp")!.publish, "yes");
    // no: kept, remembered; a rerun's publish task never asks again
    const no = c.publish(p, r, pt("test-kite"));
    await wait(() => p.state.questions.filter((x) => x.status === "open").length === 1);
    await p.answer(p.state.questions.find((x) => x.status === "open")!.id, { optionId: "no" }, "user");
    assert.equal((await no).note, "kept in this project");
    assert.equal(p.doc().assets.find((a) => a.id === "test-kite")!.publish, "no");
    const asked = p.state.questions.length;
    const again = await c.publish(p, r, { ...pt("test-kite"), id: "t_publish_test-kite_v5" });
    assert.equal(again.status, "skipped");
    assert.match(again.note, /already answered/);
    assert.equal(p.state.questions.length, asked, "the question is never asked twice");
    assert.equal(crew.keepOf(p)(pt("test-kite") as any), true, "and a rerun keeps the publish task as it is");
    // the library layers: the user's entry is listed with the seed's, and publish never shadows an id
    assert.ok(lib.libraryIndex().assets.some((a) => a.id === "test-lamp" && a.layer === "user"));
    assert.ok(lib.libraryIndex().assets.some((a) => a.id === "castle" && a.layer === "seed"));
    assert.throws(() => lib.publishAsset(lampAsset("castle"), null), /already has castle/);
    assert.throws(() => lib.publishAsset(lampAsset("test-x"), null, SEED), /seed/);
  } finally {
    lib.setUserLibrary(null);
    rmSync(user, { recursive: true, force: true });
  }
});

test("promote copies a public asset into the seed and its index; it refuses likeness, brand and unknown rights", () => {
  const from = mkdtempSync(join(tmpdir(), "pap-promote-from-"));
  const to = mkdtempSync(join(tmpdir(), "pap-promote-to-"));
  try {
    cpSync(join(SEED, "palettes"), join(to, "palettes"), { recursive: true });
    writeFileSync(join(to, "index.json"), JSON.stringify({ palette: "pap-night@1", assets: [] }));
    // a real public library sprite, under a test id, passes the standard
    const moth = JSON.parse(readFileSync(join(SEED, "moth", "asset.json"), "utf8"));
    const put = (id: string, a: object) => {
      mkdirSync(join(from, id), { recursive: true });
      writeFileSync(join(from, id, "asset.json"), JSON.stringify({ ...a, id }));
    };
    put("test-moth", moth);
    put("test-face", { ...moth, rights: { ...moth.rights, likeness: true, public: false } });
    put("test-logo", { ...moth, rights: { ...moth.rights, brand: true, trademark: true } });
    put("test-ref", { ...moth, provenance: { ...moth.provenance, ref: "refs/photo.jpg" } });
    put("test-unknown", { ...moth, rights: undefined });
    const ok = lib.promoteAsset("test-moth", { from, to });
    assert.ok(ok.ok, JSON.stringify(ok));
    assert.ok(existsSync(join(to, "test-moth", "asset.json")) && existsSync(join(to, "test-moth", "sheet.png")));
    assert.ok(lib.readIndex(to).assets.some((a) => a.id === "test-moth"));
    const refused = (id: string, re: RegExp) => {
      const r = lib.promoteAsset(id, { from, to });
      assert.ok(!r.ok && r.reasons.some((x) => re.test(x)), `${id}: ${JSON.stringify(r)}`);
      assert.ok(!existsSync(join(to, id)), `${id} stays out of the seed`);
    };
    refused("test-face", /likeness/);
    refused("test-logo", /brand/);
    refused("test-ref", /reference/);
    refused("test-unknown", /not an asset file/);
    const twice = lib.promoteAsset("test-moth", { from, to });
    assert.ok(!twice.ok && /already has/.test(twice.reasons[0]), "never over an id the seed has");
  } finally {
    rmSync(from, { recursive: true, force: true });
    rmSync(to, { recursive: true, force: true });
  }
});
