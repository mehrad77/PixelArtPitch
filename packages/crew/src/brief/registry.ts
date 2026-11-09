// The brief field registry (docs/PIP-ORCHESTRATION.md §3.2), fixed in code. Every value /new keeps, whoever wrote it
// (Pip's reading, the rules parse, a card's answer, the composer), is checked here: its type, its range, its options.
// Pip may word a question and its option labels; the ids, the defaults and what each value writes are code's.
// Also here: the rules parse (§3.3 step 4), the same regexes as the mock's (apps/web/src/mock/drafts.ts readIdea), and
// the file-type guess (apps/web/src/lib/brief.ts guessType).
import type { ProjectT } from "@pap/schema";
import { z } from "zod";

export const BRIEF_KEYS = [
  "idea",
  "title",
  "audience",
  "lengthSec",
  "narration",
  "budget",
  "deadline",
  "involvement",
  "profile",
  "style",
  "time",
  "references",
] as const;
export type BriefFieldKey = (typeof BRIEF_KEYS)[number];
export type RefType = "likeness" | "logo" | "style" | "as-is" | "sound" | "voice";
export type Rights = "mine" | "licensed" | "unsure";
export type Involvement = "key" | "every" | "auto";
export type Profile = "best" | "balanced" | "local";

/** a field the card asks (the UI's BriefFieldAsk, apps/web/src/lib/types.ts) */
export type BriefFieldAsk = {
  key: BriefFieldKey;
  label: string;
  type: "choice" | "number" | "text" | "date" | "tags" | "files";
  options?: { id: string; label: string; detail?: string }[];
  recommended?: string | number;
  min?: number;
  max?: number;
  step?: number;
  unit?: string;
  /** for `files`: the draft's refs whose rights the card asks */
  value?: unknown;
};

export const AUDIENCE = [
  { id: "investors", label: "Investors", purpose: "pitch", audience: "Investors" },
  { id: "users", label: "Users", purpose: "social", audience: "People who might use it" },
  { id: "launch", label: "A launch post", purpose: "launch", audience: "Readers of a launch post" },
  { id: "application", label: "A selection committee", purpose: "application", audience: "A selection committee" },
] as const;
export const INVOLVEMENT: { id: Involvement; label: string; picks: string }[] = [
  { id: "key", label: "Only the key picks", picks: "The key moments" },
  { id: "every", label: "Every step", picks: "Every step" },
  { id: "auto", label: "Let the crew run", picks: "Only the rights" },
];
export const NARRATION = [
  { id: "none", label: "No voice, captions only" },
  { id: "user", label: "I'll record it" },
] as const;
export const LENGTHS = [15, 30, 45, 60] as const;
export const STYLES = ["playful", "calm", "bold", "cosy", "retro"] as const;
/** the time of day a video is set in (canvas.time; never asked: night unless the idea says) */
export const TIMES = [
  { id: "night", label: "Night" },
  { id: "dusk", label: "Dusk" },
  { id: "day", label: "Day" },
] as const;
export const RIGHTS: { id: Rights; label: string }[] = [
  { id: "mine", label: "Mine" },
  { id: "licensed", label: "Licensed" },
  { id: "unsure", label: "Not sure" },
];
export const PROFILES: { id: Profile; label: string }[] = [
  { id: "best", label: "Best" },
  { id: "balanced", label: "Balanced" },
  { id: "local", label: "On this computer" },
];
export const REF_TYPES: RefType[] = ["likeness", "logo", "style", "as-is", "sound", "voice"];
export const REF_TYPE_LABEL: Record<RefType, string> = {
  likeness: "Likeness",
  logo: "Logo",
  style: "Style",
  "as-is": "As is",
  sound: "Sound",
  voice: "Voice",
};
/** likeness, logo and voice are rights-sensitive: always "Private to this project" (docs/RIGHTS.md §1) */
export const isSensitive = (t: RefType) => t === "likeness" || t === "logo" || t === "voice";

/** "If open" order (priority): the fields a card may ask when the idea leaves them open */
export const ASK_ORDER = ["audience", "involvement", "lengthSec", "narration", "budget"] as const;
export type AskKey = (typeof ASK_ORDER)[number];
export const isAskable = (k: string): k is AskKey => (ASK_ORDER as readonly string[]).includes(k);
export const MAX_FIELDS = 3;
export const MAX_QUESTION_CARDS = 2;

