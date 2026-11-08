// Phase 4 of the P4 fixes, in node over the web's pure code: the script angles as a pick (G1 and its question are one
// thing that needs you), the drawer's step names, the live `progress` line and the live canvas's row reader, Pip's
// thread as turns, the plan card as a diff with the crew named by instance, the scope chip's words, and who waits on
// you. No DOM.
import assert from "node:assert/strict";
import { test } from "node:test";
import { scoped, splitAbout } from "../src/lib/about.ts";
import { groupTitle, progressLine, stepsOf, stepWords } from "../src/lib/activity.ts";
import { channelSummary, nameOf } from "../src/lib/channel-words.ts";
import { needsYouCount } from "../src/lib/derive.ts";
import { draftFrames, liveFrame } from "../src/lib/draft.ts";
import { askedByGate, humanStatus, milestones, sentence, theMember } from "../src/lib/human.ts";
import { stuckInstances, waitingInstances } from "../src/lib/instances.ts";
import { isPick, needsItems, previewOf } from "../src/lib/needs.ts";
import { planCrew, planDiff, planUsd, titleWords } from "../src/lib/plancard.ts";
import { applyEvent } from "../src/lib/reducer.ts";
import { turnsOf } from "../src/lib/thread.ts";
import type {
  ActivityEntry,
  Gate,
  PipCard,
  PipItem,
  PlanTaskView,
  ProjectState,
  QuestionT,
  Task,
} from "../src/lib/types.ts";
import { Q_PUBLISH } from "../src/mock/journey.ts";
import { mockProgress } from "../src/mock/progress.ts";

function blank(): ProjectState {
  return {
    doc: { brief: { narration: "none" }, audio: { vo: [] }, scenes: [] } as unknown as ProjectState["doc"],
    rev: 0,
    timeline: { cues: [], hold: 0, endHold: 0, duration: 30, scenes: [], events: {} },
    stage: "script",
    gates: [],
    tasks: [],
    questions: [],
    notes: [],
    budget: { capUsd: 3, spentUsd: 0, reservedUsd: 0, estTotalUsd: null },
    time: { startedAt: null, etaSec: null, deadline: null },
    files: [],
    digest: "",
    instances: [],
    plan: null,
  };
}

const angle = (over: Partial<QuestionT> = {}): QuestionT => ({
  id: "q_7",
  kind: "single",
  question: "Which script should the crew make?",
  why: "The script sets the scenes.",
  options: [
    { id: "angle_0", label: "The walker", detail: "A day of chores turns into a quest." },
    { id: "angle_1", label: "The board", detail: "The app's board, task by task." },
    { id: "angle_2", label: "The numbers", detail: "What finishing more tasks is worth." },
  ],
  recommendedId: "angle_0",
  blocks: ["script"],
  timeoutSec: null,
  from: "writer",
  askedAt: "2026-11-08T20:00:00.000Z",
  status: "open",
  ...over,
});
const g1 = (ref?: string): Gate =>
  ({ id: "g1_script", status: "open", items: [{ label: "Pick a script angle", ...(ref ? { ref } : {}) }] }) as Gate;

test("G1 and its angle question are one pick: every option, no separate Looks good, counted once", () => {
  const s = { ...blank(), gates: [g1("q_7")], questions: [angle()] };
  const items = needsItems(s);
  assert.equal(items.length, 1, "the gate carries its question; the question isn't a second item");
  const [it] = items;
  assert.equal(it.kind, "gate");
  assert.equal(it.kind === "gate" && it.pick?.id, "q_7");
  assert.ok(isPick(angle(), s));
  assert.deepEqual([...askedByGate(s)], ["q_7"]);
  assert.equal(needsYouCount(s), 1, "the header's count says one thing, not two");
  assert.equal(humanStatus(s).text, "The writer has a question for you.");
  // the gate's ref is a question id: no frame, and no scene lookup
  assert.equal(previewOf(it, s, { frame: () => "frame", file: (n) => `file:${n}` }), undefined);
});

test("the mock's path: the angle question alone (blocks the script) is a pick; a Producer question is not", () => {
  const s = { ...blank(), questions: [angle({ id: "q_angle" })] };
  const [it] = needsItems(s);
  assert.equal(it.kind, "question");
  assert.ok(isPick(angle({ id: "q_angle" }), s));
  assert.ok(
    !isPick(angle({ id: "q_p", from: "producer" }), s),
    "the brief's questions keep the recommended-first card",
  );
  assert.ok(!isPick(angle({ id: "q_s", blocks: ["storyboard"] }), s));
});

