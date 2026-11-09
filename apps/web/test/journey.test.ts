// The journey "todo" (docs/PIP-JOURNEY.md §6) played in node through the reducer: the crew row at each checkpoint of
// the §2 table (read from the doc itself, so the two can't drift), the horizon cap, the event order, slots=1, the
// returns, the final counter, the spend, the person's picks and the strings. No DOM.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { cardRank, laterCard, revertCard } from "../src/lib/cards.ts";
import { channelSummary } from "../src/lib/channel-words.ts";
import { needsYouCount } from "../src/lib/derive.ts";
import { humanStatus, PROBLEM_BUTTON } from "../src/lib/human.ts";
import {
  crewGroups,
  ghostLine,
  instanceNews,
  instanceOfMsg,
  OUTCOME_WORD,
  ROLE_GLYPH,
  ROLE_HUE,
  revisionLine,
  stuckInstances,
  timeAlive,
  waitingInstances,
} from "../src/lib/instances.ts";
import { applyEvent } from "../src/lib/reducer.ts";
import type {
  ChannelMsg,
  Draft,
  Instance,
  PipCard,
  PipItem,
  ProjectState,
  Role,
  ServerEvent,
  Task,
} from "../src/lib/types.ts";
import { COPIED, copyLine, MockDrafts } from "../src/mock/drafts.ts";
import { fixtureChanges, fixtureInstances, instanceChange } from "../src/mock/fixture-crew.ts";
import { DAYTIME, JOURNEY, Journey, journeyFlags, OVERRUN_CAP } from "../src/mock/journey.ts";

const BASE = Date.UTC(2026, 10, 7, 21, 0, 0);

function blank(): ProjectState {
  return {
    doc: {} as ProjectState["doc"],
    rev: 0,
    timeline: { cues: [], hold: 0, endHold: 0, duration: 30, scenes: [], events: {} },
    stage: "brief",
    gates: [],
    tasks: [],
    questions: [],
    notes: [],
    budget: { capUsd: JOURNEY.capUsd, spentUsd: 0, reservedUsd: 0, estTotalUsd: null },
    time: { startedAt: null, etaSec: null, deadline: null },
    files: [],
    digest: "",
    instances: [],
    plan: null,
  };
}

type Row = { live: string[]; ghosts: string[]; counter: number };
const rowOf = (s: ProjectState): Row => {
  const all = s.instances ?? [];
  return {
    live: all.filter((i) => i.state === "live").map((i) => i.label),
    ghosts: all.filter((i) => i.ghost).map((i) => i.label),
    counter: all.filter((i) => i.state === "finished").length,
  };
};
const key = (r: Row) => `${[...r.live].sort().join("|")}#${[...r.ghosts].sort().join("|")}#${r.counter}`;

type Run = { states: ProjectState[]; events: ServerEvent[][]; final: ProjectState; sim: Journey };
function play(slots: number, maxTicks = 200, logo = true): Run {
  const sim = new Journey({ speed: 1, slots, auto: true, base: BASE, logo });
  let s = blank();
  const states: ProjectState[] = [];
  const events: ServerEvent[][] = [];
  const take = (batch: ServerEvent[]) => {
    events.push(batch);
    for (const e of batch) s = applyEvent(s, e);
    states.push(s);
  };
  take(sim.start());
  for (let t = 0; t < maxTicks && !sim.ended; t++) take(sim.step());
  return { states, events, final: s, sim };
}

/** the §2 checkpoint table, read from the doc: "Animator · scene 1, 2, 3" expands; "(…)" notes and "–" drop */
function checkpoints(): { name: string; row: Row }[] {
  const doc = readFileSync(new URL("../../../docs/PIP-JOURNEY.md", import.meta.url), "utf8");
  const start = doc.indexOf("**The row at each checkpoint**");
  assert.ok(start > 0, "PIP-JOURNEY.md §2 has the checkpoint table");
  const lines = doc.slice(start).split("\n");
  const first = lines.findIndex((l) => l.startsWith("| Checkpoint"));
  const rows: { name: string; row: Row }[] = [];
  for (const line of lines.slice(first + 2)) {
    if (!line.startsWith("|")) break;
    const [name, live, ghosts, counter] = line
      .split("|")
      .slice(1, -1)
      .map((c) => c.trim());
    const names = (cell: string) => {
      const out: string[] = [];
      for (const raw of cell
        .replace(/\([^)]*\)/g, "")
        .split(",")
        .map((x) => x.trim())
        .filter((x) => x && x !== "–")) {
        if (/^\d+$/.test(raw) && out.length) out.push(out[out.length - 1].replace(/\d+$/, raw));
        else out.push(raw);
      }
      return out;
    };
    rows.push({
      name,
      row: { live: names(live), ghosts: names(ghosts), counter: Number(counter.replace(/[^\d]/g, "") || 0) },
    });
  }
  return rows;
}

