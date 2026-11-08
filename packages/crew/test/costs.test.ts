// Cost and speed controls (docs/PIP-ORCHESTRATION.md §1.6, §1.10): the effort ceiling (and the ledger's sent effort),
// the settings deep merge, drawings per new asset (one: no judge, the draw is cast), "Finish within $X" at the 80%
// guard (the trim order, the card, `auto` trimming by itself), the cap suggestion counting only real remaining work,
// the creature kind's templates, and a critique that never shows the artist the system's fields. Over FakeProvider,
// the fictional QuestDay example and temp folders only.
import assert from "node:assert/strict";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { z } from "zod";

const home = mkdtempSync(join(tmpdir(), "pap-costs-"));
process.env.PAP_HOME = home;
const root = join(home, "projects");
mkdirSync(root, { recursive: true });
const EXAMPLE = new URL("../../../examples/questday/", import.meta.url).pathname;

const { Project } = await import("@pap/schema");
const { buildRegistry, Workspace } = await import("@pap/tools");
const { checkAsset } = await import("@pap/engine/standard");
const { ModelGateway } = await import("../src/gateway-impl.ts");
const {
  FakeProvider,
  FAKE_CAPS,
  Ledger,
  SecretStore,
  clampEffort,
  defaultSettings,
  loadSettings,
  mergeSettings,
  saveSettings,
  setPriceOverride,
} = await import("../src/llm/index.ts");
const rules = await import("../src/plan/rules.ts");
const { estimatePlanTask, planEstimate } = await import("../src/plan/estimate.ts");
const { applyDiff } = await import("../src/plan/pip.ts");
const { KIND_TEMPLATES, StoryboardOut, artistIssues, templateFor } = await import("../src/outputs.ts");
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
const ctx = (rev = 0, variants?: number) => ({ env, rev, ...(variants ? { variants } : {}) }) as any;
const mk = (id: string, kind: string, deps: string[] = [], extra: Record<string, unknown> = {}) =>
  rules.mkTask({ id, kind, dependsOn: deps, ...extra } as any, ctx());
const exampleDoc = () => Project.parse(JSON.parse(readFileSync(join(EXAMPLE, "pitch.json"), "utf8")));
type NewAsset = import("../src/plan/rules.ts").NewAsset;
const moth: NewAsset = { name: "moth", kind: "creature", description: "A small pale moth that drifts to the light." };

// ---------------------------------------------------------------- 1. effort ceiling
test("clampEffort: a card keeps its own effort up to the ceiling, never above it; none stays none", () => {
  for (const [card, ceiling, sent] of [
    ["high", "low", "low"],
    ["medium", "low", "low"],
    ["low", "low", "low"],
    ["high", "medium", "medium"],
    ["xhigh", "medium", "medium"],
    ["medium", "medium", "medium"],
    ["low", "medium", "low"],
    ["high", "high", "high"],
    ["xhigh", "high", "high"],
    ["medium", "high", "medium"],
  ] as const)
    assert.equal(clampEffort(card, ceiling), sent, `${card} under ${ceiling}`);
  assert.equal(clampEffort(undefined, "high"), undefined);
  assert.equal(clampEffort("high"), "medium", "the default ceiling is medium");
  assert.equal(defaultSettings().defaults.effortCeiling, "medium");
});

