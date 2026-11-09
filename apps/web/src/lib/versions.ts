// What a project has (the five parts: Idea, Story, Pictures, Sound, Video) and its exports (v1, v2, …), in plain
// words: the project page's parts and version line, the Projects card's marks. Never colour alone (each part has an
// icon and a word), never "stale" (the person reads "older than your changes"). Pure functions, no React.
import { numberLocale } from "./locale.ts";
import type { Part, PartId, ProjectState, Stage, Version } from "./types.ts";

export const PART_WORD: Record<PartId, string> = {
  idea: "Idea",
  story: "Story",
  pictures: "Pictures",
  sound: "Sound",
  video: "Video",
};
/** the Studio stage where each part is made (PART_STAGES in @pap/tools/parts: its first stage) */
export const PART_STAGE: Record<PartId, Stage> = {
  idea: "brief",
  story: "script",
  pictures: "art",
  sound: "narrate",
  video: "review",
};

type PartLike = Pick<Part, "id" | "state" | "done" | "of">;

/** the word after the part's name: "3 of 5", "older than your changes", "missing"; "" when ready (the ✓ says it) */
export function partDetail(p: PartLike): string {
  if (p.state === "ready") return "";
  if (p.state === "stale") return "older than your changes";
  if (p.state === "partial") return p.of > 1 ? `${p.done} of ${p.of}` : "started";
  return "missing";
}
/** the part's mark, for the eye: ✓ ready, ◐ partial, ↻ older than your changes, ○ missing (always with its words) */
export const PART_ICON: Record<Part["state"], string> = { ready: "✓", partial: "◐", stale: "↻", missing: "○" };

/** one part for a screen reader: "Idea ready", "Pictures 3 of 5", "Sound missing", "no video" */
export function partLabel(p: PartLike): string {
  if (p.id === "video" && p.state === "missing") return "no video";
  return `${PART_WORD[p.id]} ${p.state === "ready" ? "ready" : partDetail(p)}`;
}
/** the card's marks as one label: "Idea ready, Story ready, Pictures 3 of 5, Sound missing, no video" */
export const partsLabel = (parts: PartLike[]) => parts.map(partLabel).join(", ");

/** the latest export, or null (versions are oldest first) */
export const latestVersion = (versions: Version[] | undefined) =>
  (versions ?? []).reduce<Version | null>((m, v) => (!m || v.v > m.v ? v : m), null);

/** a version exists (an older server sends no versions: its exported video counts) */
export const hasVersion = (s: ProjectState) =>
  s.versions ? s.versions.length > 0 : s.files.some((f) => f.kind === "video");

export type VersionLine =
  | { kind: "current"; v: number; at: string; date: string }
  | { kind: "older"; v: number }
  | { kind: "making"; v: number }
  | { kind: "none" };

const shortDate = (iso: string) =>
  new Intl.DateTimeFormat(numberLocale(), { day: "numeric", month: "short" }).format(new Date(iso));

/**
 * The version line beside the parts, or null when there is nothing to say yet (no version, and a crew is still
 * making the parts, or the parts up to Sound aren't ready): one of
 * "v2 · exported 3 Nov · up to date", "v2 is older than your changes" (Export v3), "Making v3 · v2 still plays",
 * "No video yet" (Export).
 */
export function versionLineOf(
  s: Pick<ProjectState, "versions" | "parts">,
  running: boolean,
  date: (iso: string) => string = shortDate,
): VersionLine | null {
  const last = latestVersion(s.versions);
  if (last && running) return { kind: "making", v: last.v + 1 };
  if (last) {
    const video = s.parts?.parts.find((p) => p.id === "video");
    return video?.state === "stale"
      ? { kind: "older", v: last.v }
      : { kind: "current", v: last.v, at: last.at, date: date(last.at) };
  }
  if (running) return null;
  const upToSound = s.parts?.parts.filter((p) => p.id !== "video") ?? [];
  return upToSound.length && upToSound.every((p) => p.state === "ready") ? { kind: "none" } : null;
}

/** the line's words, as the person reads them */
export function versionWords(l: VersionLine): string {
  switch (l.kind) {
    case "current":
      return `v${l.v} · exported ${l.date} · up to date`;
    case "older":
      return `v${l.v} is older than your changes`;
    case "making":
      return `Making v${l.v} · v${l.v - 1} still plays`;
    case "none":
      return "No video yet";
  }
}
/** the Export button's label, when the line offers one */
export function exportLabel(l: VersionLine): string | null {
  if (l.kind === "older") return `Export v${l.v + 1}`;
  if (l.kind === "none") return "Export";
  return null;
}
