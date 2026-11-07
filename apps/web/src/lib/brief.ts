// The brief's words shared by /new and the composer: file types, which ones are rights-sensitive, and the guess for a
// dropped file (PIP-ORCHESTRATION §3.2, `references`). Pure, no React.
import type { RefType } from "./types.ts";

export const REF_TYPE_LABEL: Record<RefType, string> = {
  likeness: "Likeness",
  logo: "Logo",
  style: "Style",
  "as-is": "As is",
  sound: "Sound",
  voice: "Voice",
};
/** likeness, logo and voice are rights-sensitive: always "Private to this project" (docs/RIGHTS.md §1) */
export const isSensitive = (t: RefType) => t === "likeness" || t === "logo" || t === "voice";

/** the type of a dropped file, from its name and kind */
export function guessType(name: string, mime = ""): RefType {
  const n = name.toLowerCase();
  if (mime.startsWith("audio/")) return /voice|vo|narrat/.test(n) ? "voice" : "sound";
  if (/logo|brand|mark/.test(n)) return "logo";
  if (/face|portrait|me\b|selfie|headshot/.test(n)) return "likeness";
  return "style";
}
