// The Projects line (docs/PIP-ORCHESTRATION.md §3.4, D7): Pip's sentence over the Projects page, built from state
// with no model call. At most 3 clauses, ordered finished → working → failed → waiting, so it ends on what needs the
// person; the oldest clauses go first when there are more.
import { statSync } from "node:fs";
import { join } from "node:path";
import { isFinalVideo, type OpenProject, type Workspace } from "@pap/tools";

export type LinePart = { projectId: string; kind: "finished" | "working" | "waiting" | "failed"; text: string };
export type WorkspaceLine = { text: string; parts: LinePart[] };

/** a project in plain terms, for the line */
export type LineRow = {
  id: string;
  title: string;
  /** when its video was exported (ms), if it was */
  finishedAt?: number;
  /** the crew is running on it */
  running?: boolean;
  stage?: string;
  /** open questions and open gates */
  questions?: number;
  gates?: string[];
  /** Pip cards the crew waits on ("plan", "budget") and other waits for the person */
  cards?: CrewCardNeed[];
  waiting?: number;
  /** the status problem's text, when the last run failed or is held on a problem */
  problem?: string;
};

/** what the crew does at each stage, as "<title> is …" */
export const STAGE_BEING: Record<string, string> = {
  brief: "having its brief read",
  script: "being written",
  storyboard: "being storyboarded",
  art: "being drawn",
  animate: "being animated",
  narrate: "waiting for its narration",
  sound: "getting its sound",
  review: "being checked",
  deliver: "being exported",
};
const GATE_NEED: Record<string, string> = {
  g0_brief: "your OK on the brief",
  g1_script: "your pick of the script",
  g2_animatic: "your OK on the pacing",
  g3_rough: "your OK on the rough cut",
  g4_final: "your OK on the final cut",
};

/** a Pip card the crew posted and waits on: a plan change past the 20% line, or the budget */
export type CrewCardNeed = "plan" | "budget";
const CARD_NEED: Record<CrewCardNeed, string> = {
  plan: "your OK on a plan change",
  budget: "your answer on the budget",
};
/** what a project waits on: "one pick", "your OK on the rough cut", "3 things" (also `ProjectSummary.needs`) */
export function needsWords(questions: number, gates: string[], cards: CrewCardNeed[] = [], waiting = 0): string | null {
  const n = questions + gates.length + cards.length + waiting;
  if (!n) return null;
  if (n === 1)
    return questions
      ? "one pick"
      : gates.length
        ? (GATE_NEED[gates[0]] ?? "your OK")
        : cards.length
          ? CARD_NEED[cards[0]]
          : "your answer";
  return `${n} things`;
}
/** the count for "Needs you" (the Projects card and the project page) */
export const needsCount = (n: { questions: number; gates: string[]; cards: unknown[]; waiting: number }) =>
  n.questions + n.gates.length + n.cards.length + n.waiting;

/**
 * what waits on the person: open questions, and open gates that aren't just one of those questions. The G1 script
 * pick is a question and a gate that points at it (`items[].ref`): it counts once.
 */
export function openNeeds(
  p: Pick<OpenProject, "state">,
  o: {
    /** the crew cards Pip has open for this project (proposed, still holding work) */
    cards?: CrewCardNeed[];
    /** the plan's tasks: one waiting on the person counts when no open gate or question already stands for it */
    plan?: { kind: string; status: string; gate?: string }[] | null;
  } = {},
): { questions: number; gates: string[]; cards: CrewCardNeed[]; waiting: number } {
  const open = new Set(p.state.questions.filter((q) => q.status === "open").map((q) => q.id));
  const openGates = p.state.gates.filter((g) => g.status === "open");
  const gates = openGates
    .filter((g) => !(g.items ?? []).some((it: { ref?: string }) => it.ref && open.has(it.ref)))
    .map((g) => g.id);
  // a plan task waiting on the person is usually a gate (counted above) or a question (narration, publish): count
  // only the ones nothing else stands for
  const waits = (o.plan ?? []).filter((t) => t.status === "waiting_person");
  const gateWaits = waits.filter((t) => t.kind === "gate" && !openGates.some((g) => g.id === t.gate)).length;
  const otherWaits = Math.max(0, waits.filter((t) => t.kind !== "gate").length - open.size);
  return { questions: open.size, gates, cards: o.cards ?? [], waiting: gateWaits + otherWaits };
}

export function lineOf(rows: LineRow[], nowMs = Date.now()): WorkspaceLine {
  const parts: LinePart[] = [];
  const day = nowMs - 24 * 3600 * 1000;
  const needs = (r: LineRow) => needsWords(r.questions ?? 0, r.gates ?? [], r.cards ?? [], r.waiting ?? 0);
  for (const r of rows)
    if (r.finishedAt && r.finishedAt > day && !r.running && !needs(r))
      parts.push({ projectId: r.id, kind: "finished", text: `${r.title} is finished.` });
  for (const r of rows)
    if (r.running && !needs(r) && !r.problem)
      parts.push({
        projectId: r.id,
        kind: "working",
        text: `${r.title} is ${STAGE_BEING[r.stage ?? ""] ?? "being made"}.`,
      });
  for (const r of rows)
    if (r.problem)
      parts.push({ projectId: r.id, kind: "failed", text: `${r.title} stopped: ${r.problem.replace(/\.?$/, ".")}` });
  for (const r of rows) {
    const w = needs(r);
    if (w) parts.push({ projectId: r.id, kind: "waiting", text: `${r.title} is waiting on ${w} from you.` });
  }
  const kept = parts.slice(-3);
  return { text: kept.length ? kept.map((p) => p.text).join(" ") : "Nothing needs you right now.", parts: kept };
}

/** the line's rows from the workspace: each project's files, crew and open picks (never a model call) */
export function lineRows(
  ws: Workspace,
  running: (p: OpenProject) => boolean,
  extra: (p: OpenProject) => Parameters<typeof openNeeds>[1] = () => ({}),
): LineRow[] {
  const out: LineRow[] = [];
  for (const x of ws.list()) {
    let p: OpenProject;
    try {
      p = ws.get(x.id);
    } catch {
      continue;
    }
    const video = p.files().filter(isFinalVideo);
    let finishedAt: number | undefined;
    for (const f of video)
      try {
        finishedAt = Math.max(finishedAt ?? 0, statSync(join(p.dir, "out", f.name)).mtimeMs);
      } catch {}
    const run = running(p);
    const { questions, gates, cards, waiting } = openNeeds(p, extra(p));
    out.push({
      id: p.id,
      title: p.doc().title,
      ...(finishedAt ? { finishedAt } : {}),
      running: run,
      stage: p.state.stage,
      questions,
      gates,
      ...(cards.length ? { cards } : {}),
      ...(waiting ? { waiting } : {}),
      // a held run (a rejected key) is still a run, but it stopped for the person
      ...(p.state.status.problem && (!run || p.state.paused) ? { problem: p.state.status.problem.text } : {}),
    });
  }
  return out;
}
