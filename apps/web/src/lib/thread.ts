// Pip's thread as turns (the simple view, newest first): the person's message with Pip's reply under it is one turn,
// read top to bottom; a message Pip starts on its own is a turn of its own. The milestones are not turns: they are a
// track of their own, newest first, so a turn never reads as if it ran on into the timeline (the turns read down, the
// timeline reads up). Pure, no React.
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
