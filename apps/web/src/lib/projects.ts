// Which group a project card sits in on Projects. Pure, no React (tested in node).
import type { ProjectSummary } from "./types.ts";

export type Kind = "needs" | "working" | "problem" | "stopped" | "finished" | "fresh" | "draft";

/**
 * The card's group. A run that is going (a rerun after a change, an export after G3) is Working even when an older
 * video exists: `running` is read before `finished`, so a rerun never shows "✓ Finished".
 */
export function kindOf(p: ProjectSummary): Kind {
  if (p.draft) return "draft";
  if (p.needsYou > 0) return "needs";
  // a held run ("Waiting for you: Your key was rejected") waits on you; only a run that broke off is stuck
  if (p.status?.problem) return /^Waiting for you/.test(p.status.line) ? "needs" : "problem";
  if (p.running) return "working";
  if (p.finished) return "finished";
  // an older server sends none of the overview fields: anything past the brief has started
  const started = (p.milestones ?? 0) > 0 || (p.phase ?? 0) > 0 || p.stage !== "brief" || p.spentUsd > 0;
  return started || p.paused ? "stopped" : "fresh";
}
