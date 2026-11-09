// Code scenes in the crew (docs/PIP-ORCHESTRATION.md §1.13): the storyboard can board one (a beat and its assets, a
// stub bundle), the plan codes it with scene.code in place of a tune, the Scene Coder's handler writes a bundle that
// loads and renders (repairs, a fallback that keeps the stub, critique rounds that keep the last loading version), and
// a change on a code scene reaches the coder. Over FakeProvider and the fictional QuestDay example only.
import assert from "node:assert/strict";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

const home = mkdtempSync(join(tmpdir(), "pap-code-"));
process.env.PAP_HOME = home;
const root = join(home, "projects");
mkdirSync(root, { recursive: true });
const EXAMPLE = new URL("../../../examples/questday/", import.meta.url).pathname;

const { buildRegistry, Workspace } = await import("@pap/tools");
const { ModelGateway } = await import("../src/gateway-impl.ts");
const { FakeProvider, FAKE_CAPS, Ledger, SecretStore, defaultSettings, setPriceOverride } = await import(
  "../src/llm/index.ts"
);
const { Crew } = await import("../src/orchestrator.ts");
const { StoryboardOut } = await import("../src/outputs.ts");
const { checkRecipeParams } = await import("@pap/engine/recipes");

type Req = import("../src/llm/types.ts").ChatRequest;

const open: InstanceType<typeof Workspace>[] = [];
after(() => {
  for (const w of open) w.closeAll();
  rmSync(home, { recursive: true, force: true });
});

let n = 0;
async function crewOn(answer: (req: Req) => any) {
  const dir = join(root, `code_${++n}`);
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
  const id = workspace.list().find((x) => x.dir === dir)!.id;
  const p = workspace.get(id);
  await p.patch([{ op: "replace", path: "/budget/capUsd", value: 5 }], { reason: "t", author: { kind: "user" } });
  return { crew, p, dir };
}

/** QuestDay's cues as three scenes: a recipe scene, a code scene (the hub) and a code end card */
const codeBoard = (hubKind: "code" | "recipe" = "code") =>
  StoryboardOut.parse({
    scenes: [
      {
        id: "grind",
        title: "A grind",
        cues: ["c01"],
        recipes: [{ id: "backdrop_night" }, { id: "walk_in" }, { id: "block_bump" }],
      },
      hubKind === "code"
        ? {
            id: "hub",
            title: "One quest board",
            cues: ["c02", "c03"],
            kind: "code",
            beat: "0-1 s: the hero stands left. 1-3 s: three stars drop into a row above, one per beat.",
            assets: ["hero", "items"],
          }
        : {
            id: "hub",
            title: "One quest board",
            cues: ["c02", "c03"],
            recipes: [{ id: "backdrop_night" }, { id: "walk_in" }, { id: "item_collect" }],
          },
      {
        id: "end",
        title: "Press start",
        cues: ["c04"],
        kind: "code",
        endCard: true,
        beat: "The title QUESTDAY in brass at the centre, PRESS START blinking under it, the hero waving.",
        assets: ["hero", "font"],
      },
    ],
    newAssets: [],
  });

test("the storyboard boards a code scene: checked, written as kind code with its beat and a stub that renders", async () => {
  const { crew, p, dir } = await crewOn(() => ({ error: new Error("no model call expected") }));
  const board = codeBoard();
  assert.deepEqual((crew as any).checkBoard(p, board, checkRecipeParams), []);
  // a code scene needs a beat and listed assets; only the last scene is the end card
  const bad = codeBoard();
  bad.scenes[1].beat = "";
  bad.scenes[1].assets = ["dragon"];
  bad.scenes[2].endCard = false;
  const issues = (crew as any).checkBoard(p, bad, checkRecipeParams) as string[];
  assert.ok(
    issues.some((i) => /hub is a code scene with no beat/.test(i)),
    issues.join("\n"),
  );
  assert.ok(
    issues.some((i) => /hub\.assets: "dragon" is not in the asset list/.test(i)),
    issues.join("\n"),
  );
  assert.ok(
    issues.some((i) => /last scene must be the end card/.test(i)),
    issues.join("\n"),
  );

  const t = (crew as any).task(p, { kind: "director.storyboard", role: "director", title: "board" });
  await (crew as any).applyBoard(p, t, board);
  const hub = p.doc().scenes.find((s: any) => s.id === "hub") as any;
  assert.equal(hub.kind, "code");
  assert.equal(hub.bundle, "hub");
  assert.match(hub.beat, /three stars/);
  assert.deepEqual(hub.assets, ["hero", "items"]);
  const end = p.doc().scenes.find((s: any) => s.id === "end") as any;
  assert.equal(end.endCard, true);
  const entry = p.doc().code.find((c: any) => c.id === "hub")!;
  assert.deepEqual(entry, { id: "hub", file: "code/hub.mjs", fullFrame: false, sfx: false, stub: true });
  assert.match(readFileSync(join(dir, "code", "hub.mjs"), "utf8"), /The Scene Coder replaces it/);
  // the stub renders in the sandbox (the animatic and the stills work before the code exists)
  const tl = p.timeline();
  const w = tl.scenes.find((s) => s.id === "hub")!;
  const png = await p.still((w.from + w.to) / 2, 1);
  assert.ok(png.length > 100);
  // the board again with the hub from recipes: the scene turns back, its stub entry goes
  await (crew as any).applyBoard(p, t, codeBoard("recipe"));
  const back = p.doc().scenes.find((s: any) => s.id === "hub") as any;
  assert.equal(back.kind, "decl");
  assert.ok(back.recipes.some((r: any) => r.id === "item_collect"));
  assert.ok(!p.doc().code.some((c: any) => c.id === "hub"));
  assert.ok(p.doc().code.some((c: any) => c.id === "end"));
  assert.ok(existsSync(join(dir, "code", "end.mjs")));
});

