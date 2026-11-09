// Text for people: cut on a word boundary, never mid-word.

/**
 * `s` cut to at most `max` characters on a word boundary, with "…" when anything was cut ("title card ear" never
 * happens). A single word longer than `max` is cut hard.
 */
export function cutWords(s: string, max: number): string {
  const t = s.replace(/\s+/g, " ").trim();
  if (t.length <= max) return t;
  const room = Math.max(1, max - 1);
  const head = t.slice(0, room + 1);
  const at = head.lastIndexOf(" ");
  const cut = (at > room * 0.4 ? head.slice(0, at) : t.slice(0, room)).replace(/[\s,;:.–-]+$/, "");
  return `${cut}…`;
}

/**
 * `s` in whole sentences that fit `max` characters: the whole text when it fits, else the sentences that fit (never
 * a cut word); when even the first sentence is too long, it is cut at a word with "…" (cutWords).
 */
export function cutSentences(s: string, max: number): string {
  const t = s.replace(/\s+/g, " ").trim();
  if (t.length <= max) return t;
  let out = "";
  for (const m of t.matchAll(/[^.!?]+[.!?]+(?=\s|$)|[^.!?]+$/g)) {
    const next = `${out}${out ? " " : ""}${m[0].trim()}`;
    if (next.length > max) break;
    out = next;
  }
  return out || cutWords(t, max);
}

/** what plainText may name: the project's scenes (id → title), its asset ids, and plan task labels by id */
export type PlainCtx = {
  scenes?: { id: string; title?: string }[];
  assets?: string[];
  tasks?: Record<string, string>;
};
const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
/** an asset id as a person reads it: "cast-developer" → "developer", "props-small" → "props small" */
export const assetName = (id: string) => id.replace(/^cast-/, "").replace(/[-_]+/g, " ");
/**
 * Text for a person (PIP-ORCHESTRATION §1.14): no `lib:owl@1` (the asset's name), no plan task ids (`t_draw_owl_v2`:
 * its label when known, else nothing), scene ids that look like ids (`s02_moth`, or any id after "scene ") as the
 * scene's title, and asset ids with dashes as names. Leftover "()" and doubled spaces are tidied.
 */
export function plainText(s: string, ctx: PlainCtx = {}): string {
  let t = s.replace(/\blib:([a-z0-9-]+)@\d+\b/g, (_, id: string) => assetName(id));
  t = t.replace(/\bt_[a-z0-9_]+\b/g, (id) => ctx.tasks?.[id] ?? "");
  for (const sc of ctx.scenes ?? []) {
    if (!sc.title) continue;
    t = t.replace(new RegExp(`\\bscene ${esc(sc.id)}\\b`, "gi"), `"${sc.title}"`);
    if (/[_\d]/.test(sc.id)) t = t.replace(new RegExp(`\\b${esc(sc.id)}\\b`, "g"), `"${sc.title}"`);
  }
  for (const a of ctx.assets ?? [])
    if (/[-_]/.test(a) && !/^lib:/.test(a))
      t = t.replace(new RegExp(`(?<![\\w/.:-])${esc(a)}(?![\\w-])`, "g"), assetName(a));
  return t
    .replace(/\(\s*[,;]?\s*\)/g, "")
    .replace(/\s+([,.;:!?])/g, "$1")
    .replace(/([,;])\s*(?=[,;.])/g, "")
    .replace(/[ \t]{2,}/g, " ")
    .trim();
}
