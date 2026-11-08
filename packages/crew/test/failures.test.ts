// Failures stop the run and tell the person (docs/PIP-ORCHESTRATION.md §1.8): errorKind, no fallback model on a
// rejected key, the executor's hold and held propagation, a provider failure in a fallback handler holding the run
// (and lifting on a fixed key), the problem cleared on "ready", the retry revision, and "Needs you" counting cards.
// Over FakeProvider and the fictional QuestDay example only.
import assert from "node:assert/strict";
import { cpSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

const home = mkdtempSync(join(tmpdir(), "pap-failures-"));
process.env.PAP_HOME = home;
const root = join(home, "projects");
mkdirSync(root, { recursive: true });
const EXAMPLE = new URL("../../../examples/questday/", import.meta.url).pathname;

const { buildRegistry, Workspace } = await import("@pap/tools");
const { ModelGateway } = await import("../src/gateway-impl.ts");
const { FakeProvider, FAKE_CAPS, Ledger, SecretStore, defaultSettings, setPriceOverride, ProviderError, BudgetError } =
  await import("../src/llm/index.ts");
const { errorKind, holdsRun } = await import("../src/llm/http.ts");
const { Crew, humanize, pausedLine, retryRevision } = await import("../src/orchestrator.ts");
const rules = await import("../src/plan/rules.ts");
const { Executor, heldClosure, stuckError } = await import("../src/plan/executor.ts");
const { openNeeds, needsCount, needsWords, lineOf } = await import("../src/brief/line.ts");
const { crewNow } = await import("../src/assistant.ts");

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
const wait = async (ok: () => boolean, ms = 8000) => {
  for (let i = 0; i < ms / 10 && !ok(); i++) await new Promise((r) => setTimeout(r, 10));
  assert.ok(ok(), "timed out waiting");
};

// ---------------------------------------------------------------- errorKind
test("errorKind: 401/403 auth, a credit 400 or 402 or quota 429 credit, no connection unreachable, 429 rate", () => {
  const pe = (status: number, type: string, msg = "x") =>
    new ProviderError(`${status} ${type}: ${msg}`, status, type, false);
  assert.equal(errorKind(pe(401, "authentication_error")), "auth");
  assert.equal(errorKind(pe(403, "permission_error")), "auth");
  assert.equal(
    errorKind(pe(400, "invalid_request_error", "Your credit balance is too low to access the Anthropic API")),
    "credit",
  );
  assert.equal(errorKind(pe(400, "invalid_request_error", "messages: field required")), "other");
  assert.equal(errorKind(pe(402, "payment_required")), "credit");
  assert.equal(errorKind(pe(429, "insufficient_quota")), "credit");
  assert.equal(errorKind(pe(429, "rate_limit_error")), "rate");
  assert.equal(errorKind(pe(0, "network_error")), "unreachable");
  assert.equal(errorKind(new Error("fetch failed")), "unreachable");
  assert.equal(errorKind(new Error('provider "lmstudio" is turned off')), "unreachable");
  assert.equal(errorKind(Object.assign(new Error("budget: over the cap"), { code: "budget" })), "budget");
  assert.equal(errorKind(pe(529, "overloaded_error")), "other");
  assert.equal(errorKind(new Error("schema-valid answer not found")), "other");
  assert.equal(errorKind(null), "other");
  assert.ok(holdsRun(pe(401, "authentication_error")) && !holdsRun(pe(429, "rate_limit_error")));
  // the person's words: a 401 never reads "isn't answering · Use a different model"
  const h = humanize(Object.assign(pe(401, "authentication_error"), { provider: "anthropic" }), "reviewer");
  assert.deepEqual(h, { text: "Your Anthropic key was rejected.", action: "fix_key", provider: "anthropic" });
  assert.equal(
    humanize(Object.assign(pe(0, "network_error"), { provider: "lmstudio" })).text,
    "Can't reach LM Studio. Is it running?",
  );
  assert.equal(humanize(Object.assign(pe(0, "network_error"), { provider: "lmstudio" })).action, "retry");
});

test("the gateway: a rejected key never falls back to another model, and the error names its provider", async () => {
  setPriceOverride("fake/model", { inPerMTok: 1, outPerMTok: 5 });
  setPriceOverride("fake/backup", { inPerMTok: 1, outPerMTok: 5 });
  const asked: string[] = [];
  const fake = new FakeProvider(
    (req) => {
      asked.push(req.model);
      return {
        error: new ProviderError("401 authentication_error: invalid x-api-key", 401, "authentication_error", false),
      };
    },
    { id: "fake" },
  );
  const settings = defaultSettings();
  settings.providers.push({ id: "fake", kind: "custom", label: "Fake", baseUrl: "http://fake.invalid", enabled: true });
  settings.roles.reviewer = { model: "fake/model", fallback: "fake/backup" };
  const gw = new ModelGateway({
    ledger: new Ledger(join(home, "ledger-gw.sqlite")),
    secrets: new SecretStore({ env: {}, keychain: false, dir: home }),
    settings,
    providers: [fake],
    caps: { "fake/model": FAKE_CAPS, "fake/backup": FAKE_CAPS },
  });
  const { z } = await import("zod");
  const err = await gw
    .json({
      project: "p",
      capUsd: 5,
      role: "reviewer",
      taskKind: "review.final",
      system: "s",
      messages: [{ role: "user", content: "hi" }],
      schema: z.object({ ok: z.boolean() }),
      maxOut: 100,
    } as any)
    .then(
      () => null,
      (e) => e,
    );
  assert.ok(err instanceof ProviderError);
  assert.equal((err as any).provider, "fake");
  assert.deepEqual(asked, ["fake/model"], "no second call on the fallback model");
  assert.ok(!(err instanceof BudgetError));
});

// ---------------------------------------------------------------- the executor
function host(tasks: PlanTaskT[], o: { held?: Set<string>; fail?: (t: PlanTaskT) => unknown; hold?: boolean } = {}) {
  let resume: (() => void) | null = null;
  let stopped = false;
  const log: string[] = [];
  const h = {
    tasks: () => tasks,
    held: (id: string) => o.held?.has(id) ?? false,
    handle: async (t: PlanTaskT) => {
      await new Promise((r) => setTimeout(r, 2));
      const e = o.fail?.(t);
      if (e) throw e;
      log.push(t.id);
      return { status: "done" as const };
    },
    setStatus: (t: PlanTaskT, s: PlanTaskT["status"], note?: string, outcome?: "fallback") => {
      const x = tasks.find((y) => y.id === t.id)!;
      x.status = s;
      if (note !== undefined) x.note = note;
      if (outcome) x.outcome = outcome;
    },
    endpoint: () => null,
    laneSize: () => 2,
    affordable: () => true,
    overrun: () => {},
    stopped: () => stopped,
    aborted: () => false,
    waitResume: () =>
      new Promise<void>((r) => {
        resume = r;
      }),
    stageChanged: () => {},
    drain: async () => {},
    fatal: () => false,
    waiting: () => log.push("waiting"),
    ...(o.hold
      ? {
          hold: (_t: PlanTaskT, e: unknown) => {
            if (!holdsRun(e)) return false;
            stopped = true;
            return true;
          },
        }
      : {}),
  };
  return {
    h,
    log,
    release: () => {
      stopped = false;
      o.held?.clear();
      o.fail = undefined;
      const r = resume;
      resume = null;
      r?.();
    },
    waiting: () => !!resume,
  };
}

test("held is passed down: the dependents of a card's task wait with it, no 'plan is stuck'", async () => {
  const tasks = [mk("t_tune_a_r1", "scene.tune", [], { scene: "a" }), mk("t_mix", "sound.mix", ["t_tune_a_r1"])];
  tasks.push(mk("t_review_r1", "review.final", ["t_mix"]));
  const byId = new Map(tasks.map((t) => [t.id, t]));
  assert.deepEqual([...heldClosure(tasks, byId, (id) => id === "t_tune_a_r1")].sort(), [
    "t_mix",
    "t_review_r1",
    "t_tune_a_r1",
  ]);
  const x = host(tasks, { held: new Set(["t_tune_a_r1"]) });
  const run = new Executor(x.h as any).run();
  await wait(x.waiting);
  assert.deepEqual(x.log, ["waiting"], "nothing started, and the run says it waits");
  x.release();
  await run;
  assert.deepEqual(x.log, ["waiting", "t_tune_a_r1", "t_mix", "t_review_r1"]);
});

test("a stuck plan names the failed task it waits on", () => {
  const a = { ...mk("t_tune_a_r1", "scene.tune", [], { scene: "a" }), status: "failed" as const };
  const b = mk("t_mix", "sound.mix", ["t_tune_a_r1"]);
  const c = mk("t_review_r1", "review.final", ["t_mix"]);
  const e = stuckError(c, new Map([a, b, c].map((t) => [t.id, t])));
  assert.equal(e.blocking, "t_tune_a_r1");
  assert.match(e.message, /t_review_r1 waits on t_tune_a_r1, which failed/);
  assert.match(e.fix, /retry t_tune_a_r1/);
});

test("the executor's hold: a provider failure puts the task back to pending and waits; nothing is partial", async () => {
  const tasks = [mk("t_tune_a_r1", "scene.tune", [], { scene: "a" }), mk("t_mix", "sound.mix", ["t_tune_a_r1"])];
  const x = host(tasks, {
    hold: true,
    fail: (t) =>
      t.kind === "scene.tune"
        ? new ProviderError("401 authentication_error", 401, "authentication_error", false)
        : null,
  });
  const run = new Executor(x.h as any).run();
  await wait(x.waiting);
  assert.equal(tasks[0].status, "pending");
  assert.equal(tasks[0].outcome, undefined);
  assert.equal(tasks[1].status, "pending");
  x.release();
  await run;
  assert.deepEqual(
    tasks.map((t) => t.status),
    ["done", "done"],
  );
  // without a hold, a non-fatal failure is a fallback, said so on the task
  const t2 = [mk("t_tune_b_r1", "scene.tune", [], { scene: "b" })];
  await new Executor(host(t2, { fail: () => new Error("garbled") }).h as any).run();
  assert.equal(t2[0].status, "done");
  assert.equal(t2[0].outcome, "fallback");
  assert.match(t2[0].note ?? "", /^partial: garbled/);
});

// ---------------------------------------------------------------- the retry revision
test("retry: failed tasks go back in place; fallbacks run again as copies with the finished work after them", () => {
  const tune = {
    ...mk("t_tune_a_r1", "scene.tune", [], { scene: "a" }),
    status: "done" as const,
    outcome: "fallback" as const,
  };
  const mix = { ...mk("t_mix", "sound.mix", ["t_tune_a_r1"]), status: "done" as const };
  const gate = { ...mk("t_g3", "gate", ["t_mix"], { gate: "g3_rough" }), status: "done" as const };
  const exp = { ...mk("t_export", "deliver.export", ["t_mix", "t_g3"]), status: "done" as const };
  const draw = { ...mk("t_draw_moth_v1", "asset.draw", [], { asset: "moth", variant: 1 }), status: "failed" as const };
  const out = retryRevision([tune, mix, gate, exp, draw], [tune, draw], 7);
  const by = new Map(out.tasks.map((t) => [t.id, t]));
  assert.equal(by.get("t_draw_moth_v1")!.status, "pending", "a failed task goes back in place");
  assert.equal(by.get("t_tune_a_r1")!.status, "done", "the original stays done");
  assert.equal(by.get("t_tune_a_r1")!.outcome, undefined, "and is no longer a fallback");
  const copies = out.tasks.filter((t) => t.addedIn === 7).map((t) => t.id);
  assert.deepEqual(copies.sort(), ["t_export_v7", "t_g3_v7", "t_mix_v7", "t_tune_a_r1_v7"]);
  assert.deepEqual(by.get("t_mix_v7")!.dependsOn, ["t_tune_a_r1_v7"]);
  assert.ok(by.get("t_export_v7")!.dependsOn.includes("t_g3_v7"), "the export waits for the redo, through its gate");
  assert.ok(out.ops.every((o) => o.op === "add"));
});

// ---------------------------------------------------------------- "Needs you"
test("Needs you counts the crew's cards and the plan's other waits, each once", () => {
  const state = {
    questions: [{ id: "q1", status: "open" }],
    gates: [{ id: "g3_rough", status: "open", items: [] }],
  } as any;
  const plan = [
    { kind: "gate", status: "waiting_person", gate: "g3_rough" },
    { kind: "vo.align", status: "waiting_person" },
    { kind: "lib.publish", status: "waiting_person" },
  ];
  const n = openNeeds({ state }, { cards: ["plan"], plan });
  // the gate task is the open gate, one of the two other waits is the open question
  assert.deepEqual(n, { questions: 1, gates: ["g3_rough"], cards: ["plan"], waiting: 1 });
  assert.equal(needsCount(n), 4);
  const card = openNeeds({ state: { questions: [], gates: [] } as any }, { cards: ["plan"] });
  assert.equal(needsCount(card), 1);
  assert.equal(needsWords(card.questions, card.gates, card.cards, card.waiting), "your OK on a plan change");
  assert.equal(
    lineOf([{ id: "l", title: "Lantern", running: true, stage: "art", ...card }]).text,
    "Lantern is waiting on your OK on a plan change from you.",
  );
});

test("Pip's crew line says what is true now: idle after the export, held and why", () => {
  const base = {
    running: false,
    paused: false,
    stage: "deliver",
    line: "Your video is ready",
    gates: [],
    passed: ["g3_rough", "g4_final"],
    questions: 0,
    pendingCard: false,
    failed: [],
    fallbacks: [],
    reviewPending: false,
    exportedAt: "2026-11-08T10:00:00.000Z",
    working: [] as string[],
    retryRoles: [] as any[],
  };
  const idle = crewNow(base);
  assert.match(idle, /idle \(not working\)/);
  assert.match(idle, /passed gates: g3_rough, g4_final/);
  assert.match(idle, /last export 2026-11-08/);
  assert.match(
    crewNow({ ...base, running: true, held: "Your Anthropic key was rejected" }),
    /held: Your Anthropic key/,
  );
});

// ---------------------------------------------------------------- the crew on a fake provider
let n = 0;
async function crewOn(dir: string, answer: (req: Req) => any) {
  setPriceOverride("fake/model", { inPerMTok: 1, outPerMTok: 5 });
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
  return { crew, p: workspace.get(id), workspace };
}

test("a rejected key in a fallback handler holds the run (no stand-in), tells the person once, and lifts on a fix", async () => {
  const dir = join(root, `held_${++n}`);
  cpSync(EXAMPLE, dir, { recursive: true, filter: (f) => !f.endsWith(".pap-lock") });
  let bad = true;
  let tunes = 0;
  const answer = (req: Req) => {
    const sys = req.system ?? "";
    if (/Animator of one scene/.test(sys)) {
      tunes++;
      return bad
        ? {
            error: new ProviderError("401 authentication_error: invalid x-api-key", 401, "authentication_error", false),
          }
        : { json: { changes: [] } };
    }
    if (/festival judge/.test(sys)) return { json: { verdict: "ship", summary: "ok", blockers: [], polish: [] } };
    return { error: new Error(`unexpected: ${sys.slice(0, 40)}`) };
  };
  const { crew, p } = await crewOn(dir, answer);
  await p.patch(
    [
      { op: "replace", path: "/brief/involvement", value: "auto" },
      { op: "replace", path: "/budget/capUsd", value: 5 },
    ],
    { reason: "t", author: { kind: "user" } },
  );
  (crew as any).deps.gateway.laneSize = () => 1;
  const holds: unknown[] = [];
  crew.onHold = (_p, h) => holds.push(h);
  const run = crew.run(p, {});
  await wait(() => !!p.state.status.problem);
  const pr = p.state.status.problem!;
  assert.equal(pr.action, "fix_key");
  assert.equal(pr.provider, "fake");
  assert.equal(pr.text, "Your fake key was rejected.");
  assert.match(p.state.status.line, /^Waiting for you: Your fake key was rejected/);
  assert.ok(p.state.paused, "a held run reads as paused, so the web shows its problem");
  assert.equal(crew.status(p).crew.running, true, "the run is held, not ended");
  assert.equal(holds.length, 1, "Pip is told once");
  // Pip's channel line is a plain sentence, not "Hold: …"
  assert.ok(
    p.channel().some((m) => m.from === "pip" && m.text === "Paused the crew: your fake key was rejected."),
    "the hold reads as Pip's sentence",
  );
  const plan = crew.planNow(p)!;
  assert.ok(!plan.tasks.some((t) => t.outcome === "fallback"), "no 'kept as built' stand-in");
  assert.ok(!plan.tasks.some((t) => t.status === "failed"));
  assert.ok(
    plan.tasks.some((t) => t.kind === "scene.tune" && t.status === "pending"),
    "the tune waits to run again",
  );
  assert.ok(
    !p.state.tasks.some((t) => (t.status === "failed" || t.status === "partial") && !t.supersededBy),
    "its attempt is cancelled, not failed",
  );
  assert.equal(tunes, 1, "nothing else started");
  // a key for another provider changes nothing; this provider's key lifts the hold
  bad = false;
  assert.deepEqual(crew.providerFixed("other"), []);
  assert.ok(p.state.status.problem);
  assert.deepEqual(crew.providerFixed("fake"), [p.id]);
  await run;
  assert.equal(p.state.status.line, "Your video is ready");
  assert.equal(p.state.status.problem, undefined, "the problem is cleared on ready");
  assert.equal(p.state.paused, false);
  const after = crew.planNow(p)!;
  assert.ok(after.tasks.filter((t) => !t.expand).every((t) => ["done", "skipped"].includes(t.status)));
  assert.ok(!after.tasks.some((t) => t.outcome === "fallback"));
});

test("a hold reads as Pip's sentence: lower-case lead, a name keeps its capital, one full stop", () => {
  assert.equal(pausedLine("Your Anthropic key was rejected."), "Paused the crew: your Anthropic key was rejected.");
  assert.equal(pausedLine("Anthropic has no credit left"), "Paused the crew: Anthropic has no credit left.");
  assert.equal(
    pausedLine("Waiting for you: the plan changed more than 6 times in one run"),
    "Paused the crew: the plan changed more than 6 times in one run.",
  );
  assert.equal(pausedLine("Is the hero right?"), "Paused the crew: Is the hero right?");
});

test("retry over the crew: a fallback from an earlier run is redone, the revision is the person's", async () => {
  const dir = join(root, `retry_${++n}`);
  cpSync(EXAMPLE, dir, { recursive: true, filter: (f) => !f.endsWith(".pap-lock") });
  let reviews = 0;
  const answer = (req: Req) => {
    const sys = req.system ?? "";
    if (/Animator of one scene/.test(sys)) return { json: { changes: [] } };
    if (/festival judge/.test(sys)) {
      reviews++;
      // the first review is garbled: the cut goes on, on lints only (a fallback)
      return reviews === 1
        ? { error: new Error("no schema-valid answer") }
        : { json: { verdict: "ship", summary: "ok", blockers: [], polish: [] } };
    }
    return { error: new Error(`unexpected: ${sys.slice(0, 40)}`) };
  };
  const { crew, p } = await crewOn(dir, answer);
  await p.patch(
    [
      { op: "replace", path: "/brief/involvement", value: "auto" },
      { op: "replace", path: "/budget/capUsd", value: 5 },
    ],
    { reason: "t", author: { kind: "user" } },
  );
  await crew.run(p, {});
  const first = crew.planNow(p)!;
  const fb = first.tasks.filter((t) => t.outcome === "fallback");
  assert.deepEqual(
    fb.map((t) => t.kind),
    ["review.final"],
  );
  const row = p.state.tasks.find((t) => t.kind === "review.final")!;
  assert.equal(row.status, "partial", "the attempt's row is partial, not failed");
  assert.deepEqual(
    crew.retryTargets(p, row.id).map((t) => t.id),
    [fb[0].id],
    "a row id maps to its plan task",
  );
  const r = crew.retry(p, { taskId: row.id });
  assert.deepEqual(r, { started: true, resumed: false });
  // the retry reruns the review and re-renders the export: about 4 s here, four times that on a CI runner
  await wait(() => !crew.status(p).crew.running && reviews >= 2, 60_000);
  const plan = crew.planNow(p)!;
  assert.equal(plan.by, "person");
  assert.equal(plan.trigger, "retry");
  assert.equal(reviews, 2, "the review ran again");
  assert.ok(!plan.tasks.some((t) => t.outcome === "fallback"));
  assert.ok(
    plan.tasks.some((t) => t.kind === "deliver.export" && t.addedIn === plan.rev),
    "and the export after it",
  );
});

test("a rejected key in the review holds the run too: never 'review unavailable; lints only'", async () => {
  const dir = join(root, `held_review_${++n}`);
  cpSync(EXAMPLE, dir, { recursive: true, filter: (f) => !f.endsWith(".pap-lock") });
  const answer = (req: Req) => {
    const sys = req.system ?? "";
    if (/Animator of one scene/.test(sys)) return { json: { changes: [] } };
    if (/festival judge/.test(sys))
      return {
        error: new ProviderError("401 authentication_error: invalid x-api-key", 401, "authentication_error", false),
      };
    return { error: new Error(`unexpected: ${sys.slice(0, 40)}`) };
  };
  const { crew, p } = await crewOn(dir, answer);
  await p.patch(
    [
      { op: "replace", path: "/brief/involvement", value: "auto" },
      { op: "replace", path: "/budget/capUsd", value: 5 },
    ],
    { reason: "t", author: { kind: "user" } },
  );
  const run = crew.run(p, {}).catch(() => {});
  await wait(() => !!p.state.status.problem);
  assert.equal(p.state.status.problem!.action, "fix_key");
  const plan = crew.planNow(p)!;
  assert.equal(plan.tasks.find((t) => t.kind === "review.final")!.status, "pending");
  assert.ok(!plan.tasks.some((t) => t.outcome === "fallback"));
  assert.ok(!plan.tasks.some((t) => t.kind === "deliver.export" && t.status === "done"), "nothing went on to export");
  crew.pause(p, "now");
  await run;
});
