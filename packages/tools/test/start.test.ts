// A project no crew has run (no runs/state.json) starts where its content ends (docs/PIP-ORCHESTRATION.md §1.9):
// a handmade one isn't sent back to the brief, and isn't asked to approve what it already has.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

const home = mkdtempSync(join(tmpdir(), "pap-start-"));
process.env.PAP_HOME = home;
after(() => rmSync(home, { recursive: true, force: true }));
const { Workspace } = await import("../src/index.ts");

/** a handmade project on disk, shaped like GameScrobbler × Divan: code scenes, its own art, music and sfx */
function handmade(o: { version?: boolean; state?: boolean } = {}) {
  const root = join(home, `projects-${Math.random().toString(36).slice(2)}`);
  const dir = join(root, "handmade");
  for (const d of ["code", "assets", "history", "runs"]) mkdirSync(join(dir, d), { recursive: true });
  const cues = Array.from({ length: 4 }, (_, n) => ({ id: `c0${n + 1}`, text: `Line ${n + 1} of the pitch.` }));
  const doc = {
    pap: 1,
    rev: 0,
    id: "handmade",
    title: "Handmade",
    canvas: { w: 320, h: 180, fps: 30 },
    brief: { idea: "A game scrobbler for a hackathon", lengthSec: 20, narration: "none" },
    script: { cues, timing: { mode: "estimate" } },
    composition: { duration: "E(c04)+endHold" },
    code: [{ id: "legacy", file: "code/legacy.mjs", sfx: true }],
    scenes: [
      { id: "title", kind: "code", bundle: "legacy", from: 0, to: "S(c03)", cues: ["c01", "c02"] },
      { id: "end", kind: "code", bundle: "legacy", from: "S(c03)", to: "duration", cues: ["c03", "c04"] },
    ],
    audio: { sfx: { source: "legacy" }, music: { generator: "chip-bed", settle: "end" } },
    assets: [{ id: "hero", src: "file:assets/hero.json" }],
    budget: { capUsd: 5 },
  };
  writeFileSync(join(dir, "pitch.json"), JSON.stringify(doc));
  writeFileSync(join(dir, "code", "legacy.mjs"), "export default {};\n");
  writeFileSync(join(dir, "assets", "hero.json"), "{}\n");
  if (o.version)
    writeFileSync(
      join(dir, "history", "versions.jsonl"),
      `${JSON.stringify({ v: 1, rev: 0, at: "2026-11-09T10:00:00.000Z", file: "out/versions/v1.mp4", sec: 20, sha1: "x" })}\n`,
    );
  if (o.state) writeFileSync(join(dir, "runs", "state.json"), JSON.stringify({ stage: "brief" }));
  const w = new Workspace(() => [root]);
  return { w, p: w.get(w.list()[0].id) };
}

test("a fully ready project with no state starts at deliver, every gate passed by its content", () => {
  const { w, p } = handmade({ version: true });
  assert.equal(p.parts().next, null);
  assert.equal(p.state.stage, "deliver");
  assert.deepEqual(
    p.state.gates.map((g) => [g.id, g.status, g.verdict?.by]),
    ["g0_brief", "g1_script", "g2_animatic", "g3_rough", "g4_final"].map((id) => [id, "passed", "content"]),
  );
  w.closeAll();
});

test("a handmade project with no video starts at deliver; only the final cut is still to approve", () => {
  const { w, p } = handmade();
  assert.equal(p.parts().next, "review");
  assert.equal(p.state.stage, "deliver");
  assert.deepEqual(
    p.state.gates.filter((g) => g.status !== "passed").map((g) => g.id),
    ["g4_final"],
  );
  w.closeAll();
});

test("a project the crew has run keeps its own state, and a new project is still a brief", () => {
  const ran = handmade({ version: true, state: true });
  assert.equal(ran.p.state.stage, "brief");
  assert.ok(ran.p.state.gates.every((g) => g.status === "locked"));
  ran.w.closeAll();
  const root = join(home, "new");
  mkdirSync(root, { recursive: true });
  const w = new Workspace(() => [root]);
  const p = w.create({ title: "New", brief: { idea: "A short pitch", lengthSec: 10 } as any, budgetUsd: 1 });
  assert.equal(p.state.stage, "brief");
  assert.ok(p.state.gates.every((g) => g.status === "locked"));
  w.closeAll();
});