export const DEFAULTS = { audience: "investors", lengthSec: 30, narration: "none", involvement: "key" } as const;
/** 0.50-50: the registry table said 1-50, but the P4 e2e brief says "under $0.90" */
export const BUDGET = { min: 0.5, max: 50, step: 0.5 };

/** the type of a dropped file, from its name and kind */
export function guessType(name: string, mime = ""): RefType {
  const n = name.toLowerCase();
  if (mime.startsWith("audio/") || /\.(wav|mp3|m4a|ogg|aac|flac)$/.test(n))
    return /voice|vo|narrat/.test(n) ? "voice" : "sound";
  if (/logo|brand|mark/.test(n)) return "logo";
  if (/face|portrait|me\b|selfie|headshot/.test(n)) return "likeness";
  return "style";
}

// ---------------------------------------------------------------- one value
export type Failed = { ok: false; message: string; fix: string; path: string };
export type Checked = { ok: true; value: unknown } | Failed;
const bad = (path: string, message: string, fix: string): Failed => ({ ok: false, message, fix, path });

const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;
/** a day as the brief stores it: 18:00 local time that day, as an ISO datetime */
export function deadlineIso(day: string): string {
  const [y, m, d] = day.slice(0, 10).split("-").map(Number);
  return new Date(y, m - 1, d, 18, 0, 0).toISOString();
}

/**
 * Check one value against its field. Choices take their id (a length takes "30" or 30); numbers are checked against
 * the range; text is trimmed. `localOn`: whether the local profile may be picked.
 */
export function checkValue(key: string, v: unknown, ctx: { localOn?: boolean } = {}): Checked {
  switch (key) {
    case "idea": {
      const s = typeof v === "string" ? v.trim() : "";
      if (!s) return bad(key, "The idea is empty", "Say what the video is about in a sentence or two.");
      if (s.length > 4000) return bad(key, "The idea is too long", "Keep it under 4000 characters.");
      return { ok: true, value: s };
    }
    case "title": {
      const s = typeof v === "string" ? v.trim() : "";
      if (!s || s.length > 120)
        return bad(key, "The title needs 1 to 120 characters", "Use a short name for the video.");
      return { ok: true, value: s };
    }
    case "audience":
      return AUDIENCE.some((a) => a.id === v)
        ? { ok: true, value: v }
        : bad(key, `Pick one for "Who's it for?"`, `Use one of: ${AUDIENCE.map((a) => a.label).join(", ")}.`);
    case "lengthSec": {
      const n = typeof v === "string" && v.trim() ? Number(v) : v;
      if (typeof n !== "number" || !Number.isFinite(n) || n < 5 || n > 180)
        return bad(key, "The length needs a number of seconds", "Use 5 to 180, such as 15, 30, 45 or 60.");
      return { ok: true, value: Math.round(n) };
    }
    case "narration":
      return NARRATION.some((x) => x.id === v)
        ? { ok: true, value: v }
        : bad(key, `Pick one for "A voice?"`, `Use one of: ${NARRATION.map((x) => x.label).join(", ")}.`);
    case "budget": {
      const n = typeof v === "string" && v.trim() ? Number(v.replace(/^\$/, "")) : v;
      if (typeof n !== "number" || !Number.isFinite(n) || n < BUDGET.min || n > BUDGET.max)
        return bad(key, "Up to how much? needs a number", `Use ${BUDGET.min} to ${BUDGET.max}.`);
      return { ok: true, value: Math.round(n * 100) / 100 };
    }
    case "deadline": {
      const s = typeof v === "string" ? v.trim() : "";
      if (!ISO_DAY.test(s.slice(0, 10)) || Number.isNaN(Date.parse(s.slice(0, 10))))
        return bad(key, "The deadline needs a day", "Use a date such as 2026-12-01.");
      return { ok: true, value: s.slice(0, 10) };
    }
    case "involvement":
      return INVOLVEMENT.some((x) => x.id === v)
        ? { ok: true, value: v }
        : bad(
            key,
            `Pick one for "How involved do you want to be?"`,
            `Use one of: ${INVOLVEMENT.map((x) => x.label).join(", ")}.`,
          );
    case "profile": {
      const ok = PROFILES.some((x) => x.id === v) && (v !== "local" || ctx.localOn);
      return ok
        ? { ok: true, value: v }
        : bad(
            key,
            v === "local" ? "No model runs on this computer yet" : "Pick a crew profile",
            v === "local"
              ? "Turn on a local provider in Settings › Providers, or use Best or Balanced."
              : "Use one of: best, balanced, local.",
          );
    }
    case "style": {
      const xs = Array.isArray(v) ? v : typeof v === "string" ? [v] : null;
      if (!xs || xs.length > 3 || xs.some((x) => !(STYLES as readonly string[]).includes(String(x))))
        return bad(key, "The style takes up to 3 tags", `Use up to 3 of: ${STYLES.join(", ")}.`);
      return { ok: true, value: [...new Set(xs.map(String))] };
    }
    case "time":
      return TIMES.some((x) => x.id === v)
        ? { ok: true, value: v }
        : bad(key, 'Pick one for "Time of day"', `Use one of: ${TIMES.map((x) => x.id).join(", ")}.`);
    case "references":
      return bad(key, "Files are added by dropping them", "Send the file to POST /api/drafts/:id/files.");
    default:
      return bad(key, `There's no brief field "${key}"`, `Use one of: ${BRIEF_KEYS.join(", ")}.`);
  }
}

