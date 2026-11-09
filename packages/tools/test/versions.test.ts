// Versions (docs/GLOSSARY.md): every export is v1, v2, … with the rev it rendered, kept in history/versions.jsonl
// (with the project, so it survives deleting runs/) and as out/versions/v<N>.mp4.
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

const home = mkdtempSync(join(tmpdir(), "pap-versions-"));
process.env.PAP_HOME = home;
after(() => rmSync(home, { recursive: true, force: true }));
const { buildRegistry, Workspace } = await import("../src/index.ts");

function fresh() {
  const root = join(home, `projects-${Math.random().toString(36).slice(2)}`);
  mkdirSync(root, { recursive: true });
  const w = new Workspace(() => [root]);
  const p = w.create({
    title: "Versions",
    brief: { idea: "A short pitch", lengthSec: 10 } as any,
    budgetUsd: 1,
  });
  return { root, w, p };
}

test("two exports give v1 and v2, both playable, each with the rev it rendered", async () => {
  const { w, p } = fresh();
  const reg = buildRegistry();
  const ctx = { author: { kind: "user" as const }, project: p, workspace: w, emit: () => {} };
  const a = await reg.call("export_video", {}, ctx);
  assert.ok(a.ok, JSON.stringify(a));
  assert.equal((a as any).data.v, 1);
  await p.patch([{ op: "replace", path: "/composition/endHold", value: 2 }], {
    reason: "shorter end card",
    author: { kind: "user" },
  });
  const b = await reg.call("export_video", {}, ctx);
  assert.ok(b.ok, JSON.stringify(b));
  assert.equal((b as any).data.v, 2);

  const vs = p.versions();
  assert.deepEqual(
    vs.map((v) => [v.v, v.rev, v.file, v.delivery]),
    [
      [1, 0, "out/versions/v1.mp4", "hd"],
      [2, 1, "out/versions/v2.mp4", "hd"],
    ],
  );
  for (const v of vs) {
    const f = join(p.dir, v.file);
    assert.ok(statSync(f).size > 1000, `${v.file} has a video in it`);
    assert.match(v.sha1, /^[0-9a-f]{40}$/);
    assert.ok(v.sec > 0);
  }
  assert.notEqual(vs[0].sha1, vs[1].sha1);
  // the versions folder isn't a file of the project's own
  assert.ok(!p.files().some((f) => f.name === "versions"));
  // the current one is still out/<name>.mp4, and the latest version is up to date
  assert.ok(p.files().some((f) => f.name === "versions.mp4"));
  assert.equal(p.parts().parts.find((x) => x.id === "video")?.state, "ready");
  w.closeAll();
});

test("recordVersion: the list survives deleting runs/, and numbering goes on from it", () => {
  const { root, w, p } = fresh();
  const src = join(p.dir, "out", "fake.mp4");
  mkdirSync(join(p.dir, "out"), { recursive: true });
  // any bytes do: the bookkeeping copies and hashes, it doesn't decode
  writeFileSync(src, "one");
  const v1 = p.recordVersion(src, { rev: p.rev(), sec: 3 });
  assert.equal(v1.v, 1);
  assert.equal(readFileSync(join(p.dir, v1.file), "utf8"), "one");
  w.closeAll();

  rmSync(join(p.dir, "runs"), { recursive: true, force: true });
  const w2 = new Workspace(() => [root]);
  const p2 = w2.openDir(p.dir);
  assert.deepEqual(
    p2.versions().map((v) => v.v),
    [1],
  );
  // rewritten in place, as the encoder does
  writeFileSync(src, "two");
  const v2 = p2.recordVersion(src, { rev: p2.rev(), sec: 3 });
  assert.equal(v2.v, 2);
  // the older copy keeps its own bytes when out/<name>.mp4 is rewritten
  assert.equal(readFileSync(join(p2.dir, v1.file), "utf8"), "one");
  assert.ok(existsSync(join(p2.dir, "history", "versions.jsonl")));
  w2.closeAll();
});
