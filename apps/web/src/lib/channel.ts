// The crew channel: Pip's briefs and answers, the crew's reports and asks ("Behind the scenes"). One store per
// project, loaded once from GET /api/p/:id/channel and kept live by `channel` events on the project stream (useProject
// forwards them here). Messages dedupe by id, so a replay after a reconnect changes nothing.
import { useEffect, useSyncExternalStore } from "react";
import { client } from "./client.ts";
import type { ChannelMsg, ServerEvent } from "./types.ts";

type Store = { msgs: ChannelMsg[]; loaded: boolean };
const EMPTY: Store = { msgs: [], loaded: false };
const stores = new Map<string, Store>();
const listeners = new Map<string, Set<() => void>>();
const live = new Map<string, Set<(m: ChannelMsg) => void>>();
const asked = new Set<string>();

const get = (id: string) => stores.get(id) ?? EMPTY;
function put(id: string, next: Store) {
  stores.set(id, next);
  for (const l of listeners.get(id) ?? []) l();
}
const byTime = (a: ChannelMsg, b: ChannelMsg) => Date.parse(a.at) - Date.parse(b.at);
function merge(list: ChannelMsg[], more: ChannelMsg[]) {
  const seen = new Map(list.map((m) => [m.id, m]));
  for (const m of more) seen.set(m.id, m);
  return [...seen.values()].sort(byTime);
}

function load(id: string) {
  if (asked.has(id)) return;
  asked.add(id);
  client.channel(id).then(
    (msgs) => put(id, { msgs: merge(get(id).msgs, msgs), loaded: true }),
    () => {
      asked.delete(id);
      put(id, { ...get(id), loaded: true });
    },
  );
}

/** called from useProject for every event on a project stream */
export function forwardChannel(projectId: string, e: ServerEvent) {
  if (e.event !== "channel") return;
  const m = e.data;
  const had = get(projectId).msgs.some((x) => x.id === m.id);
  put(projectId, { ...get(projectId), msgs: merge(get(projectId).msgs, [m]) });
  if (!had) for (const l of live.get(projectId) ?? []) l(m);
}

export function useChannel(projectId: string | null | undefined): ChannelMsg[] {
  const id = projectId ?? "";
  const s = useSyncExternalStore(
    (cb) => {
      if (!id) return () => {};
      let set = listeners.get(id);
      if (!set) {
        set = new Set();
        listeners.set(id, set);
      }
      set.add(cb);
      return () => set.delete(cb);
    },
    () => (id ? get(id) : EMPTY),
  );
  useEffect(() => {
    if (id) load(id);
  }, [id]);
  return s.msgs;
}

/** run `fn` for each message that arrives live (never for history) */
export function useChannelLive(projectId: string | null | undefined, fn: (m: ChannelMsg) => void) {
  useEffect(() => {
    if (!projectId) return;
    let set = live.get(projectId);
    if (!set) {
      set = new Set();
      live.set(projectId, set);
    }
    const cb = (m: ChannelMsg) => fn(m);
    set.add(cb);
    return () => {
      set.delete(cb);
    };
  }, [projectId, fn]);
}

// the words live apart (pure, no client), so node tests can read them
export * from "./channel-words.ts";
