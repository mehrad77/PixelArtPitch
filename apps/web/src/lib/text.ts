// Text the person reads, kept readable: a long line is cut on a word boundary with "…" (never "title card ear"), and a
// milestone said twice in a row is said once. The server cleans its own words (plainText); this is the web's safety
// net, so it only cuts and dedupes and leaves the words alone. Pure, no React.

/** `text` cut to at most `max` characters on a word boundary, with "…"; short text comes back as it was */
export function cutWords(text: string, max = 90): string {
  const t = text.replace(/\s+/g, " ").trim();
  if (t.length <= max) return t;
  const head = t.slice(0, max - 1);
  // the last whole word that fits; a single long word (an URL, an id) is cut where it must
  const at = head.lastIndexOf(" ");
  const kept = (at >= Math.floor(max * 0.4) ? head.slice(0, at) : head).replace(/[\s,;:·–—-]+$/, "");
  return `${kept}…`;
}

type Mark = { id: string; at: string; text: string };

/** milestones in time order, each said once while it repeats: "Plan changed: x" twice in a row is one row (the
 * newest time kept); the same words later, after something else happened, stay */
export function dedupeMarkers<M extends Mark>(marks: M[]): M[] {
  const sorted = [...marks]
    .filter((m) => Number.isFinite(Date.parse(m.at)))
    .sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  const out: M[] = [];
  const norm = (s: string) => s.replace(/\s+/g, " ").trim().toLowerCase();
  for (const m of sorted) {
    const last = out.at(-1);
    if (last && norm(last.text) === norm(m.text)) out[out.length - 1] = m;
    else out.push(m);
  }
  return out;
}
