// v0.4: the five parts and the versions in the studio's words (no DOM): the project page's parts and version line,
// the Projects card's marks and group, and the helpers that read "has a version and isn't running".
import assert from "node:assert/strict";
import { test } from "node:test";
import { hasVersionIdle, humanStatus, needsNarration } from "../src/lib/human.ts";
import { kindOf } from "../src/lib/projects.ts";
import { applyEvent } from "../src/lib/reducer.ts";
import type { Part, ProjectState, ProjectSummary, Version } from "../src/lib/types.ts";
import { exportLabel, partDetail, partsLabel, playUrl, versionLineOf, versionWords } from "../src/lib/versions.ts";

const part = (id: Part["id"], state: Part["state"], done = state === "ready" ? 1 : 0, of = 1): Part => ({
  id,
  state,
  done,
  of,
});
const fourReady = [
  part("idea", "ready"),
  part("story", "ready", 5, 5),
  part("pictures", "ready", 5, 5),
  part("sound", "ready"),
];
const version = (v: number, rev = v): Version => ({
  v,
  rev,
  at: "2026-11-03T10:00:00Z",
  file: `out/versions/v${v}.mp4`,
  sec: 30,
  sha1: "x",
  url: `/api/p/x/versions/${v}.mp4`,
});
const date = () => "3 Nov";

function state(over: Partial<ProjectState> = {}): ProjectState {
  return {
    doc: { brief: { narration: "none" }, audio: { vo: [] }, scenes: [] } as unknown as ProjectState["doc"],
    rev: 0,
    timeline: { cues: [], hold: 0, endHold: 0, duration: 30, scenes: [], events: {} },
    stage: "deliver",
    gates: [],
    tasks: [],
    questions: [],
    notes: [],
    budget: { capUsd: 3, spentUsd: 0, reservedUsd: 0, estTotalUsd: null },
    time: { startedAt: null, etaSec: null, deadline: null },
    files: [],
    digest: "",
    crew: { state: "idle" },
    ...over,
  } as ProjectState;
}

test("the version line, in its four wordings, and the Export it offers", () => {
  const none = versionLineOf(
    { parts: { parts: [...fourReady, part("video", "missing")], next: "review" } },
    false,
    date,
  );
  assert.ok(none);
  assert.equal(versionWords(none), "No video yet");
  assert.equal(exportLabel(none), "Export");
  const cur = versionLineOf(
    { versions: [version(1), version(2)], parts: { parts: [...fourReady, part("video", "ready")], next: null } },
    false,
    date,
  );
  assert.ok(cur);
  assert.equal(versionWords(cur), "v2 · exported 3 Nov · up to date");
  assert.equal(exportLabel(cur), null);
  const old = versionLineOf(
    { versions: [version(2)], parts: { parts: [...fourReady, part("video", "stale")], next: "review" } },
    false,
    date,
  );
  assert.ok(old);
  assert.equal(versionWords(old), "v2 is older than your changes");
  assert.equal(exportLabel(old), "Export v3");
  const making = versionLineOf({ versions: [version(2)], parts: { parts: fourReady, next: null } }, true, date);
  assert.ok(making);
  assert.equal(versionWords(making), "Making v3 · v2 still plays");
  assert.equal(exportLabel(making), null, "no Export while a crew runs");
});

test("the version line says nothing before there is something to export", () => {
  const partial = {
    parts: {
      parts: [part("idea", "ready"), part("story", "partial", 0, 0), part("video", "missing")],
      next: "script" as const,
    },
  };
  assert.equal(versionLineOf(partial, false, date), null);
  assert.equal(
    versionLineOf({ parts: { parts: [...fourReady, part("video", "missing")], next: "review" } }, true, date),
    null,
  );
});

test("the parts in words: never 'stale', and the card's screen-reader label", () => {
  assert.equal(partDetail(part("story", "ready")), "");
  assert.equal(partDetail(part("pictures", "partial", 3, 5)), "3 of 5");
  assert.equal(partDetail(part("video", "stale")), "older than your changes");
  assert.equal(partDetail(part("sound", "missing")), "missing");
  assert.equal(
    partsLabel([
      part("idea", "ready"),
      part("story", "ready"),
      part("pictures", "partial", 3, 5),
      part("sound", "missing"),
      part("video", "missing"),
    ]),
    "Idea ready, Story ready, Pictures 3 of 5, Sound missing, no video",
  );
  const all = [part("idea", "stale"), part("story", "stale"), part("video", "stale")];
  assert.ok(!/stale/.test(all.map(partDetail).join(" ") + partsLabel(all)));
});

