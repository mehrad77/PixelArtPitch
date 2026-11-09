// Pip's thread as turns (the simple view, newest first): the person's message with Pip's reply under it is one turn,
// read top to bottom; a message Pip starts on its own is a turn of its own. The milestones are not turns, but they sit
// on the same timeline: one list, newest first, a dot per entry, a turn as its framed block and a milestone as one
// quiet line; long runs of milestones fold into "N more milestones". Pure, no React.
import { cutWords, dedupeMarkers } from "./text.ts";
import type { PipItem } from "./types.ts";

export type Marker = { id: string; at: string; text: string };
export type Turn = {
  key: string;
  at: number;
  items: PipItem[];
  /** folded under the summary divider */
  old: boolean;
  thinking?: boolean;
  /** who opened the turn: the person (a message and its reply) or Pip (a message of its own) */
  by: "person" | "pip";
};

/** the turns, oldest first; `upTo` is the newest item the summary folded, `thinking` adds Pip's dots */
export function turnsOf(items: PipItem[], upTo: string | null, thinking: boolean): Turn[] {
  const out: Turn[] = [];
  let folded = upTo != null;
  for (const it of items) {
    const last = out.at(-1);
    const joins = it.kind === "pip" && last && last.items.length === 1 && last.items[0].kind === "user";
    if (joins) last.items.push(it);
    else
      out.push({
        key: it.id,
        at: Date.parse(it.at) || 0,
        items: [it],
        old: folded,
        by: it.kind === "user" ? "person" : "pip",
      });
    if (it.id === upTo) folded = false;
  }
  out.sort((a, b) => a.at - b.at);
  if (thinking) {
    const newest = out.at(-1);
    if (newest && newest.items.length === 1 && newest.items[0].kind === "user") newest.thinking = true;
    else out.push({ key: "thinking", at: Date.now(), items: [], old: false, thinking: true, by: "pip" });
  }
  return out;
}

/** the milestone track: newest first, each said once while it repeats, each line cut on a word */
export function trackOf(marks: Marker[], max = 90): Marker[] {
  return dedupeMarkers(marks)
    .reverse()
    .map((m) => ({ ...m, text: cutWords(m.text, max) }));
}

/** one entry on the simple view's timeline: a turn, a milestone, or a folded run of milestones */
export type Entry =
  | { kind: "turn"; key: string; at: number; turn: Turn }
  | { kind: "mark"; key: string; at: number; mark: Marker }
  | { kind: "more"; key: string; at: number; marks: Marker[] };

/** turns and milestones on one timeline, newest first. A turn and a milestone at the same moment: the turn first;
 * otherwise ties keep the order given. A turn with no time (`at` 0) sinks to the end. */
export function timelineOf(turns: Turn[], marks: Marker[]): Entry[] {
  const all: Entry[] = [
    ...[...turns].reverse().map((t): Entry => ({ kind: "turn", key: t.key, at: t.at, turn: t })),
    ...marks.map((m): Entry => ({ kind: "mark", key: m.id, at: Date.parse(m.at) || 0, mark: m })),
  ];
  // stable: equal times keep the order above (turns before milestones, each newest first as given)
  return all.sort((a, b) => b.at - a.at);
}

/** fold long runs of milestones: the `keep` newest milestones always show, and each run of milestones between two
 * turns shows its first `lead`; the rest of a run fold into one "more" entry, only when two or more would fold */
export function foldRuns(entries: Entry[], { keep = 3, lead = 1 }: { keep?: number; lead?: number } = {}): Entry[] {
  const out: Entry[] = [];
  let seen = 0;
  let run: Extract<Entry, { kind: "mark" }>[] = [];
  const flush = () => {
    const shown: Entry[] = [];
    const hidden: Marker[] = [];
    run.forEach((e, i) => {
      if (i < lead || seen < keep) shown.push(e);
      else hidden.push(e.mark);
      seen++;
    });
    out.push(...shown);
    if (hidden.length >= 2)
      out.push({ kind: "more", key: `more-${hidden[0].id}`, at: Date.parse(hidden[0].at) || 0, marks: hidden });
    else out.push(...hidden.map((m): Entry => ({ kind: "mark", key: m.id, at: Date.parse(m.at) || 0, mark: m })));
    run = [];
  };
  for (const e of entries) {
    if (e.kind === "mark") run.push(e);
    else {
      flush();
      out.push(e);
    }
  }
  flush();
  return out;
}
