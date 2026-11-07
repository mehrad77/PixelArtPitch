// The project page on screen shares its live state here, so the app header (the Crew button) reads the same state
// without opening a second event stream. The page publishes on every change and clears it when it leaves.
import { useEffect, useSyncExternalStore } from "react";
import { setLastProject } from "./human.ts";
import type { ProjectState } from "./types.ts";

type Shown = { id: string; state: ProjectState } | null;
let shown: Shown = null;
const listeners = new Set<() => void>();
const notify = () => {
  for (const l of listeners) l();
};
const subscribe = (cb: () => void) => {
  listeners.add(cb);
  return () => listeners.delete(cb);
};

/** a project page calls this with its state; it also becomes the most recently opened project. The /new stage calls
 * it with no id or no state yet, which publishes nothing */
export function usePublishProject(id: string, state: ProjectState | null) {
  useEffect(() => {
    if (id) setLastProject(id);
  }, [id]);
  useEffect(() => {
    if (!id || !state) return;
    shown = { id, state };
    notify();
  }, [id, state]);
  useEffect(
    () => () => {
      if (id && shown?.id === id) {
        shown = null;
        notify();
      }
    },
    [id],
  );
}

/** the state a project page published, or null off a project page (or before it loaded) */
export const useShownProject = (): Shown => useSyncExternalStore(subscribe, () => shown);
