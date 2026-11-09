// v0.3's web fixes (the P5 run), in node over the web's pure code: Pip's questions as picks, "Pip" never "the
// producer", the scroll trigger, word-safe cuts and one row per repeated milestone, the separate milestone track,
// Projects' Working before Finished, the contact sheet's frames, Pip's "Fix the key" reply, the routed G3 estimate,
// and the mock scenarios that show them (holds that ask, a card that resumes a hold, a G3 change to the Director with
// the estimate it showed, no third cut after approval, the playable rough cut). No DOM.
import assert from "node:assert/strict";
import { test } from "node:test";
import { newKeys } from "../src/lib/attention.ts";
import { fixOfCard, fixOfItem } from "../src/lib/fix.ts";
import { effectOf, humanStatus, theMember, waitReason } from "../src/lib/human.ts";
import { isPick, needsItems } from "../src/lib/needs.ts";
import { kindOf } from "../src/lib/projects.ts";
import { applyEvent } from "../src/lib/reducer.ts";
import { fitScale, frameRect, frameTime, sheetGrid } from "../src/lib/sheet.ts";
import { cutWords, dedupeMarkers } from "../src/lib/text.ts";
import { trackOf } from "../src/lib/thread.ts";
import type { PipCard, PipItem, ProjectState, ProjectSummary, QuestionT, ServerEvent } from "../src/lib/types.ts";
import { CHANGE_USD, HOLD_NOTE, Journey, routeNote, type Scenario } from "../src/mock/journey.ts";

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
const hold = (over: Partial<QuestionT> = {}): QuestionT => ({
  id: "q_h",
  kind: "single",
  question: "How should the crew go on?",
  why: "The cast came back partly done.",
  options: [
    { id: "redo", label: "Redo with the Director", detail: "" },
    { id: "accept", label: "Accept the look", detail: "" },
    { id: "tell", label: "Tell Pip what to change", detail: "" },
  ],
  recommendedId: "redo",
  blocks: [],
  timeoutSec: null,
  from: "pip",
  askedAt: "2026-11-08T20:00:00.000Z",
  status: "open",
  hold: true,
  ...over,
});

test("Pip's questions show every option: a pip question and any hold are picks; the brief's questions aren't", () => {
  const s = blank();
  assert.ok(isPick(hold(), s));
  assert.ok(isPick(hold({ hold: undefined }), s), "any question from Pip");
  assert.ok(isPick(hold({ from: "art-director" }), s), "any question that holds the run");
  assert.ok(isPick(hold({ kind: "yesno", options: hold().options.slice(0, 2) }), s), "a yes/no hold");
  assert.ok(!isPick(hold({ from: "producer", hold: undefined }), s), "the Producer's keep the recommended-first card");
  assert.ok(!isPick(hold({ options: hold().options.slice(0, 1) }), s), "one option is no choice");
});

test("Pip is Pip: never 'the producer', in the status line too", () => {
  assert.equal(theMember("pip"), "Pip");
  assert.equal(theMember("writer"), "the writer");
  assert.equal(theMember("librarian"), "the Librarian");
  const s = { ...blank(), questions: [hold()] };
  assert.equal(humanStatus(s).text, "Pip has a question for you.");
});

test("a stage with no steps of its own says nothing, not '0 of 0 steps'", () => {
  const s: ProjectState = {
    ...blank(),
    stage: "art",
    crew: { state: "running", running: true },
    tasks: [
      {
        id: "t1",
        kind: "writer.angles",
        role: "writer",
        title: "Writing",
        status: "working",
        usd: 0,
        startedAt: "2026-11-08T20:00:00.000Z",
      },
    ],
  };
  const r = waitReason(s);
  assert.equal(r.kind, "working");
  assert.doesNotMatch(r.text, /0 of 0/);
});