test("the gateway sends the clamped effort to Anthropic, low to any other provider, and the ledger records it", async () => {
  const anthropic = new FakeProvider(() => ({ json: { ok: true } }), { id: "anthropic" });
  const other = new FakeProvider(() => ({ json: { ok: true } }), { id: "fake" });
  setPriceOverride("fake/model", { inPerMTok: 1, outPerMTok: 5 });
  const mkGw = (ceiling: "low" | "medium" | "high", n: number) => {
    const s = defaultSettings();
    s.providers.push({ id: "fake", kind: "custom", label: "Fake", baseUrl: "http://fake.invalid", enabled: true });
    s.defaults.effortCeiling = ceiling;
    return new ModelGateway({
      ledger: new Ledger(join(home, `effort-${n}.sqlite`)),
      secrets: new SecretStore({ env: {}, keychain: false, dir: home }),
      settings: s,
      providers: [anthropic, other],
      caps: { "anthropic/claude-opus-5-5": FAKE_CAPS, "fake/model": FAKE_CAPS },
    });
  };
  const call = (gw: InstanceType<typeof ModelGateway>, model: string, effort: "low" | "medium" | "high" | "xhigh") =>
    gw.json({
      project: "effort",
      capUsd: 5,
      task: "t1",
      taskKind: "asset.draw",
      role: "pixel-artist",
      promptVersion: "pixel-artist/draw@2",
      system: "s",
      messages: [{ role: "user", content: "draw" }],
      schema: z.object({ ok: z.boolean() }),
      jsonSchema: { type: "object" },
      maxOut: 1000,
      effort,
      model,
      noFallback: true,
    });
  let n = 0;
  for (const [ceiling, sent] of [
    ["low", "low"],
    ["medium", "medium"],
    ["high", "high"],
  ] as const) {
    const gw = mkGw(ceiling, ++n);
    await call(gw, "anthropic/claude-opus-5-5", "high");
    assert.equal(anthropic.calls.at(-1)!.effort, sent, `a high card under a ${ceiling} ceiling sends ${sent}`);
    assert.equal(gw.ledger.query({ project: "effort" })[0].effort, sent, "the ledger has the effort that was sent");
    await call(gw, "fake/model", "high");
    assert.equal(other.calls.at(-1)!.effort, "low", "a non-Anthropic provider is still forced low");
    assert.equal(gw.ledger.query({ project: "effort" })[0].effort, "low");
  }
  // a card below the ceiling keeps its own
  const gw = mkGw("high", ++n);
  await call(gw, "anthropic/claude-opus-5-5", "medium");
  assert.equal(anthropic.calls.at(-1)!.effort, "medium");
});

test("the Pixel Artist's draw and critique cards ask for medium effort", () => {
  for (const f of ["draw", "critique"]) {
    const src = readFileSync(new URL(`../prompts/pixel-artist/${f}.md`, import.meta.url), "utf8");
    assert.match(src, /^effort: medium$/m, f);
  }
});

// ---------------------------------------------------------------- 2. settings deep merge
test("mergeSettings: saving four defaults keeps pipPlan, reviewRounds, the effort ceiling and variants", () => {
  const cur = defaultSettings();
  cur.defaults.pipPlan = "on";
  cur.defaults.reviewRounds = 1;
  cur.defaults.effortCeiling = "high";
  cur.defaults.variants = 3;
  cur.paths.ffmpeg = "/opt/ffmpeg";
  const next = mergeSettings(cur, {
    defaults: { capUsd: 9, askAtFraction: 0.7, involvement: "auto", concurrency: 2 } as any,
    paths: { library: "/tmp/lib" } as any,
  });
  assert.equal(next.defaults.capUsd, 9);
  assert.equal(next.defaults.pipPlan, "on");
  assert.equal(next.defaults.reviewRounds, 1);
  assert.equal(next.defaults.effortCeiling, "high");
  assert.equal(next.defaults.variants, 3);
  assert.equal(next.paths.ffmpeg, "/opt/ffmpeg", "paths merge too");
  assert.equal(next.paths.library, "/tmp/lib");
  // records are replaced whole, so an entry can still be removed
  const priced = mergeSettings(
    { ...cur, prices: { a: { inPerMTok: 1, outPerMTok: 1 } } as Record<string, any> },
    { prices: {} },
  );
  assert.deepEqual(priced.prices, {});
});

test("PUT /api/settings with the Defaults form's four fields keeps pipPlan and reviewRounds on disk", async () => {
  const s = defaultSettings();
  s.defaults.pipPlan = "on";
  s.defaults.reviewRounds = 1;
  saveSettings(s);
  const gateway = new ModelGateway({
    ledger: new Ledger(join(home, "settings.sqlite")),
    secrets: new SecretStore({ env: {}, keychain: false, dir: home }),
    settings: loadSettings(),
    providers: [new FakeProvider(() => ({ error: new Error("no call") }), { id: "fake" })],
  });
  const workspace = new Workspace(() => [root]);
  open.push(workspace);
  const { hooks } = await wireCrew({ workspace, registry: buildRegistry(), gateway, resume: false });
  await (hooks as any).settings.put({
    defaults: { capUsd: 7, askAtFraction: 0.8, involvement: "key", concurrency: 3 },
  });
  const after = loadSettings();
  assert.equal(after.defaults.capUsd, 7);
  assert.equal(after.defaults.pipPlan, "on");
  assert.equal(after.defaults.reviewRounds, 1);
  assert.equal(after.defaults.effortCeiling, "medium");
});