test("the crew row passes every §2 checkpoint, in order", () => {
  const { states } = play(3);
  const seen: string[] = [];
  for (const s of states) {
    const k = key(rowOf(s));
    if (seen.at(-1) !== k) seen.push(k);
  }
  const table = checkpoints();
  assert.ok(table.length >= 15, `the table has its rows (${table.length})`);
  let at = 0;
  for (const c of table) {
    const want = key(c.row);
    const i = seen.indexOf(want, at);
    assert.ok(
      i >= 0,
      `checkpoint "${c.name}" (${want}) comes after the one before it; the row went: ${seen.slice(at).join("  ;  ")}`,
    );
    at = i + 1;
  }
});

test("live faces are instances with a working task or one waiting on the person, never more than 3 ghosts", () => {
  for (const s of play(3).states) {
    const working = new Set(
      s.tasks.filter((t) => t.status === "working" || t.status === "waiting_user").map((t) => t.instance),
    );
    const live = new Set((s.instances ?? []).filter((i) => i.state === "live").map((i) => i.id));
    assert.deepEqual([...live].sort(), [...working].sort());
    assert.ok((s.instances ?? []).filter((i) => i.ghost).length <= 3);
    for (const i of s.instances ?? []) assert.ok(!(i.ghost && i.state === "live"), `${i.id} is live and a ghost`);
  }
});

test("a face comes before its task's working, and leaves after its last task ends (N3)", () => {
  const { events } = play(3);
  const inst = new Map<string, Instance>();
  const tasks = new Map<string, { status: string; instance?: string }>();
  for (const e of events.flat()) {
    if (e.event === "instance") {
      const { instance, change } = e.data;
      if (change === "end")
        for (const [, t] of tasks)
          if (t.instance === instance.id) assert.notEqual(t.status, "working", `${instance.id} ended while working`);
      inst.set(instance.id, instance);
    }
    if (e.event === "task") {
      tasks.set(e.data.id, { status: e.data.status, instance: e.data.instance });
      if (e.data.status === "working" && e.data.instance)
        assert.equal(inst.get(e.data.instance)?.state, "live", `${e.data.instance} shows before ${e.data.id} works`);
    }
  }
});

test("slots=1: one task works at a time, and 7c has one live Animator with three Animator ghosts", () => {
  const { states, final } = play(1, 400);
  let seen = false;
  for (const s of states) {
    assert.ok(s.tasks.filter((t) => t.status === "working").length <= 1);
    const r = rowOf(s);
    if (
      r.live.length === 1 &&
      r.live[0].startsWith("Animator") &&
      r.ghosts.filter((g) => g.startsWith("Animator")).length === 3
    )
      seen = true;
  }
  assert.ok(seen, "one live Animator and three Animator ghosts at some point");
  assert.equal(rowOf(final).counter, 11);
});

test("the returns keep their instance; no label exists twice", () => {
  const { events, final } = play(3);
  const ids = new Map<string, Set<string>>();
  const changes = new Map<string, string[]>();
  for (const e of events.flat())
    if (e.event === "instance") {
      const { instance, change } = e.data;
      ids.set(instance.label, (ids.get(instance.label) ?? new Set()).add(instance.id));
      changes.set(instance.id, [...(changes.get(instance.id) ?? []), change]);
    }
  for (const [label, set] of ids) assert.equal(set.size, 1, `${label} is one instance`);
  for (const id of ["animator:s01", "animator:s02"]) {
    assert.ok(changes.get(id)?.includes("revive"), `${id} came back`);
    assert.ok((final.instances ?? []).find((i) => i.id === id)?.lives.length === 2, `${id} has two lives`);
  }
});

test("the final counter is 11 and the run spends $1.77", () => {
  const { final, sim } = play(3);
  assert.ok(sim.ended, "the run reaches step 12");
  assert.equal(rowOf(final).counter, 11);
  assert.equal((final.instances ?? []).length, 11);
  assert.ok(Math.abs(final.budget.spentUsd - 1.77) <= 0.01, `spent ${final.budget.spentUsd}`);
  const crew = (final.instances ?? []).reduce((a, i) => a + i.usd, 0);
  assert.ok(Math.abs(crew - 1.65) <= 0.01, `crew ${crew}`);
  assert.equal(final.gates.find((g) => g.id === "g4_final")?.status, "passed");
});

