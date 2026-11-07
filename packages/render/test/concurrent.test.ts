import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { loadProject, openRenderer } from "../src/index.ts";

test("concurrent frame requests each get their own frame", async () => {
  const r = await openRenderer(loadProject(new URL("../../../examples/questday", import.meta.url).pathname));
  try {
    const ts = [0.5, 3, 6, 9, 12];
    const one = await Promise.all(ts.map((t) => r.frame(t)));
    const seq: Buffer[] = [];
    for (const t of ts) seq.push(await r.frame(t));
    const h = (b: Buffer) => createHash("sha256").update(b).digest("hex");
    assert.deepEqual(one.map(h), seq.map(h));
  } finally {
    r.close();
  }
});
