// What a crew member (or Pip) just did, as a few plain words for a thought bubble over its face. Only changes seen
// live count: the caller snapshots the tasks when it mounts and diffs every later state against the last one.
import { memberOf, plainTitle } from "./human.ts";
import type { PipItem, ProjectState, Task } from "./types.ts";

/** what a finished step did, in the past tense */
const DONE: Record<string, string> = {
  "producer.plan": "Planned your video",
  "writer.angles": "Wrote your script",
  "writer.repair": "Fixed the script",
  "director.storyboard": "Sketched the scenes",
  "director.repair": "Fixed the storyboard",
  "vo.align": "Lined up your narration",
  "sound.mix": "Added music and sound",
  "review.final": "Checked for mistakes",
  "deliver.export": "Exported your video",
  "lib.match": "Found art in the library",
  "lib.publish": "Saved the art for next time",
};
const low = (t: string) => t.charAt(0).toLowerCase() + t.slice(1);

function past(t: Task, s: ProjectState): string {
  if (DONE[t.kind]) return DONE[t.kind];
  const now = plainTitle(t, s);
  const m = now.match(/^Animating (.+)$/);
  if (m) return `Animated ${m[1]}`;
  const d = now.match(/^Drawing (.+)$/);
  if (d) return `Drew ${d[1]}`;
  return `Done: ${low(now)}`;
}

export type Change = { member: string; text: string };

/** the changes between two snapshots of the tasks, one per member at most (the newest wins) */
export function taskChanges(
  prev: Map<string, Task>,
  s: ProjectState,
  /** whose face it floats over: the department by default, the instance in the instance row */
  keyOf: (t: Task) => string = (t) => memberOf(t.role).id,
): Change[] {
  const out = new Map<string, string>();
  for (const t of s.tasks) {
    const was = prev.get(t.id);
    if (was && was.status === t.status) continue;
    if (!was && (t.status === "upcoming" || t.status === "queued")) continue;
    const member = keyOf(t);
    const title = plainTitle(t, s);
    let text = "";
    if (t.status === "working")
      text =
        (t.attempt ?? 1) > 1
          ? `Trying again: ${low(title)}`
          : was?.status === "waiting_user"
            ? "Got your answer, carrying on"
            : title;
    else if (t.status === "done") text = past(t, s);
    else if (t.status === "waiting_user") text = "Has a question for you";
    else if (t.status === "failed")
      text = t.supersededBy ? `Stuck on ${low(title)}, retrying` : `Stuck on ${low(title)}`;
    else if (t.status === "cancelled") text = `Stopped ${low(title)}`;
    if (text) out.set(member, text);
  }
  return [...out].map(([member, text]) => ({ member, text }));
}

export const snapshot = (tasks: Task[]) => new Map(tasks.map((t) => [t.id, t]));

/** Pip's own thought for the newest thing in its conversation */
export function pipThought(thinking: boolean, last: PipItem | undefined): string {
  if (thinking) return "Thinking…";
  if (last?.kind !== "pip") return "";
  const c = last.cards[0];
  if (!c) return last.text || "Answered you";
  if (c.type === "files") return "Here are your files";
  if (c.type === "cant") return "Can't do that one yet";
  if (c.type === "form")
    return c.status === "done" ? "Connected" : c.status === "failed" ? "That didn't connect" : "Here's the form";
  if (c.status === "done") return c.who.length ? "Handed it to the crew" : `Done: ${low(c.title)}`;
  if (c.status === "running") return "Working on it";
  if (c.status === "failed") return "That didn't work";
  if (c.status === "declined") return "Okay, not now";
  return "Here's a plan";
}