test("a gate's preview: out/ files through the file route, scene ids through a frame", () => {
  const s = blank();
  s.timeline.scenes = [{ id: "s1", from: 0, to: 4 } as ProjectState["timeline"]["scenes"][number]];
  const urls = { frame: (t: number) => `frame@${t}`, file: (n: string) => `file:${n}` };
  const g3 = { id: "g3_rough", status: "open", items: [{ label: "Rough cut", ref: "out/contact.png" }] } as Gate;
  assert.equal(previewOf({ key: "g", kind: "gate", gate: g3 }, s, urls), "file:contact.png");
  const g2 = { id: "g2_animatic", status: "open", items: [{ label: "Scene", ref: "s1" }] } as Gate;
  assert.equal(previewOf({ key: "g", kind: "gate", gate: g2 }, s, urls), "frame@2");
});

test("drawer steps are named from the prompt card and kind, and an answer takes its call's name", () => {
  assert.equal(stepWords("pixel-artist/draw", "asset.draw", "Drawing moth, variant 2").done, "Drew variant 2");
  assert.equal(
    stepWords("pixel-artist/critique", "asset.critique", "Drawing moth, variant 1, critique 1").done,
    "Critiqued variant 1",
  );
  assert.equal(
    stepWords("pixel-artist/critique", "asset.repair", "Drawing moth, variant 1").done,
    "Fixed the grid of variant 1",
  );
  assert.equal(stepWords("art-director/judge", "asset.judge", "Choosing the best moth").done, "Picked the better one");
  assert.equal(stepWords(undefined, undefined, "x").ask, "Sent the prompt");
  const e = (kind: ActivityEntry["kind"], title: string, detail?: unknown): ActivityEntry => ({
    at: "2026-11-08T20:00:00.000Z",
    kind,
    title,
    detail,
  });
  const steps = stepsOf(
    [
      e("model", "Asked claude-opus-5 (pixel-artist/draw)", { prompt: "…", kind: "asset.draw" }),
      e("answer", "Answered in 9 s · 812 tokens"),
      e("step", "Checked variant 2 against the PAP standard: it passes"),
      e("model", "Asked claude-opus-5 (pixel-artist/critique)", { prompt: "…", kind: "asset.critique" }),
      e("answer", "Answered in 7 s · 500 tokens"),
    ],
    "Drawing moth, variant 2",
  );
  assert.deepEqual(
    steps.map((x) => x?.done ?? null),
    ["Drew variant 2", "Drew variant 2", null, "Critiqued variant 2", "Critiqued variant 2"],
  );
  assert.equal(
    groupTitle({ kind: "asset.draw", title: "Drawing moth, variant 2, critique 1" }),
    "Drawing the moth · variant 2",
  );
});

test("the live line: thinking, then writing, about N tokens, the time", () => {
  assert.equal(progressLine({ phase: "thinking", tokens: 4200, seconds: 48 }), "Thinking… about 4,200 tokens · 48 s");
  assert.equal(progressLine({ phase: "writing", tokens: 0, seconds: 3 }), "Writing… 3 s");
});

test("progress folds into state and ends with the answer or the task", () => {
  let s: ProjectState = {
    ...blank(),
    tasks: [
      {
        id: "t1",
        role: "pixel-artist",
        kind: "asset.draw",
        title: "Drawing moth, variant 1",
        status: "working",
        usd: 0,
      } as Task,
    ],
  };
  s = applyEvent(s, {
    event: "progress",
    data: { what: "task", taskId: "t1", phase: "thinking", tokens: 120, seconds: 4, tail: "" },
  });
  assert.equal(s.progress?.t1?.tokens, 120);
  // the export's own progress is not a task's
  assert.equal(applyEvent(s, { event: "progress", data: { what: "export", fraction: 0.5 } }), s);
  const answered = applyEvent(s, {
    event: "activity",
    data: { task: "t1", at: "2026-11-08T20:00:00.000Z", kind: "answer", title: "Answered in 9 s" },
  });
  assert.equal(answered.progress?.t1, undefined);
  const done = applyEvent(s, { event: "task", data: { ...s.tasks[0], status: "done" } });
  assert.equal(done.progress?.t1, undefined);
});

test("the live canvas reads only whole rows, in any key order", () => {
  const text =
    '{"notes":"a moth","frames":[{"rows":["..kk..",".kPPk."],"name":"idle0"},{"name":"idle1","rows":["..kk..",".kP';
  const frames = draftFrames(text);
  assert.deepEqual(frames, [
    { name: "idle0", rows: ["..kk..", ".kPPk."] },
    { name: "idle1", rows: ["..kk.."] },
  ]);
  assert.equal(liveFrame(text)?.name, "idle1");
  assert.deepEqual(draftFrames('{"notes":"no frames yet'), []);
  // the mock streams the same shape
  const live = mockProgress(
    { id: "t", role: "pixel-artist", status: "working", startedAt: "", kind: "asset.draw", title: "", usd: 0 } as Task,
    4,
  );
  assert.ok(live?.draft && liveFrame(live.draft)?.rows.length, "a few rows in");
});

