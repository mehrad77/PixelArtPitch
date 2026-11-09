// Which group a project card sits in on Projects. Pure, no React (tested in node).
import type { ProjectSummary } from "./types.ts";

export type Kind = "needs" | "working" | "problem" | "stopped" | "finished" | "fresh" | "draft";

/**
 * The card's group. "finished" is shown as Has a video: a version exists and no crew is running. A run that is going
 * (a rerun after a change, the next export) is Working even when an older version exists: `running` is read before
 * `version`, so a rerun never shows "✓ Has a video".
 */
export function kindOf(p: ProjectSummary): Kind {
  if (p.draft) return "draft";
  if (p.needsYou > 0) return "needs";
  // a held run ("Waiting for you: Your key was rejected") waits on you; only a run that broke off is stuck
  if (p.status?.problem) return /^Waiting for you/.test(p.status.line) ? "needs" : "problem";
  if (p.running) return "working";
  if (p.version) return "finished";
  // Stopped is a crew that did something and stopped; a project no crew has worked on (one made by hand, whatever
  // parts it has) is Not started
  const started = (p.milestones ?? 0) > 0 || p.spentUsd > 0;
  return started || p.paused ? "stopped" : "fresh";
}
