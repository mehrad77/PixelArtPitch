// Versioned prompt cards: packages/crew/prompts/<role>/<task>.md with frontmatter (version, maxOut, effort) and
// "## system" / "## user" sections. {{name}} placeholders are filled per call; the version goes into every ledger row.
import { readFileSync } from "node:fs";

const DIR = new URL("../prompts/", import.meta.url).pathname;

export type PromptCard = {
  id: string;
  version: string;
  maxOut: number;
  effort?: "low" | "medium" | "high" | "xhigh";
  system: string;
  user: string;
};

const cache = new Map<string, PromptCard>();

export function card(role: string, task: string): PromptCard {
  const id = `${role}/${task}`;
  const hit = cache.get(id);
  if (hit) return hit;
  const src = readFileSync(`${DIR}${id}.md`, "utf8");
  const fm = /^---\n([\s\S]*?)\n---\n/.exec(src);
  const meta: Record<string, string> = {};
  for (const line of (fm?.[1] ?? "").split("\n")) {
    const m = /^(\w+):\s*(.*)$/.exec(line.trim());
    if (m) meta[m[1]] = m[2];
  }
  const body = fm ? src.slice(fm[0].length) : src;
  const sec = (name: string) => {
    const m = new RegExp(`^## ${name}\\n([\\s\\S]*?)(?=^## |$(?![\\s\\S]))`, "m").exec(body);
    return m ? m[1].trim() : "";
  };
  const c: PromptCard = {
    id,
    version: `${id}@${meta.version ?? "1"}`,
    maxOut: Number(meta.maxOut ?? 8000),
    effort: (meta.effort as PromptCard["effort"]) ?? undefined,
    system: sec("system"),
    user: sec("user"),
  };
  cache.set(id, c);
  return c;
}

/** fill {{name}} placeholders; objects become pretty JSON; a missing value is an error (never send "{{x}}") */
export function fill(template: string, vars: Record<string, unknown>): string {
  return template.replace(/\{\{(\w+)\}\}/g, (_m, k: string) => {
    if (!(k in vars)) throw new Error(`prompt variable {{${k}}} has no value`);
    const v = vars[k];
    return typeof v === "string" ? v : JSON.stringify(v, null, 1);
  });
}
