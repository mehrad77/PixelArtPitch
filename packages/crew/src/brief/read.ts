// Reading the idea (docs/PIP-ORCHESTRATION.md §3.3, D6): one `assistant.brief` call in agent mode, checked against the
// field registry, or the rules parse (menu mode, a local model, or a failed read). Code keeps a value only when Pip
// quotes it from the person's own words; whatever is still open goes into one card of 3 fields or fewer.
import { z } from "zod";
import type { Gateway } from "../gateway.ts";
import { fill, card as promptCard } from "../prompts.ts";
import {
  ASK_ORDER,
  type AskKey,
  askFor,
  BRIEF_KEYS,
  type BriefFieldAsk,
  type BriefFieldKey,
  checkValue,
  isAskable,
  MAX_FIELDS,
  rulesRead,
} from "./registry.ts";

export const BriefReadOut = z.object({
  fields: z
    .array(z.object({ key: z.enum(BRIEF_KEYS), value: z.unknown(), quote: z.string().max(120) }))
    .max(10)
    .default([]),
  ask: z
    .array(
      z.object({
        key: z.enum(BRIEF_KEYS),
        question: z.string().max(80).optional(),
        options: z.array(z.string()).max(4).optional(),
        recommended: z.string().optional(),
      }),
    )
    .max(3)
    .default([]),
  title: z.string().max(120).default(""),
  say: z.string().max(240).default(""),
});
export type BriefReadOutT = z.infer<typeof BriefReadOut>;

/** what one reading leaves: the values to keep, Pip's wording for the open fields, a title and Pip's words */
export type Reading = {
  fields: Partial<Record<BriefFieldKey, unknown>>;
  /** Pip's question and option order per askable key (labels only; ids and defaults stay the registry's) */
  wording: Partial<Record<AskKey, { question?: string; options?: string[]; recommended?: string }>>;
  title?: string;
  say?: string;
  how: "pip" | "rules";
  /** why the rules parse stood in ("menu mode", "local model", "the read failed: …") */
  why?: string;
  /** values Pip gave that code dropped, and why (for /why and the tests) */
  dropped: { key: string; reason: string }[];
  usd: number;
  model?: string;
  promptVersion?: string;
};

const fold = (s: string) => s.toLowerCase().replace(/\s+/g, " ").trim();

/**
 * Code's check of Pip's reading (§3.3 step 2): each value parses with its field's type, each quote appears in the
 * person's text (case-folded), and only the askable fields keep Pip's wording. Never throws.
 */
export function checkReading(out: BriefReadOutT, personText: string): Omit<Reading, "how" | "usd"> {
  const said = fold(personText);
  const fields: Reading["fields"] = {};
  const dropped: Reading["dropped"] = [];
  for (const f of out.fields) {
    // the idea and the title are the person's words and code's title rule, not Pip's to fill
    if (f.key === "idea" || f.key === "title" || f.key === "references") {
      dropped.push({ key: f.key, reason: "code sets it" });
      continue;
    }
    const q = fold(f.quote ?? "");
    if (!q || !said.includes(q)) {
      dropped.push({ key: f.key, reason: `the quote "${f.quote}" isn't in the person's words` });
      continue;
    }
    const c = checkValue(f.key, f.value);
    if (!c.ok) {
      dropped.push({ key: f.key, reason: c.message });
      continue;
    }
    fields[f.key] = c.value;
  }
  const wording: Reading["wording"] = {};
  for (const a of out.ask) if (isAskable(a.key) && !(a.key in fields)) wording[a.key] = a;
  return {
    fields,
    wording,
    ...(out.title.trim() ? { title: out.title.trim() } : {}),
    ...(out.say.trim() ? { say: out.say.trim() } : {}),
    dropped,
  };
}

