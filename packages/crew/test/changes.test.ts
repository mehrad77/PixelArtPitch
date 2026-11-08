// One door for changes (docs/PIP-ORCHESTRATION.md §1.12): the router, a gate's notes, the dry preview, notes that
// close with the revision that applies them (no third cut after the export), and auto skipping the leftover G3.
// Over FakeProvider and the fictional QuestDay example only.
import assert from "node:assert/strict";
import { cpSync, existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

const home = mkdtempSync(join(tmpdir(), "pap-changes-"));
process.env.PAP_HOME = home;
const root = join(home, "projects");
mkdirSync(root, { recursive: true });
const EXAMPLE = new URL("../../../examples/questday/", import.meta.url).pathname;

const { buildRegistry, Workspace } = await import("@pap/tools");
const { ModelGateway } = await import("../src/gateway-impl.ts");
const { FakeProvider, FAKE_CAPS, Ledger, SecretStore, defaultSettings, setPriceOverride } = await import(
  "../src/llm/index.ts"
);
const { Crew, gateNotes, changeSummary } = await import("../src/orchestrator.ts");
const { routeChange } = await import("../src/plan/route.ts");

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
async function crewOn(answer: (req: Req) => any, involvement = "auto") {
  const dir = join(root, `change_${++n}`);
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
      { op: "replace", path: "/brief/involvement", value: involvement },
      { op: "replace", path: "/brief/narration", value: "none" },
      { op: "replace", path: "/budget/capUsd", value: 5 },
    ],
    { reason: "t", author: { kind: "user" } },
  );
  return { crew, p };
}
const ship = { json: { verdict: "ship", summary: "ok", blockers: [], polish: [] } };
const tuneAndShip = (req: Req) => {
  const sys = req.system ?? "";
  if (/Animator of one scene/.test(sys)) return { json: { changes: [] } };
  if (/festival judge/.test(sys)) return ship;
  return { error: new Error(`unexpected: ${sys.slice(0, 40)}`) };
};

test("one router: cast, staging, text cards and the end card go to the Director; motion to the Animator", () => {
  assert.equal(routeChange({ text: "cast the moth as the friend who joins" }), "director");
  assert.equal(routeChange({ text: "make the owl sit on the roof edge", target: { scene: "s1" } }), "director");
  assert.equal(routeChange({ text: "the end card should say Lumenbook" }), "director");
  assert.equal(routeChange({ text: "a glowing paper lantern on the rooftop" }), "director");
  assert.equal(routeChange({ text: "make it a bit slower", target: { scene: "s1" } }), "animator");
  assert.equal(routeChange({ text: "make the hero bigger", target: { scene: "s1" }, category: "art" }), "animator");
  assert.equal(routeChange({ text: "redraw it", target: { asset: "owl" } }), "pixel-artist");
  assert.equal(routeChange({ text: "quieter", category: "sound" }), "sound-designer");
  assert.equal(routeChange({ text: "say hello", target: { cue: "c01" }, category: "text" }), "writer");
  // a gate's owner decides only what the words don't
  assert.equal(routeChange({ text: "hmm, not quite" }, "editor"), "editor");
  assert.equal(routeChange({ text: "add a friend at the end card" }, "animator"), "director");
});

test("a gate's change: ticked items name their scene; the words route it, the gate's owner is the fallback", async () => {
  const { p } = await crewOn(tuneAndShip);
  const notes = gateNotes(p, "g3_rough", {
    reasons: ["the moth should fly to the lantern"],
    items: ["Still wrong in quest: the toast covers the hero"],
  });
  assert.equal(notes.length, 1);
  assert.deepEqual(notes[0].target, { scene: "quest" });
  assert.equal(notes[0].assignee, "director");
  // a scene named by its title, and plain words at G3: the Animator, the gate's owner
  const byTitle = gateNotes(p, "g3_rough", { reasons: ["too slow"], items: ["Raise your flag is late"] });
  assert.deepEqual(byTitle[0].target, { scene: "flag" });
  assert.equal(byTitle[0].assignee, "animator");
  const loose = gateNotes(p, "g3_rough", { reasons: ["not sure about it"] });
  assert.deepEqual(loose, [{ target: {}, text: "not sure about it", assignee: "animator" }]);
});

test("the change preview routes like the real change and writes nothing", async () => {
  const { crew, p } = await crewOn(tuneAndShip);
  await crew.run(p, {});
  const rev = crew.planNow(p)!.rev;
  const notes = p.state.notes.length;
  const pr = crew.previewChange(p, { gate: "g3_rough", text: "cast an owl that sits on the roof", items: [] });
  assert.equal(pr.role, "director");
  assert.ok(pr.roles.includes("director") && pr.roles.includes("animator"), pr.roles.join(","));
  assert.ok(pr.scenes.length >= 1);
  assert.match(pr.summary, /^The Director re-plans scenes? [\d, and]+, then the Animator tunes (it|them)\.$/);
  assert.ok(pr.usd[1] >= pr.usd[0] && pr.usd[0] >= 0);
  const anim = crew.previewChange(p, { text: "a bit slower in scene 2", scene: "quest" });
  assert.equal(anim.role, "animator");
  assert.deepEqual(anim.scenes, ["quest"]);
  assert.equal(anim.summary, "The Animator redoes scene 2.");
  assert.equal(crew.planNow(p)!.rev, rev, "no revision written");
  assert.equal(p.state.notes.length, notes, "no note added");
  assert.equal(
    changeSummary("director", ["2", "4"]),
    "The Director re-plans scenes 2 and 4, then the Animator tunes them.",
  );
});