test("Pip's thread: your message and the reply are one turn; Pip's own message and a milestone stand alone", () => {
  const at = (s: number) => new Date(Date.UTC(2026, 10, 8, 20, 0, s)).toISOString();
  const items: PipItem[] = [
    { id: "u1", at: at(1), kind: "user", text: "About the moth: make it bigger" },
    { id: "p1", at: at(2), kind: "pip", text: "On it.", cards: [] },
    { id: "p2", at: at(10), kind: "pip", text: "The rough cut is ready.", cards: [] },
  ];
  const turns = turnsOf(items, [{ id: "m1", at: at(5), text: "Plan changed: scene 2" }], null, false);
  assert.deepEqual(
    turns.map((t) => [t.by, t.items.map((i) => i.id).join("+") || t.marker?.id]),
    [
      ["person", "u1+p1"],
      ["marker", "m1"],
      ["pip", "p2"],
    ],
  );
  const thinking = turnsOf(items.slice(0, 1), [], null, true);
  assert.equal(thinking.length, 1);
  assert.ok(thinking[0].thinking, "Pip's dots go under your message, in the same turn");
});

test("the scope chip's words: sent as an About lead, shown apart in the bubble, never on a command", () => {
  assert.equal(scoped({ label: "the moth" }, "make it bigger"), "About the moth: make it bigger");
  assert.equal(scoped({ label: "the moth" }, "/context"), "/context");
  assert.equal(scoped(undefined, "hi"), "hi");
  assert.deepEqual(splitAbout("About the Pixel artist · moth: why the hat?"), {
    about: "the Pixel artist · moth",
    text: "why the hat?",
  });
  assert.deepEqual(splitAbout("make it bigger"), { about: null, text: "make it bigger" });
});

test("the plan card: the old price, the new total, the delta, and the Director named when it re-plans", () => {
  const card: Extract<PipCard, { type: "plan" }> = {
    id: "c1",
    type: "plan",
    title: "Plan change: $1.04 → about $1.95",
    detail: "The storyboard is done.",
    who: ["writer", "animator", "reviewer", "editor"],
    whoInstances: [
      { instance: "animator:s02", label: "Animator · scene 2" },
      { instance: "reviewer", label: "Reviewer" },
      { instance: "editor", label: "Editor" },
    ],
    usd: [0.8, 1.1],
    sec: null,
    effects: [],
    confirmLabel: "Go ahead",
    status: "proposed",
    revision: { rev: 3, ops: [], fromUsd: 1.04, toUsd: 1.95, planner: "director" },
  };
  assert.deepEqual(planDiff(card), { from: "$1.04", to: "$1.95", delta: "+$0.91", up: true });
  assert.equal(titleWords(card), "Plan change");
  const crew = planCrew(card);
  assert.equal(crew.planner, "Director");
  assert.deepEqual(crew.names, ["Animator · scene 2", "Reviewer", "Editor"]);
  assert.deepEqual(crew.roles, ["director", "animator", "reviewer", "editor"]);
  assert.equal(planDiff({ ...card, revision: undefined }), null);
});

test("needs you also comes from the plan (waiting_person), and the angle pick names the Writer", () => {
  const plan = (tasks: Partial<PlanTaskView>[]) =>
    ({ tasks: tasks.map((t) => ({ dependsOn: [], ...t })) }) as unknown as ProjectState["plan"];
  const s: ProjectState = {
    ...blank(),
    plan: plan([
      { id: "t_angles", role: "writer", instance: "writer", status: "done" },
      {
        id: "t_g1",
        role: "person",
        gate: "g1_script",
        instance: "",
        status: "waiting_person",
        dependsOn: ["t_angles"],
      },
      { id: "t_pub", role: "librarian", instance: "librarian:moth", status: "waiting_person" },
    ]),
  };
  assert.deepEqual([...waitingInstances(s)].sort(), ["librarian:moth", "writer"]);
});

test("stuck only for a live problem: a problem while the crew runs past it is not one", () => {
  const s: ProjectState = {
    ...blank(),
    tasks: [
      {
        id: "t1",
        role: "animator",
        kind: "scene.tune",
        title: "x",
        status: "failed",
        usd: 0,
        instance: "animator:s01",
      } as Task,
    ],
    status: { problem: { text: "Animator stopped", action: "retry", taskId: "t1" } } as ProjectState["status"],
    crew: { state: "idle" } as ProjectState["crew"],
  };
  assert.deepEqual([...stuckInstances(s)], ["animator:s01"]);
  const running = { ...s, crew: { state: "running", running: true } } as ProjectState;
  assert.deepEqual([...stuckInstances(running)], []);
});