const rules = await import("../src/plan/rules.ts");
const EXAMPLE_BUNDLE = readFileSync(new URL("../prompts/scene-coder/example.mjs", import.meta.url), "utf8");
/** the public example, as the hub's code (it carries c02 too) */
const hubCode = (tweak = "") => EXAMPLE_BUNDLE.replace('const ID = "quest";', `const ID = "hub";${tweak}`);
const BROKEN =
  'import { clear } from "pap:engine";\nexport function draw(t) { clear(); throw new Error("boom at " + t); }\n';
const run = () =>
  ({
    abort: new AbortController(),
    paused: false,
    startedAt: new Date().toISOString(),
    done: { redone: new Set(), reboarded: [], approximated: [], exported: false },
    triggers: [],
    redos: new Map(),
    id: "run_x",
    revisions: 0,
  }) as any;
const isWrite = (req: Req) => /You are the Scene Coder of a pixel-art pitch video/.test(req.system ?? "");
const isCritique = (req: Req) => /checking your own code scene/.test(req.system ?? "");
const lastText = (req: Req) => {
  const m = req.messages.at(-1)!;
  return typeof m.content === "string" ? m.content : m.content.map((c: any) => c.text ?? "").join("\n");
};

async function boarded(answer: (req: Req) => any) {
  const c = await crewOn(answer);
  const t = (c.crew as any).task(c.p, { kind: "director.storyboard", role: "director", title: "board" });
  await (c.crew as any).applyBoard(c.p, t, codeBoard());
  const pt = rules.mkTask({ id: "t_code_hub_r1", kind: "scene.code", scene: "hub", dependsOn: [] } as any, {
    env: (c.crew as any).planEnv(c.p),
    rev: 1,
  });
  return { ...c, pt };
}

test("the plan codes a code scene: scene.code by the Scene Coder in place of its tune, waiting for its art", async () => {
  const { crew, p } = await crewOn(() => ({ error: new Error("no model call expected") }));
  const t = (crew as any).task(p, { kind: "director.storyboard", role: "director", title: "board" });
  await (crew as any).applyBoard(p, t, codeBoard());
  const ctx = (crew as any).rulesCtx(p, 1);
  let ts = rules.rulesPlan(p.doc(), ctx);
  assert.ok(
    ts.some((x) => x.id === "t_code_scenes" && x.expand === "per_scene"),
    "the estimate counts code scenes",
  );
  for (const x of ts) if (["t_producer", "t_g0", "t_angles", "t_g1", "t_storyboard"].includes(x.id)) x.status = "done";
  const out = rules.expandPlan(
    ts,
    p.doc(),
    [{ name: "badge", kind: "icon", description: "a small quest badge icon" }],
    {
      ...ctx,
      assetsOf: (s: string) => (s === "hub" ? ["hero", "items", "badge"] : (ctx.assetsOf(s) as string[])),
    },
  )!;
  ts = out.tasks;
  const code = ts.find((x) => x.id === "t_code_hub_r1")!;
  assert.equal(code.kind, "scene.code");
  assert.equal(code.role, "scene-coder");
  assert.equal(code.instance, "scene-coder:hub");
  assert.ok(code.dependsOn.includes("t_judge_badge"), "it waits for the new art it draws");
  assert.ok(!ts.some((x) => x.kind === "scene.tune" && x.scene === "hub"), "no tune for a code scene");
  assert.ok(ts.some((x) => x.id === "t_tune_grind_r1" && x.kind === "scene.tune"));
  assert.ok(ts.some((x) => x.id === "t_code_end_r1"));
  assert.ok(ts.find((x) => x.id === "t_mix")!.dependsOn.includes("t_code_hub_r1"));
  assert.ok(code.estUsd[1] > 0, "priced from the scene.code and scene.patch priors");
  // a redo of a code scene is the coder's again, round 2
  const red = rules.addRedo(ts, ["hub"], { ...ctx, rev: 2 }, { reason: "a note" });
  const again = red.tasks.find((x) => red.added.includes(x.id))!;
  assert.equal(again.kind, "scene.code");
  assert.equal(again.round, 2);
});

