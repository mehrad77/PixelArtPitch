// A task's transcript in plain words: parse the server's title formats (packages/crew/src/orchestrator.ts) and merge
// what was fetched with what arrived live. Pure functions, no React.
import { duration, n } from "./format.ts";
import type { ActivityEntry, TaskProgress } from "./types.ts";

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

/** a kit icon name for a step (the subset the drawer uses) */
export type StepIcon = "edit" | "search" | "refresh" | "flask" | "cube" | "document" | "play" | "send" | "chart";
/** a model step in words: what was asked ("Asked for variant 2") and what came back ("Drew variant 2") */
export type StepWords = { ask: string; done: string; icon: StepIcon };

/** the variant a task works on, from its title ("Drawing moth, variant 2, critique 1" → 2) */
export const variantOf = (title: string) => Number(title.match(/\bvariant (\d+)/i)?.[1]) || undefined;

/**
 * A model call named from its prompt card ("pixel-artist/draw") and the task kind the server logs with it (one card
 * serves a repair and a critique): "Drew variant 2", "Critiqued variant 1", "Picked the better one". An unknown card
 * falls back to its role and name ("Asked the planner", "Answered").
 */
export function stepWords(card: string | undefined, kind: string | undefined, title: string): StepWords {
  const v = variantOf(title);
  const of = v ? ` variant ${v}` : " the drawing";
  switch (card) {
    case "pixel-artist/draw":
      return {
        ask: `Asked for${v ? ` variant ${v}` : " a drawing"}`,
        done: v ? `Drew variant ${v}` : "Drew the sprite",
        icon: "edit",
      };
    case "pixel-artist/critique":
      return kind === "asset.repair"
        ? { ask: `Asked to fix the grid of${of}`, done: `Fixed the grid of${of}`, icon: "refresh" }
        : { ask: `Asked for a critique of${of}`, done: `Critiqued${of}`, icon: "search" };
    case "art-director/judge":
      return { ask: "Asked which drawing is better", done: "Picked the better one", icon: "flask" };
    case "art-director/spec":
      return { ask: "Asked for the drawing's spec", done: "Wrote the spec", icon: "cube" };
    case "producer/plan":
      return { ask: "Asked to read the brief", done: "Read the brief", icon: "document" };
    case "writer/angles":
      return { ask: "Asked for three script angles", done: "Wrote three angles", icon: "document" };
    case "writer/translate":
      return { ask: "Asked for a translation", done: "Translated the subtitles", icon: "document" };
    case "director/storyboard":
      return { ask: "Asked for the storyboard", done: "Sketched the storyboard", icon: "chart" };
    case "director/reboard":
      return { ask: "Asked to re-plan the scenes", done: "Re-planned the scenes", icon: "chart" };
    case "animator/tune":
      return { ask: "Asked to tune the motion", done: "Tuned the motion", icon: "play" };
    case "reviewer/final":
      return { ask: "Asked to watch the cut", done: "Watched the cut", icon: "search" };
  }
  const name = card?.split("/")[1]?.replace(/[-_]+/g, " ");
  return {
    ask: name ? `Asked for the ${name}` : "Sent the prompt",
    done: name ? `Answered: ${name}` : "Answered",
    icon: "send",
  };
}

/** the task kind a model entry was logged with (`detail.kind`; older transcripts have none) */
export const kindOf = (detail: unknown): string | undefined => {
  const k = (detail as { kind?: unknown } | null)?.kind;
  return typeof k === "string" ? k : undefined;
};

/**
 * Each entry's step: a model entry by its own card, an answer (or error) by the model entry before it in the same
 * task. Other entries (tools, patches, steps) have none.
 */
export function stepsOf(entries: ActivityEntry[], title: string): (StepWords | null)[] {
  let last: StepWords | null = null;
  return entries.map((e) => {
    if (e.kind === "model") {
      last = stepWords(parseModel(e.title).card, kindOf(e.detail), title);
      return last;
    }
    return e.kind === "answer" || e.kind === "error" ? last : null;
  });
}

/** a task row's title for its group head: the asset and the variant, without ids */
export function groupTitle(t: { kind: string; title: string }): string {
  const name = t.title
    .match(/^(?:Drawing|Choosing the best|Spec for)\s+([a-z0-9][\w-]*)/i)?.[1]
    ?.replace(/[-_]+/g, " ");
  const v = variantOf(t.title);
  if (t.kind === "asset.draw" && name) return `Drawing the ${name}${v ? ` · variant ${v}` : ""}`;
  if (t.kind === "asset.judge" && name) return `Choosing the better ${name}`;
  return t.title;
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
      return stepWords(parseModel(e.title).card, kindOf(e.detail), "").ask;
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

/**
 * A working step's live line, from the `progress` event: "Thinking… about 4,200 tokens · 48 s", then "Writing…" once
 * the answer streams. Tokens are estimated from characters, hence "about".
 */
export function progressLine(p: Pick<TaskProgress, "phase" | "tokens" | "seconds">): string {
  const head = p.phase === "writing" ? "Writing…" : "Thinking…";
  const parts = [p.tokens > 0 ? `about ${n(p.tokens)} tokens` : null, duration(p.seconds)].filter(Boolean);
  return `${head} ${parts.join(" · ")}`;
}
