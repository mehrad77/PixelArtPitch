// The brief's words shared by /new and the composer: file types, which ones are rights-sensitive, and the guess for a
// dropped file (PIP-ORCHESTRATION §3.2, `references`). Pure, no React.
import type { Involvement, Profile, RefType } from "./types.ts";

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

/** rough per-60-second cost and minutes, by profile, at two drawings per new asset (the server's estimate is better) */
export const COMPOSER_RATE: Record<Exclude<Profile, "custom">, { usd: [number, number]; min: [number, number] }> = {
  best: { usd: [3.8, 6.2], min: [25, 40] },
  balanced: { usd: [1.9, 3.4], min: [20, 35] },
  local: { usd: [0, 0.4], min: [50, 90] },
};
const INVOLVE_WAIT: Record<Involvement, number> = { every: 1.3, key: 1.1, auto: 1 };
/** each drawing is about this share of a run's cost and time (one variant drops the judge as well) */
export const DRAWING_SHARE = 0.15;

/** the composer's live estimate: by profile, length and involvement, scaled by the drawings per new asset (1-3) */
export function composerEstimate(o: {
  profile: Exclude<Profile, "custom">;
  lengthSec: number;
  involvement: Involvement;
  variants?: number;
}) {
  const r = COMPOSER_RATE[o.profile];
  const f = o.lengthSec / 60;
  const w = INVOLVE_WAIT[o.involvement];
  const v = 1 + DRAWING_SHARE * (Math.min(3, Math.max(1, o.variants ?? 2)) - 2);
  return {
    usd: [r.usd[0] * f * v, r.usd[1] * f * v] as const,
    min: [r.min[0] * Math.max(0.5, f) * w * v, r.min[1] * Math.max(0.5, f) * w * v] as const,
  };
}
