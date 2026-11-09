// The free edits (docs/PIP-ORCHESTRATION.md §1.12, the `edit` tier): look_set_time and code_set_constants, with no
// model call. A constant edit is checked in the Scene Coder's trial sandbox first: a failing one writes nothing; a
// passing one writes a new file, so /undo brings back the old one. Over the fictional QuestDay example only.
import assert from "node:assert/strict";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

const home = mkdtempSync(join(tmpdir(), "pap-edits-"));
process.env.PAP_HOME = home;
const root = join(home, "projects");
mkdirSync(root, { recursive: true });
const EXAMPLE = new URL("../../../examples/questday/", import.meta.url).pathname;

const { buildRegistry, codeSetConstantsTool, Workspace } = await import("@pap/tools");
const { trialRender } = await import("../src/scene-code.ts");
const { QUEST_CODE, withCodeScene } = await import("./fixtures/code-scene.ts");

const open: InstanceType<typeof Workspace>[] = [];
after(() => {
  for (const w of open) w.closeAll();
  rmSync(home, { recursive: true, force: true });
});

let n = 0;
/** QuestDay with its "quest" scene as a code scene, and a registry with code_set_constants */
async function questdayWithCode(dirRoot = root) {
  const dir = join(dirRoot, `edits_${++n}`);
  cpSync(EXAMPLE, dir, { recursive: true, filter: (f) => !f.endsWith(".pap-lock") });
  const workspace = new Workspace(() => [dir]);
  open.push(workspace);
  const p = workspace.get(workspace.list().find((x) => x.dir === dir)!.id);
  await withCodeScene(p);
  const registry = buildRegistry().add(codeSetConstantsTool((lp, s, src) => trialRender(lp, s, src)));
  const ctx = { author: { kind: "user" as const, via: "pip" }, project: p, workspace, emit: () => {} };
  return { p, dir, registry, ctx };
}

test("code_set_constants: sets a constant with no model call, writes a new file, and /undo brings back the old", async () => {
  const { p, dir, registry, ctx } = await questdayWithCode();
  const rev = p.rev();
  const r = await registry.call(
    "code_set_constants",
    { scene: "quest", set: { BOARD_Y: 30 }, reason: "up a bit" },
    ctx,
  );
  assert.ok(r.ok, JSON.stringify(r));
  const data = r.data as { file: string; changed: { name: string; from: unknown; to: unknown }[] };
  assert.deepEqual(data.changed, [{ name: "BOARD_Y", from: 40, to: 30 }]);
  assert.equal(data.file, "code/quest.v2.mjs");
  assert.match(readFileSync(join(dir, data.file), "utf8"), /^export const BOARD_Y = 30;$/m);
  assert.equal(readFileSync(join(dir, "code/quest.mjs"), "utf8"), QUEST_CODE, "the old file stays");
  assert.ok(r.images?.length, "a still of the scene after the edit");
  // project_get lists the constants it can change
  const g = await registry.call("project_get", { section: "scene:quest" }, ctx);
  assert.ok(g.ok);
  assert.deepEqual((g.data as any).data.constants, { BOARD_X: 120, BOARD_Y: 30, TITLE: "QUESTS" });
  assert.equal(p.rev(), rev + 1);
  // the old file comes back through the history
  const hist = await p.history();
  await p.undo(hist.at(-1)!.seq, "t", { kind: "user" });
  assert.equal(p.doc().code.find((c) => c.id === "quest")!.file, "code/quest.mjs");
});

test("code_set_constants: a value that fails the trial render changes nothing (no file, no revision)", async () => {
  const { p, dir, registry, ctx } = await questdayWithCode();
  const rev = p.rev();
  // the board drawn into the caption zone fails the probe's lints
  const r = await registry.call(
    "code_set_constants",
    { scene: "quest", set: { BOARD_Y: 150 }, reason: "down low" },
    ctx,
  );
  assert.ok(!r.ok);
  assert.equal(r.error.code, "trial_failed", r.error.message);
  assert.match(r.error.fix ?? "", /nothing was changed/);
  assert.equal(p.rev(), rev);
  assert.ok(!existsSync(join(dir, "code/quest.v2.mjs")));
  // an unknown name: the fix lists what exists
  const u = await registry.call("code_set_constants", { scene: "quest", set: { LOGO_Y: 1 }, reason: "the logo" }, ctx);
  assert.ok(!u.ok);
  assert.match(u.error.fix ?? "", /BOARD_X = 120, BOARD_Y = 40, TITLE = "QUESTS"/);
});

test("look_set_time: the canvas time only, once, with the cue that still says the old time", async () => {
  const { p, registry, ctx } = await questdayWithCode();
  await p.patch([{ op: "replace", path: "/script/cues/0/text", value: "Night falls. The list waits." }], {
    reason: "t",
    author: { kind: "user" },
  });
  const r = await registry.call("look_set_time", { time: "day" }, ctx);
  assert.ok(r.ok);
  assert.equal(p.doc().canvas.time, "day");
  assert.match((r.data as { cueNote: string }).cueNote, /^Cue 1 still says "Night falls\. The list waits\."/);
  const again = await registry.call("look_set_time", { time: "day" }, ctx);
  assert.ok(again.ok && !(again.data as { changed: boolean }).changed);
});

test("look_set_time on some scenes: their own time; the whole video then drops it", async () => {
  const { p, registry, ctx } = await questdayWithCode();
  const id = p.doc().scenes.at(-1)!.id;
  const r = await registry.call("look_set_time", { time: "dusk", scenes: [id] }, ctx);
  assert.ok(r.ok, JSON.stringify(r));
  assert.equal(p.doc().canvas.time, undefined, "the video stays as it was");
  assert.equal((p.doc().scenes.at(-1) as { time?: string }).time, "dusk");
  assert.match(p.readHistory().at(-1)!.reason, /scene \d+ is set at dusk/);
  // the video's own time for that scene drops the override; an unknown scene is refused
  const bad = await registry.call("look_set_time", { time: "day", scenes: ["nope"] }, ctx);
  assert.ok(!bad.ok);
  const all = await registry.call("look_set_time", { time: "day" }, ctx);
  assert.ok(all.ok);
  assert.equal(p.doc().canvas.time, "day");
  assert.ok(
    p.doc().scenes.every((s) => !(s as { time?: string }).time),
    "the whole video means every scene",
  );
});