test("kindOf: a handmade project, four parts ready and no version, is Not started; a version and no crew, Has a video", () => {
  const p = (over: Partial<ProjectSummary>): ProjectSummary =>
    ({ id: "x", title: "x", needsYou: 0, stage: "deliver", spentUsd: 0, updatedAt: "", ...over }) as ProjectSummary;
  const handmade = p({ parts: [...fourReady, part("video", "missing")], version: null, running: false, milestones: 0 });
  assert.equal(kindOf(handmade), "fresh", "its stage (deliver) and its parts don't make it started");
  assert.equal(kindOf(p({ ...handmade, version: { v: 1, at: "", upToDate: true } })), "finished");
  assert.equal(kindOf(p({ ...handmade, spentUsd: 0.4 })), "stopped", "a crew that did something and stopped");
});

test("has a version and isn't running (Pip's mood and suggestions key on it): the status line", () => {
  const done = state({ versions: [version(1)], parts: { parts: [...fourReady, part("video", "ready")], next: null } });
  assert.equal(hasVersionIdle(done), true);
  assert.equal(humanStatus(done).text, "Your video is ready.");
  const rerun = state({ ...done, crew: { state: "running" } as never });
  assert.equal(hasVersionIdle(rerun), false, "a rerun is Working, its v1 still plays");
  assert.notEqual(humanStatus(rerun).text, "Your video is ready.");
  // the stage no longer matters: a handmade project at brief with a version is done
  assert.equal(hasVersionIdle(state({ ...done, stage: "brief" })), true);
});

test("needsNarration reads the Sound part, not a step", () => {
  const waiting = state({
    doc: { brief: { narration: "user" }, audio: { vo: [] }, scenes: [] } as unknown as ProjectState["doc"],
    tasks: [{ id: "t", role: "editor", kind: "narrate.wait", title: "", status: "waiting_user" } as never],
  });
  assert.equal(
    needsNarration({
      ...waiting,
      parts: { parts: [...fourReady.slice(0, 3), part("sound", "missing")], next: "narrate" },
    }),
    true,
  );
  assert.equal(needsNarration({ ...waiting, parts: { parts: fourReady, next: "review" } }), false);
});

test("a mock-shaped journey: export → v1 → a change → Making v2 · v1 still plays → v2", () => {
  const line = (s: ProjectState) => {
    const l = versionLineOf(s, s.crew?.state === "running", date);
    return l ? versionWords(l) : null;
  };
  let s = state({ versions: [], parts: { parts: [...fourReady, part("video", "missing")], next: "review" } });
  assert.equal(line(s), "No video yet");
  // Export: the version lands with the refetch, the parts with their event
  s = { ...s, versions: [version(1)] };
  s = applyEvent(s, { event: "parts", data: { parts: [...fourReady, part("video", "ready")], next: null } });
  assert.equal(line(s), "v1 · exported 3 Nov · up to date");
  s = applyEvent(s, { event: "parts", data: { parts: [...fourReady, part("video", "stale")], next: "review" } });
  assert.equal(line(s), "v1 is older than your changes");
  s = applyEvent(s, { event: "x-state", data: { crew: { state: "running" } as never } });
  assert.equal(line(s), "Making v2 · v1 still plays");
  s = { ...s, versions: [version(1), version(2)] };
  s = applyEvent(s, { event: "x-state", data: { crew: { state: "idle" } as never } });
  s = applyEvent(s, { event: "parts", data: { parts: [...fourReady, part("video", "ready")], next: null } });
  assert.equal(line(s), "v2 · exported 3 Nov · up to date");
});

test("the player plays the latest version while it is up to date, else the proxy", () => {
  const ready = state({
    parts: { parts: [...fourReady, part("video", "ready")], next: null },
    versions: [version(1), version(2)],
  });
  assert.equal(playUrl(ready, "/api/p/x/proxy.mp4"), "/api/p/x/versions/2.mp4");
  const older = state({
    parts: { parts: [...fourReady, part("video", "stale")], next: "review" },
    versions: [version(1)],
  });
  assert.equal(playUrl(older, "/api/p/x/proxy.mp4"), "/api/p/x/proxy.mp4");
  assert.equal(playUrl(state(), null), null);
});
