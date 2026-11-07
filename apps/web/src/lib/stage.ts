// The /new shell that stays mounted (PIP-JOURNEY §3.5): App remembers the draft and the project the stage adopted, so
// /new, /new/:draftId and that one /p/:projectId render the same ProjectStage under one key, and the thread, the
// field and the focus survive the two replaceStates (the first send, then Start).
import { useSyncExternalStore } from "react";
import type { View } from "./human.ts";

/** `n` counts fresh /new visits: the stage's key, so a new video never inherits the last one's field or files */
/** `view` is the Simple / Studio choice when the stage adopted its project: toggling it leaves the stage for the usual
 * page */
export type Adopted = { draftId: string | null; projectId: string | null; n: number; view?: View };
let adopted: Adopted = { draftId: null, projectId: null, n: 0 };
const listeners = new Set<() => void>();

export function adopt(next: Partial<Adopted>) {
  adopted = { ...adopted, ...next };
  for (const l of listeners) l();
}
/** a fresh /new forgets what the last one adopted */
export function freshStage() {
  if (adopted.draftId || adopted.projectId) adopt({ draftId: null, projectId: null, n: adopted.n + 1 });
}
export const adoptedNow = () => adopted;
export const useAdopted = () =>
  useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    () => adopted,
  );

/** Pip's first line on /new; the draft's first item says it too, so the thread leaves it out */
export const FIRST_LINE = "What are we making?";
/** the examples under the field: they fill it and never send */
export const STARTERS = ["A 30 s pitch for investors", "A 15 s launch teaser"];