test("scene.code writes a bundle that loads and renders; its sfxEvents feed the sound; the critique can ship", async () => {
  const seen: string[] = [];
  const { crew, p, pt, dir } = await boarded((req) => {
    if (isWrite(req)) {
      seen.push("write");
      const u = lastText(req);
      assert.match(u, /three stars drop/, "the beat");
      assert.match(u, /c02: S\("c02"\) = /, "the cue times");
      assert.match(u, /items \(12x12\): pc, gamepad/, "the assets with frames and sizes");
      assert.match(u, /- text\(str, x, y, opts = \{\}\)/, "the API sheet from the real exports");
      assert.match(u, /const ID = "quest"/, "the example bundle");
      return { json: { code: hubCode(), notes: "three stars drop into the row" } };
    }
    if (isCritique(req)) {
      seen.push("critique");
      assert.ok(
        (req.messages.at(-1)!.content as any[]).some((c: any) => c.type === "image"),
        "the strip",
      );
      return { json: { code: hubCode(), notes: "ship" } };
    }
    return { error: new Error(`unexpected: ${(req.system ?? "").slice(0, 40)}`) };
  });
  const out = await (crew as any).sceneCode(p, run(), pt);
  assert.equal(out.status, "done");
  assert.equal(out.outcome, undefined);
  assert.deepEqual(seen, ["write", "critique"]);
  assert.match(readFileSync(join(dir, "code", "hub.mjs"), "utf8"), /const ID = "hub"/);
  const entry = p.doc().code.find((c: any) => c.id === "hub")!;
  assert.deepEqual(entry, { id: "hub", file: "code/hub.mjs", fullFrame: false, sfx: true });
  assert.deepEqual(p.state.sceneStatus.hub, { version: "render", state: "ready" });
  const last = p.readHistory().at(-1)!;
  assert.equal(last.author.role, "scene-coder");
  const ren = await p.renderer_();
  const sfx = await ren.sfxEvents();
  const w = p.timeline().scenes.find((s) => s.id === "hub")!;
  assert.equal(sfx.filter((e) => e.type === "coin" && e.t >= w.from && e.t < w.to).length, 3);
  assert.ok((await p.still(w.to - 0.2, 1)).length > 100);
  // coded and ready: a resume skips it
  assert.equal((await (crew as any).sceneCode(p, run(), pt)).status, "skipped");
});

