// "Ask Pip about this" (the scope chip): the words a scoped message goes with, and back. Pure, no imports, so the node
// test reads it directly.

/** the words a scoped message goes with: the server strips the "About …:" lead before it matches a command */
export const scoped = (about: { label: string } | undefined, body: string) =>
  about && !body.startsWith("/") ? `About ${about.label}: ${body}` : body;

/** "About the moth: make it bigger" → { about: "the moth", text: "make it bigger" }, for the person's bubble */
export function splitAbout(text: string): { about: string | null; text: string } {
  const m = /^About (.{1,80}?): (.+)$/s.exec(text);
  return m ? { about: m[1], text: m[2] } : { about: null, text };
}