/** the open, askable fields in priority order, Pip's wording where it is valid, at most `room` */
export function openFields(
  fields: Partial<Record<BriefFieldKey, unknown>>,
  wording: Reading["wording"],
  room: number,
  recommendedBudget: number,
): BriefFieldAsk[] {
  const open = ASK_ORDER.filter((k) => fields[k] === undefined || fields[k] === null);
  // Pip's asks first (in its order), then the rest in the registry's priority order
  const pipFirst = [
    ...(Object.keys(wording) as AskKey[]).filter((k) => open.includes(k)),
    ...open.filter((k) => !(k in wording)),
  ];
  return pipFirst.slice(0, Math.max(0, Math.min(MAX_FIELDS, room))).map((k) => {
    const base = askFor(k, recommendedBudget);
    const w = wording[k];
    if (!w) return base;
    const ids = (w.options ?? []).filter((o) => base.options?.some((x) => x.id === o));
    const options = base.options
      ? ids.length >= 2
        ? ids.map((id) => base.options!.find((x) => x.id === id)!)
        : base.options
      : undefined;
    const rec =
      w.recommended && options?.some((o) => o.id === w.recommended)
        ? w.recommended
        : options && !options.some((o) => o.id === String(base.recommended))
          ? options[0].id
          : base.recommended;
    return {
      ...base,
      ...(w.question?.trim() ? { label: w.question.trim().slice(0, 80) } : {}),
      ...(options ? { options } : {}),
      ...(rec !== undefined ? { recommended: rec } : {}),
    };
  });
}

/**
 * Read the person's words. `mode` "agent" makes one `assistant.brief` call (metered on `budget`); anything else,
 * or a failed call, is the rules parse. `first`: this is the draft's first message (it sets the idea and title).
 */
export async function readBrief(o: {
  gateway: Gateway;
  text: string;
  /** every message the person sent in this draft, the newest last (the quotes are checked against these) */
  said: string[];
  known: Partial<Record<BriefFieldKey, unknown>>;
  refs: { name: string; type: string; rights: string }[];
  model: string;
  mode: "agent" | "menu" | "local";
  budget: { key: string; capUsd: number };
  task: string;
}): Promise<Reading> {
  const rules = (why: string): Reading => {
    const r = rulesRead(o.text);
    return {
      fields: Object.fromEntries(Object.entries(r).filter(([k]) => k !== "idea" && k !== "title")),
      wording: {},
      title: String(r.title ?? ""),
      how: "rules",
      why,
      dropped: [],
      usd: 0,
    };
  };
  if (o.mode !== "agent") return rules(o.mode === "local" ? "local model" : "menu mode");
  const c = promptCard("assistant", "brief");
  try {
    const res = await o.gateway.json({
      project: o.budget.key,
      capUsd: o.budget.capUsd,
      task: o.task,
      taskKind: "assistant.brief",
      role: "assistant",
      promptVersion: c.version,
      system: c.system,
      messages: [
        {
          role: "user",
          content: fill(c.user, {
            said: o.said.map((s, k) => `${k + 1}. ${s}`).join("\n"),
            known: Object.keys(o.known).length ? JSON.stringify(o.known) : "(nothing yet)",
            refs: o.refs.length ? o.refs.map((r) => `- ${r.name}: ${r.type}, rights ${r.rights}`).join("\n") : "(none)",
            keys: ASK_ORDER.map((k) => `${k}: ${keyHelp[k]}`).join("\n"),
          }),
        },
      ],
      schema: BriefReadOut,
      jsonSchema: z.toJSONSchema(BriefReadOut, { io: "input" }) as Record<string, unknown>,
      maxOut: c.maxOut,
      effort: c.effort,
      model: o.model,
      noFallback: true,
    });
    const checked = checkReading(res.data, o.said.join("\n"));
    return { ...checked, how: "pip", usd: res.result.usd, model: res.model, promptVersion: c.version };
  } catch (e: any) {
    const r = rules(`the read failed: ${String(e?.message ?? e).slice(0, 120)}`);
    return { ...r, ...(e?.code === "budget" || e?.name === "BudgetError" ? { why: "the daily budget is spent" } : {}) };
  }
}

/** the registry in the prompt's words: what each askable key takes */
const keyHelp: Record<AskKey, string> = {
  audience: "who it's for. ids: investors, users, launch, application",
  involvement:
    "how often the person wants to pick. ids: key (only the key picks), every (every step), auto (let the crew run)",
  lengthSec: "the length in seconds, a number 5-180 (15, 30, 45 or 60 are the usual)",
  narration: "ids: none (no voice, captions only), user (the person records it)",
  budget: "the most to spend, in US dollars, a number 1-50",
};