test("scroll to attention: the first look is the baseline; only keys it hasn't seen are news", () => {
  assert.deepEqual(newKeys(null, ["g:g1_script", "q:q_rights"]), [], "a load never scrolls");
  assert.deepEqual(newKeys(new Set(["q:q_rights"]), ["q:q_rights", "g:g3_rough"]), ["g:g3_rough"]);
  assert.deepEqual(newKeys(new Set(["q:q_rights"]), []), []);
  assert.deepEqual(newKeys(new Set<string>(), ["q:q_hold"]), ["q:q_hold"], "after everything was answered");
});

test("long text is cut on a word with '…'; a short line is left alone", () => {
  assert.equal(cutWords("Plan ready · 11 tasks to start"), "Plan ready · 11 tasks to start");
  const long = "Plan changed: scene 4 goes back to the Director for the title card earlier than planned because";
  const cut = cutWords(long, 60);
  assert.ok(cut.length <= 60, cut);
  assert.ok(cut.endsWith("…"));
  assert.doesNotMatch(cut, /\bear…$/, "never a cut word");
  assert.ok(long.startsWith(cut.slice(0, -1)), "the kept words are the line's own");
  assert.equal(cutWords("a".repeat(100), 20).length, 20, "one long word is cut where it must");
});

test("milestones: one row while it repeats, newest first, in a track of their own", () => {
  const at = (s: number) => new Date(Date.UTC(2026, 10, 8, 20, 0, s)).toISOString();
  const marks = [
    { id: "m1", at: at(1), text: "Plan ready · 11 tasks to start" },
    { id: "m2", at: at(5), text: "Plan changed: scene 1 goes back" },
    { id: "m3", at: at(6), text: "Plan changed: scene 1 goes back" },
    { id: "m4", at: at(9), text: "Your video is ready" },
    { id: "m5", at: at(12), text: "Plan changed: scene 1 goes back" },
  ];
  assert.deepEqual(
    dedupeMarkers(marks).map((m) => m.id),
    ["m1", "m3", "m4", "m5"],
    "the same words later, after something else, stay",
  );
  assert.deepEqual(
    trackOf(marks).map((m) => m.id),
    ["m5", "m4", "m3", "m1"],
    "newest first",
  );
});

test("Projects: a rerun is Working with v2 still playing, not ✓ Has a video", () => {
  const p = (over: Partial<ProjectSummary>): ProjectSummary =>
    ({ id: "x", title: "x", needsYou: 0, stage: "review", spentUsd: 1, updatedAt: "", ...over }) as ProjectSummary;
  const v2 = { v: 2, at: "2026-11-03T10:00:00Z", upToDate: false };
  assert.equal(kindOf(p({ version: v2, running: true })), "working");
  assert.equal(kindOf(p({ version: v2, running: false })), "finished");
  assert.equal(kindOf(p({ version: v2, running: true, needsYou: 1 })), "needs");
  assert.equal(kindOf(p({ draft: true })), "draft");
});

test("the contact sheet: 6 columns of 320×180, frame i at i + 0.5 s, a partial last row; odd sizes show whole", () => {
  const g = sheetGrid(1920, 900, 30);
  assert.deepEqual(g, { cols: 6, rows: 5, n: 30, every: 1 });
  const g2 = sheetGrid(1920, 1080, 33);
  assert.equal(g2?.n, 33, "a partial last row");
  assert.deepEqual(frameRect(g2 as NonNullable<typeof g2>, 7), { x: 320, y: 180, w: 320, h: 180 });
  assert.equal(frameTime(g2 as NonNullable<typeof g2>, 4), 4.5);
  assert.equal(sheetGrid(1000, 600, 30), null, "not whole frames: the dialog shows it whole");
  assert.equal(sheetGrid(1920, 900, 90)?.n, 30, "a film longer than the sheet trusts the sheet");
  assert.equal(fitScale(1300), 4);
  assert.equal(fitScale(1300, 400), 2, "the height limits it too");
  assert.equal(fitScale(100), 1);
});

