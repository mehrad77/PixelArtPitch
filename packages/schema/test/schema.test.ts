import assert from "node:assert/strict";
import { test } from "node:test";
import { applyPatch, inScope, parseTime, resolveTimeline, TimeError } from "../src/index.ts";

const doc = {
  script: {
    cues: [
      { id: "c01", text: "one two three" },
      { id: "c02", text: "four" },
    ],
    timing: { mode: "estimate" as const, wps: 2.5, pause: 0.2, lead: 0.6, minCue: 1.1 },
  },
  composition: { hold: 3, endHold: 4, duration: "E(c02)+endHold" } as any,
  scenes: [
    { id: "intro", from: 0, to: "E(c01)+0.1" },
    { id: "end", from: "intro.to", to: "duration" },
  ] as any,
  events: { land: "S(c02)+max(0.5, (E(c02)-S(c02))*0.5)" },
};

test("timeline matches the hand-written formula", () => {
  const tl = resolveTimeline(doc);
  const e0 = 0.6 + Math.max(1.1, 3 / 2.5);
  assert.equal(tl.cues[0].end, e0);
  assert.equal(tl.scenes[0].to, e0 + 0.1);
  assert.equal(tl.scenes[1].from, e0 + 0.1);
  const s1 = e0 + 0.2;
  assert.equal(tl.duration, s1 + 1.1 + 4);
  assert.equal(tl.events.land, s1 + Math.max(0.5, (s1 + 1.1 - s1) * 0.5));
});

test("unknown names give a fix hint", () => {
  assert.throws(
    () => resolveTimeline({ ...doc, events: { x: "E(c99)" } }),
    (e: TimeError) => e.fix!.includes("c01"),
  );
  assert.throws(() => parseTime("E(c01) +"), TimeError);
});

test("cycles are rejected", () => {
  assert.throws(() => resolveTimeline({ ...doc, events: { a: "@b+1", b: "@a" } }), /cycle/);
});

test("patch inverse restores the document", () => {
  const a = { x: [1, 2, 3], o: { k: "v" } };
  const ops = [
    { op: "add", path: "/x/1", value: 9 },
    { op: "remove", path: "/x/0" },
    { op: "replace", path: "/o/k", value: "w" },
    { op: "add", path: "/o/n", value: { deep: true } },
    { op: "move", from: "/x/0", path: "/x/2" },
    { op: "copy", from: "/o/k", path: "/o/c" },
  ] as const;
  const { doc: b, inverse } = applyPatch(a, ops as any);
  assert.notDeepEqual(b, a);
  assert.deepEqual(applyPatch(b, inverse).doc, a);
});

test("scopes", () => {
  assert.ok(inScope("/scenes/2/layers/0/props/x", ["/scenes/*/layers"]));
  assert.ok(!inScope("/script/cues/0", ["/scenes/*/layers"]));
});
