// The studio's private art (docs/RIGHTS.md): another project's likeness or brand is listed for the crew, casting it
// copies the file in with its flags (never into the library), the plan adds only the person's rights OK (no drawing,
// no cost), and that OK is asked, never passed by itself. A studio with no private art around is unchanged. Over
// FakeProvider and the fictional QuestDay example only; no model call.
import assert from "node:assert/strict";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

const home = mkdtempSync(join(tmpdir(), "pap-studio-"));
process.env.PAP_HOME = home;
const root = join(home, "projects");
mkdirSync(root, { recursive: true });
const EXAMPLE = new URL("../../../examples/questday/", import.meta.url).pathname;

const { buildRegistry, Workspace, studioAssets, studioArtFor, bringStudioAsset } = await import("@pap/tools");
const { libraryAssetDir, userLibraryDir } = await import("@pap/render");
const { ModelGateway } = await import("../src/gateway-impl.ts");
const { FakeProvider, FAKE_CAPS, Ledger, SecretStore, defaultSettings } = await import("../src/llm/index.ts");
const { Crew } = await import("../src/orchestrator.ts");
const { copiedRights, startPlan } = await import("../src/plan/rules.ts");

const open: InstanceType<typeof Workspace>[] = [];
after(() => {
  for (const w of open) w.closeAll();
  rmSync(home, { recursive: true, force: true });
});
const wait = async (ok: () => boolean, ms = 10_000) => {
  const end = Date.now() + ms;
  while (!ok() && Date.now() < end) await new Promise((r) => setTimeout(r, 10));
  assert.ok(ok(), "timed out waiting");
};

/** a drawn asset file: the library's moon, renamed, with its rights */
function artFile(dir: string, name: string, kind: string, rights: Record<string, boolean>) {
  const a = JSON.parse(readFileSync(join(libraryAssetDir("moon")!, "asset.json"), "utf8"));
  mkdirSync(join(dir, "assets"), { recursive: true });
  writeFileSync(join(dir, "assets", `${name}.json`), JSON.stringify({ ...a, id: name, kind, rights }));
  writeFileSync(join(dir, "assets", `${name}.png`), "png");
}

let n = 0;
/** a studio: a target project and (unless `bare`) a source project that keeps a likeness and a brand */
async function studio(opts: { bare?: boolean } = {}) {
  const ws = join(root, `ws_${++n}`);
  const target = join(ws, "target");
  const source = join(ws, "source");
  cpSync(EXAMPLE, target, { recursive: true, filter: (f) => !f.endsWith(".pap-lock") });
  if (!opts.bare) {
    cpSync(EXAMPLE, source, { recursive: true, filter: (f) => !f.endsWith(".pap-lock") });
    const doc = JSON.parse(readFileSync(join(source, "pitch.json"), "utf8"));
    doc.id = "source_pitch";
    doc.title = "Source pitch";
    artFile(source, "mehrad", "character", { likeness: true, brand: false, trademark: false, public: false });
    artFile(source, "platforms", "icon", { likeness: false, brand: true, trademark: true, public: false });
    doc.assets.push(
      {
        id: "mehrad",
        src: "file:assets/mehrad.json",
        flags: { private: true, likeness: { person: "Mehrad", refs: ["private/ref/m.png"] } },
      },
      {
        id: "platforms",
        src: "file:assets/platforms.json",
        flags: { private: true, brand: { owner: "Platform makers", trademark: true } },
      },
    );
    writeFileSync(join(source, "pitch.json"), JSON.stringify(doc, null, 2));
  }
  const settings = defaultSettings();
  settings.providers.push({ id: "fake", kind: "custom", label: "Fake", baseUrl: "http://fake.invalid", enabled: true });
  for (const r of Object.keys(settings.roles)) settings.roles[r] = { model: "fake/model" };
  const workspace = new Workspace(() => [ws]);
  open.push(workspace);
  const gateway = new ModelGateway({
    ledger: new Ledger(join(home, `ledger-${n}.sqlite`)),
    secrets: new SecretStore({ env: {}, keychain: false, dir: home }),
    settings,
    providers: [new FakeProvider(() => ({ error: new Error("no model call in this test") }), { id: "fake" })],
    caps: { "fake/model": FAKE_CAPS },
  });
  const crew = new Crew({ workspace, registry: buildRegistry(), gateway });
  const p = workspace.get(workspace.list().find((x) => x.dir === target)!.id);
  const castTask = () => (crew as any).task(p, { kind: "art.cast", role: "art-director", title: "Casting" });
  return { workspace, crew, p, castTask, source };
}

