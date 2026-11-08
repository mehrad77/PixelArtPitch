// A plan-change card in words (PipCard `plan` with `revision`): the price as a diff (the old total struck, the new one
// large, the delta as a chip) and the crew named by instance, the planner first, so the Director shows when it
// re-plans (Pip's department faces fold the Director into the Writer). Pure, no React.
import { ROLE_LABEL } from "./derive.ts";
import { memberOf, usdPlain } from "./human.ts";
import type { PipCard, Role, RoleT } from "./types.ts";

type Plan = Extract<PipCard, { type: "plan" }>;

const money = (v: number) => usdPlain(Math.round(v * 100) / 100);

/** "$1.04" → "about $1.95", "+$0.91"; null for a card that is no revision */
export function planDiff(card: Plan): { from: string; to: string; delta: string; up: boolean } | null {
  const r = card.revision;
  if (!r) return null;
  const d = Math.round((r.toUsd - r.fromUsd) * 100) / 100;
  return {
    from: money(r.fromUsd),
    to: money(r.toUsd),
    delta: `${d >= 0 ? "+" : "−"}${money(Math.abs(d))}`,
    up: d >= 0,
  };
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