const failed = (over: Partial<Task> = {}): Task =>
  ({
    id: "t1",
    role: "pixel-artist",
    kind: "asset.draw",
    title: "Drawing founder",
    status: "failed",
    usd: 0,
    error: { message: "401 invalid api key" },
    ...over,
  }) as Task;

test("a held run waits on you (needs, with its button); a run that broke off still reads Stopped", () => {
  const problem = { text: "Your Anthropic key was rejected.", action: "fix_key" as const, taskId: "t1" };
  const held: ProjectState = {
    ...blank(),
    tasks: [failed({ status: "cancelled" })],
    status: { line: "Waiting for you: Your Anthropic key was rejected", phase: 2, problem },
    crew: { state: "running", running: true, held: "Your Anthropic key was rejected" } as ProjectState["crew"],
  };
  const h = humanStatus(held);
  assert.equal(h.tone, "needs");
  assert.equal(h.text, "Your Anthropic key was rejected.");
  assert.equal(h.problem?.action, "fix_key", "the Fix the key button still has its problem");
  // a real failure, nothing held, the crew idle: Stopped (the red prefix's tone)
  const broke: ProjectState = { ...blank(), tasks: [failed()], crew: { state: "idle" } as ProjectState["crew"] };
  const b = humanStatus(broke);
  assert.equal(b.tone, "problem");
  assert.match(b.text, /stopped/);
});

test("the Librarian's publish question is a pick of its own two answers, and the Librarian is named as itself", () => {
  const s = { ...blank(), questions: [Q_PUBLISH("2026-11-08T10:00:00Z")] };
  const q = s.questions[0];
  assert.ok(isPick(q, s));
  assert.ok(!isPick({ ...q, from: "producer" }, s), "another member's yes/no keeps its card");
  assert.equal(theMember("librarian"), "the Librarian");
  assert.equal(theMember("pixel-artist"), "the artist");
  assert.equal(humanStatus(s).text, "The Librarian has a question for you.");
});

test("the budget pair costs nothing, so the card shows no $0; a priced card and a moved revision keep theirs", () => {
  const card: Extract<PipCard, { type: "plan" }> = {
    id: "c_finish",
    type: "plan",
    title: "Finish within $1.50",
    detail: "",
    who: [],
    usd: [0, 0],
    sec: null,
    effects: [],
    confirmLabel: "Finish within $1.50",
    status: "proposed",
  };
  assert.equal(planUsd(card), null);
  assert.equal(planUsd({ ...card, usd: [0.4, 0.4] }), "$0.40");
  assert.equal(planUsd({ ...card, usd: [0.2, 0.6] }), "$0.20–$0.60");
  const rev = { ...card, usd: [0.5, 0.9] as [number, number], revision: { fromUsd: 1, toUsd: 1, planner: "pip" } };
  assert.equal(planUsd(rev as typeof card), null, "a revision says its price as a diff");
  assert.equal(planDiff(rev as typeof card)?.delta, "", "no +$0 chip when the price stays");
});

test("a sentence ends once: Pip's crew line as is, a question keeps its mark, the crew is the crew", () => {
  assert.equal(sentence("raise it to $2.00?"), "raise it to $2.00?");
  assert.equal(sentence("Your key was rejected"), "Your key was rejected.");
  assert.equal(nameOf("crew"), "the crew");
  const at = new Date().toISOString();
  const m = {
    id: "m1",
    at,
    from: "pip",
    to: "crew",
    kind: "brief" as const,
    text: "Paused the crew: your key was rejected.",
  };
  assert.equal(channelSummary([m]), "Paused the crew: your key was rejected.");
  const ask = { ...m, to: "writer", text: "Can you shorten scene 2?" };
  assert.equal(channelSummary([ask]), "I briefed the writer: Can you shorten scene 2?");
});

test("a picked drawing names its asset; without a name it says Picked the drawing", () => {
  const judge = (id: string, title: string): Task =>
    ({
      id,
      role: "art-director",
      kind: "asset.judge",
      title,
      status: "done",
      usd: 0,
      endedAt: "2026-11-08T10:00:00Z",
    }) as Task;
  const s = {
    ...blank(),
    tasks: [judge("j1", "Choosing the best founder variants"), judge("j2", "Choosing the best cat variants")],
  };
  assert.deepEqual(
    milestones(s).map((m) => m.text),
    ["Founder drawn", "Cat drawn"],
  );
  assert.deepEqual(
    milestones({ ...blank(), tasks: [judge("j3", "Pick")] }).map((m) => m.text),
    ["Picked the drawing"],
  );
});
