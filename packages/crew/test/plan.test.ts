// The production plan (docs/PIP-ORCHESTRATION.md): the rules planner, the validator (one test per rule), expansion,
// redo and change revisions, the executor's slots and budget stop, resume from runs/plan.json, and the rights of
// imported and reference-drawn art. Over FakeProvider and fictional briefs only.
import assert from "node:assert/strict";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { crc32, deflateSync } from "node:zlib";

const home = mkdtempSync(join(tmpdir(), "pap-plan-"));
process.env.PAP_HOME = home;
const root = join(home, "projects");
mkdirSync(root, { recursive: true });
const EXAMPLE = new URL("../../../examples/questday/", import.meta.url).pathname;

const { Project } = await import("@pap/schema");
const { buildRegistry, Workspace } = await import("@pap/tools");
const { ModelGateway } = await import("../src/gateway-impl.ts");
const { FakeProvider, FAKE_CAPS, Ledger, SecretStore, defaultSettings, setPriceOverride } = await import(
  "../src/llm/index.ts"
);
const { Crew } = await import("../src/orchestrator.ts");
const rules = await import("../src/plan/rules.ts");
const { validate } = await import("../src/plan/validate.ts");
const { Executor, viewStage } = await import("../src/plan/executor.ts");
const { decodePng, logoIcon } = await import("../src/plan/import.ts");
const { CATALOGUE, instanceKey } = await import("../src/plan/catalogue.ts");
const { resolveTier } = await import("../src/plan/estimate.ts");

type PlanTaskT = import("../src/plan/schema.ts").PlanTaskT;
type Req = import("../src/llm/types.ts").ChatRequest;

const open: InstanceType<typeof Workspace>[] = [];
after(() => {
  for (const w of open) w.closeAll();
  rmSync(home, { recursive: true, force: true });
});

// ---------------------------------------------------------------- fixtures
const env = {
  modelFor: (role: string) => (role === "pixel-artist" ? "anthropic/claude-opus-5-5" : "anthropic/claude-sonnet-5-5"),
  fallbackFor: (role: string) => (role === "reviewer" ? "anthropic/claude-opus-5-5" : undefined),
  caps: () => FAKE_CAPS,
  laneSize: () => 3,
  local: () => false,
};
const ctx = (rev = 0) => ({ env, rev }) as any;

function doc(brief: Record<string, unknown> = {}, extra: Record<string, unknown> = {}) {
  return Project.parse({
    pap: 1,
    rev: 0,
    id: "lumen",
    title: "Lumen",
    canvas: { w: 320, h: 180, fps: 30 },
    brief: { idea: "Lumen is a fictional reading app.", lengthSec: 30, narration: "none", ...brief },
    script: { cues: [{ id: "c01", text: "Placeholder: the Writer replaces this." }], timing: { mode: "estimate" } },
    composition: { hold: 1, endHold: 3, duration: "E(c01)+endHold" },
    scenes: [{ id: "s01", title: "x", kind: "decl", from: 0, to: "duration", recipes: [{ id: "backdrop_night" }] }],
    audio: { sfx: {} },
    budget: { capUsd: 3 },
    ...extra,
  });
}
const ids = (ts: PlanTaskT[]) => ts.map((t) => t.id);
const byId = (ts: PlanTaskT[], id: string) => ts.find((t) => t.id === id)!;
const errs = (ts: PlanTaskT[], d: any, o: Record<string, unknown> = {}) =>
  validate(ts, {
    doc: d,
    library: new Set(["mentor-ai", "items"]),
    env,
    by: "rules",
    spentUsd: 0,
    ...o,
  } as any).errors.map((e) => e.rule);

