// The run order at parity (docs/PIP-ORCHESTRATION.md §1.7, "the regression bar"): a whole crew run on a fake provider,
// recorded as the sequence of task kinds, model calls per kind and gate events. Written against the stage machine
// before the executor replaced it, so the executor has to give the same run.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

const home = mkdtempSync(join(tmpdir(), "pap-parity-"));
process.env.PAP_HOME = home;
const root = join(home, "projects");
mkdirSync(root, { recursive: true });

const { buildRegistry, Workspace } = await import("@pap/tools");
const { ModelGateway } = await import("../src/gateway-impl.ts");
const { FakeProvider, FAKE_CAPS, Ledger, SecretStore, defaultSettings, setPriceOverride } = await import(
  "../src/llm/index.ts"
);
const { Crew } = await import("../src/orchestrator.ts");

type Req = import("../src/llm/types.ts").ChatRequest;
type Step = import("../src/llm/fake.ts").FakeStep;

/** one fake crew: every role answers well enough to reach the export; the Pixel Artist always fails (library fallback) */
export function crewAnswer(req: Req): Step {
  const sys = req.system ?? "";
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
            cues: ["Lists feel heavy.", "Lumen makes them light.", "Try Lumen."],
          },
          { name: "The calm", approach: "a calm night", cues: ["Night falls.", "Lumen keeps your day.", "Try Lumen."] },
        ],
        recommended: 0,
      },
    };
  // an unusable board: the baseline storyboard keeps the crew moving
  if (/turn the script into scenes/.test(sys)) return { error: new Error("no board today") };
  if (/You are the Art Director. You write a precise drawing spec/.test(sys))
    return {
      json: {
        letters: "kKwW",
        description: "A small hero with a scarf and a backpack, facing right.",
        reads: "a hero",
      },
    };
  if (/senior pixel artist/.test(sys)) return { error: new Error("no pixels today") };
  if (/Animator of one scene/.test(sys)) return { json: { changes: [] } };
  if (/festival judge/.test(sys)) return { json: { verdict: "ship", summary: "fine", blockers: [], polish: [] } };
  return { error: new Error(`unexpected call: ${sys.slice(0, 60)}`) };
}

const fake = new FakeProvider((req) => crewAnswer(req), { id: "fake" });
setPriceOverride("fake/model", { inPerMTok: 1, outPerMTok: 5 });
const settings = defaultSettings();
settings.providers.push({ id: "fake", kind: "custom", label: "Fake", baseUrl: "http://fake.invalid", enabled: true });
for (const r of Object.keys(settings.roles)) settings.roles[r] = { model: "fake/model" };

const open: InstanceType<typeof Workspace>[] = [];
after(() => {
  for (const w of open) w.closeAll();
  rmSync(home, { recursive: true, force: true });
});

let n = 0;
async function fresh(involvement: "auto" | "key") {
  const dir = join(root, `lumen_${++n}`);
  const workspace = new Workspace(() => [dir]);
  open.push(workspace);
  const p = workspace.create({
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
      involvement,
      references: [],
    },
  });
  const gateway = new ModelGateway({
    ledger: new Ledger(join(home, `ledger-${n}.sqlite`)),
    secrets: new SecretStore({ env: {}, keychain: false, dir: home }),
    settings: structuredClone(settings),
    providers: [fake],
    caps: { "fake/model": FAKE_CAPS },
  });
  const crew = new Crew({ workspace, registry: buildRegistry(), gateway });
  return { p, crew, gateway };
}

/** what a run did, in order: task rows (kind), model calls per kind, gate events */
function record(p: any, gateway: any) {
  const kinds = p.state.tasks.map((t: any) => t.kind);
  const calls: Record<string, number> = {};
  for (const r of gateway.ledger.query({ project: p.id })) calls[r.taskKind] = (calls[r.taskKind] ?? 0) + 1;
  const gates = p
    .eventsSince(0)
    .filter((e: any) => e.event === "gate")
    .map((e: any) => `${e.data.id}:${e.data.status}${e.data.verdict?.by ? `:${e.data.verdict.by}` : ""}`);
  return { kinds, calls, gates };
}

const until = async (f: () => boolean, ms = 60_000) => {
  for (let t = 0; t < ms && !f(); t += 20) await new Promise((r) => setTimeout(r, 20));
  assert.ok(f(), "timed out");
};

