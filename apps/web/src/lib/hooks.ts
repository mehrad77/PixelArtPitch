import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { forwardChannel } from "./channel.ts";
import { client } from "./client.ts";
import { currentView, onViewChange, type View } from "./human.ts";
import { forwardPip } from "./pip.ts";
import { applyEvent } from "./reducer.ts";
import type { ConnState, PatchEntryT, ProjectState, ServerEvent } from "./types.ts";

export type Load<T> = { data: T | null; error: Error | null; loading: boolean; reload: () => void };

/** run an async loader on mount and when deps change; the latest call wins */
export function useLoad<T>(fn: () => Promise<T>, deps: unknown[]): Load<T> {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<Error | null>(null);
  const [loading, setLoading] = useState(true);
  const [nonce, setNonce] = useState(0);
  // biome-ignore lint/correctness/useExhaustiveDependencies: deps are the caller's
  useEffect(() => {
    let live = true;
    setLoading(true);
    fn().then(
      (d) => {
        if (!live) return;
        setData(d);
        setError(null);
        setLoading(false);
      },
      (e: Error) => {
        if (!live) return;
        setError(e);
        setLoading(false);
      },
    );
    return () => {
      live = false;
    };
  }, [...deps, nonce]);
  return { data, error, loading, reload: () => setNonce((x) => x + 1) };
}

export type ProjectView = {
  state: ProjectState | null;
  history: PatchEntryT[];
  error: Error | null;
  conn: ConnState;
  /** the newest still the crew rendered, and the proxy once one is built */
  lastStill: string | null;
  proxy: string | null;
  /** bumps on every event, so views can show "updated" without moving anything */
  seq: number;
  reload: () => void;
};

/** the remembered Simple / Studio choice, re-rendering when it changes */
export const useView = (): View => useSyncExternalStore(onViewChange, currentView);

/** a project's state, kept live by its event stream; patches refetch the state (debounced) and extend the history.
 * A null id loads nothing. */
export function useProject(id: string | null): ProjectView {
  const [state, setState] = useState<ProjectState | null>(null);
  const [history, setHistory] = useState<PatchEntryT[]>([]);
  const [error, setError] = useState<Error | null>(null);
  const [conn, setConn] = useState<ConnState>("connecting");
  const [lastStill, setLastStill] = useState<string | null>(null);
  const [proxy, setProxy] = useState<string | null>(null);
  const [seq, setSeq] = useState(0);
  const refetch = useRef<ReturnType<typeof setTimeout> | null>(null);

  const load = useCallback(() => {
    if (!id) return;
    client.project(id).then(
      (s) => {
        // live activity is client-only: a refetched state must not drop it
        setState((prev) => ({ ...s, activity: s.activity ?? prev?.activity }));
        setError(null);
      },
      (e: Error) => setError(e),
    );
    client.history(id).then(setHistory, () => {});
  }, [id]);

  useEffect(() => {
    setState(null);
    setHistory([]);
    setProxy(null);
    if (!id) return;
    load();
    // a proxy built before this visit announces nothing: look for it once
    let live = true;
    const probe = client.proxyUrl(id);
    if (probe)
      fetch(probe, { method: "HEAD" }).then(
        (r) => live && r.ok && setProxy((p) => p ?? probe),
        () => {},
      );
    const on = (e: ServerEvent) => {
      if (e.event === "pip") return forwardPip(id, e);
      if (e.event === "channel") return forwardChannel(id, e);
      setSeq((x) => x + 1);
      if (e.event === "patch") {
        setHistory((h) => (h.some((x) => x.seq === e.data.seq) ? h : [...h, e.data]));
        if (refetch.current) clearTimeout(refetch.current);
        refetch.current = setTimeout(
          () =>
            client.project(id).then(
              (s) => setState((prev) => ({ ...s, activity: s.activity ?? prev?.activity })),
              () => {},
            ),
          250,
        );
        return;
      }
      if (e.event === "render") {
        if (e.data.kind === "still") setLastStill(e.data.url);
        // a rebuilt proxy often keeps its URL; a fresh query makes the <video> load it again
        // (a blob: or data: URL is new each time, and a query would break it)
        if (e.data.kind === "proxy")
          setProxy(
            /^(blob|data):/.test(e.data.url)
              ? e.data.url
              : `${e.data.url}${e.data.url.includes("?") ? "&" : "?"}v=${Date.now()}`,
          );
      }
      setState((s) => (s ? applyEvent(s, e) : s));
    };
    const off = client.subscribe(id, on, setConn);
    return () => {
      live = false;
      off();
      if (refetch.current) clearTimeout(refetch.current);
    };
  }, [id, load]);

  return { state, history, error, conn, lastStill, proxy, seq, reload: load };
}

/** true when a keyboard event belongs to a control that uses the key itself */
export function isControlTarget(e: KeyboardEvent): boolean {
  if (e.defaultPrevented) return true;
  const t = e.target as HTMLElement | null;
  if (!t || !(t instanceof HTMLElement)) return false;
  if (t.isContentEditable || t.closest("dialog[open], [role=menu]")) return true;
  // text entry and native pickers own every key
  if (t.closest("textarea, select, input:not([type=checkbox]):not([type=radio]):not([type=button]):not([type=submit])"))
    return true;
  // buttons, links and summaries own Space and Enter
  if ((e.key === " " || e.key === "Enter") && t.closest("button, summary, a[href], input")) return true;
  // composite widgets own the arrows, Home and End
  if (
    /^(Arrow|Home|End)/.test(e.key) &&
    t.closest("input, [role=tab], [role=radio], [role=menuitem], [role=slider], [role=listbox]")
  )
    return true;
  return false;
}

/** throttle a changing string: hand on the newest value at most once per `ms` */
export function useThrottled(value: string, ms: number): string {
  const [out, setOut] = useState(value);
  const last = useRef(0);
  const pending = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    const now = Date.now();
    const wait = Math.max(0, last.current + ms - now);
    if (pending.current) clearTimeout(pending.current);
    pending.current = setTimeout(() => {
      last.current = Date.now();
      setOut(value);
    }, wait);
    return () => {
      if (pending.current) clearTimeout(pending.current);
    };
  }, [value, ms]);
  return out;
}
