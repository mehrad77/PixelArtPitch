// One door for changes (docs/PIP-ORCHESTRATION.md §1.12): who owns a person's note, whether it comes through Pip's
// crew_request_change, a gate's "Change something" or a retry card. The same words always reach the same member.
import type { ProjectT, RoleT } from "@pap/schema";
import { type ChangeCategory, changeOwner } from "@pap/tools";

/**
 * What is on screen and who is in it: cast, staging, recipes, the backdrop, text cards, the end card. The Director
 * re-plans these (a re-board).
 */
const DIRECTOR =
  /\b(cast|casting|characters?|actors?|npcs?|friends?|crowd|people|someone|staging|recipes?|backdrops?|background|sky|rooftop|setting|location|title card|text card|end card|ending|banner|sign|name ?tag|toast|logo|props?|lantern|lamp|walks? in|joins?|enters?|appears?|shows? up|add(ing)? (a |an |two |three |some |more |another )?(new )?\w*\s*(scenes?|characters?|npcs?|people|items?|props?|beats?|shots?|friends?)|remove|swap|replace|instead of|sits?|sitting|perch(es)?|flies|fly|flying|glows?|glowing|new (beat|scene|shot)s?|order of the scenes)\b/i;
/** how a scene moves and when, inside the scene: the Animator's */
const ANIMATOR =
  /\b(faster|slower|speed|timing|tempo|earlier|later|sooner|delay|longer|shorter|pause|hold it|linger|bounce|smoother|jumpy|choppy|motion|moves?|moving|animation|animate|bigger|smaller|size|scale|position|higher|lower|left|right|closer|further|zoom|camera)\b/i;
const WRITER = /\b(narration|voice ?over|vo|script|words?|wording|line|lines|say|says|caption|subtitle|tagline)\b/i;

/**
 * The time of day a person's words ask for ("make it day", "sunny", "at sunset instead", "back to night"), or null.
 * A complaint that names the old time ("it's still night!") asks nothing here: the redo of the scenes that show it
 * is the coder's.
 */
export function timeAsked(text: string): "day" | "dusk" | "night" | null {
  const t = (text ?? "").toLowerCase();
  if (/\b(sunset|sundown|dusk|twilight|golden hour|evening)\b/.test(t)) return "dusk";
  if (
    /\b(sunny|sunshine|daylight|day-?time|midday|noon|morning|afternoon|blue sky)\b/.test(t) ||
    /\b(in|during|by) (the )?(broad )?day\b/.test(t) ||
    /\b(make|turn|set|change|switch|put)\b[^.!?]{0,40}\b(to |into |in |at )?(a |the )?(bright |sunny )?day\b/.test(t)
  )
    return "day";
  if (
    /\b(make|turn|set|change|switch|put)\b[^.!?]{0,40}\b(night|night-?time)\b/.test(t) ||
    /\bback to (the )?night\b/.test(t)
  )
    return "night";
  return null;
}

export type RouteNote = {
  text: string;
  target?: { scene?: string; cue?: string; asset?: string };
  category?: ChangeCategory;
  /** the target scene is a code scene the Scene Coder writes (routeIn sets it from the document) */
  codeScene?: boolean;
};

/**
 * The member who owns a person's change. A drawn asset is the Pixel Artist's; sound the Sound Designer's; the script's
 * words the Writer's; cast, staging, recipes, backdrop, text cards and the end card the Director's (a re-board);
 * timing and motion inside a scene the Animator's. `fallback` (a gate's owner) only decides what the words don't.
 */
export function routeChange(note: RouteNote, fallback?: RoleT): RoleT {
  // the time of day is the whole video's look: the Director's, done with no model call (look.time), never a re-code
  if (!note.target?.asset && note.category !== "sound" && timeAsked(note.text)) return "director";
  const owner = routeWords(note, fallback);
  // a code scene is drawn by its code: how it looks, moves or is staged is the Scene Coder's (a redo priced by
  // scene.code); a story change still re-boards it (the Director writes a new beat)
  if (
    note.codeScene &&
    note.target?.scene &&
    (owner === "animator" || (owner === "director" && note.category !== "story"))
  )
    return "scene-coder";
  return owner;
}

/** the scene is a code scene the crew codes (a beat from the board; an imported bundle stays the person's) */
export const isCodeScene = (doc: Pick<ProjectT, "scenes">, scene?: string) => {
  const s = scene ? doc.scenes.find((x) => x.id === scene) : undefined;
  return s?.kind === "code" && !!s.beat;
};

/** routeChange with the document: a note on a code scene reaches the Scene Coder */
export function routeIn(doc: Pick<ProjectT, "scenes">, note: RouteNote, fallback?: RoleT): RoleT {
  return routeChange({ ...note, codeScene: isCodeScene(doc, note.target?.scene) }, fallback);
}

function routeWords(note: RouteNote, fallback?: RoleT): RoleT {
  const t = note.target ?? {};
  const text = note.text ?? "";
  const category = note.category ?? "other";
  if (t.asset) return "pixel-artist";
  // sound only when the change says it is about sound (its category): a word like "rain sound" alone isn't enough
  if (category === "sound") return "sound-designer";
  if (category === "story") return "director";
  if (category === "text") return t.cue || !t.scene ? "writer" : "animator";
  if (t.cue && category === "other" && WRITER.test(text)) return "writer";
  const director = DIRECTOR.test(text);
  const animator = ANIMATOR.test(text);
  if (director && !(category === "timing" && animator)) return "director";
  if (animator || category === "timing") return "animator";
  if (category === "other" && WRITER.test(text) && !t.scene) return "writer";
  return fallback ?? changeOwner(t, category, text);
}