/** an 8-bit RGBA PNG (no real logo: a fictional two-colour badge), rows written with filters none, sub, up, average */
function pngOf(w: number, h: number, px: (x: number, y: number) => [number, number, number, number]) {
  const stride = w * 4;
  const rows = Array.from({ length: h }, (_, y) => {
    const line = Buffer.alloc(stride);
    for (let x = 0; x < w; x++) line.set(px(x, y), x * 4);
    return line;
  });
  const raw = Buffer.alloc(h * (stride + 1));
  rows.forEach((line, y) => {
    const f = y % 4;
    raw[y * (stride + 1)] = f;
    for (let i = 0; i < stride; i++) {
      const left = i >= 4 ? line[i - 4] : 0;
      const up = y ? rows[y - 1][i] : 0;
      const pred = f === 1 ? left : f === 2 ? up : f === 3 ? (left + up) >> 1 : 0;
      raw[y * (stride + 1) + 1 + i] = (line[i] - pred) & 255;
    }
  });
  const chunk = (type: string, data: Buffer) => {
    const b = Buffer.alloc(12 + data.length);
    b.writeUInt32BE(data.length, 0);
    b.write(type, 4, "latin1");
    data.copy(b, 8);
    b.writeUInt32BE(crc32(Buffer.concat([Buffer.from(type, "latin1"), data])), 8 + data.length);
    return b;
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr.set([8, 6, 0, 0, 0], 8);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

// ---------------------------------------------------------------- the rules planner
test("rules plan: a 30 s brief with no voice is today's stage machine, gates inserted, placeholders priced", () => {
  const ts = rules.rulesPlan(doc(), ctx());
  assert.deepEqual(ids(ts), [
    "t_producer",
    "t_g0",
    "t_angles",
    "t_g1",
    "t_storyboard",
    "t_cast",
    "t_g2",
    "t_spec_new",
    "t_draw_new",
    "t_judge_new",
    "t_tune_scenes",
    "t_mix",
    "t_review_r1",
    "t_g3",
    "t_export",
    "t_g4",
    "t_publish_new",
  ]);
  assert.equal(byId(ts, "t_tune_scenes").count, 4, "E[scenes] = round(30 / 8) = 4");
  assert.deepEqual(byId(ts, "t_tune_scenes").dependsOn, ["t_g2", "t_judge_new"]);
  assert.ok(!ts.some((t) => t.kind === "vo.align"));
  assert.equal(byId(ts, "t_publish_new").conditional, true);
  assert.equal(byId(ts, "t_publish_new").estUsd[0], 0, "a conditional task is $0 at p50");
  for (const k of ["t_cast", "t_mix", "t_export", "t_g0"]) assert.deepEqual(byId(ts, k).estUsd, [0, 0], k);
  assert.ok(byId(ts, "t_review_r1").estUsd[0] > 0);
  assert.deepEqual(errs(ts, doc()), []);
});

test("rules plan: narration by the person adds vo.align; 60 s expects 6 scenes; a /new brief skips the Producer", () => {
  const ts = rules.rulesPlan(doc({ narration: "user", lengthSec: 60 }), ctx());
  assert.deepEqual(byId(ts, "t_mix").dependsOn, ["t_tune_scenes", "t_vo"]);
  assert.equal(byId(ts, "t_tune_scenes").count, 6);
  const pip = rules.rulesPlan(doc({ source: "pip" }), ctx());
  assert.ok(!pip.some((t) => t.kind === "producer.plan"));
  assert.equal(byId(pip, "t_g0").status, "done");
  assert.equal(rules.expectedScenes(15), 2);
});

test("rules plan: a logo is imported (never drawn), a likeness is drawn; both are private and wait for the person", () => {
  const d = doc({
    references: [
      { file: "private/refs/badge-logo.png", type: "logo", rights: "mine" },
      { file: "private/refs/Founder.jpg", type: "likeness", rights: "mine", note: "a founder in a green coat" },
      { file: "private/refs/other.jpg", type: "likeness", rights: "unsure" },
    ],
  });
  const ts = rules.rulesPlan(d, ctx());
  assert.deepEqual(byId(ts, "t_import_badge_logo").dependsOn, ["t_g0"]);
  assert.ok(byId(ts, "t_storyboard").dependsOn.includes("t_import_badge_logo"), "the Director sees the logo");
  assert.ok(ts.some((t) => t.id === "t_rights_badge_logo" && t.gate === "rights"));
  assert.equal(byId(ts, "t_spec_founder").fromRef, "private/refs/Founder.jpg");
  assert.deepEqual(byId(ts, "t_rights_founder").dependsOn, ["t_judge_founder"]);
  assert.ok(byId(ts, "t_tune_scenes").dependsOn.includes("t_rights_founder"));
  assert.ok(!ts.some((t) => t.asset === "other"), "unsure rights block the reference");
  assert.ok(!ts.some((t) => t.kind === "lib.publish"), "nothing from a reference is ever published");
  assert.ok(!ts.some((t) => t.id === "t_spec_new"), "the references are the new art");
  assert.deepEqual(errs(ts, d), []);
  // V9: a publish for a reference asset is an error
  const bad = [
    ...ts,
    rules.mkTask({ id: "t_publish_founder", kind: "lib.publish", asset: "founder", dependsOn: [] }, ctx()),
  ];
  assert.ok(errs(bad, d).includes("V9"));
});

test("rev 0: questday (boarded, nothing run) skips the early crew and passes G0-G2; rendered scenes are done", () => {
  const d = Project.parse(JSON.parse(readFileSync(join(EXAMPLE, "pitch.json"), "utf8")));
  const state = {
    tasks: [],
    gates: [],
    sceneStatus: { grind: { version: "render" as const, state: "ready" as const } },
  };
  const ts = rules.startPlan(d, state as any, ctx());
  for (const k of ["t_producer", "t_angles", "t_storyboard", "t_cast"]) assert.equal(byId(ts, k).status, "skipped", k);
  for (const k of ["t_g0", "t_g1", "t_g2"]) assert.equal(byId(ts, k).status, "done", k);
  assert.equal(byId(ts, "t_tune_grind_r1").status, "done");
  assert.equal(byId(ts, "t_tune_quest_r1").status, "pending");
  assert.ok(!ts.some((t) => t.expand), "placeholders already expanded from the document");
  assert.equal(viewStage(ts), "animate");
});

test("expansion: one tune per scene, one chain per new asset; a tune waits only for the art it uses", () => {
  const d = doc(
    {},
    {
      script: {
        cues: [
          { id: "c01", text: "One." },
          { id: "c02", text: "Two." },
        ],
        timing: { mode: "estimate" },
      },
      scenes: [
        { id: "hook", title: "x", kind: "decl", from: 0, to: "S(c02)", cues: ["c01"], recipes: [{ id: "walk_in" }] },
        {
          id: "end",
          title: "y",
          kind: "decl",
          from: "hook.to",
          to: "duration",
          cues: ["c02"],
          recipes: [{ id: "end_card_loop", params: { title: "LUMEN" } }],
        },
      ],
    },
  );
  let ts = rules.rulesPlan(d, ctx());
  for (const t of ts) if (["t_producer", "t_g0", "t_angles", "t_g1", "t_storyboard"].includes(t.id)) t.status = "done";
  const out = rules.expandPlan(ts, d, [{ name: "hero", kind: "character", description: "a small hero with a scarf" }], {
    ...ctx(1),
    assetsOf: (s: string) => (s === "hook" ? ["hero"] : []),
  })!;
  ts = out.tasks;
  assert.match(out.reason, /The storyboard has 2 scenes\. The library had no hero sprite, so I added one drawing\./);
  assert.deepEqual(byId(ts, "t_tune_hook_r1").dependsOn, ["t_g2", "t_judge_hero"]);
  assert.deepEqual(byId(ts, "t_tune_end_r1").dependsOn, ["t_g2"]);
  assert.deepEqual(byId(ts, "t_mix").dependsOn, ["t_tune_hook_r1", "t_tune_end_r1"]);
  assert.equal(byId(ts, "t_tune_scenes").status, "skipped");
  assert.ok(ts.some((t) => t.id === "t_publish_hero" && t.conditional));
  assert.deepEqual(
    out.ops.filter((o) => o.op === "expand").map((o: any) => o.placeholder),
    ["t_spec_new", "t_draw_new", "t_judge_new", "t_publish_new", "t_tune_scenes"],
  );
  assert.deepEqual(errs(ts, d), []);
});

test("redo: the same instance comes back, round + 1, and whatever waited on the scene waits on the redo", () => {
  const d = Project.parse(JSON.parse(readFileSync(join(EXAMPLE, "pitch.json"), "utf8")));
  let ts = rules.startPlan(d, { tasks: [], gates: [], sceneStatus: {} } as any, ctx());
  const r = rules.addRedo(ts, ["grind"], ctx(1), { reason: "the hero is small" });
  ts = r.tasks;
  const redo = byId(ts, r.added[0]);
  assert.equal(redo.id, "t_tune_grind_r2");
  assert.equal(redo.instance, byId(ts, "t_tune_grind_r1").instance);
  assert.equal(redo.instance, "animator:grind");
  assert.ok(byId(ts, "t_mix").dependsOn.includes("t_tune_grind_r2"));
  // a second request mints a fresh id (ids stay unique across revisions)
  const again = rules.addRedo(ts, ["grind"], ctx(2), { reason: "again" });
  assert.equal(again.added[0], "t_tune_grind_r3");
  const third = rules.addRedo(again.tasks, ["grind"], ctx(3), { reason: "once more" });
  assert.equal(byId(third.tasks, third.added[0]).round, 3, "rounds stop at 3");
  assert.notEqual(third.added[0], "t_tune_grind_r3");
  // a review round after the redo: the rough cut waits for it, and the redo never waits on it (no cycle)
  const rv = rules.addReviewRound(r.tasks, "t_review_r1", r.added, ctx(4), "check the fixes");
  assert.ok(byId(rv.tasks, "t_g3").dependsOn.includes(rv.id));
  assert.ok(!byId(rv.tasks, "t_tune_grind_r2").dependsOn.includes(rv.id));
  assert.deepEqual(errs(rv.tasks, d), []);
});

test("a change: reopen from the stage copies finished work, keeps rendered scenes, re-boards in place of the board", () => {
  const d = Project.parse(JSON.parse(readFileSync(join(EXAMPLE, "pitch.json"), "utf8")));
  const ss: any = Object.fromEntries(d.scenes.map((s) => [s.id, { version: "render", state: "ready" }]));
  let ts = rules.startPlan(d, { tasks: [], gates: [], sceneStatus: ss } as any, ctx());
  for (const t of ts) if (t.status === "pending") t.status = "done";
  ss.grind = { version: "animatic", state: "stale" };
  const out = rules.changeRevision(ts, { reboard: ["grind"], scope: ["grind"] }, "storyboard", ctx(1), ss);
  ts = out.tasks;
  const live = ts.filter((t) => t.status === "pending");
  assert.deepEqual(
    live.map((t) => t.kind),
    ["scene.tune", "sound.mix", "review.final", "gate", "deliver.export", "gate", "director.storyboard", "art.cast"],
  );
  assert.deepEqual(live.find((t) => t.kind === "director.storyboard")!.scenes, ["grind"]);
  assert.ok(live.find((t) => t.kind === "scene.tune")!.dependsOn.includes("t_cast_scenes"));
  assert.ok(!live.some((t) => t.kind === "gate" && t.gate === "g2_animatic"), "a re-board passes the animatic itself");
  assert.deepEqual(errs(ts, d), []);
});

// ---------------------------------------------------------------- the validator, one test per rule
test("validator: V1-V14", () => {
  const d = doc();
  const base = () => rules.rulesPlan(d, ctx()).map((t) => ({ ...t }));
  const mut = (f: (ts: PlanTaskT[]) => void) => {
    const ts = base();
    f(ts);
    return ts;
  };
  assert.ok(
    errs(
      mut((ts) => ((ts[0] as any).kind = "writer.poem")),
      d,
    ).includes("V1"),
  );
  assert.ok(errs(base(), d, { by: "pip", ops: [{ op: "add", kind: "review.final" }] }).includes("V1"));
  assert.ok(
    errs(
      mut((ts) => ((byId(ts, "t_angles") as any).role = "reviewer")),
      d,
    ).includes("V2"),
  );
  assert.ok(
    errs(
      mut((ts) => byId(ts, "t_mix").dependsOn.push("t_nope")),
      d,
    ).includes("V3"),
  );
  assert.ok(
    errs(
      mut((ts) => byId(ts, "t_producer").dependsOn.push("t_g4")),
      d,
    ).includes("V3"),
    "a cycle",
  );
  const v4 = mut((ts) => {
    byId(ts, "t_storyboard").status = "done";
    ts.push(rules.mkTask({ id: "t_x", kind: "scene.tune", scene: "nope", dependsOn: [] }, ctx()));
  });
  assert.ok(errs(v4, d).includes("V4"));
  assert.ok(
    errs(
      mut((ts) => (byId(ts, "t_g3").status = "dropped")),
      d,
    ).includes("V5"),
  );
  assert.ok(errs(base(), d, { by: "pip", ops: [{ op: "drop", task: "t_g1" }] }).includes("V5"), "gates aren't Pip's");
  assert.ok(errs(base(), { ...d, budget: { ...d.budget, capUsd: 0.6 } }, { by: "pip" }).includes("V6"));
  assert.ok(!errs(base(), { ...d, budget: { ...d.budget, capUsd: 0.6 } }).includes("V6"), "never for a rules plan");
  assert.ok(
    !errs(base(), { ...d, budget: { ...d.budget, capUsd: 0.6 } }, { by: "pip", before: base(), ops: [] }).includes(
      "V6",
    ),
    "an empty diff on an over-cap rules plan isn't Pip's error",
  );
  const before = base();
  assert.ok(errs(base(), d, { by: "pip", before, ops: [{ op: "drop", task: "t_storyboard" }] }).includes("V7"));
  byId(before, "t_review_r1").status = "running";
  assert.ok(errs(base(), d, { by: "pip", before, ops: [{ op: "drop", task: "t_review_r1" }] }).includes("V8"));
  // V9: see the rights test; V10: a tier without vision for the animator
  const blind = { ...env, caps: (m: string) => (m.includes("haiku") ? { ...FAKE_CAPS, vision: "failed" } : FAKE_CAPS) };
  const ts10 = mut((ts) => (byId(ts, "t_review_r1").tier = "light"));
  assert.ok(
    validate(ts10, { doc: d, library: new Set(), env: blind, by: "pip", spentUsd: 0 } as any).errors.some(
      (e) => e.rule === "V10",
    ),
  );
  assert.ok(
    errs(
      mut((ts) => ts.push(rules.mkTask({ id: "t_y", kind: "scene.tune", dependsOn: [] }, ctx()))),
      d,
    ).includes("V11"),
  );
  assert.ok(
    errs(base(), d, {
      by: "pip",
      ops: Array.from({ length: 9 }, () => ({ op: "drop", task: "t_publish_new" })),
    }).includes("V12"),
  );
  assert.ok(
    errs(
      mut((ts) => ts.push({ ...byId(ts, "t_mix"), id: "t_mix_v2" })),
      d,
    ).includes("V13"),
  );
  assert.ok(errs(base(), d, { redos: new Map([["s01", 3]]) }).includes("V14"));
});

// ---------------------------------------------------------------- tiers
test("tiers resolve in code: light steps down the ladder, strong is a pricier fallback, local is always the role", () => {
  assert.equal(resolveTier("writer", "light", env as any), "anthropic/claude-haiku-5-5");
  assert.equal(resolveTier("pixel-artist", "light", env as any), "anthropic/claude-sonnet-5-5");
  assert.equal(resolveTier("reviewer", "strong", env as any), "anthropic/claude-opus-5-5");
  assert.equal(resolveTier("writer", "strong", env as any), "anthropic/claude-sonnet-5-5");
  assert.equal(resolveTier("writer", "light", { ...env, local: () => true } as any), "anthropic/claude-sonnet-5-5");
  assert.equal(instanceKey({ kind: "asset.draw", asset: "hero" }), "pixel-artist:hero");
  assert.equal(CATALOGUE["review.final"].render, true);
});

// ---------------------------------------------------------------- the executor
function hostFor(tasks: PlanTaskT[], o: { lane?: number; afford?: (t: PlanTaskT) => boolean; ms?: number } = {}) {
  let running = 0;
  let max = 0;
  const order: string[] = [];
  let overruns = 0;
  let resume: (() => void) | null = null;
  const h = {
    tasks: () => tasks,
    held: () => false,
    handle: async (t: PlanTaskT) => {
      running++;
      max = Math.max(max, running);
      order.push(t.id);
      await new Promise((r) => setTimeout(r, o.ms ?? 5));
      running--;
      return { status: "done" as const };
    },
    setStatus: (t: PlanTaskT, s: PlanTaskT["status"]) => {
      tasks.find((x) => x.id === t.id)!.status = s;
    },
    endpoint: (t: PlanTaskT) => (CATALOGUE[t.kind].calls[1] && t.role !== "person" ? "lmstudio" : null),
    laneSize: () => o.lane ?? 1,
    affordable: (t: PlanTaskT) => o.afford?.(t) ?? true,
    overrun: () => {
      overruns++;
      setTimeout(() => {
        o.afford = () => true;
        resume?.();
      }, 20);
    },
    stopped: () => false,
    aborted: () => false,
    waitResume: () =>
      new Promise<void>((r) => {
        resume = r;
      }),
    stageChanged: () => {},
    drain: async () => {},
    fatal: () => true,
  };
  return { h, stats: () => ({ max, order, overruns }) };
}
const fourScenes = () =>
  ["a", "b", "c", "d"].map((s) =>
    rules.mkTask({ id: `t_tune_${s}_r1`, kind: "scene.tune", scene: s, dependsOn: [] }, ctx()),
  );

test("slots: a local endpoint never has 2 running; 3 slots run 3 Animators and the 4th waits as ready", async () => {
  const one = hostFor(fourScenes(), { lane: 1 });
  await new Executor(one.h as any).run();
  assert.equal(one.stats().max, 1);
  const tasks = fourScenes();
  const three = hostFor(tasks, { lane: 3, ms: 30 });
  const ex = new Executor(three.h as any);
  const run = ex.run();
  await new Promise((r) => setTimeout(r, 10));
  assert.deepEqual(ex.slots(), { lmstudio: { size: 3, used: 3 } });
  assert.equal(tasks.filter((t) => t.status === "ready").length, 1, "the 4th is a ghost: ready, waiting for a slot");
  await run;
  assert.equal(three.stats().max, 3);
});

test("overrun: nothing starts while the budget can't cover a task; it asks, and goes on once it can", async () => {
  const tasks = fourScenes();
  const h = hostFor(tasks, { lane: 4, afford: () => false });
  await new Executor(h.h as any).run();
  assert.equal(h.stats().overruns, 1);
  assert.equal(h.stats().order.length, 4);
  assert.ok(tasks.every((t) => t.status === "done"));
});

// ---------------------------------------------------------------- the crew on a fake provider
const setPrices = () => setPriceOverride("fake/model", { inPerMTok: 1, outPerMTok: 5 });
let n = 0;
async function crewOn(dir: string, answer: (req: Req) => any) {
  setPrices();
  const fake = new FakeProvider((req) => answer(req), { id: "fake" });
  const settings = defaultSettings();
  settings.providers.push({ id: "fake", kind: "custom", label: "Fake", baseUrl: "http://fake.invalid", enabled: true });
  for (const r of Object.keys(settings.roles)) settings.roles[r] = { model: "fake/model" };
  const workspace = new Workspace(() => [dir]);
  open.push(workspace);
  const gateway = new ModelGateway({
    ledger: new Ledger(join(home, `ledger-${++n}.sqlite`)),
    secrets: new SecretStore({ env: {}, keychain: false, dir: home }),
    settings,
    providers: [fake],
    caps: { "fake/model": FAKE_CAPS },
  });
  const crew = new Crew({ workspace, registry: buildRegistry(), gateway });
  const id = workspace.list().find((x) => x.dir === dir)!.id;
  return { crew, p: workspace.get(id), workspace, fake };
}

test("a logo reference: imported as a private 16x16 icon, never drawn, never offered to the library", async () => {
  const badge = pngOf(64, 48, (x, y) =>
    x > 8 && x < 56 && y > 8 && y < 40 ? (x < 32 ? [240, 200, 60, 255] : [40, 60, 140, 255]) : [0, 0, 0, 0],
  );
  const img = decodePng(badge);
  assert.deepEqual([img.w, img.h, img.data[4 * (20 * 64 + 20) + 3]], [64, 48, 255]);
  assert.equal(img.data[4 * (20 * 64 + 20)], 240);
  assert.equal(img.data[3], 0);
  const dir = join(root, `logo_${++n}`);
  cpSync(EXAMPLE, dir, { recursive: true, filter: (f) => !f.endsWith(".pap-lock") });
  mkdirSync(join(dir, "private", "refs"), { recursive: true });
  writeFileSync(join(dir, "private", "refs", "badge-logo.png"), badge);
  const { crew, p } = await crewOn(dir, () => ({ error: new Error("no model call expected") }));
  await p.patch(
    [
      {
        op: "replace",
        path: "/brief/references",
        value: [{ file: "private/refs/badge-logo.png", type: "logo", rights: "mine", note: "" }],
      },
    ],
    {
      reason: "test",
      author: { kind: "user" },
    },
  );
  const pt = rules.mkTask(
    {
      id: "t_import_badge_logo",
      kind: "asset.import",
      asset: "badge-logo",
      fromRef: "private/refs/badge-logo.png",
      dependsOn: [],
    },
    ctx(),
  );
  const out = await (crew as any).importLogo(p, pt);
  assert.equal(out.status, "done");
  const ref = p.doc().assets.find((a: any) => a.id === "badge-logo")!;
  assert.equal(ref.flags.private, true);
  assert.ok(ref.flags.brand);
  const file = JSON.parse(readFileSync(join(dir, "assets", "badge-logo.json"), "utf8"));
  assert.deepEqual(file.rights, { likeness: false, brand: true, trademark: true, public: false });
  assert.equal(file.grid.icon.length, 16);
  assert.ok(file.grid.icon.every((r: string) => r.length === 16));
  assert.ok(file.grid.icon.join("").replace(/\./g, "").length > 40, "the badge shows");
  assert.equal(logoIcon(badge, { a: "#f0c83c", b: "#283c8c" }).rows.length, 16);
  // the publish handler's own check: a brand asset never leaves the project
  const pub = rules.mkTask(
    { id: "t_publish_badge_logo", kind: "lib.publish", asset: "badge-logo", dependsOn: [] },
    ctx(),
  );
  assert.equal((await (crew as any).publish(p, {}, pub)).status, "skipped");
  assert.ok(!existsSync(join(new URL("../../../library/", import.meta.url).pathname, "badge-logo")));
});

test("resume: after a kill the plan picks up from runs/plan.json; done work isn't redone, running work runs again", async () => {
  const dir = join(root, `resume_${++n}`);
  cpSync(EXAMPLE, dir, { recursive: true, filter: (f) => !f.endsWith(".pap-lock") });
  let tunes = 0;
  let hang = true;
  const answer = (req: Req) => {
    const sys = req.system ?? "";
    if (/Animator of one scene/.test(sys)) {
      tunes++;
      return hang && tunes === 2 ? { json: { changes: [] }, delayMs: 60_000 } : { json: { changes: [] } };
    }
    if (/festival judge/.test(sys)) return { json: { verdict: "ship", summary: "ok", blockers: [], polish: [] } };
    return { error: new Error(`unexpected: ${sys.slice(0, 40)}`) };
  };
  const a = await crewOn(dir, answer);
  await a.p.patch(
    [
      { op: "replace", path: "/brief/involvement", value: "auto" },
      { op: "replace", path: "/budget/capUsd", value: 5 },
    ],
    { reason: "t", author: { kind: "user" } },
  );
  // a concurrency of 1 makes the order fixed: one tune done, the second hanging when the process "dies"
  (a.crew as any).deps.gateway.laneSize = () => 1;
  const run = a.crew.run(a.p, {}).catch(() => {});
  for (let i = 0; i < 500 && tunes < 2; i++) await new Promise((r) => setTimeout(r, 10));
  assert.equal(tunes, 2);
  const plan = JSON.parse(readFileSync(join(dir, "runs", "plan.json"), "utf8"));
  const st = (id: string) => plan.tasks.find((t: any) => t.id === id)?.status;
  assert.equal(plan.tasks.filter((t: any) => t.kind === "scene.tune" && t.status === "done").length, 1);
  assert.equal(plan.tasks.filter((t: any) => t.kind === "scene.tune" && t.status === "running").length, 1);
  assert.equal(st("t_mix"), "pending");
  // the kill: a new process opens the same folder (the crew left `running` set)
  a.crew.pause(a.p, "now");
  await run;
  a.p.state.running = true;
  a.p.state.paused = false;
  a.p.saveState();
  for (const w of open.splice(-1)) w.closeAll();
  hang = false;
  const before = tunes;
  const b = await crewOn(dir, answer);
  (b.crew as any).deps.gateway.laneSize = () => 1;
  writeFileSync(join(dir, "runs", "plan.json"), JSON.stringify(plan));
  const resumed = b.crew.resumeInterrupted();
  assert.deepEqual(resumed, [b.p.id]);
  for (let i = 0; i < 3000 && b.p.state.running; i++) await new Promise((r) => setTimeout(r, 20));
  assert.equal(tunes - before, 3, "the running tune and the two never started; the done one stays done");
  const after = JSON.parse(readFileSync(join(dir, "runs", "plan.json"), "utf8"));
  assert.ok(after.tasks.filter((t: any) => !t.expand).every((t: any) => ["done", "skipped"].includes(t.status)));
  assert.match(b.p.state.status.line ?? "", /^Exported v[0-9]+$/);
  assert.equal(after.runs.length, 1, "a resume continues the same plan run list");
});
