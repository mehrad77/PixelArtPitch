// Folds one server event into ProjectState. The mock runs its master copy through the same function.
import type { ProjectState, ServerEvent } from "./types.ts";

const upsert = <T extends { id: string }>(list: T[], item: T): T[] => {
  const i = list.findIndex((x) => x.id === item.id);
  if (i < 0) return [...list, item];
  const next = list.slice();
  next[i] = item;
  return next;
};

/** returns the next state, or the same object when the event needs a refetch (patch) or changes nothing here */
export function applyEvent(s: ProjectState, e: ServerEvent): ProjectState {
  switch (e.event) {
    case "task":
      return { ...s, tasks: upsert(s.tasks, e.data) };
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
        if (e.data.kind === "final" && !s.files.some((f) => f.url === e.data.url))
          return { ...s, files: [...s.files, { name, url: e.data.url, bytes: 0, kind: "video" }] };
      }
      return s;
    case "x-state":
      return { ...s, ...e.data };
    default:
      return s;
  }
}