// ---------------------------------------------------------------- 3. variants per asset
const boarded = (variants?: number, assets: NewAsset[] = [moth]) =>
  rules.rulesPlan(exampleDoc(), ctx(0, variants), { scenes: ["hook", "grind"], newAssets: assets });

test("variants=1: one drawing, no judge; the scenes and the rights OK wait on the drawing itself", () => {
  const ts = boarded(1, [moth, { ...moth, name: "owl", fromRef: "refs/owl.png", rights: "likeness" }]);
  const draws = ts.filter((t) => t.kind === "asset.draw" && t.asset === "moth");
  assert.deepEqual(
    draws.map((t) => t.id),
    ["t_draw_moth_v1"],
  );
  assert.equal(draws[0].variants, 1, "the draw knows it is the pick");
  assert.ok(!ts.some((t) => t.kind === "asset.judge"), "no judge task");
  for (const t of ts.filter((x) => x.kind === "scene.tune"))
    assert.ok(t.dependsOn.includes("t_draw_moth_v1"), `${t.id} waits on the drawing`);
  assert.deepEqual(ts.find((t) => t.id === "t_rights_owl")!.dependsOn, ["t_draw_owl_v1"]);
  // before the storyboard: the placeholder draws one per new asset, and the tunes wait on it
  const pre = rules.rulesPlan(exampleDoc(), ctx(0, 1));
  assert.equal(pre.find((t) => t.id === "t_draw_new")!.count, 1);
  assert.ok(!pre.some((t) => t.id === "t_judge_new"));
  assert.ok(pre.find((t) => t.id === "t_tune_scenes")!.dependsOn.includes("t_draw_new"));
});

test("variants=3: three drawings and a judge over all three; absent means two", () => {
  const ts = boarded(3);
  assert.deepEqual(
    ts.filter((t) => t.kind === "asset.draw").map((t) => t.variant),
    [1, 2, 3],
  );
  assert.deepEqual(ts.find((t) => t.id === "t_judge_moth")!.dependsOn, [
    "t_draw_moth_v1",
    "t_draw_moth_v2",
    "t_draw_moth_v3",
  ]);
  assert.equal(rules.rulesPlan(exampleDoc(), ctx(0, 3)).find((t) => t.id === "t_draw_new")!.count, 3);
  const two = boarded();
  assert.equal(two.filter((t) => t.kind === "asset.draw").length, 2);
  assert.ok(two.some((t) => t.id === "t_judge_moth"));
  assert.ok(!two.some((t) => "variants" in t), "a default chain carries no variants field (old plans unchanged)");
});

test("a per-asset count wins over the project's, and Pip's add op takes its own count too", () => {
  const ts = boarded(3, [
    { ...moth, variants: 1 },
    { ...moth, name: "owl" },
  ]);
  assert.equal(ts.filter((t) => t.kind === "asset.draw" && t.asset === "moth").length, 1);
  assert.equal(ts.filter((t) => t.kind === "asset.draw" && t.asset === "owl").length, 3);
  assert.equal(rules.variantsOf({ variants: 1 }, { variants: 3 }), 1);
  assert.equal(rules.variantsOf(undefined, { variants: 3 }), 3);
  assert.equal(rules.variantsOf(undefined, {}), 2);
  const base = rules.rulesPlan(exampleDoc(), ctx(0, 2), { scenes: ["hook"], newAssets: [] });
  const out = applyDiff(
    base,
    {
      ops: [
        {
          op: "add",
          kind: "asset.spec",
          asset: "lamp",
          assetKind: "prop",
          description: "A paper lantern on a string, glowing.",
          variants: 1,
          after: [],
          reason: "a lantern for the rooftop",
        },
      ],
      summary: "",
    },
    { ...ctx(1, 2), refs: [] },
  );
  assert.deepEqual(
    out.tasks.filter((t) => t.asset === "lamp").map((t) => t.kind),
    ["asset.spec", "asset.draw"],
    "one drawing, no judge",
  );
});

