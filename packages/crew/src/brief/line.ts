// The Projects line (docs/PIP-ORCHESTRATION.md §3.4, D7): Pip's sentence over the Projects page, built from state
// with no model call. At most 3 clauses, ordered finished → working → failed → waiting, so it ends on what needs the
// person; the oldest clauses go first when there are more.
import { statSync } from "node:fs";
import { join } from "node:path";
import type { OpenProject, Workspace } from "@pap/tools";

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
  /** the status problem's text, when the last run failed */
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

/** what a project waits on: "one pick", "your OK on the rough cut", "3 things" (also `ProjectSummary.needs`) */
export function needsWords(questions: number, gates: string[]): string | null {
  const n = questions + gates.length;
  if (!n) return null;
  if (n === 1) return questions ? "one pick" : (GATE_NEED[gates[0]] ?? "your OK");
  return `${n} things`;
}

export function lineOf(rows: LineRow[], nowMs = Date.now()): WorkspaceLine {
  const parts: LinePart[] = [];
  const day = nowMs - 24 * 3600 * 1000;
  const needs = (r: LineRow) => needsWords(r.questions ?? 0, r.gates ?? []);
  for (const r of rows)
    if (r.finishedAt && r.finishedAt > day && !r.running && !needs(r))
      parts.push({ projectId: r.id, kind: "finished", text: `${r.title} is finished.` });
  for (const r of rows)
    if (r.running && !needs(r))
      parts.push({
        projectId: r.id,
        kind: "working",
        text: `${r.title} is ${STAGE_BEING[r.stage ?? ""] ?? "being made"}.`,
      });
  for (const r of rows)
    if (r.problem && !r.running)
      parts.push({ projectId: r.id, kind: "failed", text: `${r.title} stopped: ${r.problem.replace(/\.?$/, ".")}` });
  for (const r of rows) {
    const w = needs(r);
    if (w) parts.push({ projectId: r.id, kind: "waiting", text: `${r.title} is waiting on ${w} from you.` });
  }
  const kept = parts.slice(-3);
  return { text: kept.length ? kept.map((p) => p.text).join(" ") : "Nothing needs you right now.", parts: kept };
}

/** the line's rows from the workspace: each project's files, crew and open picks (never a model call) */
export function lineRows(ws: Workspace, running: (p: OpenProject) => boolean): LineRow[] {
  const out: LineRow[] = [];
  for (const x of ws.list()) {
    let p: OpenProject;
    try {
      p = ws.get(x.id);
    } catch {
      continue;
    }
    const video = p.files().filter((f) => f.kind === "video");
    let finishedAt: number | undefined;
    for (const f of video)
      try {
        finishedAt = Math.max(finishedAt ?? 0, statSync(join(p.dir, "out", f.name)).mtimeMs);
      } catch {}
    const run = running(p);
    out.push({
      id: p.id,
      title: p.doc().title,
      ...(finishedAt ? { finishedAt } : {}),
      running: run,
      stage: p.state.stage,
      questions: p.state.questions.filter((q) => q.status === "open").length,
      gates: p.state.gates.filter((g) => g.status === "open").map((g) => g.id),
      ...(p.state.status.problem && !run ? { problem: p.state.status.problem.text } : {}),
    });
  }
  return out;
}
