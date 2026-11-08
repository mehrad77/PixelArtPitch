// Folds one server event into ProjectState. The mock runs its master copy through the same function.
import type { ProjectState, ServerEvent } from "./types.ts";

const upsert = <T extends { id: string }>(list: T[], item: T): T[] => {
  const i = list.findIndex((x) => x.id === item.id);
  if (i < 0) return [...list, item];
  const next = list.slice();
  next[i] = item;
  return next;
};

/** how many live activity lines to keep per task */
export const ACTIVITY_KEEP = 500;

const drop = <T>(m: Record<string, T>, k: string): Record<string, T> => {
  const { [k]: _gone, ...rest } = m;
  return rest;
};

/** returns the next state, or the same object when the event needs a refetch (patch) or changes nothing here */
export function applyEvent(s: ProjectState, e: ServerEvent): ProjectState {
  switch (e.event) {
    case "task": {
      const next = { ...s, tasks: upsert(s.tasks, e.data) };
      // a task that stopped working has no live call any more
      return e.data.status !== "working" && s.progress?.[e.data.id]
        ? { ...next, progress: drop(s.progress, e.data.id) }
        : next;
    }
    case "question":
      return { ...s, questions: upsert(s.questions, e.data) };
    case "note":
      return { ...s, notes: upsert(s.notes, e.data) };
    case "gate":
      return {
        ...s,
        gates: s.gates.some((g) => g.id === e.data.id)
          ? s.gates.map((g) => (g.id === e.data.id ? e.data : g))
          : [...s.gates, e.data],
      };
    case "ledger":
      return { ...s, budget: { ...s.budget, spentUsd: e.data.spentUsd, reservedUsd: e.data.reservedUsd } };
    case "digest":
      return { ...s, digest: e.data.text };
    case "stage":
      return { ...s, stage: e.data.stage };
    case "render":
      if (e.data.kind === "final" || e.data.kind === "proxy") {
        const name = e.data.url.split("/").pop() ?? e.data.kind;
        // a logged "files/x.mp4" (before v0.3.1) would resolve against /p/<id>: the listed file already has the real URL
        const usable = /^(blob|data|https?):|^\//.test(e.data.url);
        if (e.data.kind === "final" && usable && !s.files.some((f) => f.url === e.data.url || f.name === name))
          return { ...s, files: [...s.files, { name, url: e.data.url, bytes: 0, kind: "video" }] };
      }
      return s;
    case "status":
      return { ...s, status: e.data };
    case "milestone":
      return { ...s, milestones: upsert(s.milestones ?? [], e.data) };
    case "activity": {
      const { task, ...entry } = e.data;
      const list = [...(s.activity?.[task] ?? []), entry].slice(-ACTIVITY_KEEP);
      const next = { ...s, activity: { ...s.activity, [task]: list } };
      // the answer (or the error) ends the live call; the next call's progress starts it again
      return (entry.kind === "answer" || entry.kind === "error") && s.progress?.[task]
        ? { ...next, progress: drop(s.progress, task) }
        : next;
    }
    case "progress": {
      if (e.data.what !== "task") return s;
      const { what: _w, ...p } = e.data;
      return { ...s, progress: { ...s.progress, [p.taskId]: p } };
    }
    case "x-state":
      return { ...s, ...e.data };
    case "plan":
      return { ...s, plan: e.data.view };
    case "instance":
      return { ...s, instances: upsert(s.instances ?? [], e.data.instance) };
    default:
      return s;
  }
}