test("Pip's 401 reply: a fix card or a problem on the item is the 'Fix the key' button", () => {
  const card = { id: "c", type: "fix", action: "fix_key", provider: "anthropic" } as PipCard;
  assert.deepEqual(fixOfCard(card), { action: "fix_key", provider: "anthropic" });
  const plan = { id: "c2", type: "plan", action: { kind: "fix_key" }, provider: "openai" } as unknown as PipCard;
  assert.deepEqual(fixOfCard(plan), { action: "fix_key", provider: "openai" });
  assert.equal(fixOfCard({ id: "f", type: "files", files: [] }), null);
  // what survives the server's publicCard (it strips `action`): the card's type, or a `fix` field
  assert.deepEqual(fixOfCard({ id: "s", type: "fix", provider: "anthropic" } as PipCard), {
    action: "fix_key",
    provider: "anthropic",
  });
  assert.deepEqual(fixOfCard({ id: "t", type: "fix", fix: "change_model" } as PipCard), { action: "change_model" });
  const item: PipItem = {
    id: "p",
    at: "",
    kind: "pip",
    text: "Your Anthropic key was rejected.",
    cards: [],
    problem: { action: "fix_key", provider: "anthropic" },
  };
  assert.deepEqual(fixOfItem(item), { action: "fix_key", provider: "anthropic" });
});

test("G3 'Change something': the routed estimate replaces 'the animator redoes all of animation'", () => {
  const s = blank();
  const r = routeNote("cast the owl from the library and have it sit on the roof in scene 3");
  assert.equal(r.role, "director");
  assert.deepEqual(r.scenes, ["s03"]);
  assert.equal(r.usd[0], +(CHANGE_USD.reboard + CHANGE_USD.tune + CHANGE_USD.review).toFixed(2));
  const fx = effectOf({ kind: "gate_changes", stage: "review", items: [], preview: r }, s);
  assert.match(fx.text, /^The Director re-boards scene 3/);
  assert.doesNotMatch(fx.text, /redoes all of/);
  assert.equal(fx.confirm, false, "a cheap change needs no second press");
  const pricey = effectOf({ kind: "gate_changes", stage: "review", items: [], preview: { ...r, usd: [0.6, 0.9] } }, s);
  assert.equal(pricey.confirm, true, "a costly one asks again");
  assert.equal(routeNote("make it faster in scene 2").role, "animator");
  assert.equal(routeNote("change the end card").scenes.at(-1), "s04");
});

// ---- the mock scenarios ----
const BASE = Date.UTC(2026, 10, 8, 20, 0, 0);
function play(scenario: Scenario | null, auto = true, extra: Partial<ConstructorParameters<typeof Journey>[0]> = {}) {
  const sim = new Journey({
    speed: 1,
    slots: 3,
    auto,
    base: BASE,
    scenario,
    sceneIds: ["s01", "s02", "s03", "s04"],
    ...extra,
  });
  let s: ProjectState = blank();
  const events: ServerEvent[] = [];
  const take = (b: ServerEvent[]) => {
    for (const e of b) {
      s = applyEvent(s, e);
      events.push(e);
    }
    s = { ...s, crew: { ...(s.crew ?? {}), held: sim.held } };
  };
  take(sim.start());
  const o = {
    sim,
    get s() {
      return s;
    },
    events,
    step: () => take(sim.step()),
    act: (a: Parameters<Journey["act"]>[0]) => take(sim.act(a)),
    run(until: (s: ProjectState) => boolean, max = 300) {
      for (let t = 0; t < max && !sim.ended && !until(s); t++) o.step();
    },
  };
  return o;
}
const open = (s: ProjectState, qid: string) => s.questions.some((q) => q.id === qid && q.status === "open");

