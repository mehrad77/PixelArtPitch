// The crew row for the mock's scripted fixtures (Lantern, Harbor lights, …), which predate the journey's executor: one
// instance per role, derived from the project's task rows, in the journey's shape (PIP-ORCHESTRATION §2), with the
// next members as ghosts while the crew runs. The client sends the differences as `instance` events, as the server does.
// Node-safe: types only, so the web tests can import it.
import type { Instance, InstanceChange, ProjectState, Role, Task } from "../lib/types.ts";

/** the scripted run's members, in plan order */
export const FIXTURE_ROSTER: Role[] = [
  "producer",
  "writer",
  "director",
  "librarian",
  "art-director",
  "pixel-artist",
  "sound-designer",
  "animator",
  "editor",
  "mixer",
  "reviewer",
];
const WORD: Partial<Record<Role, string>> = {
  producer: "Producer",
  writer: "Writer",
  director: "Director",
  librarian: "Librarian",
  "art-director": "Art director",
  "pixel-artist": "Pixel artist",
  "sound-designer": "Sound designer",
  animator: "Animator",
  "scene-coder": "Scene coder",
  editor: "Editor",
  mixer: "Mixer",
  reviewer: "Reviewer",
};
const LIVE = new Set<Task["status"]>(["working", "waiting_user"]);
const ENDED = new Set<Task["status"]>(["done", "partial", "failed", "cancelled"]);

/** every member of a scripted fixture, from its rows: live while a row works or waits on you, finished once all ended */
export function fixtureInstances(s: ProjectState, models: Partial<Record<Role, string>> = {}): Instance[] {
  const rows = s.tasks.filter((t) => !t.supersededBy);
  const roles = [...FIXTURE_ROSTER, ...rows.map((t) => t.role).filter((r) => !FIXTURE_ROSTER.includes(r))];
  const running = s.crew?.state === "running" || s.crew?.state === "pausing";
  const out: Instance[] = [];
  let ghosts = 0;
  for (const role of [...new Set(roles)]) {
    const mine = rows.filter((t) => t.role === role);
    const all = s.tasks.filter((t) => t.role === role);
    // a project that never planned this member (no row, crew not running) leaves it out
    if (!mine.length && !running) continue;
    const starts = all.map((t) => t.startedAt).filter((x): x is string => !!x);
    const ends = all.map((t) => t.endedAt).filter((x): x is string => !!x);
    const spawnedAt = starts.sort()[0] ?? null;
    const live = mine.some((t) => LIVE.has(t.status));
    const ended = mine.length > 0 && mine.every((t) => ENDED.has(t.status));
    const state: Instance["state"] = live ? "live" : ended ? "finished" : spawnedAt ? "idle" : "planned";
    const endedAt = state === "finished" ? (ends.sort().at(-1) ?? null) : null;
    const ghost = state !== "live" && state !== "finished" && running && ghosts < 3;
    if (ghost) ghosts++;
    const last = mine.at(-1);
    const failed = mine.some((t) => t.status === "failed");
    const word = WORD[role] ?? role;
    out.push({
      id: role,
      role,
      label: word,
      model: spawnedAt ? (models[role] ?? last?.model ?? null) : null,
      state,
      ghost,
      running: mine.filter((t) => t.status === "working").length,
      spawnedAt,
      endedAt,
      lives: spawnedAt ? [{ from: spawnedAt, to: state === "live" ? null : (ends.sort().at(-1) ?? null) }] : [],
      reason: `Pip brought in the ${word.toLowerCase()}`,
      tasks: all.map((t) => t.id),
      usd: +all.reduce((a, t) => a + (t.usd ?? 0), 0).toFixed(2),
      outcome: state !== "finished" ? null : failed ? "failed" : "done",
      ...(state === "finished" && last ? { lastReport: { status: "done" as const, did: last.title } } : {}),
      ...(state === "finished" && last ? { endReason: last.summary ?? last.title } : {}),
    });
  }
  return out;
}

/** what changed between two views of a member, as the server names it (journey.ts `changeOf`) */
export function instanceChange(prev: Instance | undefined, next: Instance): InstanceChange | null {
  const p = prev?.state ?? "planned";
  const moved = (prev?.ghost ?? false) !== next.ghost;
  if (p === next.state) {
    if (moved) return "ghost";
    // the same state with new numbers (spend, tasks): sent again as that state, never as a move
    if (JSON.stringify(prev) === JSON.stringify(next)) return null;
    return next.state === "live" ? "live" : next.state === "idle" ? "idle" : null;
  }
  if (next.state === "finished") return "end";
  if (p === "finished") return "revive";
  if (p === "planned" && next.state === "live") return "spawn";
  if (next.state === "live") return "live";
  if (next.state === "idle") return "idle";
  return moved ? "ghost" : null;
}

/** the `instance` events that bring a state's crew row up to date with its rows (a member the row no longer lists,
 * because the crew stopped, stops being a ghost) */
export function fixtureChanges(
  s: ProjectState,
  models: Partial<Record<Role, string>> = {},
): { instance: Instance; change: InstanceChange }[] {
  const prev = new Map((s.instances ?? []).map((i) => [i.id, i]));
  const all = fixtureInstances(s, models);
  const out: { instance: Instance; change: InstanceChange }[] = [];
  for (const next of all) {
    const change = instanceChange(prev.get(next.id), next);
    if (change) out.push({ instance: next, change });
  }
  for (const old of prev.values())
    if (old.ghost && !all.some((i) => i.id === old.id))
      out.push({ instance: { ...old, ghost: false }, change: "ghost" });
  return out;
}
