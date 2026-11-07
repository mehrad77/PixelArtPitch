// Runs only with PAP_GOLDEN_PROJECT=<project dir> (a private project with gen/golden.json, e.g. the first video).
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { checkGolden, loadProject, openRenderer } from "../src/index.ts";

const dir = process.env.PAP_GOLDEN_PROJECT;
test("imported project renders byte-identical frames", {
  skip: !dir || !existsSync(join(dir ?? "", "gen/golden.json")),
}, async () => {
  const p = loadProject(dir!);
  const golden = JSON.parse(readFileSync(join(dir!, "gen/golden.json"), "utf8"));
  const r = await openRenderer(p);
  try {
    const res = await checkGolden(r, golden);
    assert.equal(res.mismatches, 0, `first mismatching frames: ${res.bad.join(", ")}`);
    assert.equal(res.combined, golden.combined);
  } finally {
    r.close();
  }
});