test("no person pick passes without the person; G2 passes in code, G4 with the G3 press (Decision 2)", () => {
  const sim = new Journey({ speed: 1, slots: 3, auto: false, base: BASE });
  let s = blank();
  const run = (batch: ServerEvent[]) => {
    for (const e of batch) s = applyEvent(s, e);
  };
  run(sim.start());
  for (let t = 0; t < 120; t++) run(sim.step());
  // left alone, the run waits on the script pick and the logo; nothing is answered for the person
  assert.equal(s.gates.find((g) => g.id === "g1_script")?.status, undefined);
  assert.deepEqual(
    s.questions.map((q) => [q.id, q.status]),
    [
      ["q_rights", "open"],
      ["q_angle", "open"],
    ],
  );
  run(sim.act({ type: "answer", qid: "q_angle" }));
  for (let t = 0; t < 120; t++) run(sim.step());
  assert.equal(s.gates.find((g) => g.id === "g2_animatic")?.status, "passed", "G2 passes in code under key");
  // scene 4 carries the logo: it never starts before the rights pick
  assert.ok(!s.tasks.some((t) => t.instance === "animator:s04"), "scene 4 waits on the rights pick");
  assert.equal(s.questions.find((q) => q.id === "q_rights")?.status, "open");
  run(sim.act({ type: "answer", qid: "q_rights" }));
  for (let t = 0; t < 120; t++) run(sim.step());
  assert.equal(s.gates.find((g) => g.id === "g3_rough")?.status, "open");
  assert.notEqual(s.gates.find((g) => g.id === "g4_final")?.status, "passed");
  run(sim.act({ type: "gate", gate: "g3_rough", verdict: "approve" }));
  for (let t = 0; t < 20; t++) run(sim.step());
  assert.equal(s.gates.find((g) => g.id === "g4_final")?.status, "passed", "the G3 press passes G4");
  for (const q of s.questions) assert.equal(q.answer?.by, "user");
});

test("every reason and milestone matches its §5 template", () => {
  const { events } = play(3);
  const flat = events.flat();
  const milestones = flat.flatMap((e) => (e.event === "milestone" ? [e.data.text] : []));
  for (const m of milestones)
    assert.match(m, /^(Plan ready · \d+ tasks to start|Plan changed: [a-z].+|Your video is ready)$/, m);
  assert.ok(milestones.includes("Plan ready · 11 tasks to start"));
  const reasons = new Set<string>();
  for (const e of flat)
    if (e.event === "instance") {
      reasons.add(e.data.instance.reason);
      for (const l of e.data.instance.lives) if (l.reason) reasons.add(l.reason);
    }
  for (const r of reasons)
    assert.match(
      r,
      /^Pip brought (in (the|an?) [A-Z][a-z]+( [a-z]+)? (for|to) .+|the [A-Z][a-z]+ back (to|for) .+)$/,
      r,
    );
  // role words in sentence case (N5), qualifier after " · "
  for (const e of flat)
    if (e.event === "instance") assert.match(e.data.instance.label, /^[A-Z][a-z]+( [a-z]+)?( · [a-z0-9 ]+)?$/);
});

test("the picks follow the draft: 3 with a logo, 2 without (no import, no logo pick, no toast)", () => {
  const picks = (r: Run) => {
    const flat = r.events.flat();
    const asked = new Set(flat.flatMap((e) => (e.event === "question" ? [e.data.id] : [])));
    const gates = new Set(flat.flatMap((e) => (e.event === "gate" && e.data.status === "open" ? [e.data.id] : [])));
    return asked.size + gates.size;
  };
  const withLogo = play(3);
  assert.equal(picks(withLogo), 3, "the script, the logo, the rough cut");
  const without = play(3, 200, false);
  assert.ok(without.sim.ended, "the run without a logo reaches step 12");
  assert.equal(picks(without), 2, "the script and the rough cut");
  const flat = without.events.flat();
  assert.ok(!flat.some((e) => e.event === "question" && e.data.id === "q_rights"), "no logo pick");
  assert.ok(!flat.some((e) => e.event === "task" && e.data.kind === "asset.import"), "no import");
  assert.ok(!without.sim.nodes.some((n) => n.gate === "rights"), "no rights node, so no logo toast waits on one");
  assert.ok(flat.some((e) => e.event === "milestone" && e.data.text === "Plan ready · 10 tasks to start"));
  assert.equal(rowOf(without.final).counter, 11);
  assert.ok(Math.abs(without.final.budget.spentUsd - 1.77) <= 0.01);
});

// ---- P2: the faces, the words and the groups (lib/instances.ts) ----