test("parity: a whole run on `auto` gives today's task order, calls and gates", async () => {
  const { p, crew, gateway } = await fresh("auto");
  await crew.run(p, {});
  const r = record(p, gateway);
  // the same rows as the stage machine made, plus the Art Director's own cast (§1.1 C1). Scenes that use no new art
  // animate while the art is drawn (§1.3 "Expansion"), so the order is a partial one.
  assert.deepEqual([...r.kinds].sort(), [
    "art.cast",
    "asset.draw",
    "asset.draw",
    "asset.spec",
    "deliver.export",
    "director.storyboard",
    "producer.plan",
    "review.final",
    "scene.tune",
    "scene.tune",
    "scene.tune",
    "sound.mix",
    "writer.angles",
  ]);
  const at = (k: string) => r.kinds.indexOf(k);
  const last = (k: string) => r.kinds.lastIndexOf(k);
  assert.ok(at("producer.plan") < at("writer.angles") && at("writer.angles") < at("director.storyboard"));
  assert.ok(at("director.storyboard") < at("art.cast") && at("art.cast") < at("asset.spec"));
  assert.ok(at("asset.spec") < at("asset.draw") && last("scene.tune") < at("sound.mix"));
  assert.ok(at("sound.mix") < at("review.final") && at("review.final") < at("deliver.export"));
  assert.equal(r.kinds.at(-1), "deliver.export");
  // the export is v1, and its row says so
  assert.equal(p.state.tasks.find((t: any) => t.kind === "deliver.export")?.v, 1);
  assert.deepEqual(
    p.versions().map((v: any) => [v.v, v.rev]),
    [[1, p.rev()]],
  );
  // the latest version is up to date (Pictures waits on a stand-in the fake couldn't draw)
  assert.equal(p.parts().parts.find((x: any) => x.id === "video")?.state, "ready");
  // the hook walks the new hero in, so it waits for the hero; the payoff and the end card don't
  const plan = (crew as any).planNow(p);
  const deps = (id: string) => plan.tasks.find((t: any) => t.id === id).dependsOn;
  assert.ok(deps("t_tune_hook_r1").includes("t_judge_hero"));
  assert.ok(!deps("t_tune_end_r1").includes("t_judge_hero"));
  assert.ok(
    plan.tasks
      .filter((t: any) => t.status !== "skipped" || !t.expand)
      .every((t: any) => !["pending", "running", "ready"].includes(t.status)),
  );
  // the baseline board: hook, payoff and end card for 3 cues
  assert.deepEqual(
    p.doc().scenes.map((s: any) => s.id),
    ["hook", "payoff", "end"],
  );
  assert.ok(
    p.doc().assets.some((a: any) => a.id === "hero" && a.src.startsWith("lib:")),
    "the library hero stands in",
  );
  // metered calls that answered (the Director's and the Pixel Artist's failures leave no row)
  assert.deepEqual(r.calls, {
    "producer.plan": 1,
    "writer.angles": 1,
    "asset.spec": 1,
    "scene.tune": 3,
    "review.final": 1,
  });
  assert.deepEqual(r.gates, [
    "g0_brief:passed:producer",
    "g1_script:passed:producer",
    "g2_animatic:passed:producer",
    "g3_rough:passed:producer",
    "g4_final:passed:producer",
  ]);
  assert.equal(p.state.stage, "deliver");
  assert.equal(p.state.status.line, "Your video is ready");
  assert.ok(p.files().some((f: any) => f.kind === "video"));
});

test("parity: `key` stops at the brief, the script pick, the rough cut; the animatic passes by itself (D2)", async () => {
  const { p, crew } = await fresh("key");
  const run = crew.run(p, {});
  const gate = (id: string) => p.state.gates.find((g: any) => g.id === id)!;
  await until(() => gate("g0_brief").status === "open");
  crew.gate(p, "g0_brief", { verdict: "approve", by: "user" });
  await until(() => p.state.questions.some((q: any) => q.status === "open" && /Which script/.test(q.question)));
  const q = p.state.questions.find((x: any) => x.status === "open")!;
  await p.answer(q.id, { optionId: "angle_1" }, "user");
  await until(() => gate("g3_rough").status === "open");
  assert.equal(gate("g2_animatic").status, "passed");
  assert.equal(gate("g2_animatic").verdict?.by, "producer");
  assert.match(p.doc().script.cues[0].text, /Night falls/);
  crew.gate(p, "g3_rough", { verdict: "approve", by: "user" });
  await run;
  // "Looks good" at the rough cut passes the final as well
  assert.equal(gate("g4_final").status, "passed");
  assert.ok(p.files().some((f: any) => f.kind === "video"));
});
