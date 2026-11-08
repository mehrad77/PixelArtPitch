// Pip's revision of the plan (docs/PIP-ORCHESTRATION.md §1.4-1.6, §5): one assistant.plan call and one repair, then
// the rules plan at no cost; shadow mode; the 6-proposal cap; the 20% card (confirm and decline); crew_replan; the
// reviewRounds setting; and the eval scorer on two fixed items. FakeProvider only, fictional briefs.
import assert from "node:assert/strict";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

const home = mkdtempSync(join(tmpdir(), "pap-pip-plan-"));
process.env.PAP_HOME = home;
const root = join(home, "projects");
mkdirSync(root, { recursive: true });
const EXAMPLE = new URL("../../../examples/questday/", import.meta.url).pathname;

const { buildRegistry, Workspace } = await import("@pap/tools");
const { ModelGateway } = await import("../src/gateway-impl.ts");
const { FakeProvider, FAKE_CAPS, Ledger, SecretStore, defaultSettings, setPriceOverride } = await import(
  "../src/llm/index.ts"
);
const { wireCrew } = await import("../../../apps/server/src/wire.ts");
const rules = await import("../src/plan/rules.ts");
const { pipRevision, planPromptVars } = await import("../src/plan/pip.ts");
const { PlanEvalItem, aggregate, evalDoc, pipWins, scorePlan } = await import("../src/plan/evals.ts");
const { envOf, planEstimate } = await import("../src/plan/estimate.ts");

type Req = import("../src/llm/types.ts").ChatRequest;
const isPlan = (req: Req) => /deciding who works on this video/.test(req.system ?? "");

let answer: (req: Req) => any = () => ({ error: new Error("no call expected") });
const fake = new FakeProvider((req) => answer(req), { id: "fake" });
setPriceOverride("fake/model", { inPerMTok: 1, outPerMTok: 5 });

const open: InstanceType<typeof Workspace>[] = [];
after(() => {
  for (const w of open) w.closeAll();
  rmSync(home, { recursive: true, force: true });
});

let n = 0;
async function setup(o: { pipPlan?: "on" | "shadow" | "off"; reviewRounds?: 1 | 2 } = {}) {
  const dir = join(root, `questday_${++n}`);
  cpSync(EXAMPLE, dir, { recursive: true, filter: (f) => !f.endsWith(".pap-lock") });
  const s = defaultSettings();
  s.providers.push({ id: "fake", kind: "custom", label: "Fake", baseUrl: "http://fake.invalid", enabled: true });
  for (const r of Object.keys(s.roles)) s.roles[r] = { model: "fake/model" };
  s.defaults.pipPlan = o.pipPlan ?? "on";
  s.defaults.reviewRounds = o.reviewRounds ?? 2;
  const gateway = new ModelGateway({
    ledger: new Ledger(join(home, `ledger-${n}.sqlite`)),
    secrets: new SecretStore({ env: {}, keychain: false, dir: home }),
    settings: s,
    providers: [fake],
    caps: { "fake/model": FAKE_CAPS },
  });
  const workspace = new Workspace(() => [dir]);
  open.push(workspace);
  const wired = await wireCrew({ workspace, registry: buildRegistry(), gateway, resume: false });
  const p = workspace.get(workspace.list().find((x) => x.dir === dir)!.id);
  await p.patch(
    [
      { op: "replace", path: "/budget/capUsd", value: 5 },
      { op: "replace", path: "/brief/narration", value: "none" },
    ],
    { reason: "test", author: { kind: "user" } },
  );
  const crew = wired.crewImpl as any;
  // a run as the executor makes one, so the handlers can be called one at a time
  const run = () => {
    const plan = crew.ensurePlan(p, null);
    const r = {
      id: `run_${n}`,
      abort: new AbortController(),
      redos: new Map(),
      revisions: 0,
      triggers: [],
      done: { redone: new Set(), reboarded: [], approximated: [], exported: false },
      startedAt: new Date().toISOString(),
    };
    plan.runs.push({ id: r.id, startedAt: r.startedAt, pipProposals: 0 });
    crew.runs.set(p.id, r);
    return r;
  };
  return { ...wired, p, crew, run, gateway };
}
const add = {
  op: "add",
  kind: "asset.spec",
  asset: "keeper",
  assetKind: "character",
  description: "A lighthouse keeper with a lantern and a long coat.",
  reason: "added a Pixel artist for the keeper",
};

