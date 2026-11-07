// The public example renders byte-identical frames. Regenerate after an intended visual change with
//   PAP_UPDATE_GOLDEN=1 node --test packages/render/test/example.test.ts
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { checkGolden, frameCount, loadProject, openRenderer, PAP_ROOT } from "../src/index.ts";

const dir = join(PAP_ROOT, "examples/questday");
const file = join(dir, "gen/golden.json");

test("the QuestDay example renders its golden frames", async () => {
  const p = loadProject(dir);
  const r = await openRenderer(p);
  try {
    if (process.env.PAP_UPDATE_GOLDEN === "1") {
      const n = frameCount(p.timeline.duration, p.timeline.hold);
      const hashes: string[] = [];
      const all = createHash("sha256");
      await r.frames(0, n, (f) => {
        const h = createHash("sha256").update(f).digest("hex");
        hashes.push(h);
        all.update(h);
      });
      mkdirSync(join(dir, "gen"), { recursive: true });
      writeFileSync(file, `${JSON.stringify({ frames: n, combined: all.digest("hex"), hashes }, null, 2)}\n`);
    }
    const golden = JSON.parse(readFileSync(file, "utf8"));
    const res = await checkGolden(r, golden);
    assert.equal(res.frames, golden.frames);
    assert.equal(res.mismatches, 0, `first mismatching frames: ${res.bad.join(", ")}`);
    assert.equal(res.combined, golden.combined);
    const sfx = await r.sfxEvents();
    assert.ok(["bump", "coin", "flag", "start"].every((t) => sfx.some((e) => e.type === t)));
  } finally {
    r.close();
  }
});
