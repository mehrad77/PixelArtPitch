// Experiments the person turns on in Settings › Experimental. Per browser, like the direct controls: a convenience,
// not a project setting (nothing on the server reads them). Reads never throw; storage may be blocked.
import { useSyncExternalStore } from "react";

export type Experiment = "liveCanvas";
const KEY: Record<Experiment, string> = { liveCanvas: "pap.exp.liveCanvas" };
const EVENT = "pap:experiments";

export function experimentOn(x: Experiment): boolean {
  try {
    return localStorage.getItem(KEY[x]) === "1";
  } catch {
    return false;
  }
}
export function setExperiment(x: Experiment, on: boolean) {
  try {
    if (on) localStorage.setItem(KEY[x], "1");
    else localStorage.removeItem(KEY[x]);
  } catch {}
  window.dispatchEvent(new Event(EVENT));
}
const subscribe = (cb: () => void) => {
  window.addEventListener(EVENT, cb);
  window.addEventListener("storage", cb);
  return () => {
    window.removeEventListener(EVENT, cb);
    window.removeEventListener("storage", cb);
  };
};
/** live: a toggle in Settings shows at once in an open drawer */
export const useExperiment = (x: Experiment) =>
  useSyncExternalStore(
    subscribe,
    () => experimentOn(x),
    () => false,
  );