test("the crew's asset list has another project's private art, marked private; never the project's own", async () => {
  const { workspace, crew, p } = await studio();
  const all = studioAssets(workspace);
  assert.deepEqual(
    all.map((a) => [a.id, a.project.id]),
    [
      ["mehrad", "source_pitch"],
      ["platforms", "source_pitch"],
    ],
  );
  assert.ok(all[0].flags.likeness, "flags as the source lists them");
  assert.deepEqual(
    studioArtFor(workspace, p).map((a) => a.id),
    ["mehrad", "platforms"],
  );
  // the source itself: its own art is already its own
  assert.deepEqual(studioArtFor(workspace, workspace.get("source_pitch")), []);
  const lines: string[] = (crew as any).studioList(p);
  assert.match(
    lines[0],
    /^mehrad: character \d+x\d+, frames .+ \(private studio art from Source pitch, a likeness; never public\)$/,
  );
  assert.match(lines[1], /^platforms: icon .+, a brand; never public\)$/);
});

test("casting studio art copies the file with all its flags, never into the library; the rights pick is asked", async () => {
  const { crew, p, castTask } = await studio();
  const t = castTask();
  await (crew as any).castStudio(p, t, ["mehrad", "platforms", "moon"]);
  const ref = p.doc().assets.find((a) => a.id === "mehrad")!;
  assert.equal(ref.src, "file:assets/mehrad.json");
  assert.deepEqual(ref.flags, { private: true, likeness: { person: "Mehrad", refs: ["private/ref/m.png"] } });
  assert.equal(ref.copiedFrom, "source_pitch");
  assert.ok(p.doc().assets.find((a) => a.id === "platforms")!.flags.brand);
  for (const f of ["mehrad.json", "mehrad.png", "platforms.json", "platforms.png"])
    assert.ok(existsSync(join(p.dir, "assets", f)), f);
  assert.equal(JSON.parse(readFileSync(join(p.dir, "assets", "mehrad.json"), "utf8")).rights.likeness, true);
  // never the library: neither layer has it
  assert.equal(libraryAssetDir("mehrad"), null);
  assert.ok(!existsSync(join(userLibraryDir(), "mehrad")));
  // the plan: a rights OK each, no drawing, no cost
  const plan = (crew as any).planNow(p);
  const gates = plan.tasks.filter((x: any) => x.kind === "gate" && x.gate === "rights");
  assert.deepEqual(gates.map((x: any) => [x.asset, x.status]).sort(), [
    ["mehrad", "pending"],
    ["platforms", "pending"],
  ]);
  for (const g of gates) assert.deepEqual(g.estUsd, [0, 0]);
  // nothing to draw: any chain task for it is done ("already in the project"), never pending
  assert.ok(
    !plan.tasks.some(
      (x: any) => x.kind.startsWith("asset.") && ["mehrad", "platforms"].includes(x.asset) && x.status !== "done",
    ),
  );
  // casting again changes nothing
  const rev = plan.rev;
  await (crew as any).castStudio(p, t, ["mehrad"]);
  assert.equal((crew as any).planNow(p).rev, rev);
  // the rights pick: the person's question, never passed by itself
  const pt = gates.find((x: any) => x.asset === "mehrad");
  const out = (crew as any).rights(p, { abort: new AbortController() }, pt);
  await wait(() => p.state.questions.some((q) => q.rights?.asset === "mehrad" && q.status === "open"));
  const q = p.state.questions.find((x) => x.rights?.asset === "mehrad")!;
  assert.deepEqual(q.rights, { asset: "mehrad", private: true });
  await assert.rejects(p.answer(q.id, { optionId: "use" }, "claude-desktop"), /only the person/);
  await p.answer(q.id, { optionId: "use" }, "user");
  assert.equal((await out).status, "done");
});