/** the project's log lines from now on (they are never on the channel) */
function logsOf(p: any): string[] {
  const out: string[] = [];
  p.events.on("event", (e: any) => {
    if (e.event === "log") out.push(String(e.data?.text ?? ""));
  });
  return out;
}

test("Pip's revision, applied: one call; code expands the asset into its chain; a `pip` revision and a milestone", async () => {
  const w = await setup({ pipPlan: "on" });
  const r = w.run();
  let calls = 0;
  answer = (req) => {
    if (!isPlan(req)) return { error: new Error("unexpected") };
    calls++;
    assert.match(JSON.stringify(req.messages), /t_tune_grind_r1/, "the plan reaches the prompt");
    return { json: { ops: [add], summary: "Added a drawing of the keeper." } };
  };
  const res = await w.crew.pipRevise(w.p, r, "g0");
  assert.equal(calls, 1);
  assert.equal(res.valid, "first");
  const plan = w.crew.planNow(w.p);
  assert.equal(plan.by, "pip");
  assert.equal(plan.trigger, "pip_revision");
  assert.equal(plan.reason, "Added a drawing of the keeper.");
  for (const id of ["t_spec_keeper", "t_draw_keeper_v1", "t_draw_keeper_v2", "t_judge_keeper"])
    assert.ok(
      plan.tasks.some((t: any) => t.id === id && t.status === "pending"),
      id,
    );
  assert.equal(plan.runs.at(-1).pipProposals, 1);
  assert.ok(w.p.state.milestones.some((m: any) => m.text === "Plan changed: Added a drawing of the keeper."));
  assert.ok(w.p.channel().some((m: any) => m.from === "pip" && /^Plan changed: Added a drawing/.test(m.text)));
  // the Director sees the new drawing in its asset list
  assert.ok(w.crew.plannedArt(w.p).some((l: string) => l.startsWith("keeper:")));
  const row = w.gateway.ledger.query({ project: w.p.id } as any).at(-1)!;
  assert.equal(row.taskKind, "assistant.plan");
  assert.equal(row.role, "assistant");
});

