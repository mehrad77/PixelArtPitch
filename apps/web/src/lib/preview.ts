// "Change something" on a gate, priced as the person types: the server routes the note the way it will really run
// (POST /api/p/:id/changes/preview: the Director for cast, staging or the end card; the Animator for motion) and says
// what it costs, with no model call. Debounced, newest answer wins, nothing asked for an empty note. An older server
// without the route answers null once; the card then falls back to its own estimate.
import { useEffect, useRef, useState } from "react";
import { client } from "./client.ts";
import type { Effect } from "./human.ts";
import type { ChangesPreview, GateId } from "./types.ts";

export type PreviewState =
  /** nothing typed yet, or the server has no preview route (`supported` false) */
  | { status: "idle"; supported: boolean | null; preview: null }
  | { status: "loading"; supported: boolean | null; preview: ChangesPreview | null }
  | { status: "ready"; supported: true; preview: ChangesPreview }
  | { status: "error"; supported: boolean | null; preview: null };

const DEBOUNCE_MS = 450;
/** projects whose server said it has no preview route: asked once per page */
const unsupported = new Set<string>();

export function useChangePreview(
  projectId: string,
  gate: GateId | undefined,
  text: string,
  items: string[],
  on = true,
): PreviewState {
  const [st, setSt] = useState<PreviewState>({
    status: "idle",
    supported: unsupported.has(projectId) ? false : null,
    preview: null,
  });
  const seq = useRef(0);
  const words = text.trim();
  const key = `${gate ?? ""}|${words}|${items.join("\u0001")}`;
  // biome-ignore lint/correctness/useExhaustiveDependencies: the key stands for gate, words and items
  useEffect(() => {
    const n = ++seq.current;
    if (!on || unsupported.has(projectId) || (!words && !items.length)) {
      setSt((s) => ({ status: "idle", supported: unsupported.has(projectId) ? false : s.supported, preview: null }));
      return;
    }
    setSt((s) => ({ status: "loading", supported: s.supported, preview: s.preview }));
    const t = setTimeout(() => {
      client
        .changesPreview(projectId, { ...(gate ? { gate } : {}), text: words, ...(items.length ? { items } : {}) })
        .then(
          (p) => {
            if (n !== seq.current) return;
            if (!p) {
              unsupported.add(projectId);
              setSt({ status: "idle", supported: false, preview: null });
            } else setSt({ status: "ready", supported: true, preview: p });
          },
          () => n === seq.current && setSt((s) => ({ status: "error", supported: s.supported, preview: null })),
        );
    }, DEBOUNCE_MS);
    return () => clearTimeout(t);
  }, [projectId, key, on]);
  return st;
}

/**
 * The effect line for "Send changes": the server's routed preview once it lands (who does it, what it costs), a quiet
 * "working it out" while it's on the way, and the card's own estimate only on a server without the route. Shared with
 * Studio's gate card.
 */
export function changeEffect(st: PreviewState, make: (preview?: ChangesPreview) => Effect, typed: boolean): Effect {
  if (st.status === "ready") return make(st.preview);
  if (st.supported === false) return make();
  if (st.status === "loading") return { text: "Working out who does it and what it costs…", confirm: false };
  if (st.status === "error")
    return { text: "The estimate didn't load; the crew still gets your note.", confirm: false };
  return { text: typed ? "" : "Say what to change, and Pip says who does it and what it costs.", confirm: false };
}