test("scenario hold: a partial cast holds the run and asks with three options; Needs you is never 0 while held", () => {
  const r = play("hold");
  r.run((s) => open(s, "q_hold"));
  const q = r.s.questions.find((x) => x.id === "q_hold") as QuestionT;
  assert.equal(q.from, "pip");
  assert.equal(q.hold, true);
  assert.equal(q.options.length, 3);
  assert.ok(isPick(q, r.s), "every option shows");
  // auto leaves it to you; nothing starts while it asks
  const running = () => r.s.tasks.filter((t) => t.status === "working").length;
  for (let i = 0; i < 6; i++) {
    r.step();
    assert.ok(r.sim.held && needsItems(r.s).length > 0, "held only with an open need");
  }
  assert.equal(running(), 0, "nothing new starts while Pip holds");
  r.act({ type: "answer", qid: "q_hold", optionId: "redo" });
  assert.equal(r.sim.held, null, "the answer lifts the hold");
  r.run((s) => s.tasks.some((t) => t.status === "working"), 10);
  assert.ok(running() > 0, "the run goes on");
  assert.ok(
    r.s.instances?.some((i) => i.id === "pixel-artist:founder"),
    "Redo draws the founder",
  );
});

test("scenario hold: 'Tell Pip' needs the person's words; with them the hold lifts and the note goes on", () => {
  const r = play("hold");
  r.run((s) => open(s, "q_hold"));
  // no words: as the server, the question stays open and the crew stays held
  r.act({ type: "answer", qid: "q_hold", optionId: "tell" });
  assert.ok(open(r.s, "q_hold"), "an empty 'Tell Pip' keeps the question open");
  assert.ok(r.sim.held, "and the hold");
  r.act({ type: "answer", qid: "q_hold", optionId: "tell", note: "use the walking founder" });
  assert.equal(r.sim.held, null, "the note lifts the hold");
  assert.ok(!open(r.s, "q_hold"), "the question is answered");
  r.run((s) => s.tasks.some((t) => t.status === "working"), 10);
  assert.ok(
    r.s.tasks.some((t) => t.status === "working"),
    "the run goes on with the note",
  );
});

test("scenario holdcard: a Pip card confirmed during a hold starts now, closes the question and resumes", () => {
  const r = play("holdcard");
  r.run(() => r.sim.cards.has("c_hold"));
  assert.ok(r.sim.held, "still held while the card waits");
  const card = r.sim.cards.get("c_hold");
  assert.match(card?.detail ?? "", new RegExp(HOLD_NOTE.slice(0, 20)));
  assert.equal(card?.revision?.planner, "director", "the card names the Director");
  r.act({ type: "card", cardId: "c_hold", decision: "confirm" });
  assert.equal(r.sim.held, null);
  assert.equal(r.s.questions.find((q) => q.id === "q_hold")?.status, "withdrawn", "the hold's question closes");
  assert.equal(needsItems(r.s).length, 0);
  r.run((s) => s.tasks.some((t) => t.status === "working"), 10);
  assert.ok(
    r.s.tasks.some((t) => t.status === "working"),
    "the crew works at once",
  );
});

test("scenario g3director: a G3 change goes to the Director with the estimate it showed; after approval, no third cut", () => {
  const r = play("g3director");
  r.run((s) => s.gates.some((g) => g.id === "g3_rough" && g.status === "open"));
  const text = "the owl should sit on the roof in scene 3";
  const shown = routeNote(text);
  const revs = r.sim.revisions.length;
  r.act({ type: "gate", gate: "g3_rough", verdict: "changes", text });
  const rev = r.sim.revisions.at(-1);
  assert.equal(r.sim.revisions.length, revs + 1);
  assert.equal(rev?.by, "person");
  assert.ok(
    rev?.ops.some((o) => o.label === "Director"),
    "the Director re-boards",
  );
  assert.deepEqual(rev?.deltaUsd, shown.usd, "the estimate the card showed");
  // the scene goes stale while it is redrawn
  assert.ok(Object.values(r.s.sceneStatus ?? {}).some((x) => x.stale));
  r.run((s) => s.gates.some((g) => g.id === "g3_rough" && g.status === "open"));
  const after = r.sim.revisions.length;
  r.act({ type: "gate", gate: "g3_rough", verdict: "approve" });
  r.run(() => r.sim.nodes.find((n) => n.id === "g4")?.status === "done");
  for (let i = 0; i < 12; i++) r.step();
  assert.equal(r.sim.revisions.length, after, "no new revision after the approval: no third cut");
  assert.equal(r.s.gates.find((g) => g.id === "g4_final")?.status, "passed");
});