test("a bad answer gets one repair turn, then the rules plan stands at no further cost", async () => {
  const w = await setup({ pipPlan: "on" });
  const logs = logsOf(w.p);
  const r = w.run();
  const before = JSON.stringify(w.crew.planNow(w.p).tasks);
  let calls = 0;
  answer = (req) => {
    if (!isPlan(req)) return { error: new Error("unexpected") };
    calls++;
    if (calls === 2) assert.match(JSON.stringify(req.messages), /gate_touched|gates aren't yours/);
    return {
      json: { ops: [{ op: "drop", task: "t_g3", reason: "skip the rough cut" }], summary: "Dropped the rough cut." },
    };
  };
  const res = await w.crew.pipRevise(w.p, r, "g0");
  assert.equal(calls, 2, "one call, one repair");
  assert.equal(res.valid, "no");
  assert.equal(JSON.stringify(w.crew.planNow(w.p).tasks), before, "the rules plan stands");
  assert.ok(
    logs.some((t) => /^Kept the default plan: t_g3 is a gate/.test(t)),
    "the error goes to the log",
  );
  assert.ok(w.p.channel().some((m: any) => m.from === "pip" && m.text === "I kept the default plan."));
  assert.ok(!w.p.channel().some((m: any) => /t_g3/.test(m.text)), "no task id on the channel");
  // a failed call counts too: the cap is 6 proposals per run, then no more calls
  answer = () => ({ error: new Error("down") });
  for (let i = 0; i < 6; i++) await w.crew.pipRevise(w.p, r, "g0");
  assert.equal(w.crew.planNow(w.p).runs.at(-1).pipProposals, 6);
  const k0 = fake.calls.length;
  assert.equal(await w.crew.pipRevise(w.p, r, "g0"), null);
  assert.equal(fake.calls.length, k0, "the 7th trigger makes no call");
  assert.equal(w.crew.pipView(w.p).proposals, 6);
});

test("shadow: the call runs and is logged, not applied, with one plain sentence on the channel; off makes no call", async () => {
  const w = await setup({ pipPlan: "shadow" });
  const logs = logsOf(w.p);
  const r = w.run();
  answer = (req) =>
    isPlan(req) ? { json: { ops: [add], summary: "Added a drawing of the keeper." } } : { error: new Error("x") };
  const before = w.crew.planNow(w.p).rev;
  await w.crew.pipRevise(w.p, r, "g0");
  assert.equal(w.crew.planNow(w.p).rev, before, "no revision");
  assert.ok(logs.some((t) => /^Shadow plan \(not applied\): Added a drawing/.test(t)));
  assert.ok(w.p.channel().some((m: any) => /^I looked for a better plan and kept the default one/.test(m.text)));
  assert.ok(
    !w.p.channel().some((m: any) => /Shadow plan|asset\.spec|t_/.test(m.text)),
    "the channel isn't a debug log",
  );
  const off = await setup({ pipPlan: "off" });
  const k0 = fake.calls.length;
  assert.equal(await off.crew.pipRevise(off.p, off.run(), "g0"), null);
  assert.equal(fake.calls.length, k0);
});

test("the 20% card: a revision past 1.2 x approved waits for the person; confirm runs it, decline drops it", async () => {
  const w = await setup({ pipPlan: "on" });
  const r = w.run();
  const plan = w.crew.planNow(w.p);
  plan.approvedUsd = Math.max(0.01, plan.estimate.usd[0]);
  answer = (req) =>
    isPlan(req) ? { json: { ops: [add], summary: "Added a drawing of the keeper." } } : { error: new Error("x") };
  await w.crew.pipRevise(w.p, r, "g0");
  const pending = w.crew.planNow(w.p).pending;
  assert.ok(pending, "the revision is held");
  assert.ok(pending.tasks.includes("t_spec_keeper"));
  const items = w.pip!.items(w.p.id);
  const c = (items.at(-1) as any).cards[0];
  assert.equal(c.id, pending.cardId);
  assert.match(c.title, /^Plan change: \$/);
  assert.ok(c.revision.toUsd > c.revision.fromUsd * 1.2);
  assert.deepEqual(
    c.whoInstances.map((x: any) => x.instance),
    ["art-director", "pixel-artist:keeper"],
  );
  assert.ok(!JSON.stringify(items).includes('"crew"'), "the action stays on the server");
  // decline: a `decline` revision by the person drops them, and Pip hears so
  const declined = await w.pip!.decide(w.p.id, c.id, "decline").done;
  assert.equal((declined as any).status, "declined");
  const after = w.crew.planNow(w.p);
  assert.equal(after.trigger, "decline");
  assert.equal(after.by, "person");
  assert.equal(after.tasks.find((t: any) => t.id === "t_spec_keeper").status, "dropped");
  assert.ok(!after.pending);
  assert.ok(r.triggers.some((t: any) => t.kind === "stage"));
  // again, and confirm: the new total is what the person approved
  after.runs.at(-1).pipProposals = 0;
  answer = (req) =>
    isPlan(req)
      ? {
          json: { ops: [{ ...add, asset: "keeper2", reason: "the keeper again" }], summary: "Added the keeper again." },
        }
      : { error: new Error("x") };
  await w.crew.pipRevise(w.p, r, "g0");
  const p2 = w.crew.planNow(w.p).pending;
  assert.ok(p2);
  await w.pip!.decide(w.p.id, p2.cardId, "confirm").done;
  const ok = w.crew.planNow(w.p);
  assert.ok(!ok.pending);
  assert.equal(ok.approvedUsd, ok.estimate.usd[0]);
});

test("the 20% rule covers expansions (C5): new art from the board waits for the card; the tunes don't", async () => {
  const w = await setup({ pipPlan: "off" });
  const r = w.run();
  const plan = w.crew.planNow(w.p);
  plan.approvedUsd = 0.01;
  const { writeFileSync } = await import("node:fs");
  const art = ["lantern", "boat", "gull"].map((name) => ({
    name,
    kind: "prop",
    description: `a small ${name} for the harbour`,
  }));
  writeFileSync(join(w.p.dir, "runs", "new-assets.json"), JSON.stringify(art));
  w.crew.expandAfterBoard(w.p, r);
  const after = w.crew.planNow(w.p);
  assert.equal(after.trigger, "expand");
  assert.ok(after.pending, "the expansion is held for the person");
  for (const a of ["lantern", "boat", "gull"]) assert.ok(after.pending.tasks.includes(`t_spec_${a}`), a);
  assert.ok(!after.pending.tasks.some((id: string) => id.startsWith("t_tune_")), "tunes keep running");
  const c = (w.pip!.items(w.p.id).at(-1) as any).cards[0];
  assert.equal(c.id, after.pending.cardId);
  assert.ok(c.whoInstances.some((x: any) => x.instance === "pixel-artist:boat"));
});

test("crew_replan: the conductor's ops are validated like Pip's; a gate can't be touched", async () => {
  const w = await setup({ pipPlan: "off" });
  const logs = logsOf(w.p);
  const r = w.run();
  await w.crew.apply(w.p, r, [
    { kind: "replan", diff: { ops: [{ op: "drop", task: "t_g4", reason: "no final" }], summary: "x" } },
  ]);
  assert.ok(logs.some((t) => /^Kept the default plan: t_g4 is a gate/.test(t)));
  await w.crew.apply(w.p, r, [
    {
      kind: "replan",
      diff: {
        ops: [{ op: "add", kind: "scene.tune", scene: "quest", after: [], reason: "the toast is cut" }],
        summary: "Sent scene 2 back.",
      },
    },
  ]);
  const plan = w.crew.planNow(w.p);
  assert.equal(plan.trigger, "conductor");
  assert.ok(plan.tasks.some((t: any) => t.id === "t_tune_quest_r2" && t.instance === "animator:quest"));
  assert.equal(plan.runs.at(-1).pipProposals, 2, "both count");
});

test("reviewRounds 1: blockers become notes but no second round is planned", async () => {
  const w = await setup({ pipPlan: "off", reviewRounds: 1 });
  const r = w.run();
  answer = (req) =>
    /festival judge/.test(req.system ?? "")
      ? {
          json: {
            verdict: "fix",
            summary: "x",
            blockers: [{ t: 1, scene: "grind", issue: "dark", fix: "lighter" }],
            polish: [],
          },
        }
      : { error: new Error("x") };
  const pt = w.crew.planNow(w.p).tasks.find((t: any) => t.id === "t_review_r1");
  await w.crew.review(w.p, r, pt);
  assert.ok(w.p.state.notes.some((x: any) => x.by === "reviewer"));
  assert.ok(!w.crew.planNow(w.p).tasks.some((t: any) => t.kind === "review.final" && t.round === 2));
  const two = await setup({ pipPlan: "off", reviewRounds: 2 });
  const r2 = two.run();
  await two.crew.review(
    two.p,
    r2,
    two.crew.planNow(two.p).tasks.find((t: any) => t.id === "t_review_r1"),
  );
  assert.ok(two.crew.planNow(two.p).tasks.some((t: any) => t.kind === "review.final" && t.round === 2));
});

test("the eval scorer: a valid diff and a diff that fails twice, on two fixed items", async () => {
  const lines = readFileSync(new URL("../evals/plan.jsonl", import.meta.url), "utf8")
    .split("\n")
    .filter(Boolean);
  assert.ok(lines.length >= 15);
  const items = lines.map((l) => PlanEvalItem.parse(JSON.parse(l)));
  const ids = new Set(items.map((x) => x.id));
  assert.equal(ids.size, items.length);
  const pick = (id: string) => items.find((x) => x.id === id)!;
  const s = defaultSettings();
  s.providers.push({ id: "fake", kind: "custom", label: "Fake", baseUrl: "http://fake.invalid", enabled: true });
  for (const r of Object.keys(s.roles)) s.roles[r] = { model: "fake/model" };
  const gateway = new ModelGateway({
    ledger: new Ledger(join(home, "ledger-evals.sqlite")),
    secrets: new SecretStore({ env: {}, keychain: false, dir: home }),
    settings: s,
    providers: [fake],
    caps: { "fake/model": FAKE_CAPS },
  });
  const env = envOf(gateway);
  const run = async (id: string, reply: (k: number) => any) => {
    const item = pick(id);
    const doc = evalDoc(item);
    const ctx = { env, rev: 1, refs: doc.brief.references };
    const rulesTs = rules.rulesPlan(doc, { env, rev: 0 });
    let k = 0;
    answer = (req) => (isPlan(req) ? reply(++k) : { error: new Error("x") });
    const res = await pipRevision({
      gateway,
      project: "_evals",
      capUsd: 1,
      model: "fake/model",
      vars: planPromptVars({
        brief: item.brief,
        refs: [],
        library: [{ id: "mentor-ai", kind: "character" }],
        budget: { capUsd: 3, reserveUsd: 0.5, spentUsd: 0, estUsd: [1, 2] },
        tasks: rulesTs,
        ctx,
      }),
      tasks: rulesTs,
      ctx,
      validate: { doc, library: new Set(["mentor-ai"]), env, spentUsd: 0 },
    });
    const ts = res.tasks ?? rulesTs;
    return {
      res,
      rules: scorePlan(item, rulesTs, { rules: rulesTs, p50: planEstimate(rulesTs, 0, env).usd[0] }),
      pip: scorePlan(item, ts, {
        rules: rulesTs,
        p50: planEstimate(ts, 0, env).usd[0],
        valid: res.valid,
        usd: res.usd,
        sec: res.sec,
      }),
    };
  };
  // the brief names a character the library lacks: Pip's added drawing is what the item asks for
  const a = await run("missing-character", () => ({ json: { ops: [add], summary: "Added the keeper." } }));
  assert.equal(a.res.calls, 1);
  assert.deepEqual([a.rules.missing, a.rules.extra, a.pip.missing, a.pip.extra, a.pip.valid], [1, 0, 0, 0, "first"]);
  // a fully served brief: Pip adds a drawing anyway, twice wrongly (no description), and the rules plan stands
  const b = await run("library-served", () => ({
    json: { ops: [{ op: "add", kind: "asset.spec", asset: "star", reason: "a star sprite" }], summary: "x" },
  }));
  assert.equal(b.res.calls, 2);
  assert.equal(b.res.valid, "no");
  assert.deepEqual([b.pip.missing, b.pip.extra], [0, 0], "fell back to the rules plan");
  const mid = (pick("missing-character").estUsd[0] + pick("missing-character").estUsd[1]) / 2;
  assert.ok(Math.abs(a.rules.estErr - Math.abs(a.rules.p50 - mid) / mid) < 1e-9);
  const ra = aggregate([a.rules, b.rules], 0);
  const pa = aggregate([a.pip, b.pip], 3);
  assert.equal(ra.missing, 0.5);
  assert.equal(pa.validity, 0.5);
  assert.equal(pa.missing, 0);
  assert.equal(pipWins(ra, pa), false, "validity under 95% never wins");
  assert.equal(pipWins(ra, { ...pa, validity: 1 }), pa.medianEstErr <= ra.medianEstErr + 0.05);
});
