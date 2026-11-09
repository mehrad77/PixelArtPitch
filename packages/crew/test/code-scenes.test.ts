// Code scenes in the crew (docs/PIP-ORCHESTRATION.md §1.16): the storyboard can board one (a beat and its assets, a
// stub bundle), the plan codes it with scene.code in place of a tune, the Scene Coder's handler writes a bundle that
// loads and renders (repairs, a fallback that keeps the stub, critique rounds that keep the last loading version), and
// a change on a code scene reaches the coder. Over FakeProvider and the fictional QuestDay example only.
import assert from "node:assert/strict";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
      return { json: { code: BROKEN, notes: "a bolder look" } };
    }
    return { error: new Error("unexpected") };
  });
  const out = await (crew as any).sceneCode(p, run(), pt);
  assert.equal(out.status, "done");
  assert.equal(critiques, 1, "a first write gets at most one critique round");
  const src = readFileSync(join(dir, "code", "hub.mjs"), "utf8");
  assert.match(src, /\/\/ v1/, "the last version that loaded");
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

test("a G3 note on a code scene goes to the Scene Coder, and the change redoes only that scene's code", async () => {
  const { routeChange } = await import("../src/plan/route.ts");
  const { gateNotes } = await import("../src/orchestrator.ts");
  // the words alone go to the Animator; on a code scene they reach the coder; a story change still re-boards it
  assert.equal(routeChange({ text: "make the stars bigger", target: { scene: "hub" } }), "animator");
  assert.equal(
    routeChange({ text: "make the stars bigger", target: { scene: "hub" }, codeScene: true }),
    "scene-coder",
  );
  assert.equal(
    routeChange({ text: "add a castle", target: { scene: "hub" }, category: "story", codeScene: true }),
    "director",
  );
  const { crew, p } = await crewOn(() => ({ error: new Error("no model call expected") }));
  const t = (crew as any).task(p, { kind: "director.storyboard", role: "director", title: "board" });
  await (crew as any).applyBoard(p, t, codeBoard());
  const notes = gateNotes(p, "g3_rough", { reasons: ["the stars fall too fast"], items: ["One quest board"] });
  assert.deepEqual(
    notes.map((x) => [x.target.scene, x.assignee]),
    [["hub", "scene-coder"]],
  );
  // a note that came in as the Animator's (crew_request_change has no document) is the coder's once it arrives
  const n = p.addNote({
    target: { scene: "hub" },
    category: "timing",
    text: "slower stars",
    assignee: "animator",
    by: "user",
  });
  (crew as any).runs.set(p.id, { held: false } as any);
  crew.requestChange(p, n);
  (crew as any).runs.delete(p.id);
  assert.equal(p.state.notes.find((x) => x.id === n.id)!.assignee, "scene-coder");
  // the change's revision: every scene is done and rendered; only the hub's code runs again
  const ctx = (crew as any).rulesCtx(p, 1);
  const ts = rules.rulesPlan(p.doc(), ctx, { scenes: p.doc().scenes.map((s) => s.id), newAssets: [] });
  for (const x of ts) x.status = "done";
  const ss = Object.fromEntries(p.doc().scenes.map((s) => [s.id, { version: "render", state: "ready" }])) as any;
  ss.hub = { version: "animatic", state: "stale" };
  const out = rules.changeRevision(ts, { scope: ["hub"] }, "animate", { ...ctx, rev: 2 }, ss);
  const live = out.tasks.filter((x) => x.status === "pending" && rules.isSceneWork(x));
  assert.deepEqual(
    live.map((x) => [x.kind, x.scene]),
    [["scene.code", "hub"]],
  );
});

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
const boardTask = {
  id: "t_storyboard",
  kind: "director.storyboard",
  role: "director",
  tier: "role",
  instance: "director",
  dependsOn: [],
  estUsd: [0, 0],
  estSec: [0, 0],
  conditional: false,
  status: "running",
  taskIds: [],
  addedIn: 0,
} as any;
/** QuestDay told by two players: its own hero and the library's gamer */
async function twoPlayers(p: any) {
  await p.patch(
    [
      {
        op: "replace",
        path: "/brief/idea",
        value: `${p.doc().brief.idea} Told by the hero and the gamer, side by side.`,
      },
    ],
    { reason: "t", author: { kind: "user" } },
  );
}

