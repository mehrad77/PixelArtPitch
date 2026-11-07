// The crew channel: Pip's briefs and answers, the crew's reports and asks ("Behind the scenes"). One store per
// project, loaded once from GET /api/p/:id/channel and kept live by `channel` events on the project stream (useProject
// forwards them here). Messages dedupe by id, so a replay after a reconnect changes nothing.
import { useEffect, useSyncExternalStore } from "react";
import { client } from "./client.ts";
import { ROLE_LABEL } from "./derive.ts";
import { memberOf } from "./human.ts";
import type { ChannelMsg, RoleT, ServerEvent } from "./types.ts";

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

// ---- words ----
export const isPip = (who: string) => who === "pip";
/** the crew member id a sender maps to ("pip", or a CREW id) */
export const memberIdOf = (who: string) => (isPip(who) ? "pip" : memberOf(who as RoleT).id);
export const nameOf = (who: string) =>
  isPip(who)
    ? "Pip"
    : who === "person" || who === "user"
      ? "you"
      : `the ${(ROLE_LABEL[who as RoleT] ?? memberOf(who as RoleT).label).toLowerCase()}`;
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

export const KIND_WORD: Record<ChannelMsg["kind"], string> = {
  brief: "briefed",
  report: "reported",
  ask: "asked",
  answer: "answered",
};

/** "Pip briefed the director", "The animator reported" */
export const headOf = (m: ChannelMsg) =>
  `${cap(nameOf(m.from))} ${KIND_WORD[m.kind]}${m.kind === "brief" || m.kind === "answer" ? ` ${nameOf(m.to)}` : ""}`;

/** the bubble over the sender's face */
export function bubbleOf(m: ChannelMsg): string {
  if (isPip(m.from)) {
    const to = nameOf(m.to).replace(/^the /, "the ");
    return m.kind === "answer" ? `Told ${to}: ${m.text}` : `Asked ${to}: ${m.text}`;
  }
  return m.text;
}

/** one plain sentence for Pip's line: what's happening behind the scenes lately, or "" */
export function channelSummary(msgs: ChannelMsg[], withinMin = 15): string {
  const recent = msgs.filter((m) => Date.now() - Date.parse(m.at) < withinMin * 60_000);
  const last = recent.at(-1);
  if (!last) return "";
  if (isPip(last.from))
    return `I ${last.kind === "answer" ? "answered" : "briefed"} ${nameOf(last.to)}: ${last.text.replace(/\.$/, "")}.`;
  return `${cap(nameOf(last.from))} ${last.kind === "ask" ? "asked me" : "reported"}: ${last.text.replace(/\.$/, "")}.`;
}

/** the messages between Pip and one member */
export const withMember = (msgs: ChannelMsg[], roles: string[]) =>
  msgs.filter((m) => roles.includes(m.from) || roles.includes(m.to));