test("the estimate drops with one drawing per new asset (the brief card's rules plan)", () => {
  const one = planEstimate(rules.rulesPlan(exampleDoc(), ctx(0, 1)), 0, env as any);
  const two = planEstimate(rules.rulesPlan(exampleDoc(), ctx(0, 2)), 0, env as any);
  const three = planEstimate(rules.rulesPlan(exampleDoc(), ctx(0, 3)), 0, env as any);
  assert.ok(one.usd[0] < two.usd[0] && two.usd[0] < three.usd[0], `${one.usd} < ${two.usd} < ${three.usd}`);
  assert.ok(one.usd[1] < two.usd[1]);
});

// ---------------------------------------------------------------- a crew over FakeProvider
let n = 0;
async function crewOn(o: { involvement?: "every" | "key" | "auto"; variants?: number } = {}) {
  const dir = join(root, `q_${++n}`);
  cpSync(EXAMPLE, dir, { recursive: true, filter: (f) => !f.endsWith(".pap-lock") });
  setPriceOverride("fake/model", { inPerMTok: 1, outPerMTok: 5 });
  const settings = defaultSettings();
  settings.providers.push({ id: "fake", kind: "custom", label: "Fake", baseUrl: "http://fake.invalid", enabled: true });
  for (const r of Object.keys(settings.roles)) settings.roles[r] = { model: "fake/model" };
  if (o.variants) settings.defaults.variants = o.variants;
  const gateway = new ModelGateway({
    ledger: new Ledger(join(home, `ledger-${n}.sqlite`)),
    secrets: new SecretStore({ env: {}, keychain: false, dir: home }),
    settings,
    providers: [new FakeProvider((_req: Req) => ({ error: new Error("unexpected call") }), { id: "fake" })],
    caps: { "fake/model": FAKE_CAPS },
  });
  const workspace = new Workspace(() => [dir]);
  open.push(workspace);
  const wired = await wireCrew({ workspace, registry: buildRegistry(), gateway, resume: false });
  const p = workspace.get(workspace.list().find((x) => x.dir === dir)!.id);
  await p.patch(
    [
      { op: "replace", path: "/budget/capUsd", value: 5 },
      { op: "replace", path: "/brief/involvement", value: o.involvement ?? "key" },
    ],
    { reason: "t", author: { kind: "user" } },
  );
  return { ...wired, c: wired.crewImpl as any, p, gateway };
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

test("variants=1 on the crew: the project's count reaches the plan, and the single drawing is cast", async () => {
  const { c, p } = await crewOn({ variants: 1 });
  assert.equal(c.variants(p), 1, "Settings' default reaches the crew");
  await p.patch([{ op: "add", path: "/crew/variants", value: 3 }], { reason: "t", author: { kind: "user" } });
  assert.equal(c.variants(p), 3, "the project's own count wins");
  await p.patch([{ op: "replace", path: "/crew/variants", value: 1 }], { reason: "t", author: { kind: "user" } });
  const spec = {
    letters: "kS",
    description: "A small pale moth with soft wings, light from the upper left.",
    reads: "a moth",
  };
  writeFileSync(
    c.artFile(p, "moth", "spec"),
    JSON.stringify({ ...moth, size: "16x16", motion: "fly", spec, letters: "kS", row: "x" }),
  );
  const tpl = templateFor("creature", { size: "16x16", motion: "fly" });
  let seen: any = null;
  c.drawVariant = async (
    _p: any,
    _r: any,
    a: { name: string },
    t: any,
    _s: any,
    _l: any,
    _tb: any,
    _pl: any,
    v: number,
  ) => {
    seen = t;
    writeFileSync(join(p.dir, "runs", `${a.name}-v${v}.png`), Buffer.from("png"));
    const rows = Array.from({ length: 16 }, () => "kkkkkkkkkkkkkkkk");
    return {
      frames: { notes: "ship", frames: tpl.frames.map((name) => ({ name, rows })) },
      std: { ok: true },
      model: "fake/model",
    };
  };
  const [draw] = rules
    .rulesPlan(p.doc(), c.rulesCtx(p, 0), { scenes: ["hook"], newAssets: [moth] })
    .filter((t) => t.kind === "asset.draw");
  const out = await c.assetDraw(p, fakeRun(), { ...draw, status: "running" });
  assert.equal(out.status, "done");
  assert.deepEqual(seen.frames, tpl.frames, "the draw uses the creature's template");
  const ref = p.doc().assets.find((a) => a.id === "moth");
  assert.ok(ref && ref.src === "file:assets/moth.json" && !ref.standIn, "the drawing is cast as itself");
  const file = JSON.parse(readFileSync(join(p.dir, "assets", "moth.json"), "utf8"));
  assert.equal(file.kind, "creature");
  assert.deepEqual([file.w, file.h], [16, 16]);
  assert.deepEqual(file.frames, ["idle0", "idle1", "move0", "move1", "move2", "move3", "perch0", "perch1"]);
});

test("variants=1: a failed single drawing casts the library stand-in, as the judge would", async () => {
  const { c, p } = await crewOn({ variants: 1 });
  const spec = { letters: "kS", description: "A small glowing paper lantern hung on a string.", reads: "a lantern" };
  writeFileSync(
    c.artFile(p, "lamp", "spec"),
    JSON.stringify({ name: "lamp", kind: "prop", description: spec.description, spec, letters: "kS", row: "x" }),
  );
  c.drawVariant = async () => {
    throw new Error("variant 1 fails the standard: orphan pixels");
  };
  const t = mk("t_draw_lamp_v1", "asset.draw", [], { asset: "lamp", variant: 1, variants: 1 });
  const out = await c.assetDraw(p, fakeRun(), { ...t, status: "running" });
  assert.equal(out.outcome, "fallback");
  assert.ok(p.doc().assets.find((a) => a.id === "lamp")?.standIn);
});

// ---------------------------------------------------------------- 4. finish within the budget
const finishTasks = () =>
  [
    { ...mk("t_draw_moth_v1", "asset.draw", [], { asset: "moth", variant: 1 }), estUsd: [0.3, 0.5] },
    { ...mk("t_draw_moth_v2", "asset.draw", [], { asset: "moth", variant: 2 }), estUsd: [0.3, 0.5] },
    {
      ...mk("t_judge_moth", "asset.judge", ["t_draw_moth_v1", "t_draw_moth_v2"], { asset: "moth" }),
      estUsd: [0.05, 0.1],
    },
    { ...mk("t_review_r1", "review.final", ["t_judge_moth"], { round: 1 }), estUsd: [0.2, 0.3] },
    { ...mk("t_publish_moth", "lib.publish", ["t_review_r1"], { asset: "moth", conditional: true }) },
  ] as PlanTaskT[];

test("finishWithin trims in the fixed order and stops as soon as the rest fits", () => {
  const ts = finishTasks();
  assert.ok(rules.restP90(ts) > 0.9);
  // $0.90 left: dropping the second drawing is enough (the judge then makes no call)
  const a = rules.finishWithin(ts, { leftUsd: 0.9, ctx: ctx(1) });
  assert.ok(a.fits);
  assert.deepEqual(
    a.trims.map((x) => x.what),
    ["variant"],
  );
  assert.equal(a.tasks.find((t) => t.id === "t_draw_moth_v2")!.status, "dropped");
  assert.deepEqual(a.tasks.find((t) => t.id === "t_judge_moth")!.estUsd, [0, 0]);
  assert.equal(a.tasks.find((t) => t.id === "t_draw_moth_v1")!.critiques, undefined, "nothing past what fits");
  // $0.10 left: everything droppable goes, in order, and it still doesn't fit
  const b = rules.finishWithin(ts, { leftUsd: 0.1, ctx: ctx(1) });
  assert.deepEqual(
    b.trims.map((x) => x.what),
    ["variant", "critique", "review_round", "publish"],
  );
  assert.ok(!b.fits);
  assert.equal(b.tasks.find((t) => t.id === "t_draw_moth_v1")!.critiques, 0);
  const v1 = b.tasks.find((t) => t.id === "t_draw_moth_v1")!;
  const full = estimatePlanTask({ ...v1, critiques: undefined }, env as any);
  assert.ok(v1.estUsd[1] < full.usd[1] && v1.estUsd[0] < full.usd[0], "the critique's cost is gone");
  assert.equal(b.tasks.find((t) => t.id === "t_review_r1")!.lastRound, true);
  assert.equal(b.tasks.find((t) => t.id === "t_publish_moth")!.status, "dropped");
  assert.deepEqual(
    b.ops.map((o) => o.op),
    ["drop", "trim", "trim", "drop"],
  );
  assert.deepEqual(
    b.trims.map((x) => rules.trimWords(x, ts)),
    [
      "the second drawing of moth",
      "the critique round on moth (drawing 1)",
      "the second review round",
      "the library question for moth",
    ],
  );
  // it fits already: nothing goes; one review round in Settings: there is no second round to take
  assert.equal(rules.finishWithin(ts, { leftUsd: 5, ctx: ctx(1) }).trims.length, 0);
  const one = rules.finishWithin(ts, { leftUsd: 0.1, ctx: ctx(1), reviewRounds: 1 });
  assert.ok(!one.trims.some((x) => x.what === "review_round"));
  // a rerun copy starts fresh: the trims stay with the run that made them
  const copy = rules.rerun(b.tasks, ["t_draw_moth_v1"], 2, { reason: "x" }).tasks.at(-1)!;
  assert.equal(copy.critiques, undefined);
});

test("suggestUsd counts only real remaining work: art already in the project and answered publishes are free", () => {
  const ts = finishTasks();
  const all = rules.suggestCap(1, rules.realRemaining(ts));
  const drawn = (t: PlanTaskT) => t.asset === "moth" && t.kind !== "review.final";
  const real = rules.suggestCap(1, rules.realRemaining(ts, drawn));
  assert.ok(real < all, `${real} < ${all}`);
  assert.equal(real, Math.ceil((1 + 0.3) * 2) / 2, "only the review is left");
});

/** a crew plan the overrun can trim, and $4.10 of a $5 cap spent (past the 80% line) */
async function nearTheCap(involvement: "key" | "auto") {
  const w = await crewOn({ involvement });
  const plan = w.c.ensurePlan(w.p, null);
  plan.tasks = finishTasks();
  w.gateway.ledger.insert({
    project: w.p.id,
    task: "t_old",
    taskKind: "asset.draw",
    role: "pixel-artist",
    attempt: 0,
    provider: "fake",
    model: "fake/model",
    promptVersion: "x",
    usage: { inputTokens: 1, outputTokens: 1 },
    usd: 4.1,
    usdSource: "table",
    ttftMs: 1,
    durationMs: 1,
    stop: "end",
    estUsd: null,
  });
  const r = fakeRun();
  w.c.runs.set(w.p.id, r);
  return {
    ...w,
    r,
    items: () =>
      (w.pip as any)
        .log(w.p)
        .all()
        .filter((it: any) => it.kind === "pip"),
  };
}

test("the 80% card leads with Finish within $5, lists exactly what goes, and offers the raise second", async () => {
  const w = await nearTheCap("key");
  const t = w.c.planNow(w.p).tasks[0];
  assert.equal(w.c.affordable(w.p, w.r, t), false, "past the ask-at line");
  w.c.overrun(w.p, w.r, t);
  const item = w.items().at(-1);
  assert.equal(item.cards.length, 2);
  const [finish, raise] = item.cards;
  assert.equal(finish.title, "Finish within $5");
  assert.deepEqual(finish.effects, ["Leaves out the second drawing of moth.", "Everything else is made as planned."]);
  assert.match(raise.title, /^Raise the cap to \$/);
  assert.match(
    w.p.state.status.line,
    /^Waiting for you: 80% of the \$5 cap is spent\. Finish within it, or raise it to \$[\d.]+\.$/,
  );
  assert.doesNotMatch(w.p.state.status.line, /\?/, "a statement: the web ends it once, never '?.'");
  assert.equal(w.p.channel().at(-1)?.text, "Paused the crew: 80% of the $5 cap is spent.");
  assert.equal(w.p.state.status.waiting, "budget");
  assert.deepEqual(
    w.c
      .planNow(w.p)
      .tasks.map((x: PlanTaskT) => x.status)
      .filter((s: string) => s === "dropped"),
    [],
  );
  // "Needs you" counts the question once
  assert.deepEqual((w.pip as any).crewCards(w.p, { budget: true }), ["budget"]);
  // Pip's turns spend a little more while the card waits: the confirm still applies exactly what the card listed
  w.gateway.ledger.insert({ ...(w.gateway.ledger.query({ project: w.p.id })[0] as any), task: "t_pip", usd: 0.3 });
  // the person picks Finish within: a code revision with trigger budget, the raise card settles, the crew goes on
  w.pip!.decide(w.p.id, finish.id, "confirm");
  const plan = w.c.planNow(w.p);
  assert.equal(plan.by, "code");
  assert.equal(plan.trigger, "budget");
  assert.equal(plan.tasks.find((x: PlanTaskT) => x.id === "t_draw_moth_v2").status, "dropped");
  assert.deepEqual(
    plan.ops.map((o: any) => o.task),
    ["t_draw_moth_v2"],
    "nothing beyond the card's list",
  );
  assert.equal(plan.tasks.find((x: PlanTaskT) => x.id === "t_draw_moth_v1").critiques, undefined);
  const after = w.items().find((it: any) => it.id === item.id);
  assert.equal(after.cards[1].status, "declined", "the raise card is settled");
  assert.equal(w.c.affordable(w.p, w.r, t), true, "the overrun is answered for this cap");
  assert.equal(w.p.state.status.waiting, undefined);
});

test("at auto involvement the crew trims by itself and says so; no card", async () => {
  const w = await nearTheCap("auto");
  const t = w.c.planNow(w.p).tasks[0];
  const before = w.items().length;
  w.c.overrun(w.p, w.r, t);
  const plan = w.c.planNow(w.p);
  assert.equal(plan.trigger, "budget");
  assert.equal(plan.tasks.find((x: PlanTaskT) => x.id === "t_draw_moth_v2").status, "dropped");
  const fresh = w.items().slice(before);
  assert.equal(fresh.length, 1);
  assert.equal(fresh[0].cards.length, 0, "no card at auto");
  assert.match(fresh[0].text, /^Assumption: you'd rather finish within \$5 .*the second drawing of moth/);
  assert.ok(w.p.channel().some((m: any) => m.from === "pip" && /left out the second drawing of moth/.test(m.text)));
  assert.equal(w.c.affordable(w.p, w.r, t), true);
});

test("the crew's suggestion ignores work the project already satisfies", async () => {
  const w = await nearTheCap("key");
  const all = w.c.suggestUsd(w.p);
  // the moth is drawn already: its chain and its publish question would be skipped at run time
  mkdirSync(join(w.p.dir, "assets"), { recursive: true });
  writeFileSync(join(w.p.dir, "assets", "moth.json"), "{}");
  await w.p.patch([{ op: "add", path: "/assets/-", value: { id: "moth", src: "file:assets/moth.json" } }], {
    reason: "t",
    author: { kind: "user" },
  });
  const real = w.c.suggestUsd(w.p);
  assert.ok(real < all, `${real} < ${all}`);
  assert.equal(real, Math.ceil((4.1 + 0.3) * 2) / 2);
});

// ---------------------------------------------------------------- 5. the creature kind
test("creature templates: fly, sit and walk give the engine's frame names at the asked size; character unchanged", () => {
  const fly = templateFor("creature", { size: "16x16", motion: "fly" });
  assert.deepEqual([fly.w, fly.h], [16, 16]);
  assert.deepEqual(fly.frames, ["idle0", "idle1", "move0", "move1", "move2", "move3", "perch0", "perch1"]);
  const sit = templateFor("creature", { size: "16x24", motion: "sit" });
  assert.deepEqual([sit.w, sit.h], [16, 24]);
  assert.deepEqual(sit.frames, ["idle0", "idle1", "perch0", "perch1"]);
  const walk = templateFor("creature", { motion: "walk" });
  assert.deepEqual([walk.w, walk.h], [16, 16], "a creature is 16x16 unless the brief says 16x24");
  assert.deepEqual(walk.frames, ["idle0", "idle1", "move0", "move1", "move2", "move3"]);
  assert.match(fly.note, /never a chibi biped/);
  const hero = templateFor("character", { size: "16x16", motion: "fly" });
  assert.deepEqual([hero.w, hero.h], [16, 24]);
  assert.deepEqual(hero.frames, ["idle0", "idle1", "run0", "run1", "run2", "run3", "jump", "wave"]);
  assert.equal(hero, KIND_TEMPLATES.character);
  // the Director can ask for one
  const b = StoryboardOut.parse({
    scenes: [{ id: "s1", title: "x", cues: ["c01"], recipes: [{ id: "backdrop_night", params: {} }] }],
    newAssets: [{ ...moth, size: "16x16", motion: "fly" }],
  });
  assert.equal(b.newAssets[0].motion, "fly");
  // and the plan carries it to the spec, the draws and the estimate
  const ts = boarded(2, [{ ...moth, size: "16x24", motion: "sit" }]);
  const d = ts.find((t) => t.id === "t_draw_moth_v1")!;
  assert.deepEqual([d.assetKind, d.assetSize, d.motion], ["creature", "16x24", "sit"]);
});

test("the PAP standard takes a 16x16 creature with its own frames, and checks its loops", () => {
  const tpl = templateFor("creature", { motion: "fly" });
  const body = [
    "................",
    "................",
    "................",
    "................",
    ".....SSSSSS.....",
    "....SSSSSSSS....",
    "...SSSSSSSSSS...",
    "...SSSSSSSSSS...",
    "...SSSSSSSSSS...",
    "...SSSSSSSSSS...",
    "....SSSSSSSS....",
    ".....SSSSSS.....",
    "................",
    "................",
    "................",
    "................",
  ];
  const file = {
    id: "moth",
    kind: "creature",
    w: 16,
    h: 16,
    frames: tpl.frames,
    palette: "pap-night@1",
    licence: "LicenseRef-PAP-Library",
    rights: { likeness: false, brand: false, trademark: false, public: true },
    provenance: { source: "generated", role: "pixel-artist" },
    hash: "x",
    standard: null,
    grid: Object.fromEntries(tpl.frames.map((f) => [f, body])),
  };
  const res = checkAsset(file, { colours: { k: "#000000", S: "#e8e0ff" }, sky: "#101830" });
  assert.deepEqual(
    res.hard.map((i) => i.rule),
    [],
    JSON.stringify(res.hard),
  );
  const tall = checkAsset({ ...file, h: 20, grid: {} }, { colours: { k: "#000000" }, sky: "#101830" });
  assert.ok(tall.hard.some((i) => i.rule === "size" && /16x16 or 16x24/.test(i.fix)));
});

test("the critique input drops what the artist can't fix: provenance and the file's records", () => {
  const rows = Array.from({ length: 16 }, () => "kkkkkkkkkkkkkkkk");
  const std = checkAsset(
    {
      id: "lamp",
      kind: "icon",
      w: 16,
      h: 16,
      frames: ["icon"],
      palette: "pap-night@1",
      licence: "",
      rights: { likeness: false, brand: false, trademark: false, public: true },
      provenance: {},
      hash: "x",
      standard: null,
      grid: { icon: rows },
    },
    { colours: { k: "#000000" }, sky: "#101830" },
  );
  assert.ok(
    std.hard.some((i) => /provenance is empty/.test(i.message)),
    "the checker still finds it",
  );
  const shown = artistIssues(std.hard);
  assert.ok(!shown.some((i) => /provenance|licence/.test(i.message)), JSON.stringify(shown));
  assert.ok(shown.length < std.hard.length);
  const shape = artistIssues([
    { rule: "shape", message: "provenance.source: Required", fix: "x" },
    { rule: "grid", message: "row 3 has 15 cells, expected 16", fix: "x" },
  ]);
  assert.deepEqual(
    shape.map((i) => i.rule),
    ["grid"],
  );
  assert.ok(existsSync(EXAMPLE));
});