test("the rough cut with sound: each review writes a proxy; proxy=0 plays an older server without one", () => {
  const withIt = play(null, true, { proxyUrl: () => "blob:rough" });
  withIt.run((s) => s.gates.some((g) => g.id === "g3_rough" && g.status === "open"));
  assert.ok(withIt.events.some((e) => e.event === "render" && e.data.kind === "proxy" && e.data.url === "blob:rough"));
  const without = play(null, true, { proxyUrl: () => "blob:rough", proxy: false });
  without.run((s) => s.gates.some((g) => g.id === "g3_rough" && g.status === "open"));
  assert.ok(!without.events.some((e) => e.event === "render"));
});

test("the stops: drawer leaves the script pick open, sheet the rough cut; pipkey answers with 'Fix the key'", () => {
  const d = play("drawer");
  d.run((s) => open(s, "q_angle"));
  for (let i = 0; i < 8; i++) d.step();
  assert.ok(open(d.s, "q_angle"), "auto leaves the drawer's ask open");
  const sh = play("sheet");
  sh.run((s) => s.gates.some((g) => g.id === "g3_rough" && g.status === "open"));
  for (let i = 0; i < 8; i++) sh.step();
  const g3 = sh.s.gates.find((g) => g.id === "g3_rough");
  assert.equal(g3?.status, "open", "auto leaves the rough cut open");
  assert.equal(g3?.items[0]?.ref, "out/contact.png", "the rough cut's picture is its contact sheet");
  const k = play("pipkey");
  k.run((s) => s.gates.some((g) => g.id === "g3_rough" && g.status === "open"));
  assert.ok(k.sim.handlesAsk("anything at all"), "every message gets the rejected key");
  const before = k.events.length;
  k.act({ type: "ask", text: "make the hero bigger in scene 2" });
  k.step();
  k.step();
  const reply = k.events
    .slice(before)
    .find((e) => e.event === "pip" && e.data.type === "item" && e.data.item.kind === "pip");
  assert.ok(reply && reply.event === "pip" && reply.data.type === "item");
  const item = (reply as Extract<ServerEvent, { event: "pip" }>).data as { item: PipItem };
  const c = item.item.kind === "pip" ? item.item.cards[0] : undefined;
  assert.deepEqual(c && fixOfCard(c), { action: "fix_key", provider: "anthropic" });
});

test("a logged relative render URL never becomes a file the page can't load", () => {
  const listed = {
    name: "lumenbook_pitch.mp4",
    url: "/api/p/l/files/lumenbook_pitch.mp4",
    bytes: 9,
    kind: "video" as const,
  };
  const s = { ...blank(), files: [listed] };
  // P6: "files/x.mp4" resolved against /p/<id> and the player got the app's HTML
  const old = applyEvent(s, {
    event: "render",
    data: { kind: "final", url: "files/lumenbook_pitch.mp4" },
  } as ServerEvent);
  assert.deepEqual(old.files, [listed]);
  const again = applyEvent(s, { event: "render", data: { kind: "final", url: listed.url } } as ServerEvent);
  assert.equal(again.files.length, 1);
  const fresh = applyEvent(blank(), {
    event: "render",
    data: { kind: "final", url: "/api/p/l/files/new.mp4" },
  } as ServerEvent);
  assert.equal(fresh.files[0]?.url, "/api/p/l/files/new.mp4");
});
