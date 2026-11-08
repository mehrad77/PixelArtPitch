// A Pip reply that couldn't be answered because of something only the person can fix (a rejected key, no credit):
// the reply carries the fix as a card (`type: "fix"`), on the item (`problem`), or as an `action` on a card, and the
// thread shows it as its one button ("Fix the key"). Tolerant of each shape, so an older or newer server still gets
// the button. Pure, no React.
import type { PipCard, PipItem, ProblemAction } from "./types.ts";

export type PipFix = { action: ProblemAction; provider?: string; text?: string };

const ACTIONS: readonly ProblemAction[] = ["retry", "change_model", "add_budget", "fix_key"];
const isAction = (a: unknown): a is ProblemAction => typeof a === "string" && ACTIONS.includes(a as ProblemAction);

/** the fix a card stands for, or null: a `fix` card, or any card with an `action` the person runs */
export function fixOfCard(c: PipCard): PipFix | null {
  const raw = c as PipCard & { action?: unknown; fix?: unknown; provider?: unknown; text?: unknown };
  const named = raw.action ?? raw.fix;
  let a = typeof named === "object" && named ? (named as { kind?: unknown }).kind : named;
  // the server's publicCard strips `action` from every card: a `fix` card that lost it is the key's
  if (!isAction(a) && c.type === "fix") a = "fix_key";
  if (!isAction(a)) return null;
  return {
    action: a,
    ...(typeof raw.provider === "string" ? { provider: raw.provider } : {}),
    ...(typeof raw.text === "string" ? { text: raw.text } : {}),
  };
}

/** the fix a Pip reply carries on the item itself (not as a card), or null */
export function fixOfItem(it: PipItem): PipFix | null {
  if (it.kind !== "pip") return null;
  const raw = it as typeof it & { action?: unknown; provider?: unknown };
  const p = it.problem;
  if (p && isAction(p.action)) return { action: p.action, ...(p.provider ? { provider: p.provider } : {}) };
  if (isAction(raw.action))
    return { action: raw.action, ...(typeof raw.provider === "string" ? { provider: raw.provider } : {}) };
  return null;
}
