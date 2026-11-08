// Pip's thread as turns (the simple view, newest first): the person's message with Pip's reply under it is one turn; a
// message Pip starts on its own is a turn of its own; a milestone is a quiet marker between turns. Pure, no React.
import type { PipItem } from "./types.ts";

export type Marker = { id: string; at: string; text: string };
export type Turn = {
  key: string;
  at: number;
  items: PipItem[];
  marker?: Marker;
  /** folded under the summary divider */
  old: boolean;
  thinking?: boolean;
  /** who opened the turn: the person (a message and its reply) or Pip (a message of its own) */
  by: "person" | "pip" | "marker";
};

/** the turns, oldest first; `upTo` is the newest item the summary folded, `thinking` adds Pip's dots */
export function turnsOf(items: PipItem[], marks: Marker[], upTo: string | null, thinking: boolean): Turn[] {
  const out: Turn[] = [];
  let folded = upTo != null;
  for (const it of items) {
    const last = out.at(-1);
    const joins = it.kind === "pip" && last && !last.marker && last.items.length === 1 && last.items[0].kind === "user";
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
  // a milestone older than the last folded message belongs with the folded part
  const cutAt = upTo ? Date.parse(items.find((i) => i.id === upTo)?.at ?? "") || 0 : 0;
  for (const m of marks)
    out.push({
      key: m.id,
      at: Date.parse(m.at),
      items: [],
      marker: m,
      old: !!upTo && Date.parse(m.at) <= cutAt,
      by: "marker",
    });
  out.sort((a, b) => a.at - b.at);
  if (thinking) {
    const newest = [...out].reverse().find((t) => !t.marker);
    if (newest && newest.items.length === 1 && newest.items[0].kind === "user") newest.thinking = true;
    else out.push({ key: "thinking", at: Date.now(), items: [], old: false, thinking: true, by: "pip" });
  }
  return out;
}
