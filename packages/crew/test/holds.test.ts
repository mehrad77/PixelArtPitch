// One picture (docs/PIP-ORCHESTRATION.md §1.8): every hold asks the person a question with real options, answering
// it lifts the hold and acts, a change on a held run resumes it, Pip's words come from the run, a refused change is
// corrected before Pip escalates, and the escalation recommends the cheapest option that fits. Over FakeProvider and
// the fictional QuestDay example only.
import assert from "node:assert/strict";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

const home = mkdtempSync(join(tmpdir(), "pap-holds-"));
process.env.PAP_HOME = home;
const root = join(home, "projects");
mkdirSync(root, { recursive: true });
const EXAMPLE = new URL("../../../examples/questday/", import.meta.url).pathname;

const { buildRegistry, Workspace } = await import("@pap/tools");
const { ModelGateway } = await import("../src/gateway-impl.ts");
const { FakeProvider, FAKE_CAPS, Ledger, SecretStore, defaultSettings, setPriceOverride, ProviderError } = await import(
  "../src/llm/index.ts"
);
const { Crew, holdOptions, holdQuestion, cheapestOption, optionKind, reviewVerdict, mergeChange } = await import(
  "../src/orchestrator.ts"
);
const { openNeeds } = await import("../src/brief/line.ts");
const { resultFor } = await import("../src/assistant.ts");

type Req = import("../src/llm/types.ts").ChatRequest;

const open: InstanceType<typeof Workspace>[] = [];
after(() => {
  for (const w of open) w.closeAll();
  rmSync(home, { recursive: true, force: true });
});
// a deadline, not a count: CI runs these renders about 4x slower than a laptop
const wait = async (ok: () => boolean, ms = 60_000) => {
  const end = Date.now() + ms;
  while (!ok() && Date.now() < end) await new Promise((r) => setTimeout(r, 10));
  assert.ok(ok(), "timed out waiting");
};

let n = 0;
async function crewOn(answer: (req: Req) => any) {
  const dir = join(root, `hold_${++n}`);
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
  const crew = new Crew({ workspace, registry: buildRegistry(), gateway });
  (crew as any).deps.gateway.laneSize = () => 1;
  const id = workspace.list().find((x) => x.dir === dir)!.id;
  const p = workspace.get(id);
  await p.patch(
    [
      { op: "replace", path: "/brief/involvement", value: "auto" },
      { op: "replace", path: "/budget/capUsd", value: 5 },
    ],
    { reason: "t", author: { kind: "user" } },
  );
  return { crew, p };
}
/** the Animator reports partial on its first tune; the Reviewer ships */
function partialOnce() {
  let tunes = 0;
  return (req: Req) => {
    const sys = req.system ?? "";
    if (/Animator of one scene/.test(sys)) {
      tunes++;
      return {
        json: {
          changes: [],
          ...(tunes === 1
            ? { report: { status: "partial", did: "kept the old look", couldnt: "the moth can't fly here" } }
            : {}),
        },
      };
    }
    if (/festival judge/.test(sys)) return { json: { verdict: "ship", summary: "ok", blockers: [], polish: [] } };
    return { error: new Error(`unexpected: ${sys.slice(0, 40)}`) };
  };
}
/** Pip holds on every partial report, and carries on otherwise */
const holdingConductor = {
  think: async (_p: any, t: any) =>
    t.kind === "report" ? [{ kind: "hold", why: `the animator couldn't finish: ${t.report.couldnt}` }] : [],
};
const holdQ = (p: any) => p.state.questions.find((q: any) => q.hold && q.status === "open");

test("no code path sets r.held outside holdFor and liftHold", () => {
  const src = readFileSync(new URL("../src/orchestrator.ts", import.meta.url), "utf8");
  const body = (name: string) => {
    const at = src.indexOf(`  private ${name}(`);
    assert.ok(at > 0, name);
    return [at, src.indexOf("\n  }\n", at)] as const;
  };
  const spans = [body("holdFor"), body("liftHold")];
  const sets = [...src.matchAll(/\.held = /g)].map((m) => m.index!);
  assert.ok(sets.length >= 2);
  for (const i of sets)
    assert.ok(
      spans.some(([a, b]) => i > a && i < b),
      `r.held set outside holdFor: ${i}`,
    );
});

