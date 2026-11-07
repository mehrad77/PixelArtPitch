// How far along a Pip card is, so a late reply never undoes what the card's own events already said. A card's
// optimistic status (shown at the press), its POST reply and its `card` events race: a fork, a rules-mode form or a
// Start can finish before the reply lands. Pure, so the node tests check it.
import type { PipCard } from "./types.ts";

/** 0 waiting on the person, 1 in flight, 2 settled; a card with no status (files, can't) is settled */
export function cardRank(c: PipCard | undefined): number {
  if (!c) return -1;
  const st = "status" in c ? String(c.status) : "";
  if (!st) return 2;
  if (st === "open" || st === "proposed") return 0;
  if (st === "running" || st === "submitted") return 1;
  return 2;
}

/** the card to show when `next` (a reply) arrives while `now` is shown: a reply never moves a card back */
export function laterCard(now: PipCard | undefined, next: PipCard): PipCard {
  return now && cardRank(now) > cardRank(next) ? now : next;
}

/** a failed press puts the card back only if nothing moved it on since the optimistic status went up */
export function revertCard(now: PipCard | undefined, optimistic: PipCard | null, before: PipCard): PipCard | null {
  if (!now) return null;
  if (optimistic ? now === optimistic : cardRank(now) <= cardRank(before)) return before;
  return null;
}

/** every card in a conversation, by id */
export function findCard(items: { kind: string; cards?: PipCard[] }[], id: string): PipCard | undefined {
  for (const i of items) for (const c of i.cards ?? []) if (c.id === id) return c;
  return undefined;
}
