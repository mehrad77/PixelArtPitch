// A code bundle gets the kit from "pap:engine" (walk, flag, slots, faceTo), and a trial render's probe records the
// sprites they draw, so the walk check sees them.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { loadProject, openRenderer } from "../src/index.ts";

const BUNDLE = `import { clear, faceTo, flag, slots, walk } from "pap:engine";
import { E, S } from "pap:timeline";
export function draw(t) {
  clear();
  walk("runner", { x0: 20, x1: 200, t0: S("c01"), t1: E("c01"), t });
  slots(3, { x: 40, y: 30, filled: [S("c01"), S("c01") + 0.5, E("c01")], t });
  flag("runner", { x: 280, t, up: faceTo("runner", "left") ? 1 : 0 });
}`;

test("a bundle walks, flags and fills slots, and the probe sees the walker's frames", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pap-kit-"));
  mkdirSync(join(dir, "code"));
  writeFileSync(join(dir, "code", "b.mjs"), BUNDLE);
  writeFileSync(
    join(dir, "pitch.json"),
    JSON.stringify({
      pap: 1,
      rev: 0,
      id: "t",
      title: "t",
      canvas: { w: 320, h: 180, fps: 30, palette: "pap-night@1" },
      brief: { idea: "test", lengthSec: 5 },
      script: { cues: [{ id: "c01", text: "we walk all the way across here" }], timing: { mode: "estimate" } },
      composition: { hold: 0, endHold: 1, duration: "E(c01)+endHold" },
      code: [{ id: "b", file: "code/b.mjs" }],
      scenes: [{ id: "s", kind: "code", bundle: "b", from: 0, to: "duration" }],
      audio: { sfx: {} },
      assets: [{ id: "runner", src: "lib:gamer@1" }],
      budget: { capUsd: 0 },
    }),
  );
  const p = loadProject(dir);
  assert.deepEqual(p.facing, { runner: "right" });
  const r = await openRenderer({ ...p, probe: true });
  try {
    const mid = (p.timeline.cues[0].start + p.timeline.cues[0].end) / 2;
    const pr = await r.probe(mid);
    const sprites = pr.boxes.filter((b: any) => b.kind === "sprite" && b.name === "runner");
    assert.ok(sprites.length >= 1);
    assert.match((sprites[0] as any).frame, /^run[0-3]$/);
    assert.equal(pr.boxes.filter((b: any) => b.kind === "panel").length, 3, "three slot panels");
  } finally {
    r.close();
  }
});