test("scene.code repairs a sandbox error twice, then keeps the stub with a note (a fallback, never a crash)", async () => {
  const asked: string[] = [];
  const { crew, p, pt } = await boarded((req) => {
    if (!isWrite(req)) return { error: new Error("unexpected") };
    asked.push(lastText(req));
    // the first answer runs into the output limit: that is a repair too
    if (asked.length === 1) return { text: "Thinking about where the stars land", stop: "max_tokens" };
    return { json: { code: BROKEN, notes: "draws" } };
  });
  const out = await (crew as any).sceneCode(p, run(), pt);
  assert.equal(out.outcome, "fallback");
  assert.match(out.note, /kept the sketch/);
  assert.equal(asked.length, 3, "one write and two repairs (the cut-off answer was the first)");
  assert.match(asked[1], /Think less and write a shorter module/);
  assert.match(asked[2], /draw\([0-9.]+\) threw: boom at/);
  const entry = p.doc().code.find((c: any) => c.id === "hub")!;
  assert.equal(entry.stub, true, "the stub stays");
  assert.ok(p.doc().notes.some((n: any) => /hub keeps the storyboard's sketch/.test(n.text)));
  assert.notEqual(p.state.sceneStatus.hub?.version, "render");
  const parts = p.parts();
  assert.notEqual(
    parts.parts.find((x: any) => x.id === "pictures")?.state,
    "ready",
    "a stub is not a finished picture",
  );
});

test("scene.code: a critique round that breaks loading is dropped and the last loading version stays", async () => {
  let critiques = 0;
  const { crew, p, pt, dir } = await boarded((req) => {
    if (isWrite(req)) return { json: { code: hubCode("\n// v1"), notes: "v1" } };
    if (isCritique(req)) {
      critiques++;
      // round 1 improves it (it loads); round 2 breaks it
      return critiques === 1
        ? { json: { code: hubCode("\n// v2"), notes: "slower stars" } }
        : { json: { code: BROKEN, notes: "a bolder look" } };
    }
    return { error: new Error("unexpected") };
  });
  const out = await (crew as any).sceneCode(p, run(), pt);
  assert.equal(out.status, "done");
  assert.equal(critiques, 2);
  const src = readFileSync(join(dir, "code", "hub.mjs"), "utf8");
  assert.match(src, /\/\/ v2/, "the last version that loaded");
  assert.ok(!src.includes("boom"));
});

test("the API sheet can't drift: one line per pap:engine export and per pap:timeline name", async () => {
  const { ENGINE_DOC, TIMELINE_DOC, apiSheet } = await import("../src/scene-code.ts");
  const { ENGINE_EXPORTS } = await import("@pap/engine/core");
  const { loadProject, timelineModule } = await import("@pap/render");
  assert.deepEqual(Object.keys(ENGINE_DOC).sort(), [...ENGINE_EXPORTS].sort());
  const tl = timelineModule(loadProject(EXAMPLE));
  assert.deepEqual(Object.keys(TIMELINE_DOC).sort(), [...Object.keys(tl), "S", "E"].sort());
  const sheet = apiSheet();
  for (const k of ENGINE_EXPORTS) assert.match(sheet, new RegExp(`^- ${k}\\b`, "m"), k);
  assert.match(sheet, /- sprite\(rows, x, y, opts = \{\}\)/);
});

test("code scenes in every scene check: the end card, the parts, Pip's lines and the lints", async () => {
  const { crew, p } = await crewOn(() => ({ error: new Error("no model call expected") }));
  const t = (crew as any).task(p, { kind: "director.storyboard", role: "director", title: "board" });
  await (crew as any).applyBoard(p, t, codeBoard());
  const { isEndCard, sceneMakeup } = await import("../src/scene-code.ts");
  const d = p.doc();
  assert.equal(isEndCard(d.scenes.find((s: any) => s.id === "end")!), true, "a code scene can be the end card");
  assert.equal(isEndCard(d.scenes.find((s: any) => s.id === "hub")!), false);
  assert.match(sceneMakeup(d.scenes.find((s: any) => s.id === "hub")!, d), /^code \(sketch\): 0-1 s: the hero/);
  // a stub is a sketch, not a finished picture, even after the animatic marks every scene ready
  for (const s of d.scenes) p.setSceneStatus(s.id, { version: "animatic", state: "ready" });
  const pictures = p.parts().parts.find((x) => x.id === "pictures")!;
  assert.notEqual(pictures.state, "ready");
  assert.match(pictures.why ?? "", /still a sketch/);
  const { lintProject, lintCodeProbes, lintBundleSource } = await import("@pap/engine/lints");
  const missing = { ...d, scenes: d.scenes.map((s: any) => (s.id === "hub" ? { ...s, assets: ["dragon"] } : s)) };
  const ls = lintProject(missing as any, p.timeline());
  assert.ok(ls.some((l) => l.rule === "missing-asset" && l.scene === "hub" && /dragon/.test(l.message)));
  const probes = lintCodeProbes("hub", [
    {
      t: 1,
      ms: 400,
      boxes: [
        { kind: "text", text: "TOO LOW", x: 10, y: 150, w: 30, h: 8 },
        { kind: "text", text: "OFF", x: 300, y: 10, w: 40, h: 8 },
        { kind: "missing-asset", name: "dragon" },
      ],
    },
  ]);
  assert.deepEqual(probes.map((l) => l.rule).sort(), ["caption-zone", "placeholder-box", "slow-draw", "text-clipped"]);
  const src = lintBundleSource(
    "hub",
    'import { frame } from "pap:engine";\nimport x from "node:fs";\nexport function draw(t) { Math.random(); frame("dragon", "fly"); frame("items", "nope"); }',
    new Map([["items", ["star"]]]),
  );
  assert.deepEqual(src.map((l) => l.rule).sort(), [
    "bundle-banned",
    "bundle-import",
    "missing-frame",
    "placeholder-box",
  ]);
});
