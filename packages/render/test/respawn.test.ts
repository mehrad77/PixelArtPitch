// A sandbox child that dies (a crash, a kill, an edit that breaks its imports) never takes the host process with it:
// pending calls reject with a clear error, and the next call starts a fresh child.
import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";
import { loadProject, openRenderer, PAP_ROOT } from "../src/index.ts";

test("kill the sandbox child: the next frame call still works", async () => {
  const r = await openRenderer(loadProject(join(PAP_ROOT, "examples/questday")));
  try {
    const before = await r.frame(1);
    const pid = r.pid!;
    process.kill(pid, "SIGKILL");
    await new Promise((res) => setTimeout(res, 200));
    const after = await r.frame(1);
    assert.notEqual(r.pid, pid, "a new child");
    assert.ok(before.equals(after), "the same pixels");
    // a call in flight when the child dies rejects instead of hanging or crashing
    const p = r.frame(2);
    process.kill(r.pid!, "SIGKILL");
    await p.then(
      () => {},
      (e) => assert.match(String(e.message), /render sandbox/),
    );
    assert.equal((await r.frame(1)).length, before.length);
    const frames: Buffer[] = [];
    await r.frames(0, 3, (f) => {
      frames.push(f);
    });
    assert.equal(frames.length, 3);
  } finally {
    r.close();
  }
});
