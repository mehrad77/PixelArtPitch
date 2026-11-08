// One door for changes (docs/PIP-ORCHESTRATION.md §1.12): who owns a person's note, whether it comes through Pip's
// crew_request_change, a gate's "Change something" or a retry card. The same words always reach the same member.
import type { RoleT } from "@pap/schema";
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

export type RouteNote = {
  text: string;
  target?: { scene?: string; cue?: string; asset?: string };
  category?: ChangeCategory;
};

/**
 * The member who owns a person's change. A drawn asset is the Pixel Artist's; sound the Sound Designer's; the script's
 * words the Writer's; cast, staging, recipes, backdrop, text cards and the end card the Director's (a re-board);
 * timing and motion inside a scene the Animator's. `fallback` (a gate's owner) only decides what the words don't.
 */
export function routeChange(note: RouteNote, fallback?: RoleT): RoleT {
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