test("each role's calm glyphs and hue follow the §3.1 table, and no two crew roles look alike", () => {
  const doc = readFileSync(new URL("../../../docs/PIP-JOURNEY.md", import.meta.url), "utf8");
  const start = doc.indexOf("| Role | Glyphs | Hue |");
  assert.ok(start > 0, "§3.1 has the glyph table");
  const rows: string[] = [];
  for (const l of doc.slice(start).split("\n").slice(2)) {
    if (!/^\s*\|/.test(l)) break;
    rows.push(l);
  }
  assert.ok(rows.length >= 12, `the table has its rows (${rows.length})`);
  for (const line of rows) {
    const [role, glyphs, hue] = line
      .split("|")
      .slice(1, -1)
      .map((c) => c.trim().replace(/`/g, ""));
    assert.equal(ROLE_GLYPH[role as Role], glyphs, `${role}'s glyphs`);
    assert.equal(ROLE_HUE[role as Role], Number(hue), `${role}'s hue`);
  }
  assert.notEqual(ROLE_GLYPH.writer, ROLE_GLYPH.director, "the Writer and the Director differ");
});

test("the row's sentences and Pip's words follow §5, once per change", () => {
  const { states } = play(3);
  const said: string[] = [];
  const pip: string[] = [];
  let prev = new Map<string, Instance>();
  for (const s of states) {
    const news = instanceNews(prev, s.instances ?? []);
    said.push(...news.said);
    if (news.pip) pip.push(news.pip);
    assert.equal(news.conduct, news.pip !== "", "Pip conducts exactly when it brings someone in");
    prev = new Map((s.instances ?? []).map((i) => [i.id, i]));
  }
  for (const line of said)
    assert.match(
      line,
      /^(Pip brought (in|the) .+\.|Pip brought in \d+ [A-Z][a-z]+s, one per scene\.|.+ (finished|stopped|failed)\.|.+ is partly done: .+)$/,
      line,
    );
  assert.ok(said.includes("Pip brought in the Writer for three script angles."));
  assert.ok(said.includes("Pip brought in 2 Animators, one per scene."), "a batch of one role merges");
  assert.ok(
    said.includes("Pip brought the Animator back to fix the scene 1 headline."),
    "a return says its life's reason",
  );
  assert.ok(said.includes("Animator · scene 3 is partly done: No recipe for two people talking."));
  assert.equal(said.filter((l) => l === "Pixel artist · founder finished.").length, 1, "one sentence per leave");
  for (const w of pip) assert.ok(!/^Pip /.test(w) && /^[A-Z]/.test(w), `Pip's bubble drops "Pip ": ${w}`);
  assert.ok(pip.includes("Brought in the Director to board 4 scenes"));
  assert.ok(pip.some((w) => w.includes("Brought in a Pixel artist for the founder")));
});

test("the drawer's groups: Working, Up next in plan order, Finished newest first; time alive adds up", () => {
  const { states, final } = play(3);
  // 7c, scene 3 waits for a free slot: its ghost line says so
  const slot = states.find((s) =>
    (s.plan?.tasks ?? []).some((t) => t.instance === "animator:s03" && t.status === "ready"),
  );
  assert.ok(slot, "scene 3 waits for a slot");
  assert.equal(ghostLine("animator:s03", slot as ProjectState), "Waiting for a free slot. 3 are working.");
  // 5, the Director waits on the script pick
  const first = states[0];
  assert.equal(ghostLine("director", first), "Starts after the script pick.");
  for (const s of states) {
    const g = crewGroups(s);
    const ids = [...g.working, ...g.upNext, ...g.finished].map((i) => i.id);
    assert.equal(new Set(ids).size, ids.length, "no instance in two groups");
  }
  const g = crewGroups(final);
  assert.equal(g.working.length, 0);
  assert.equal(g.upNext.length, 0);
  assert.equal(g.finished.length, 11);
  assert.equal(g.finished[0].label, "Editor", "newest first");
  const s01 = g.finished.find((i) => i.id === "animator:s01") as Instance;
  const spans = s01.lives.reduce((a, l) => a + (Date.parse(l.to ?? "") - Date.parse(l.from)) / 1000, 0);
  assert.equal(timeAlive(s01), spans);
  assert.ok(
    s01.lives.length === 2 &&
      timeAlive(s01) > (Date.parse(s01.lives[0].to ?? "") - Date.parse(s01.lives[0].from)) / 1000,
  );
  assert.equal(OUTCOME_WORD[s01.outcome ?? "done"], "✓ done");
  // midway, Up next lists every planned member, uncapped, in plan order
  const mid = states.find((s) =>
    (s.instances ?? []).some((i) => i.id === "director" && i.state === "live"),
  ) as ProjectState;
  const next = crewGroups(mid).upNext.map((i) => i.id);
  assert.ok(next.length > 3, `Up next is not capped (${next.length})`);
  const order = (mid.plan?.tasks ?? []).map((t) => t.instance);
  assert.deepEqual(
    next,
    [...next].sort((a, b) => order.indexOf(a) - order.indexOf(b)),
  );
});

test("Pip's messages float over the member they are about; plan revisions read as one line each", () => {
  const { final, sim } = play(3);
  const all = final.instances ?? [];
  const msg = (from: string, to: string, ref?: string) =>
    ({ id: "x", at: "", from, to, kind: "answer", text: "", ...(ref ? { ref } : {}) }) as const;
  assert.equal(instanceOfMsg(msg("pip", "animator", "s03"), all), "animator:s03");
  assert.equal(instanceOfMsg(msg("art-director", "pip", "t_cast"), all), "art-director");
  assert.equal(instanceOfMsg(msg("animator", "pip"), all), null, "an animator message without a ref is nobody's");
  const lines = sim.revisions.map((r) => revisionLine(r, () => "21:06"));
  assert.equal(lines.length, 4);
  assert.equal(
    lines[1],
    "rev 1 · 21:06 · Pip: added a Pixel artist for the founder: the library had no founder sprite.",
  );
  assert.match(lines[0], /^rev 0 · 21:06 · Rules: /, "the rules plan is rev 0, as on the server (N26)");
  assert.match(lines[3], /^rev 3 · 21:06 · You: scene 2 goes back/);
});

// ---- /new on the real server: the races and "Make another like this" (PIP-JOURNEY §3.6, §9) ----

test("a late reply never moves a card back from where its own events took it", () => {
  const form = { id: "c_q1", type: "form", form: "brief_fields", title: "", fields: [] } as const;
  const plan = {
    id: "c_f",
    type: "plan",
    title: "",
    detail: "",
    who: [],
    usd: null,
    sec: null,
    effects: [],
    confirmLabel: "",
  } as const;
  const at = <C extends object>(c: C, status: string) => ({ ...c, status }) as unknown as PipCard;
  // the form's done event came first; the "submitted" reply lands after
  assert.equal(laterCard(at(form, "done"), at(form, "submitted")).status, "done");
  assert.equal(laterCard(at(form, "superseded"), at(form, "submitted")).status, "superseded");
  assert.equal(laterCard(at(form, "open"), at(form, "submitted")).status, "submitted");
  // a fork's done before its "running" reply; a Start's reply moves the brief card on
  assert.equal(laterCard(at(plan, "done"), at(plan, "running")).status, "done");
  assert.equal(laterCard(at(plan, "running"), at(plan, "failed")).status, "failed");
  assert.equal(cardRank(at(form, "open")) < cardRank(at(form, "submitted")), true);
  // a failed press puts the card back only while its optimistic status still shows
  const before = at(plan, "proposed");
  const optimistic = at(plan, "running");
  assert.equal(revertCard(optimistic, optimistic, before), before);
  assert.equal(revertCard(at(plan, "done"), optimistic, before), null, "a 409 after its done event keeps done");
  assert.equal(revertCard(at(form, "open"), null, at(form, "open"))?.status, "open");
});

function drafts(projects: Record<string, { title: string; fields: Draft["fields"] }>) {
  const pushed: PipItem[] = [];
  const d = new MockDrafts({
    push: (_draft, item) => pushed.push(item),
    update: () => {},
    card: (_draft, card) => card,
    thinking: () => {},
    start: () => "p",
    started: () => {},
    copyOf: (id) => projects[id] ?? null,
  });
  return { d, pushed };
}

test("Make another like this copies the settings, never the idea or the files, and says so first", () => {
  const { d } = drafts({
    questday_teaser: {
      title: "QuestDay teaser",
      fields: {
        audience: "investors",
        lengthSec: 15,
        narration: "none",
        involvement: "key",
        style: ["playful"],
        budget: 3,
        profile: "balanced",
        idea: "never copied",
      },
    },
  });
  const { draft, items } = d.create("questday_teaser");
  assert.equal(draft.from, "questday_teaser");
  assert.deepEqual(Object.keys(draft.fields).sort(), [...COPIED].sort());
  assert.equal(draft.fields.idea, undefined);
  assert.deepEqual(draft.refs, []);
  assert.equal(items.length, 1);
  assert.equal(items[0].kind === "pip" && items[0].text, copyLine("QuestDay teaser"));
  assert.equal(
    copyLine("QuestDay teaser"),
    "Another one like QuestDay teaser: same style, cast and settings. What's this one about?",
  );
  // the idea alone: nothing is left open, so the brief comes straight away, and Pip repeats nothing it inherited
  const r = d.reply(draft.id, "a pitch for Lumenbook, a reading app");
  assert.equal(r.reply, "Got it.");
  assert.equal(r.cards[0].type, "brief");
  const brief = r.cards[0] as Extract<PipCard, { type: "brief" }>;
  assert.equal(brief.fields.find((f) => f.key === "lengthSec")?.value, "15 s");
  assert.throws(() => d.create("gone"), /That project is gone/);
  // a fresh /new still opens on "What are we making?"
  const fresh = d.create();
  assert.equal(fresh.items[0].kind === "pip" && fresh.items[0].text, "What are we making?");
  assert.deepEqual(fresh.draft.fields, {});
});

// ---- the scenarios (`scenario=…`, PIP-JOURNEY §6): P4's situations with the server's shapes, no paid call ----
type Scn = {
  sim: Journey;
  s: ProjectState;
  /** every state after a batch, with the status and crew.held the client would send */
  states: ProjectState[];
  /** the crew channel so far */
  chans: ChannelMsg[];
  step: () => void;
  act: (a: Parameters<Journey["act"]>[0]) => void;
  /** step until `until` holds (or the run ends) */
  run: (until?: (s: ProjectState, sim: Journey) => boolean, max?: number) => void;
};
function scenario(name: "revision" | "overrun" | "publish" | "keyfail" | "edits", auto = true, capUsd?: number): Scn {
  const sim = new Journey({ speed: 1, slots: 3, auto, base: BASE, scenario: name, ...(capUsd ? { capUsd } : {}) });
  const o: Scn = {
    sim,
    s: {
      ...blank(),
      // enough of the document for humanStatus
      doc: { brief: { narration: "none" }, scenes: [], audio: { vo: [] } } as unknown as ProjectState["doc"],
      budget: { ...blank().budget, capUsd: capUsd ?? JOURNEY.capUsd },
    },
    states: [],
    chans: [],
    step: () => take(sim.step()),
    act: (a) => take(sim.act(a)),
    run: (until, max = 300) => {
      for (let t = 0; t < max && !sim.ended && !(until?.(o.s, sim) ?? false); t++) o.step();
    },
  };
  const take = (batch: ServerEvent[]) => {
    for (const e of batch) {
      o.s = applyEvent(o.s, e);
      if (e.event === "channel") o.chans.push(e.data as ChannelMsg);
    }
    // as MockClient.pushStatus and syncCrew do
    const own = sim.statusNow;
    o.s = {
      ...o.s,
      status: own ? { phase: 0, ...own } : undefined,
      crew: { ...(o.s.crew ?? {}), state: "running", running: true, held: sim.held },
    };
    o.states.push(o.s);
  };
  take(sim.start());
  return o;
}

/** the person's two picks, each answered once it is asked (the logo, then the angle) */
function picks(sc: Scn) {
  const open = (id: string) => sc.s.questions.some((q) => q.id === id && q.status === "open");
  sc.run((s) => s.questions.some((q) => q.id === "q_rights" && q.status === "open"));
  sc.act({ type: "answer", qid: "q_rights" });
  sc.run(() => open("q_angle"));
  sc.act({ type: "answer", qid: "q_angle" });
}

test("scenario revision: a plan change past 20% holds the founder's drawing behind a 'Plan change' card", () => {
  const sc = scenario("revision", false);
  // answer the picks by hand, then watch the card arrive
  picks(sc);
  sc.run((s) => !!s.plan?.pending);
  const plan = sc.s.plan;
  assert.deepEqual(plan?.pending, { rev: 1, cardId: "c_rev", tasks: ["t_draw_founder"] });
  const card = sc.sim.cards.get("c_rev");
  assert.equal(card?.title, "Plan change: $1.40 → about $1.95");
  assert.equal(card?.revision?.planner, "director");
  assert.deepEqual([card?.revision?.fromUsd, card?.revision?.toUsd], [1.4, 1.95]);
  assert.equal(card?.confirmLabel, "Go ahead");
  assert.deepEqual(sc.s.status, {
    phase: 0,
    line: "Waiting for you: the plan change in Pip's thread",
    waiting: "plan",
  });
  assert.equal(needsYouCount(sc.s), 1, "the card counts as needing you");
  // the held drawing never starts while the card waits; scene 4 runs on
  for (let i = 0; i < 12; i++) sc.step();
  assert.ok(!sc.s.tasks.some((t) => t.planTask === "t_draw_founder"), "the founder isn't drawn yet");
  assert.ok(
    sc.s.tasks.some((t) => t.planTask === "t_tune_s04" && t.status !== "upcoming"),
    "scene 4 keeps running",
  );
  sc.act({ type: "card", cardId: "c_rev", decision: "confirm" });
  assert.equal(sc.sim.cards.get("c_rev")?.status, "done");
  assert.equal(sc.s.plan?.pending, undefined);
  assert.equal(sc.s.plan?.approvedUsd, 1.95, "confirming moves the approved estimate");
  assert.equal(sc.s.status, undefined);
  sc.run((s) => s.tasks.some((t) => t.planTask === "t_draw_founder"));
  assert.ok(sc.s.tasks.some((t) => t.planTask === "t_draw_founder" && t.status === "working"));
  // a decline drops the drawing and the scenes go on without it
  const d = scenario("revision", false);
  picks(d);
  d.run((s) => !!s.plan?.pending);
  d.act({ type: "card", cardId: "c_rev", decision: "decline" });
  assert.equal(d.sim.node("t_draw_founder").status, "dropped");
  d.run((s) => s.tasks.some((t) => t.planTask === "t_tune_s01"));
  assert.ok(!d.s.tasks.some((t) => t.planTask === "t_draw_founder"));
});

test("scenario overrun: at 80% of a $1.50 cap, 'Finish within' leads, 'Raise the cap' follows; one settles the other", () => {
  const sc = scenario("overrun", true, OVERRUN_CAP);
  sc.run((_s, sim) => sim.budgetWait);
  const finish = sc.sim.cards.get("c_finish");
  const raise = sc.sim.cards.get("c_raise");
  assert.equal(finish?.title, "Finish within $1.50");
  assert.deepEqual(finish?.effects, ["Leaves out the second review round.", "Everything else is made as planned."]);
  assert.equal(raise?.title, "Raise the cap to $2");
  assert.equal(raise?.confirmLabel, "Set $2");
  assert.ok(sc.sim.spent >= 0.8 * OVERRUN_CAP, `asked at ${sc.sim.spent}`);
  assert.equal(sc.s.status?.waiting, "budget");
  assert.match(
    sc.s.status?.line ?? "",
    /^Waiting for you: 80% of the \$1\.50 cap is spent\. Finish within it, or raise it to \$2\.$/,
  );
  // Pip's line under the status ends once: no "$2.00?."
  const said = channelSummary([{ ...sc.chans.at(-1)!, at: new Date().toISOString() }]);
  assert.equal(said, "Paused the crew: 80% of the $1.50 cap is spent.");
  assert.equal(needsYouCount(sc.s), 1);
  // nothing new starts while the question is open
  const working = sc.s.tasks.filter((t) => t.status === "working").length;
  sc.step();
  assert.ok(sc.s.tasks.filter((t) => t.status === "working").length <= working);
  // auto leaves the question to the person; "Finish within" settles the raise, the second review round never comes
  for (let i = 0; i < 6; i++) sc.step();
  assert.equal(sc.sim.cards.get("c_finish")?.status, "proposed", "auto never answers a scenario's own question");
  sc.act({ type: "card", cardId: "c_finish", decision: "confirm" });
  sc.run();
  assert.equal(sc.sim.cards.get("c_finish")?.status, "done");
  assert.equal(sc.sim.cards.get("c_raise")?.status, "declined");
  assert.equal(sc.sim.cards.get("c_raise")?.result?.text, "You chose the other way.");
  assert.ok(!sc.sim.nodes.some((n) => n.id === "t_review_r2"), "no second review round");
  assert.ok(sc.sim.revisions.some((r) => r.trigger === "budget" && r.ops[0]?.op === "trim"));
  assert.equal(sc.s.gates.find((g) => g.id === "g4_final")?.status, "passed", "the run still finishes");
  // the other answer: raising the cap settles "Finish within" and sends the new cap
  const r = scenario("overrun", false, OVERRUN_CAP);
  picks(r);
  r.run((_s, sim) => sim.budgetWait);
  r.act({ type: "card", cardId: "c_raise", decision: "confirm" });
  assert.equal(r.sim.cards.get("c_finish")?.status, "declined");
  assert.equal(r.s.budget.capUsd, 2);
  assert.equal(r.s.status, undefined);
});

test("scenario publish: the Librarian asks once, with the server's copy, and shows needs you until answered", () => {
  const sc = scenario("publish");
  sc.run((s) => s.questions.some((q) => q.id === "q_publish"));
  const q = sc.s.questions.find((x) => x.id === "q_publish");
  assert.equal(q?.question, 'Add "founder" to your asset library?');
  assert.equal(q?.kind, "yesno");
  assert.deepEqual(
    q?.options.map((o) => o.label),
    ["Yes, add it", "Keep it in this project"],
  );
  const row = sc.s.tasks.find((t) => t.kind === "lib.publish");
  assert.equal(row?.status, "waiting_user");
  assert.equal(row?.title, "Waiting for you: publish founder?");
  assert.ok(waitingInstances(sc.s).has("librarian"), "the Librarian's face says needs you");
  assert.equal(sc.s.instances?.find((i) => i.id === "librarian")?.state, "live");
  assert.ok(needsYouCount(sc.s) >= 1);
  sc.act({ type: "answer", qid: "q_publish", optionId: "yes" });
  sc.run();
  assert.equal(sc.s.questions.filter((x) => x.id === "q_publish").length, 1, "asked once");
  assert.equal(sc.s.tasks.find((t) => t.kind === "lib.publish")?.title, "Published founder");
  assert.equal(sc.s.instances?.find((i) => i.id === "librarian")?.state, "finished");
});

test("scenario keyfail: a rejected key holds the run, Pip says so, the founder is stuck with 'Fix the key'; a key resumes it", () => {
  const sc = scenario("keyfail", false);
  picks(sc);
  sc.run((_s, sim) => !!sim.hold);
  const cancelled = sc.s.tasks.find((t) => t.planTask === "t_draw_founder");
  assert.equal(cancelled?.status, "cancelled", "the attempt's row ends cancelled, not failed");
  assert.deepEqual(sc.s.status, {
    phase: 0,
    line: "Waiting for you: Your Anthropic key was rejected",
    problem: {
      text: "Your Anthropic key was rejected.",
      action: "fix_key",
      taskId: cancelled?.id,
      provider: "anthropic",
    },
  });
  assert.equal(sc.s.crew?.held, "Your Anthropic key was rejected");
  const h = humanStatus(sc.s);
  assert.equal(h.text, "Your Anthropic key was rejected.");
  assert.equal(h.tone, "needs", "a hold waits on you: no red Stopped");
  // Pip's channel line is a sentence to the crew, not "I briefed the producer: Hold: …"
  const hold = sc.chans.findLast((m) => m.from === "pip" && m.to === "crew");
  assert.equal(hold?.text, "Paused the crew: your Anthropic key was rejected.");
  assert.equal(
    channelSummary([{ ...hold!, at: new Date().toISOString() }]),
    "Paused the crew: your Anthropic key was rejected.",
  );
  assert.equal(h.problem?.action, "fix_key");
  assert.equal(PROBLEM_BUTTON[h.problem?.action ?? "retry"], "Fix the key");
  assert.deepEqual([...stuckInstances(sc.s)], ["pixel-artist:founder"], "the founder's face is stuck");
  assert.ok(crewGroups(sc.s).working.some((i) => i.id === "pixel-artist:founder"));
  // nothing new starts while held; the tasks already running finish
  const before = new Set(sc.s.tasks.map((t) => t.id));
  for (let i = 0; i < 15; i++) sc.step();
  assert.ok(sc.s.tasks.filter((t) => !before.has(t.id)).length === 0, "no new task starts while the run is held");
  // the fix lifts the hold: the drawing runs again as a second attempt, and the run finishes
  sc.act({ type: "key", provider: "openai" });
  assert.ok(sc.sim.hold, "another provider's key doesn't lift it");
  sc.act({ type: "key", provider: "anthropic" });
  assert.equal(sc.s.status, undefined);
  assert.equal(sc.s.crew?.held, null);
  assert.deepEqual([...stuckInstances(sc.s)], []);
  sc.run((s) => s.tasks.some((t) => t.planTask === "t_draw_founder" && t.status === "working"));
  assert.equal(sc.s.tasks.find((t) => t.planTask === "t_draw_founder" && t.status === "working")?.attempt, 2);
  // with auto, the run goes to the hold and stays there until the key is fixed, then reaches the end
  const a = scenario("keyfail");
  a.run((_s, sim) => !!sim.hold);
  for (let i = 0; i < 10; i++) a.step();
  assert.ok(a.sim.hold, "auto never fixes the key");
  a.act({ type: "key", provider: "anthropic" });
  a.run();
  assert.equal(a.s.gates.find((g) => g.id === "g4_final")?.status, "passed");
});

test("scenarios read from the flags; the default journey has none", () => {
  assert.equal(journeyFlags("?journey=todo&scenario=overrun").scenario, "overrun");
  assert.equal(journeyFlags("?journey=todo&scenario=nope").scenario, null);
  assert.equal(journeyFlags("?journey=todo").scenario, null);
});

test("the scripted fixtures' crew row: done members finish, a waiting one is live, the next three are ghosts", () => {
  const t = (id: string, role: Role, status: Task["status"], extra: Partial<Task> = {}): Task => ({
    id,
    kind: "x",
    role,
    title: `${role} work`,
    status,
    model: "m",
    usd: 0.1,
    estUsd: 0.1,
    instance: role,
    ...extra,
  });
  const s: ProjectState = {
    ...blank(),
    crew: { state: "running" },
    tasks: [
      t("t_producer", "producer", "done", { startedAt: "2026-11-07T21:00:00Z", endedAt: "2026-11-07T21:01:00Z" }),
      t("t_writer", "writer", "waiting_user", { startedAt: "2026-11-07T21:01:00Z" }),
    ],
  };
  const all = fixtureInstances(s);
  const by = Object.fromEntries(all.map((i) => [i.id, i]));
  assert.equal(by.producer.state, "finished");
  assert.equal(by.producer.outcome, "done");
  assert.equal(by.writer.state, "live");
  assert.ok(waitingInstances({ ...s, instances: all }).has("writer"), "the writer's face needs you");
  assert.deepEqual(
    all.filter((i) => i.ghost).map((i) => i.id),
    ["director", "librarian", "art-director"],
  );
  assert.ok(all.every((i) => i.state !== "live" || !i.ghost));
  // an idle project lists only the members it has rows for, with no ghosts
  const idle = fixtureInstances({ ...s, crew: { state: "idle" } });
  assert.deepEqual(
    idle.map((i) => i.id),
    ["producer", "writer"],
  );
  // the crew stops: the ghosts it showed go, nothing stays a ghost
  let st: ProjectState = { ...s, instances: all, crew: { state: "idle" } };
  for (const data of fixtureChanges(st)) st = applyEvent(st, { event: "instance", data });
  assert.deepEqual(
    (st.instances ?? []).filter((i) => i.ghost).map((i) => i.id),
    [],
  );
  assert.deepEqual(fixtureChanges(st), [], "and then nothing more to send");
  assert.equal(instanceChange(undefined, by.writer), "spawn");
  assert.equal(instanceChange(by.writer, { ...by.writer, state: "finished" }), "end");
});

test("scenario edits: Pip makes the step 10 change itself, free, with an Undo; daytime is a free card", () => {
  const sc = scenario("edits", true);
  // auto drives the run to the rough cut and leaves it open there (the scenario's stop)
  sc.run((_s, sim) => sim.waits.has("gate:g3_rough"));
  sc.act({ type: "ask", text: JOURNEY.change });
  sc.run((_s, sim) => sim.cards.has("c_undo"), 10);
  const sim = sc.sim;
  assert.equal(sim.edited, true, "scene 2's hero is 2× at once");
  assert.ok(!sim.cards.has("c_ch"), "no crew card");
  assert.ok(!sim.nodes.some((n) => n.id === "t_tune_s02_r2"), "no Animator redo");
  assert.deepEqual(sim.cards.get("c_undo")?.type === "plan" && sim.cards.get("c_undo")?.usd, [0, 0]);
  sc.act({ type: "card", cardId: "c_undo", decision: "confirm" });
  assert.equal(sim.edited, false);
  sc.act({ type: "ask", text: DAYTIME });
  sc.run((_s, j) => j.cards.has("c_free"), 10);
  const free = sim.cards.get("c_free");
  assert.ok(free?.type === "plan" && free.title === "I can do this now: free");
  sc.act({ type: "card", cardId: "c_free", decision: "confirm" });
  assert.equal(sim.time, "day");
});