/** a whole set of fields (the composer's PATCH): every key is checked, the first problem wins */
export function checkFields(
  fields: Record<string, unknown>,
  ctx: { localOn?: boolean } = {},
): { ok: true; value: Partial<Record<BriefFieldKey, unknown>> } | Failed {
  const out: Partial<Record<BriefFieldKey, unknown>> = {};
  for (const [k, v] of Object.entries(fields ?? {})) {
    if (v === null || v === undefined) continue;
    const c = checkValue(k, v, ctx);
    if (!c.ok) return c;
    out[k as BriefFieldKey] = c.value;
  }
  return { ok: true, value: out };
}

// ---------------------------------------------------------------- the card's fields
/** the registry's own question for a field (Pip may reword the label) */
export function askFor(key: AskKey, recommendedBudget = 3): BriefFieldAsk {
  switch (key) {
    case "audience":
      return {
        key,
        label: "Who's it for?",
        type: "choice",
        options: AUDIENCE.map((a) => ({ id: a.id, label: a.label })),
        recommended: DEFAULTS.audience,
      };
    case "involvement":
      return {
        key,
        label: "How involved do you want to be?",
        type: "choice",
        options: INVOLVEMENT.map((a) => ({ id: a.id, label: a.label })),
        recommended: DEFAULTS.involvement,
      };
    case "lengthSec":
      return {
        key,
        label: "How long?",
        type: "choice",
        options: LENGTHS.map((v) => ({ id: String(v), label: `${v} s` })),
        recommended: String(DEFAULTS.lengthSec),
      };
    case "narration":
      return {
        key,
        label: "A voice?",
        type: "choice",
        options: NARRATION.map((x) => ({ ...x })),
        recommended: DEFAULTS.narration,
      };
    case "budget":
      return {
        key,
        label: "Up to how much?",
        type: "number",
        min: BUDGET.min,
        max: BUDGET.max,
        step: BUDGET.step,
        unit: "$",
        recommended: recommendedBudget,
      };
  }
}

/** the inline rights field for files whose rights are still `unsure` (always asked, never preselected) */
export function filesAsk(refs: { name: string; type: RefType }[], second = false): BriefFieldAsk {
  const one = refs.length === 1 ? refs[0] : null;
  const label = second
    ? one?.type === "logo"
      ? "Is this your logo?"
      : one?.type === "likeness"
        ? "Do you have their OK to use their likeness?"
        : one?.type === "voice"
          ? "Do you have their OK to use their voice?"
          : "Do you have the OK to use these?"
    : one
      ? `Is the ${REF_TYPE_LABEL[one.type].toLowerCase()} yours to use?`
      : "Are these yours to use?";
  return {
    key: "references",
    label,
    type: "files",
    options: RIGHTS.map((r) => ({ id: r.id, label: r.label })),
    value: structuredClone(refs),
  };
}

/**
 * Check a card's answers. Every field the card asks needs a value; a `files` field needs a rights pick for each of
 * its files. Returns the values to keep (references as name -> {rights, type?}), or the first problem.
 */
