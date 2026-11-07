// The journey "todo" (docs/PIP-JOURNEY.md §6) played in node through the reducer: the crew row at each checkpoint of
// the §2 table (read from the doc itself, so the two can't drift), the horizon cap, the event order, slots=1, the
// returns, the final counter, the spend, the person's picks and the strings. No DOM.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { applyEvent } from "../src/lib/reducer.ts";
import type { Instance, ProjectState, ServerEvent } from "../src/lib/types.ts";
import { JOURNEY, Journey } from "../src/mock/journey.ts";

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
