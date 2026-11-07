// What went wrong, in a few kinds: read from a task's error (its `kind` when the crew wrote one) or a fallback note.

export const FAIL_KINDS = [
  "limit",
  "auth",
  "credit",
  "unreachable",
  "rate",
  "budget",
  "standard",
  "fallback",
  "other",
] as const;
export type FailKind = (typeof FAIL_KINDS)[number];

export const FAIL_LABEL: Record<FailKind, string> = {
  limit: "Hit the token limit",
  auth: "Key rejected",
  credit: "Out of credit",
  unreachable: "Provider unreachable",
  rate: "Rate limited",
  budget: "Stopped by the budget",
  standard: "Rejected by the standard",
  fallback: "Fell back to a stand-in",
  other: "Other failure",
};

/** the timeline's incident label, for the kinds worth a line across every lane */
export const INCIDENT_LABEL: Partial<Record<FailKind, string>> = {
  auth: "Key rejected",
  credit: "Out of credit",
  unreachable: "Provider unreachable",
  rate: "Rate limited",
  standard: "Rejected by the standard",
};

const KNOWN = new Set<string>(FAIL_KINDS);

/** a message's kind; `null` for a pause (the person stopped it), which is not a failure */
export function errorKind(message: string, kind?: string | null): FailKind | null {
  if (kind && KNOWN.has(kind)) return kind as FailKind;
  const m = message;
  if (/\bpaused\b|\bstopped by (you|the person)\b/i.test(m)) return null;
  if (
    /\b(401|403)\b|authentication|x-api-key|api key|key was rejected|unauthori[sz]ed|forbidden|permission_error/i.test(
      m,
    )
  )
    return "auth";
  if (/credit|billing|insufficient.?(funds|balance)|quota/i.test(m)) return "credit";
  if (/ECONNREFUSED|ENOTFOUND|ECONNRESET|ETIMEDOUT|fetch failed|unreachable|can't reach|cannot reach/i.test(m))
    return "unreachable";
  if (/\b(429|529)\b|rate.?limit|overloaded/i.test(m)) return "rate";
  if (/max_tokens|token limit/i.test(m)) return "limit";
  if (/fails the standard|failed the standard/i.test(m)) return "standard";
  if (/\bbudget\b|over the cap|\bcap\b/i.test(m)) return "budget";
  return "other";
}

/** a plan task's fallback note ("partial: kept as built (401 …)"): the provider kinds keep their kind, the rest fell back */
export function fallbackKind(note: string): FailKind {
  const k = errorKind(note);
  return k === "auth" || k === "credit" || k === "unreachable" || k === "rate" || k === "standard" ? k : "fallback";
}