test("notes close with the revision that applies them: approve G3, export, and no third cut", async () => {
  const { crew, p } = await crewOn(tuneAndShip);
  await crew.run(p, {});
  await p.patch([{ op: "replace", path: "/brief/involvement", value: "key" }], {
    reason: "t",
    author: { kind: "user" },
  });
  const runs = crew.planNow(p)!.runs.length;
  const note = p.addNote({
    target: { scene: "grind" },
    category: "art",
    text: "make the hero bigger",
    assignee: "animator",
    by: "user",
  });
  const res = crew.requestChange(p, note);
  assert.equal(res.started, true);
  assert.ok(
    crew.planNow(p)!.claims?.some((c) => c.notes.includes(note.id)),
    "the change revision claims the note",
  );
  await wait(() => p.state.gates.find((g) => g.id === "g3_rough")?.status === "open");
  crew.gate(p, "g3_rough", { verdict: "approve", by: "user" });
  await wait(() => !crew.status(p).crew.running);
  const after = crew.planNow(p)!;
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(p.state.notes.find((x) => x.id === note.id)?.status, "done", "the note closed with its revision");
  assert.equal(after.claims, undefined, "no claim left");
  assert.equal(crew.status(p).crew.running, false, "no run after the export");
  assert.equal(crew.planNow(p)!.runs.length, runs + 1, "one change run, not two");
  assert.equal(crew.planNow(p)!.rev, after.rev, "no new revision after the export");
});

test("G3 'Change something' runs once, approving the new rough cut exports, and nothing runs after", async () => {
  const { crew, p } = await crewOn(tuneAndShip);
  await crew.run(p, {});
  await p.patch([{ op: "replace", path: "/brief/involvement", value: "key" }], {
    reason: "t",
    author: { kind: "user" },
  });
  const runs = crew.planNow(p)!.runs.length;
  crew.requestChange(
    p,
    p.addNote({ target: { scene: "grind" }, category: "art", text: "bigger", assignee: "animator", by: "user" }),
  );
  await wait(() => p.state.gates.find((g) => g.id === "g3_rough")?.status === "open");
  // the person asks for more at the rough cut: one note, routed by its words, starts one change run
  crew.gate(p, "g3_rough", { verdict: "changes", reasons: ["a bit slower in A grind"], by: "user" });
  await wait(
    () =>
      crew.planNow(p)!.runs.length === runs + 2 && p.state.gates.find((g) => g.id === "g3_rough")?.status === "open",
  );
  const g3note = p.state.notes.find((x) => x.text === "a bit slower in A grind")!;
  assert.equal(g3note.assignee, "animator");
  assert.deepEqual(g3note.target, { scene: "grind" });
  crew.gate(p, "g3_rough", { verdict: "approve", by: "user" });
  await wait(() => !crew.status(p).crew.running && p.state.status.line === "Your video is ready");
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(p.state.notes.find((x) => x.id === g3note.id)?.status, "done");
  assert.equal(crew.planNow(p)!.runs.length, runs + 2, "no third run after the export");
  assert.equal(crew.status(p).crew.running, false);
});

test("auto: leftover blockers on the changed scene are logged and the cut exports without G3", async () => {
  const { crew, p } = await crewOn((req) => {
    const sys = req.system ?? "";
    if (/Animator of one scene/.test(sys)) return { json: { changes: [] } };
    if (/festival judge/.test(sys))
      return {
        json: {
          verdict: "fix",
          summary: "still small",
          blockers: [{ t: 1, scene: "grind", issue: "The hero is still small.", fix: "scale it" }],
          polish: [],
        },
      };
    return { error: new Error("unexpected") };
  });
  for (const s of p.doc().scenes) p.setSceneStatus(s.id, { version: "render", state: "ready" });
  p.setStage("deliver");
  const logs: string[] = [];
  const renders: any[] = [];
  p.events.on("event", (e: any) => {
    if (e.event === "log") logs.push(String(e.data?.text ?? ""));
    if (e.event === "render") renders.push(e.data);
  });
  const note = p.addNote({
    target: { scene: "grind" },
    category: "art",
    text: "make the hero bigger",
    assignee: "animator",
    by: "user",
  });
  crew.requestChange(p, note);
  await wait(() => !crew.status(p).crew.running && p.state.status.line === "Your video is ready");
  assert.notEqual(p.state.gates.find((g) => g.id === "g3_rough")?.status, "open", "no G3 at auto");
  assert.ok(logs.some((t) => /exporting without asking \(auto\)/.test(t)));
  // the review wrote a playable rough cut with its sound, and said so
  assert.ok(existsSync(join(p.dir, "out", "proxy.mp4")), "out/proxy.mp4");
  assert.ok(renders.some((r) => r.kind === "proxy" && r.url === "files/proxy.mp4"));
});