test("a copied likeness keeps its rights OK pending when the plan is rebuilt from the project", async () => {
  const { crew, p, castTask } = await studio();
  await (crew as any).castStudio(p, castTask(), ["mehrad"]);
  const ctx = (crew as any).rulesCtx(p, 0);
  const tasks = startPlan(p.doc(), p.state, ctx);
  const gate = tasks.find((t) => t.kind === "gate" && t.gate === "rights" && t.asset === "mehrad");
  assert.ok(gate && gate.status === "pending", "never done because the art is already there");
  // an asset of the project's own (not copied) is unchanged: its art stands for its OK, as before
  const own = {
    ...p.doc(),
    assets: p.doc().assets.map((a) => (a.id === "mehrad" ? { ...a, copiedFrom: undefined } : a)),
  };
  const t2 = startPlan(own, p.state, ctx).find((t) => t.kind === "gate" && t.gate === "rights" && t.asset === "mehrad");
  assert.equal(t2?.status, "done");
  assert.equal(copiedRights(tasks, p.doc(), ctx), null, "one OK per asset");
});

test("a studio with no private art around: nothing listed, nothing cast, the plan unchanged", async () => {
  const { workspace, crew, p, castTask } = await studio({ bare: true });
  assert.deepEqual(studioAssets(workspace), []);
  assert.deepEqual((crew as any).studioList(p), []);
  const before = p.doc().assets.length;
  await (crew as any).castStudio(p, castTask(), ["mehrad"]);
  assert.equal(p.doc().assets.length, before);
  assert.equal((crew as any).planNow(p), null, "no revision written");
  assert.equal(await bringStudioAsset(p, { id: "moon" } as any, { kind: "user" }), false, "a name it has");
});

test("cast while the plan runs: the rights OK is added after the animatic and the scenes using it wait", async () => {
  const { crew, p, castTask } = await studio();
  // the flag scene's hero is the studio's likeness
  await p.patch([{ op: "replace", path: "/scenes/2/recipes/0/params/hero", value: "mehrad" }], {
    reason: "t",
    author: { kind: "user" },
  });
  const before = (crew as any).ensurePlan(p, null);
  assert.ok(!before.tasks.some((t: any) => t.asset === "mehrad"));
  for (const t of before.tasks) if (t.kind === "scene.tune") t.status = "pending";
  await (crew as any).castStudio(p, castTask(), ["mehrad"]);
  const plan = (crew as any).planNow(p);
  const gate = plan.tasks.find((t: any) => t.kind === "gate" && t.gate === "rights" && t.asset === "mehrad");
  assert.ok(gate, "a rights OK");
  assert.equal(gate.status, "pending");
  const tune = (scene: string) => plan.tasks.find((t: any) => t.kind === "scene.tune" && t.scene === scene);
  assert.ok(tune("flag").dependsOn.includes(gate.id), "the scene that uses it waits for the OK");
  assert.ok(!tune("grind").dependsOn.includes(gate.id), "a scene that doesn't, doesn't");
  const g2 = plan.tasks.filter((t: any) => t.kind === "gate" && t.gate === "g2_animatic").at(-1);
  assert.deepEqual(gate.dependsOn, [g2.id]);
  assert.deepEqual(gate.estUsd, [0, 0]);
  assert.ok(!plan.tasks.some((t: any) => t.kind.startsWith("asset.") && t.asset === "mehrad"), "no drawing");
});