export function checkCard(
  fields: BriefFieldAsk[],
  values: Record<string, unknown>,
):
  | {
      ok: true;
      fields: Partial<Record<BriefFieldKey, unknown>>;
      refs: { name: string; rights: Rights; type?: RefType }[];
    }
  | Failed {
  const out: Partial<Record<BriefFieldKey, unknown>> = {};
  const refs: { name: string; rights: Rights; type?: RefType }[] = [];
  for (const f of fields) {
    const v = values?.[f.key];
    if (f.type === "files") {
      const rows = (Array.isArray(v) ? v : []) as { name?: unknown; type?: unknown; rights?: unknown }[];
      for (const ref of (f.value ?? []) as { name: string }[]) {
        const row = rows.find((r) => r?.name === ref.name);
        if (!row?.rights || !RIGHTS.some((r) => r.id === row.rights))
          return bad(`references/${ref.name}`, `Say whose ${ref.name} is`, "Pick one: Mine, Licensed or Not sure.");
        if (row.type !== undefined && !REF_TYPES.includes(row.type as RefType))
          return bad(`references/${ref.name}`, `${ref.name} needs a file type`, `Use one of: ${REF_TYPES.join(", ")}.`);
        refs.push({
          name: ref.name,
          rights: row.rights as Rights,
          ...(row.type ? { type: row.type as RefType } : {}),
        });
      }
      continue;
    }
    if (v === undefined || v === null || v === "")
      return bad(
        f.key,
        `Pick one for "${f.label}"`,
        f.options ? `Use one of: ${f.options.map((o) => o.label).join(", ")}.` : `Give a value for ${f.key}.`,
      );
    // a choice the card offered: its id must be one of the card's options
    if (f.type === "choice" && f.options && !f.options.some((o) => o.id === String(v)))
      return bad(f.key, `Pick one for "${f.label}"`, `Use one of: ${f.options.map((o) => o.label).join(", ")}.`);
    const c = checkValue(f.key, v);
    if (!c.ok) return { ...c, message: c.message.replace(/^Pick one for "[^"]*"/, `Pick one for "${f.label}"`) };
    out[f.key] = c.value;
  }
  return { ok: true, fields: out, refs };
}

// ---------------------------------------------------------------- the rules parse (§3.3 step 4)
/** what the idea says, nothing invented: the same patterns as the mock's readIdea */
export function rulesRead(text: string): Partial<Record<BriefFieldKey, unknown>> {
  const t = text.toLowerCase();
  const out: Partial<Record<BriefFieldKey, unknown>> = {};
  const len = t.match(/(\d{1,3})\s*(s\b|sec|second)/);
  if (len) out.lengthSec = Math.min(180, Math.max(5, Number(len[1])));
  else if (/half a minute/.test(t)) out.lengthSec = 30;
  else if (/\ba minute\b/.test(t)) out.lengthSec = 60;
  if (/no (voice|narration|vo)\b|silent|captions only/.test(t)) out.narration = "none";
  else if (/i'?ll (record|narrate)|my voice/.test(t)) out.narration = "user";
  const cap = t.match(/(under|max|keep it under|budget)\s*\$?\s*(\d+(\.\d+)?)/);
  if (cap) {
    const n = Number(cap[2]);
    if (n >= BUDGET.min && n <= BUDGET.max) out.budget = n;
  }
  if (/investor/.test(t)) out.audience = "investors";
  else if (/\b(users?|customers)\b/.test(t)) out.audience = "users";
  else if (/\blaunch\b/.test(t)) out.audience = "launch";
  const time = timeOfIdea(t);
  if (time) out.time = time;
  if (/let (the crew|it) run|surprise me/.test(t)) out.involvement = "auto";
  else if (/every step/.test(t)) out.involvement = "every";
  out.title = titleOf(text);
  out.idea = ideaOf(text);
  return out;
}
/** the time of day an idea is set in: "sunny", "in the day" → day; "at sunset", "dusk" → dusk; "night" → night */
export function timeOfIdea(text: string): "night" | "dusk" | "day" | undefined {
  const t = text.toLowerCase();
  if (/\b(sunset|sundown|dusk|twilight|golden hour)\b/.test(t)) return "dusk";
  if (/\b(sunny|sunshine|daylight|day-?time|midday|blue sky)\b|\b(in|during|by) (the )?(broad )?day\b/.test(t))
    return "day";
  if (/\b(night|night-?time|nighttime|moonlit|at midnight)\b/.test(t)) return "night";
  return undefined;
}
/** the first capitalized word that doesn't start a sentence, + " pitch"; else the first 6 words */
export function titleOf(text: string): string {
  const words = [...text.matchAll(/(^|[.!?]\s+|\s)([A-Za-z][A-Za-z0-9]*)/g)];
  const product = words.find((m, i) => i > 0 && !/[.!?]/.test(m[1]) && /^[A-Z][A-Za-z0-9]+$/.test(m[2]))?.[2];
  const t = product ? `${product} pitch` : text.trim().split(/\s+/).slice(0, 6).join(" ");
  return t.slice(0, 120) || "New video";
}
/** the idea without the clauses the parse already took, as a sentence */
export function ideaOf(text: string): string {
  const kept = text
    .split(/(?<=[.!?])\s+/)
    .filter((s) => !/^(no (voice|narration|vo)|silent|captions only|keep it under|under \$|budget)/i.test(s.trim()))
    .join(" ")
    .trim();
  const base = kept || text.trim();
  const idea = base.charAt(0).toUpperCase() + base.slice(1);
  return (/[.!?]$/.test(idea) ? idea : `${idea}.`).slice(0, 4000);
}

// ---------------------------------------------------------------- what each field writes
/** the brief, title, budget and profile a set of draft fields writes (missing ones take the registry default) */
export function briefOf(
  fields: Partial<Record<BriefFieldKey, unknown>>,
  refs: { file: string; type: RefType; rights: Rights }[],
  extra: { source: "pip" | "composer"; budgetUsd: number },
): { title: string; brief: ProjectT["brief"]; budgetUsd: number } {
  const aud = AUDIENCE.find((a) => a.id === (fields.audience ?? DEFAULTS.audience)) ?? AUDIENCE[0];
  const brief: ProjectT["brief"] = {
    idea: String(fields.idea ?? "").slice(0, 4000) || "A short pixel-art video.",
    purpose: aud.purpose,
    audience: aud.audience,
    ask: "",
    lengthSec: typeof fields.lengthSec === "number" ? fields.lengthSec : DEFAULTS.lengthSec,
    tone: Array.isArray(fields.style) ? (fields.style as string[]).slice(0, 3) : [],
    mustSay: [],
    mustAvoid: [],
    narration: fields.narration === "user" ? "user" : "none",
    involvement: (fields.involvement as Involvement | undefined) ?? DEFAULTS.involvement,
    ...(typeof fields.deadline === "string" ? { deadline: deadlineIso(fields.deadline) } : {}),
    source: extra.source,
    references: refs.map((r) => ({ ...r, note: "" })),
  };
  const title = typeof fields.title === "string" && fields.title.trim() ? fields.title.trim() : titleOf(brief.idea);
  return { title, brief, budgetUsd: typeof fields.budget === "number" ? fields.budget : extra.budgetUsd };
}

/** the fields "Make another like this" inherits from a project (never the idea or the references) */
export function inheritFrom(doc: ProjectT): Partial<Record<BriefFieldKey, unknown>> {
  const b = doc.brief;
  const aud = AUDIENCE.find((a) => a.purpose === b.purpose)?.id;
  const out: Partial<Record<BriefFieldKey, unknown>> = {
    lengthSec: Math.min(180, Math.max(5, Math.round(b.lengthSec))),
    narration: b.narration === "user" ? "user" : "none",
    involvement: b.involvement,
  };
  if (aud) out.audience = aud;
  const time = (doc.canvas as { time?: string }).time;
  if (time && time !== "night") out.time = time;
  if (doc.crew.profile !== "custom") out.profile = doc.crew.profile;
  const style = b.tone.map((x) => x.toLowerCase()).filter((x) => (STYLES as readonly string[]).includes(x));
  if (style.length) out.style = [...new Set(style)].slice(0, 3);
  const cap = doc.budget.capUsd;
  if (cap >= BUDGET.min && cap <= BUDGET.max) out.budget = cap;
  return out;
}

export const BriefFieldKeyZ = z.enum(BRIEF_KEYS);
