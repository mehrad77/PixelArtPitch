// A task's transcript in plain words: parse the server's title formats (packages/crew/src/orchestrator.ts) and merge
// what was fetched with what arrived live. Pure functions, no React.
import type { ActivityEntry } from "./types.ts";

const key = (e: ActivityEntry) => `${e.at}|${e.kind}|${e.title}`;

/** the fetched transcript plus live lines, deduped (there is no id) and oldest first */
export function mergeEntries(fetched: ActivityEntry[] | null | undefined, live: ActivityEntry[] | undefined) {
  const seen = new Set<string>();
  const out: ActivityEntry[] = [];
  for (const e of [...(fetched ?? []), ...(live ?? [])]) {
    const k = key(e);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(e);
  }
  return out.sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
}

/** "read_project → ok" → { name: "read_project", ok: true }; "x → timeout" → { ok: false, code: "timeout" } */
export function parseTool(title: string): { name: string; ok: boolean; code?: string } {
  const m = title.match(/^(.+?)\s*→\s*(.+)$/);
  if (!m) return { name: title.trim(), ok: true };
  const code = m[2].trim();
  return { name: m[1].trim(), ok: code === "ok", ...(code === "ok" ? {} : { code }) };
}

/** "Asked gpt-oss-20b (writer/angles)" → { model: "gpt-oss-20b", card: "writer/angles" } */
export function parseModel(title: string): { model: string; card?: string } {
  const m = title.match(/^Asked\s+(.+?)(?:\s+\(([^)]+)\))?$/);
  return m ? { model: m[1], card: m[2] } : { model: title };
}

/** "Answered in 9 s · 812 tokens · $0.004" → "9 s · 812 tokens · $0.004" */
export const answerStats = (title: string) => title.replace(/^Answered in\s+/i, "");

const TOOL_WORDS: Record<string, string> = {
  read_project: "Read the project",
  read_brief: "Read your brief",
  read_script: "Read the script",
  count_words: "Counted the words",
  check_timing: "Checked the timing",
  estimate_cost: "Worked out the cost",
  render_frame: "Drew a frame",
  render_still: "Drew a frame",
  place_scene: "Placed a scene",
  search_library: "Searched the library",
  match_sprite: "Matched a sprite",
  draw_sprite: "Drew a sprite",
  check_palette: "Checked the colors",
  compare_variants: "Compared the versions",
  search_sfx: "Looked for sound effects",
  place_sfx: "Placed a sound effect",
  set_keyframes: "Set the motion",
  check_motion: "Checked the motion",
  align_vo: "Lined up the narration",
  measure_loudness: "Measured the loudness",
  set_gain: "Set a volume",
  check_text_safe: "Checked the text fits",
  check_loudness: "Checked the loudness",
  render_video: "Rendered the video",
  write_subtitles: "Wrote the subtitles",
  call_model: "Called the model",
  patch_project: "Changed the project",
  ask_user: "Asked you a question",
};

/** a tool's name as the person reads it: "Searched the library"; unknown ones become "Used set keyframes" */
export function toolWords(name: string): string {
  const known = TOOL_WORDS[name];
  if (known) return known;
  const plain = name
    .replace(/[_.-]+/g, " ")
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .trim();
  return `Used ${plain || "a tool"}`;
}

/** pretty JSON for a details panel; strings stay as they are */
export function pretty(v: unknown): string {
  if (typeof v === "string") return v;
  try {
    return JSON.stringify(v, null, 2) ?? String(v);
  } catch {
    return String(v);
  }
}

/** the prompt text out of a model entry's detail */
export function promptOf(detail: unknown): string | null {
  if (typeof detail === "string") return detail;
  const p = (detail as { prompt?: unknown } | null)?.prompt;
  return typeof p === "string" ? p : detail == null ? null : pretty(detail);
}

/** one short line for the switcher: what the newest entry was about */
export function entryLine(e: ActivityEntry): string {
  switch (e.kind) {
    case "model":
      return `Asked ${parseModel(e.title).model} for help`;
    case "tool": {
      const t = parseTool(e.title);
      return t.ok ? toolWords(t.name) : `${toolWords(t.name)}, didn't work`;
    }
    case "patch":
      return e.title.startsWith("Changed the project") ? e.title : `Changed the project: ${e.title}`;
    case "answer":
      return "Answered";
    case "error":
      return "Ran into a problem";
    default:
      return e.title;
  }
}