test("the players stay on stage: a scene that leaves one out is a soft warning, asked once, and a code scene lists them", async () => {
  const sys: string[] = [];
  const { crew, p } = await crewOn((req) => {
    sys.push(JSON.stringify(req.messages.at(-1)?.content ?? ""));
    return { json: codeBoard() };
  });
  await twoPlayers(p);
  const c = crew as any;
  assert.deepEqual(c.playersOf(p, codeBoard()), ["hero", "gamer"], "the brief's characters, in its order");
  // the warning names who is missing where; the hard checks still pass, so it never costs the board
  const warn = c.boardWarnings(p, codeBoard()) as string[];
  assert.equal(warn.length, 2, warn.join("\n"));
  assert.match(warn[0], /scene hub leaves out gamer: the players stay on stage/);
  assert.match(warn[1], /scene end leaves out gamer/);
  assert.deepEqual(c.checkBoard(p, codeBoard(), checkRecipeParams), []);
  // a close-up is left alone; the first scene is where they load in
  const close = codeBoard();
  close.scenes[1].beat = "A close-up of the quest board: three stars drop into a row, one per beat.";
  assert.equal((c.boardWarnings(p, close) as string[]).length, 1);
  // the run: the first answer leaves the gamer out, the one repair asks, the model ignores it, the board stands
  await c.storyboard(p, fakeRun(), boardTask);
  assert.equal(sys.length, 2, "one storyboard call and one repair, never a second for a warning");
  assert.match(sys[1], /scene hub leaves out gamer/);
  const hub = p.doc().scenes.find((s: any) => s.id === "hub") as any;
  assert.equal(hub.kind, "code", "the Director's board, not the baseline");
  assert.deepEqual(hub.assets, ["hero", "items", "gamer"]);
  assert.deepEqual((p.doc().scenes.find((s: any) => s.id === "end") as any).assets, ["hero", "font", "gamer"]);
});

test("a counted list: a cue reading three things asks for one code scene whose beat names three slots", async () => {
  const { crew, p } = await crewOn(() => ({ error: new Error("no model call expected") }));
  const c = crew as any;
  await p.patch([{ op: "replace", path: "/script/cues/1/text", value: "QuestDay gives you three things:" }], {
    reason: "t",
    author: { kind: "user" },
  });
  const { countedLists, beatHasSlots } = await import("../src/orchestrator.ts");
  assert.deepEqual(countedLists(p.doc().script.cues), [{ cue: "c02", n: 3, words: "three things" }]);
  // the hub boards c02 as a code scene, but its beat has no slots: the warning says what to do
  const warn = (c.boardWarnings(p, codeBoard()) as string[]).filter((w) => /counts/.test(w));
  assert.equal(warn.length, 1);
  assert.match(warn[0], /cue c02 counts "three things": .* one code scene with 3 numbered slots/);
  // a recipe scene for the list is the same warning; a beat with three numbered slots is not
  assert.equal((c.boardWarnings(p, codeBoard("recipe")) as string[]).filter((w) => /counts/.test(w)).length, 1);
  const good = codeBoard();
  good.scenes[1].beat =
    "Three numbered slots, 1-2-3, in a row at y 60. With c02 slot 1 fills with a star, then 2 and 3.";
  assert.deepEqual(
    (c.boardWarnings(p, good) as string[]).filter((w) => /counts/.test(w)),
    [],
  );
  assert.ok(beatHasSlots("slots(3, { x: 40, y: 60 }) fill on c12, c13, c14", 3));
  assert.ok(!beatHasSlots("the three mentors walk in one by one", 3));
});

