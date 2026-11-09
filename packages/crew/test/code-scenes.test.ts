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
  assert.ok(issues.some((i) => /hub is a code scene with no beat/.test(i)), issues.join("\n"));
  assert.ok(issues.some((i) => /hub\.assets: "dragon" is not in the asset list/.test(i)), issues.join("\n"));
  assert.ok(issues.some((i) => /last scene must be the end card/.test(i)), issues.join("\n"));

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
