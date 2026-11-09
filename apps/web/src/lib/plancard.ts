// A plan-change card in words (PipCard `plan` with `revision`): the price as a diff (the old total struck, the new one
// large, the delta as a chip) and the crew named by instance, the planner first, so the Director shows when it
// re-plans (Pip's department faces fold the Director into the Writer). Pure, no React.
import { ROLE_LABEL } from "./derive.ts";
import { memberOf, usdPlain } from "./human.ts";
import type { PipCard, Role, RoleT } from "./types.ts";

type Plan = Extract<PipCard, { type: "plan" }>;

const money = (v: number) => usdPlain(Math.round(v * 100) / 100);

/** "$1.04" → "about $1.95", "+$0.91" (no delta when the price stays); null for a card that is no revision */
export function planDiff(card: Plan): { from: string; to: string; delta: string; up: boolean } | null {
  const r = card.revision;
  if (!r) return null;
  const d = Math.round((r.toUsd - r.fromUsd) * 100) / 100;
  return {
    from: money(r.fromUsd),
    to: money(r.toUsd),
    delta: d === 0 ? "" : `${d > 0 ? "+" : "−"}${money(Math.abs(d))}`,
    up: d >= 0,
  };
}

/**
 * The price on the card's meta line ("$0.40", "$0.20–$0.60"), or null: a revision says it as a diff, and a card that
 * costs nothing (the budget pair's "Finish within" and "Raise the cap") shows no "$0"
 */
export function planUsd(card: Plan): string | null {
  if (!card.usd || card.revision || card.usd[1] <= 0) return null;
  const [lo, hi] = card.usd;
  return lo === hi ? money(lo) : `${money(lo)}–${money(hi)}`;
}

/** the title without its price ("Plan change: $1.04 → about $1.95" → "Plan change"), when the diff says the price */
export const titleWords = (card: Plan) => (card.revision ? card.title.replace(/:\s*\$.*$/, "") : card.title);

/** the role an instance label starts with ("Animator · scene 2" → animator) */
function roleOfLabel(label: string): Role | null {
  const head = label.split(" · ")[0].toLowerCase();
  const hit = (Object.entries(ROLE_LABEL) as [Role, string][]).find(([, w]) => w.toLowerCase() === head);
  return hit?.[0] ?? null;
}

/**
 * Who the card names: the planner ("Director", "Pip"), then the members it brings in by instance label, each once
 * ("Animator · scene 2", "Reviewer"); without instances, the card's roles by their own words (not the departments).
 * `roles` are for the faces, one per role.
 */
export function planCrew(card: Plan): { planner: string | null; names: string[]; roles: Role[] } {
  const p = card.revision?.planner;
  const planner = p === "pip" ? "Pip" : p ? ROLE_LABEL[p] : null;
  const names: string[] = [];
  const roles: Role[] = [];
  const addRole = (r: Role | null) => {
    if (r && !roles.includes(r)) roles.push(r);
  };
  if (p && p !== "pip") addRole(p);
  if (card.whoInstances?.length)
    for (const w of card.whoInstances) {
      if (!names.includes(w.label)) names.push(w.label);
      addRole(roleOfLabel(w.label));
    }
  else
    for (const r of card.who as RoleT[]) {
      const word = ROLE_LABEL[r as Role] ?? memberOf(r as Role).label;
      if (!names.includes(word)) names.push(word);
      addRole(r as Role);
    }
  return { planner, names: names.filter((n) => n !== planner), roles };
}

const GREW = "The plan grew past what you approved: ";
const listed = (xs: string[]) => (xs.length < 2 ? (xs[0] ?? "") : `${xs.slice(0, -1).join(", ")} and ${xs.at(-1)}`);
const same = (a: string, b: string) => a.trim() === b.trim();

/** a reason the server cut short (no closing mark): whole sentences first, the rest behind "more", never a cut word.
 * `more` is null when nothing is held back; a cut line ends in "…" */
export function wholeReason(text: string): { lead: string; more: string | null } {
  const t = text.trim();
  if (!t || /[.!?…)"'”’]$/.test(t)) return { lead: t, more: null };
  // the last word may be cut mid-way: drop it, and any comma or dash it leaves
  const whole = t.replace(/\s*\S+$/, "").replace(/[\s,;:–—-]+$/, "");
  if (!whole) return { lead: t, more: null };
  const end = Math.max(...[". ", "! ", "? "].map((m) => whole.lastIndexOf(m)));
  if (end < 0) return { lead: `${whole}…`, more: null };
  return { lead: whole.slice(0, end + 1), more: `${whole.slice(end + 2)}…` };
}

/** a plan change says its reason once: Pip's line only frames it, the card's body carries it, and its "Adds" lines
 * name who comes in ("Adds Director and Animator · scene 1"), never the reason again */
export function revisionOnce(text: string, card: Plan): { text: string; effects: string[] } {
  if (!card.revision || !card.detail) return { text, effects: card.effects };
  const reason = card.detail;
  const said =
    text.startsWith(GREW) && same(text.slice(GREW.length), reason) ? "The plan grew past what you approved." : text;
  const groups = new Map<string, string[]>();
  const rest: string[] = [];
  for (const e of card.effects) {
    const m = /^(Adds|Drops|Changes) (.+?): ([\s\S]+)$/.exec(e);
    if (m && same(m[3], reason)) {
      const names = groups.get(m[1]) ?? [];
      groups.set(m[1], [...names, m[2]]);
    } else rest.push(e);
  }
  return { text: said, effects: [...[...groups].map(([verb, names]) => `${verb} ${listed(names)}`), ...rest] };
}