test("a code redo reads the person's note ahead of the old beat, and its critique checks the change too", async () => {
  const seen: { write?: string; critique?: string } = {};
  const { crew, p, pt } = await boarded((req) => {
    if (isWrite(req)) {
      seen.write = lastText(req);
      return { json: { code: hubCode(), notes: "a day sky" } };
    }
    if (isCritique(req)) {
      seen.critique = lastText(req);
      return { json: { code: hubCode(), notes: "ship" } };
    }
    return { error: new Error(`unexpected: ${(req.system ?? "").slice(0, 40)}`) };
  });
  p.addNote({
    target: { scene: "hub" },
    category: "art",
    text: "it's still night! make it day",
    assignee: "scene-coder",
    by: "user",
  });
  await (crew as any).sceneCode(p, run(), pt);
  const w = seen.write ?? "";
  const change = w.indexOf("The person asked for this change");
  assert.ok(change >= 0, "the change is in the prompt");
  assert.ok(change < w.indexOf("The beat (from the Director)"), "ahead of the beat");
  assert.match(w, /the change wins[\s\S]*- it's still night! make it day/);
  assert.match(seen.critique ?? "", /it's still night! make it day/);
  // a re-plan that hands back the same beat for a code scene is told to rewrite it
  const rb = await crewOn((req) => {
    if (/The person asked for a change/.test(req.system ?? ""))
      return {
        json: { scenes: [{ id: "hub", kind: "code", beat: codeBoard().scenes[1].beat, assets: ["hero", "items"] }] },
      };
    return { error: new Error("unexpected") };
  });
  const t = (rb.crew as any).task(rb.p, { kind: "director.storyboard", role: "director", title: "board" });
  await (rb.crew as any).applyBoard(rb.p, t, codeBoard());
  rb.p.addNote({
    target: { scene: "hub" },
    category: "story",
    text: "make it a castle",
    assignee: "director",
    by: "user",
  });
  const logs: string[] = [];
  rb.p.events.on("event", (e: any) => e.event === "log" && logs.push(String(e.data?.text ?? "")));
  const out = await (rb.crew as any).reboard(rb.p, fakeRun(), ["hub"], { ...boardTask, scenes: ["hub"] });
  assert.equal(out.outcome, "fallback", "the same beat twice is no change");
  assert.ok(
    (rb.p.doc().code.find((c: any) => c.id === "hub") as any).stub,
    "the hub is still the board's stub, never reset from the old beat",
  );
});

test("make it day: no re-board, a no-model look.time patches the canvas, and only a fixed-sky code scene is patched", async () => {
  const { routeChange, timeAsked } = await import("../src/plan/route.ts");
  assert.equal(timeAsked("make the sky sunny in a day"), "day");
  assert.equal(timeAsked("sunset instead"), "dusk");
  assert.equal(timeAsked("it's still night!"), null, "a complaint about the old time is the coder's redo");
  assert.equal(routeChange({ text: "make the sky sunny in a day" }), "director");
  assert.equal(routeChange({ text: "make it day", target: { scene: "hub" }, codeScene: true }), "director");
  const { crew, p } = await crewOn(() => ({ error: new Error("no model call expected") }));
  const c = crew as any;
  const t0 = c.task(p, { kind: "director.storyboard", role: "director", title: "board" });
  await c.applyBoard(p, t0, codeBoard());
  // the preview: the Director's, no re-board; the code scenes draw their sky from TIME (the stubs call
  // skyGradient), so none is re-made (§1.12, check first)
  const pr = crew.previewChange(p, { text: "make the sky sunny in a day" });
  assert.equal(pr.role, "director");
  assert.deepEqual(pr.scenes, []);
  // a code scene with a fixed night sky is the one scene patched
  const hub = p.doc().code.find((x: any) => x.id === "hub")!;
  writeFileSync(
    join(p.dir, hub.file),
    'import { clear } from "pap:engine";\nexport function draw(t) {\n  clear("#0f1411");\n}\n',
  );
  assert.deepEqual(crew.previewChange(p, { text: "make the sky sunny in a day" }).scenes, ["hub"]);
  // the revision: look.time first, the code scenes' redo after it, no storyboard and no tune of the recipe scene
  const ctx = c.rulesCtx(p, 1);
  const ts = rules.rulesPlan(p.doc(), ctx, { scenes: p.doc().scenes.map((s: any) => s.id), newAssets: [] });
  for (const x of ts) x.status = "done";
  const ss = Object.fromEntries(p.doc().scenes.map((s: any) => [s.id, { version: "render", state: "ready" }])) as any;
  ss.hub = ss.end = { version: "animatic", state: "stale" };
  const out = rules.changeRevision(ts, { scope: ["hub", "end"], time: "day" }, "animate", { ...ctx, rev: 2 }, ss);
  const live = out.tasks.filter((x: any) => x.status === "pending");
  const look = live.find((x: any) => x.kind === "look.time")!;
  assert.ok(look, live.map((x: any) => x.kind).join(","));
  assert.deepEqual(look.estUsd, [0, 0], "no model call");
  assert.ok(!live.some((x: any) => x.kind === "director.storyboard" || x.kind === "scene.tune"));
  const codes = live.filter((x: any) => x.kind === "scene.code");
  assert.deepEqual(codes.map((x: any) => x.scene).sort(), ["end", "hub"]);
  for (const x of codes) assert.ok(x.dependsOn.includes(look.id), "re-coded after the sky changes");
  // the handler: canvas.time and the palette, and Pip's line on the cue that still says night
  await p.patch([{ op: "replace", path: "/script/cues/0/text", value: "Night falls. The list waits." }], {
    reason: "t",
    author: { kind: "user" },
  });
  const note = p.addNote({
    target: {},
    category: "art",
    text: "make the sky sunny in a day",
    assignee: "director",
    by: "user",
  });
  const r = { ...fakeRun(), change: { notes: [note.id], time: "day" } };
  const res = await c.lookTime(p, r, { ...boardTask, id: "t_look_time", kind: "look.time" });
  assert.equal(res.status, "done");
  assert.equal(p.doc().canvas.time, "day");
  assert.equal(p.doc().canvas.palette, "pap-night@1", "the time only: the built-in palette follows it");
  const { paletteFor } = await import("@pap/schema");
  assert.equal(paletteFor(p.doc().canvas), "pap-day@1");
  // the crew's palette table follows too: the Scene Coder and the sprite check see the day letters
  const night = c.palette().table.split("\n").length;
  assert.ok(c.palette(p).table.split("\n").length > night, "day adds sky, cloud and sun letters");
  assert.equal(r.done.time, "day");
  assert.match(r.done.timeCue, /^Cue 1 still says "Night falls\. The list waits\." Tell me/);
  // again: nothing to change
  const again = await c.lookTime(p, r, { ...boardTask, id: "t_look_time", kind: "look.time" });
  assert.match(again.note, /nothing was changed: already day/);
  // Pip's card says it in one line
  const { settleCard } = await import("../src/assistant.ts");
  const card: any = {};
  settleCard(card, c.report(p, r, "done"), p);
  assert.match(card.result.text, /^The video is now set at day\. Cue 1 still says "Night falls/);
});

test("an SVG reference reaches vision as a PNG, and an .svg upload is a logo", async () => {
  const { guessType } = await import("../src/brief/registry.ts");
  assert.equal(guessType("gs.svg"), "logo");
  assert.equal(guessType("mark", "image/svg+xml"), "logo");
  const { crew, p, dir } = await crewOn(() => ({ error: new Error("no model call expected") }));
  mkdirSync(join(dir, "private", "refs"), { recursive: true });
  const svg =
    '<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32"><rect x="4" y="4" width="24" height="24" fill="#3a7"/></svg>';
  writeFileSync(join(dir, "private", "refs", "gs.svg"), svg);
  const t = (crew as any).task(p, { kind: "asset.spec", role: "art-director", title: "spec" });
  const [img] = (crew as any).refImage(p, t, "private/refs/gs.svg");
  assert.equal(img.mediaType, "image/png");
  assert.deepEqual([...img.data.slice(0, 4)], [0x89, 0x50, 0x4e, 0x47], "PNG bytes, not the SVG text");
});

/** the hub coded once (a finished scene), with a person's change on it */
async function codedHub(answer: (req: Req) => any, text = "the stars should twinkle more") {
  const b = await boarded(answer);
  writeFileSync(join(b.dir, "code", "hub.mjs"), hubCode());
  const k = b.p.doc().code.findIndex((c: any) => c.id === "hub");
  await b.p.patch([{ op: "replace", path: `/code/${k}/stub`, value: false }], {
    reason: "t",
    author: { kind: "user" },
  });
  b.p.setSceneStatus("hub", { version: "animatic", state: "stale" });
  const note = b.p.addNote({ target: { scene: "hub" }, category: "art", text, assignee: "scene-coder", by: "user" });
  return { ...b, note };
}
const isCheck = (req: Req) => /whether a change a person asked for is already true/.test(req.system ?? "");

test("a code redo is a patch: the current code, no examples, medium effort, and no critique on a clean trial", async () => {
  const seen: string[] = [];
  const { crew, p, pt } = await codedHub((req) => {
    if (isCheck(req)) {
      seen.push("check");
      assert.equal(
        (req.messages.at(-1)!.content as any[]).filter((c: any) => c.type === "image").length,
        3,
        "three stills",
      );
      return { json: { already: false, why: "the stars are still" } };
    }
    if (isWrite(req)) {
      // medium on the card (the fake's caps may lower it further), never the first write's high
      seen.push(`write:${req.effort === "high" ? "high" : "not high"}`);
      const u = lastText(req);
      assert.match(u, /This is a patch\. The scene's code now is below/);
      assert.match(u, /const ID = "hub"/, "the current code");
      assert.doesNotMatch(u, /Example bundles for scenes of another video/, "no examples in a patch");
      return { json: { code: hubCode("\n// twinkle"), notes: "the stars twinkle" } };
    }
    if (isCritique(req)) seen.push("critique");
    return { error: new Error(`unexpected: ${(req.system ?? "").slice(0, 40)}`) };
  });
  const out = await (crew as any).sceneCode(p, run(), { ...pt, patch: true });
  assert.equal(out.status, "done");
  assert.deepEqual(seen, ["check", "write:not high"]);
});

test("check first: a change already true in the frames re-codes nothing", async () => {
  const seen: string[] = [];
  const { crew, p, pt, note, dir } = await codedHub((req) => {
    if (isCheck(req)) {
      seen.push("check");
      return { json: { already: true, why: "three stars already sit in a row" } };
    }
    seen.push("other");
    return { error: new Error("no write expected") };
  }, "three stars in a row");
  const r = run();
  const out = await (crew as any).sceneCode(p, r, pt);
  assert.deepEqual(seen, ["check"]);
  assert.match(out.note, /nothing was changed: already true/);
  assert.deepEqual(r.done.already, [{ scene: "hub", why: "three stars already sit in a row" }]);
  const { settleCard } = await import("../src/assistant.ts");
  const card: any = {};
  settleCard(card, (crew as any).report(p, r, "done"), p);
  assert.match(card.result.text, /^Scene 2 already shows it: three stars already sit in a row\./);
  assert.doesNotMatch(card.result.text, /Nothing was changed|stays open/);
  assert.equal(readFileSync(join(dir, "code", "hub.mjs"), "utf8"), hubCode(), "the code is as it was");
  assert.notEqual(p.state.notes.find((x: any) => x.id === note.id)?.status, "open");
});

test("a change revision patches a coded scene: priced as scene.patch, below a first write", async () => {
  const { crew, p } = await crewOn(() => ({ error: new Error("no model call expected") }));
  const c = crew as any;
  const t0 = c.task(p, { kind: "director.storyboard", role: "director", title: "board" });
  await c.applyBoard(p, t0, codeBoard());
  const ctx = c.rulesCtx(p, 1);
  const ts = rules.rulesPlan(p.doc(), ctx, { scenes: p.doc().scenes.map((s: any) => s.id), newAssets: [] });
  for (const x of ts) x.status = "done";
  const first = ts.find((x: any) => x.kind === "scene.code" && x.scene === "hub")!;
  const ss = Object.fromEntries(p.doc().scenes.map((s: any) => [s.id, { version: "render", state: "ready" }])) as any;
  ss.hub = { version: "animatic", state: "stale" };
  const out = rules.changeRevision(ts, { scope: ["hub"] }, "animate", { ...ctx, rev: 2 }, ss);
  const redo = out.tasks.find((x: any) => x.status === "pending" && x.kind === "scene.code")!;
  assert.equal(redo.patch, true);
  assert.ok(redo.estUsd[1] < first.estUsd[1], `${redo.estUsd} < ${first.estUsd}`);
});
