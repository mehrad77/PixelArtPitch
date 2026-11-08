// Readable text (docs/PIP-ORCHESTRATION.md §1.14): cuts on a word boundary, no ids in what a person reads, and one
// marker per thing that happened.
import assert from "node:assert/strict";
import { cpSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

const home = mkdtempSync(join(tmpdir(), "pap-words-"));
process.env.PAP_HOME = home;
after(() => rmSync(home, { recursive: true, force: true }));
const { cutWords, plainText, Workspace } = await import("../src/index.ts");
const EXAMPLE = new URL("../../../examples/questday/", import.meta.url).pathname;

test("cutWords: never mid-word, with … when it cut", () => {
  assert.equal(cutWords("short", 20), "short");
  assert.equal(cutWords("the title card earns its place", 18), "the title card…");
  assert.ok(!/ear…$/.test(cutWords("the title card earns its place", 19)));
  assert.equal(cutWords("supercalifragilistic", 8), "superca…");
});

test("plainText: no library refs, task ids or id-like scene ids; titles and names instead", () => {
  const ctx = {
    scenes: [
      { id: "s02_moth", title: "The moth" },
      { id: "grind", title: "A grind" },
    ],
    assets: ["cast-developer", "owl"],
    tasks: { t_draw_owl_v2: "Drawing the owl" },
  };
  assert.equal(plainText("Cast lib:mentor-gtm@1 in s02_moth", ctx), 'Cast mentor gtm in "The moth"');
  assert.equal(plainText("Redo grind: the toast covers scene grind", ctx), 'Redo grind: the toast covers "A grind"');
  assert.equal(plainText("waits on t_draw_owl_v2 and (t_judge_owl)", ctx), "waits on Drawing the owl and");
  assert.equal(plainText("cast-developer joins", ctx), "developer joins");
  assert.equal(
    plainText("Paused the crew: your fake key was rejected."),
    "Paused the crew: your fake key was rejected.",
  );
});

test("markers: one per thing that happened (the script pick isn't said twice), in plain words", async () => {
  const dir = join(home, "qd");
  cpSync(EXAMPLE, dir, { recursive: true, filter: (f) => !f.endsWith(".pap-lock") });
  const ws = new Workspace(() => [dir]);
  try {
    const p = ws.get(ws.list()[0].id);
    const live: any[] = [];
    p.events.on("event", (e: any) => e.event === "milestone" && live.push(e.data));
    const q = p.ask(
      {
        kind: "single",
        question: "Which script should the crew make?",
        options: [
          { id: "angle_0", label: "Quest log", detail: "" },
          { id: "angle_1", label: "Boss fight", detail: "" },
        ],
        recommendedId: "angle_0",
        blocks: ["script"],
        from: "writer",
      },
      "writer",
    );
    await p.answer(q.id, { optionId: "angle_0" }, "user");
    p.setGate("g1_script", {
      status: "passed",
      items: [{ label: "Script: Quest log" }],
      verdict: { by: "user", verdict: "approve", at: new Date().toISOString() } as any,
    });
    p.milestone("plan.r3", "Plan changed: dropped t_draw_owl_v2 for lib:owl@1 in grind");
    const ms = p.markers();
    assert.equal(ms.filter((m) => /picked the script/.test(m.text)).length, 1, ms.map((m) => m.text).join(" | "));
    assert.equal(live.filter((m) => /picked the script/.test(m.text)).length, 1);
    const plan = ms.find((m) => m.kind === "plan")!;
    assert.equal(plan.text, "Plan changed: dropped for owl in grind");
  } finally {
    ws.closeAll();
  }
});
