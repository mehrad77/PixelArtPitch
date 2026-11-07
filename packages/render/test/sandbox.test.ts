import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { loadProject, openRenderer } from "../src/index.ts";

/** a one-scene project whose only scene is the given code bundle */
function projectWith(source: string) {
  const dir = mkdtempSync(join(tmpdir(), "pap-sandbox-"));
  mkdirSync(join(dir, "code"));
  writeFileSync(join(dir, "code", "b.mjs"), source);
  writeFileSync(
    join(dir, "pitch.json"),
    JSON.stringify({
      pap: 1,
      rev: 0,
      id: "t",
      title: "t",
      canvas: { w: 320, h: 180, fps: 30, palette: "pap-night@1" },
      brief: { idea: "test", lengthSec: 5 },
      script: { cues: [{ id: "c01", text: "hello there" }], timing: { mode: "estimate" } },
      composition: { hold: 0, endHold: 1, duration: "E(c01)+endHold" },
      code: [{ id: "b", file: "code/b.mjs" }],
      scenes: [{ id: "s", kind: "code", bundle: "b", from: 0, to: "duration" }],
      audio: { sfx: {} },
      budget: { capUsd: 0 },
    }),
  );
  return loadProject(dir);
}

async function attempt(source: string) {
  const r = await openRenderer(projectWith(source)).catch((e) => e as Error);
  if (r instanceof Error) return r.message;
  try {
    await r.frame(0.5);
    return "ok";
  } catch (e: any) {
    return e.message as string;
  } finally {
    r.close();
  }
}

test("a well-behaved bundle draws", async () => {
  assert.equal(
    await attempt(
      `import { clear, rect } from "pap:engine"; export function draw(t) { clear(); rect(0, 0, 10, 10, "P"); }`,
    ),
    "ok",
  );
});

test("no Node builtins can be imported", async () => {
  assert.match(await attempt(`import fs from "node:fs"; export function draw() {}`), /may only import/);
});

test("host functions cannot be used to reach process", async () => {
  const msg = await attempt(
    `import { rect } from "pap:engine"; export function draw() { rect.constructor("return process")().exit(3); }`,
  );
  assert.match(msg, /Code generation from strings disallowed|EvalError/);
});

test("no Node globals inside the bundle", async () => {
  assert.match(await attempt(`export function draw() { process.exit(1); }`), /process is not defined/);
  assert.match(await attempt(`export function draw() { fetch("http://127.0.0.1:9"); }`), /fetch is not defined/);
});

test("an endless frame is stopped", async () => {
  assert.match(await attempt(`export function draw() { for (;;) {} }`), /timed out/);
});
