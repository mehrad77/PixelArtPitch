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