test("a hold's question and options: provider, scenes, anything else", () => {
  assert.equal(
    holdQuestion("Your fake key was rejected."),
    "The crew is waiting: your fake key was rejected. What should it do?",
  );
  const key = holdOptions({ action: "fix_key" });
  assert.deepEqual(
    key.options.map((o) => o.id),
    ["fix_key", "retry"],
  );
  assert.equal(key.recommendedId, "fix_key");
  assert.equal(holdOptions({ action: "retry" }).recommendedId, "retry");
  const sc = holdOptions({ scenes: ["scene 2"] });
  assert.deepEqual(
    sc.options.map((o) => o.label),
    ["Redo with the Director", "Accept the look", "Tell Pip what to change"],
  );
  assert.match(sc.options[0].detail, /re-plans scene 2, then the Animator tunes it/);
  assert.deepEqual(
    holdOptions({}).options.map((o) => o.id),
    ["accept", "tell"],
  );
  const long = holdQuestion("x ".repeat(300));
  assert.ok(long.length <= 200 && long.length >= 5);
});

test("a Pip hold asks with three options, counts in Needs you, and answering it resumes the run", async () => {
  const { crew, p } = await crewOn(partialOnce());
  crew.conductor = holdingConductor as any;
  const ended: string[] = [];
  crew.onRunEnd = (_p, r) => ended.push(r.status);
  const run = crew.run(p, {});
  await wait(() => !!holdQ(p));
  const q = holdQ(p);
  assert.equal(q.from, "pip");
  assert.equal(q.kind, "single");
  assert.equal(q.hold, true);
  assert.deepEqual(
    q.options.map((o: any) => o.id),
    ["redo_director", "accept", "tell"],
  );
  assert.equal(q.recommendedId, "redo_director");
  assert.equal(openNeeds(p).questions, 1, "Needs you counts the hold");
  assert.match(p.state.status.line, /^Waiting for you: the animator couldn't finish/);
  assert.equal(crew.snapshot(p).holdQuestion, q.question);
  assert.deepEqual(ended, [], "a hold doesn't settle the cards that handed work to the run");
  // "Tell Pip" with no words can't act yet: the question stays open, the same id
  const kept = await p.answer(q.id, { optionId: "tell" }, "user");
  assert.equal(kept.status, "open");
  assert.equal(holdQ(p)?.id, q.id);
  await p.answer(q.id, { optionId: "accept" }, "user");
  await run;
  assert.match(p.state.status.line ?? "", /^Exported v[0-9]+$/);
  assert.equal(p.state.paused, false);
  assert.equal(holdQ(p), undefined);
  assert.equal(p.state.questions.find((x) => x.id === q.id)?.status, "answered");
});

test("a change on a held run lifts the hold and resumes it now; the run's end doesn't run it again", async () => {
  const { crew, p } = await crewOn(partialOnce());
  crew.conductor = holdingConductor as any;
  const reports: any[] = [];
  crew.onRunEnd = (_p, r) => reports.push(r);
  const run = crew.run(p, {});
  await wait(() => !!holdQ(p));
  const q = holdQ(p);
  const note = p.addNote({
    target: { scene: p.doc().scenes[1].id },
    category: "art",
    text: "make the moth glow",
    assignee: "animator",
    by: "user",
  });
  const res = crew.requestChange(p, note);
  assert.deepEqual(
    { started: res.started, resumed: res.resumed, queued: res.queued },
    {
      started: true,
      resumed: true,
      queued: false,
    },
  );
  assert.equal(p.state.questions.find((x) => x.id === q.id)?.status, "withdrawn", "the hold's question goes");
  assert.equal(openNeeds(p).questions, 0);
  await run;
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(reports.length, 1, "one run, no re-trigger for the claimed note");
  assert.ok(reports[0].notes.includes(note.id), "the run's report names the change");
  assert.equal(crew.status(p).crew.running, false);
});

test("a provider hold asks Fix the key · Try again; Fix the key stays open until the key is fixed", async () => {
  let bad = true;
  const { crew, p } = await crewOn((req) => {
    const sys = req.system ?? "";
    if (/Animator of one scene/.test(sys))
      return bad
        ? {
            error: new ProviderError("401 authentication_error: invalid x-api-key", 401, "authentication_error", false),
          }
        : { json: { changes: [] } };
    if (/festival judge/.test(sys)) return { json: { verdict: "ship", summary: "ok", blockers: [], polish: [] } };
    return { error: new Error("unexpected") };
  });
  const run = crew.run(p, {});
  await wait(() => !!holdQ(p));
  const q = holdQ(p);
  assert.deepEqual(
    q.options.map((o: any) => o.id),
    ["fix_key", "retry"],
  );
  assert.equal((await p.answer(q.id, { optionId: "fix_key" }, "user")).status, "open");
  // a change while the key is wrong: it joins the plan and waits on the key, said so
  const note = p.addNote({
    target: {},
    category: "sound",
    text: "softer music",
    assignee: "sound-designer",
    by: "user",
  });
  const res = crew.requestChange(p, note);
  assert.equal(res.started, false);
  assert.equal(res.waiting, q.question);
  bad = false;
  assert.deepEqual(crew.providerFixed("fake"), [p.id]);
  assert.equal(p.state.questions.find((x) => x.id === q.id)?.status, "withdrawn");
  await run;
  assert.match(p.state.status.line ?? "", /^Exported v[0-9]+$/);
});

test("the escalation recommends the cheapest option that fits the cap", () => {
  assert.equal(optionKind("Draw a new owl"), "draw");
  assert.equal(optionKind("Use the library owl and make it sit"), "free");
  assert.equal(optionKind("Have the Director re-plan scene 2"), "reboard");
  assert.equal(optionKind("Redo the scene"), "redo");
  const usd = (o: string) => ({ draw: 1.2, reboard: 0.2, redo: 0.05, free: 0 })[optionKind(o)];
  assert.equal(cheapestOption(["Draw a new owl", "Use the library owl"], usd, 5), 1);
  assert.equal(cheapestOption(["Draw a new owl", "Redo the scene", "Re-plan with the Director"], usd, 0.1), 1);
  // nothing fits: still the cheapest
  assert.equal(cheapestOption(["Draw a new owl", "Re-plan with the Director"], usd, 0.01), 1);
});

test("a refused change must be corrected once before Pip may escalate", async () => {
  const { crew, p } = await crewOn(() => ({ error: new Error("no calls") }));
  const seen: (string | null)[] = [];
  crew.conductor = {
    think: async (_p: any, _t: any, ctx: any) => {
      const esc = { kind: "escalate", question: "Draw a new moth?" };
      seen.push(ctx.check(esc));
      seen.push(ctx.check({ kind: "redo", scenes: ["nope"], why: "fix it" }));
      seen.push(ctx.check(esc));
      seen.push(ctx.check({ kind: "redo", scenes: ["nope2"], why: "fix it again" }));
      seen.push(ctx.check(esc));
      return [];
    },
  } as any;
  (crew as any).ensurePlan(p, null);
  const r = { redos: new Map(), triggers: [], done: {}, id: "run_x", abort: new AbortController() } as any;
  await (crew as any).think(p, r, { kind: "stage", stage: "animate", notes: [] });
  assert.equal(seen[0], null, "nothing refused yet: may escalate");
  assert.match(String(seen[1]), /no scene nope/);
  assert.match(String(seen[2]), /correct the refused change once/);
  assert.match(String(seen[3]), /no scene nope2/);
  assert.equal(seen[4], null, "after one corrected retry");
});

test("Pip's words for a change come from the run: started, resumed, queued behind, or waiting", () => {
  const snap = { working: ["Animating scene 2"], reviewPending: true } as any;
  assert.match(
    resultFor("crew_request_change", { queued: true, owner: "animator" }, undefined, snap).text,
    /^Queued behind Animating scene 2\. The next review reads it\./,
  );
  assert.match(
    resultFor("crew_request_change", { started: true, resumed: true, owner: "director" }).text,
    /^The crew goes on now\. The director is on it/i,
  );
  assert.match(
    resultFor("crew_request_change", { started: false, waiting: "The crew is waiting: x. What should it do?" }).text,
    /waits for your answer to "The crew is waiting/,
  );
  assert.doesNotMatch(
    resultFor("crew_request_change", { queued: true, owner: "animator" }, undefined, snap).text,
    /picked up at the next review/,
  );
});

test("the review's verdict is the report's sentence; change plans merge", () => {
  assert.equal(reviewVerdict({ verdict: "ship", blockers: [] }), "The cut is ready to ship.");
  assert.equal(
    reviewVerdict(
      { verdict: "fix", blockers: [{ scene: "a" }, { scene: "b" }, { scene: "a" }] },
      (s) => `scene ${s === "a" ? 2 : 4}`,
    ),
    "Found 3 problems in scenes 2 and 4.",
  );
  assert.deepEqual(mergeChange({ notes: ["n1"], scope: ["a"] }, { notes: ["n2"], scope: ["b"], reboard: ["b"] }), {
    notes: ["n1", "n2"],
    scope: ["a", "b"],
    reboard: ["b"],
  });
  assert.deepEqual(mergeChange({ notes: ["n1"] }, { notes: ["n2"], scope: ["b"] }), { notes: ["n1", "n2"] });
});