// ---------------------------------------------------------------- the crew knows its tools (§1.13)
const { recipeMenu, castOf, cueDetail } = await import("../src/orchestrator.ts");
const { recipeCatalog, checkRecipeParams } = await import("@pap/engine/recipes");

test("the Director's menu lists every on-screen param from the catalogue: sit, fly, glow, the cast", () => {
  const menu = recipeMenu(recipeCatalog());
  const line = (id: string) => menu.split("\n").find((l) => l.startsWith(`- ${id} `))!;
  assert.match(line("walk_in"), /then: stand\|sit/);
  assert.match(line("walk_in"), /prop: obj.*glow/);
  assert.match(line("spawn_join"), /who\*: string/);
  assert.match(line("spawn_join"), /motion: drop\|walk\|fly/);
  assert.match(line("spawn_join"), /follow: string/);
  assert.match(line("spawn_join"), /banner: string = ""/);
  assert.match(line("backdrop_rooftop"), /decor: array.*lantern.*glow/);
  assert.doesNotMatch(line("backdrop_rooftop"), /lamp/);
});

test("the Director's cards no longer say no recipe can fly, sit or glow", async () => {
  const { readFileSync } = await import("node:fs");
  for (const f of ["storyboard", "reboard"]) {
    const card = readFileSync(new URL(`../prompts/director/${f}.md`, import.meta.url), "utf8");
    assert.doesNotMatch(card, /No recipe makes/i, f);
    assert.match(card, /Sit, fly and glow are on the menu/, f);
  }
});

test("checkBoard: spawn_join needs who, cast from the brief; who and follow must be listed assets", async () => {
  const { crew, p } = await crewOn(tuneAndShip);
  await p.patch(
    [{ op: "replace", path: "/brief/idea", value: "A sleepy owl reads on a roof; a small moth follows the light." }],
    {
      reason: "t",
      author: { kind: "user" },
    },
  );
  const cues = p.doc().script.cues.map((c) => c.id);
  const board = (params: Record<string, unknown>) => ({
    scenes: [
      {
        id: "a",
        title: "A",
        cues: cues.slice(0, -1),
        recipes: [
          { id: "backdrop_rooftop", params: {} },
          { id: "walk_in", params: { hero: "owl" } },
          { id: "spawn_join", params },
        ],
      },
      { id: "end", title: "End", cues: cues.slice(-1), recipes: [{ id: "end_card_loop", params: { title: "LUMEN" } }] },
    ],
    newAssets: [],
  });
  const issues = (crew as any).checkBoard(p, board({}), checkRecipeParams) as string[];
  assert.ok(
    issues.some((i) => /params\.who: spawn_join needs who, .*fix: cast moth as who/.test(i)),
    issues.join("\n"),
  );
  const bad = (crew as any).checkBoard(p, board({ who: "moth", follow: "dragon" }), checkRecipeParams) as string[];
  assert.ok(
    bad.some((i) => /params\.follow: asset "dragon" is not in the asset list/.test(i)),
    bad.join("\n"),
  );
  const ok = (crew as any).checkBoard(p, board({ who: "moth", motion: "fly", follow: "owl" }), checkRecipeParams);
  assert.deepEqual(ok, []);
  assert.deepEqual(castOf("a small moth follows the owl", ["owl", "moth", "font"]), ["moth", "owl"]);
});

test("the script pick keeps whole cues: a word-safe cut after the last cue that fits", () => {
  const cues = ["Night falls on the city.", "A sleepy owl opens a book.", "The title card earns its place here."];
  assert.equal(cueDetail(cues, 280), cues.join(" "));
  assert.equal(cueDetail(cues, 60), "Night falls on the city. A sleepy owl opens a book.…");
  assert.ok(!/ear$/.test(cueDetail(cues, 70).replace(/…$/, "")));
  assert.match(cueDetail(["one very long cue that never fits in a short space at all"], 20), /…$/);
});

test("answering a gate takes the line off 'Waiting for you…' and onto the stage that runs", async () => {
  const { crew, p } = await crewOn(tuneAndShip);
  p.setStage("deliver");
  p.setGate("g3_rough", { status: "open", items: [{ label: "Rough cut" }] });
  p.setStatus({ line: "Waiting for you: the Reviewer still sees 2 problems in the scenes you changed" });
  crew.gate(p, "g3_rough", { verdict: "approve", by: "user" });
  assert.equal(p.state.status.line, "Exporting your video");
});
