// Pip's conversations, one store for the whole tab: the simple view's sheet, Studio's Pip tab and the header drawer can
// show the same conversation at once without each loading it. A project's `pip` events arrive on its existing stream
// (useProject forwards them here); the workspace conversation (no project) listens on /api/events only while shown.
import { useEffect, useRef, useSyncExternalStore } from "react";
import { ApiError } from "./api.ts";
import { client } from "./client.ts";
import { hasVideo, humanStatus, PHASES, phaseOf } from "./human.ts";
import type { PipCard, PipEvent, PipItem, PipSummary, ProjectState, ServerEvent } from "./types.ts";

export const WORKSPACE = "_workspace";
export const keyOf = (project?: string | null) => project || WORKSPACE;

export type Conv = {
  items: PipItem[];
  thinking: boolean;
  loaded: boolean;
  /** the conversation couldn't load (an older server has no Pip) */
  unavailable: string | null;
  /** one calm line under the field: "Pip is still answering", a failed send */
  note: string | null;
  /** how many of Pip's replies the person has seen; more than that puts a dot on the face */
  seen: number;
  listening: boolean;
  model?: string;
  summary?: PipSummary | null;
  /** a prefilled, editable question ("About the animator's work: "), bumped each time someone asks for one */
  draft?: { text: string; n: number };
};

const EMPTY: Conv = {
  items: [],
  thinking: false,
  loaded: false,
  unavailable: null,
  note: null,
  seen: 0,
  listening: false,
};
const convs = new Map<string, Conv>();
const listeners = new Map<string, Set<() => void>>();
const asked = new Set<string>();
const silence = new Map<string, ReturnType<typeof setTimeout>>();
/** how long a turn may stay quiet before the UI says Pip didn't answer */
const SILENCE_MS = 90_000;

const get = (key: string) => convs.get(key) ?? EMPTY;
function set(key: string, fn: (c: Conv) => Conv) {
  convs.set(key, fn(get(key)));
  for (const l of listeners.get(key) ?? []) l();
}
const pipCount = (items: PipItem[]) => items.filter((i) => i.kind === "pip").length;

function load(key: string) {
  if (asked.has(key)) return;
  asked.add(key);
  client.pip(key === WORKSPACE ? undefined : key).then(
    (c) => {
      const items = (c.items ?? []).filter((i) => i.kind !== "thinking");
      set(key, (s) => {
        // events may have landed while the GET was in flight: keep them
        const merged = [...items, ...s.items.filter((x) => !items.some((y) => y.id === x.id))];
        return {
          ...s,
          items: merged,
          loaded: true,
          unavailable: null,
          thinking: c.busy ?? s.thinking,
          summary: c.summary ?? s.summary ?? null,
          model: c.model,
          seen: Math.max(s.seen, pipCount(items)),
        };
      });
    },
    (e: Error) => {
      asked.delete(key);
      set(key, (s) => ({
        ...s,
        loaded: true,
        unavailable:
          e instanceof ApiError && e.status === 404
            ? "Pip isn't on this server yet. Update the studio to ask Pip."
            : `Pip didn't load: ${e.message}.`,
      }));
    },
  );
}

function quiet(key: string, on: boolean) {
  const t = silence.get(key);
  if (t) clearTimeout(t);
  silence.delete(key);
  if (on)
    silence.set(
      key,
      setTimeout(
        () =>
          set(key, (s) =>
            s.thinking ? { ...s, thinking: false, note: "Pip didn't answer. Ask again in a moment." } : s,
          ),
        SILENCE_MS,
      ),
    );
}

const replaceCard = (items: PipItem[], card: PipCard): PipItem[] =>
  items.map((i) =>
    i.kind === "pip" && i.cards.some((c) => c.id === card.id)
      ? { ...i, cards: i.cards.map((c) => (c.id === card.id ? card : c)) }
      : i,
  );

/** fold one `pip` event into its conversation */
export function pipEvent(key: string, e: PipEvent) {
  if (!e || typeof e !== "object") return;
  if (e.type === "thinking") {
    quiet(key, !e.done);
    set(key, (s) => ({ ...s, thinking: !e.done, note: null }));
    return;
  }
  if (e.type === "error") {
    quiet(key, false);
    set(key, (s) => ({ ...s, thinking: false, note: `Pip stopped: ${e.message}` }));
    return;
  }
  if (e.type === "summary") {
    set(key, (s) => ({ ...s, summary: e.summary }));
    return;
  }
  if (e.type === "card") {
    set(key, (s) => ({ ...s, items: replaceCard(s.items, e.card) }));
    return;
  }
  if (e.type === "item") {
    const it = e.item;
    if (it.kind === "thinking") return pipEvent(key, { type: "thinking" });
    if (it.kind === "pip") quiet(key, false);
    set(key, (s) => {
      // the server echoes the person's own line: it replaces the one shown right away
      let items = s.items;
      if (it.kind === "user") {
        const i = items.findIndex((x) => x.kind === "user" && x.id.startsWith("local-") && x.text === it.text);
        if (i >= 0) items = items.filter((_, j) => j !== i);
      }
      items = items.some((x) => x.id === it.id) ? items.map((x) => (x.id === it.id ? it : x)) : [...items, it];
      return it.kind === "pip" ? { ...s, items, thinking: false, note: null } : { ...s, items };
    });
  }
}

/** the hook useProject calls for every event on a project stream */
export function forwardPip(projectId: string, e: ServerEvent) {
  if (e.event === "pip") pipEvent(keyOf(projectId), e.data);
}

let wsRefs = 0;
let wsOff: (() => void) | null = null;
function holdWorkspace() {
  if (wsRefs++ === 0)
    wsOff = client.subscribeWorkspace((e) => {
      if (e.event === "pip") pipEvent(WORKSPACE, e.data);
    });
  return () => {
    if (--wsRefs === 0) {
      wsOff?.();
      wsOff = null;
    }
  };
}

/** a conversation, loaded on first use; the workspace one also holds its event stream while mounted */
export function usePip(project?: string | null): Conv {
  const key = keyOf(project);
  const conv = useSyncExternalStore(
    (cb) => {
      let set = listeners.get(key);
      if (!set) {
        set = new Set();
        listeners.set(key, set);
      }
      set.add(cb);
      return () => set.delete(cb);
    },
    () => get(key),
  );
  useEffect(() => {
    load(key);
    if (key === WORKSPACE) return holdWorkspace();
  }, [key]);
  return conv;
}

export const hasNews = (c: Conv) => pipCount(c.items) > c.seen;
export const markSeen = (project?: string | null) => {
  const key = keyOf(project);
  if (hasNews(get(key))) set(key, (s) => ({ ...s, seen: pipCount(s.items) }));
};
export const setListening = (project: string | null | undefined, on: boolean) => {
  const key = keyOf(project);
  if (get(key).listening !== on) set(key, (s) => ({ ...s, listening: on }));
};

/** ask Pip; resolves false when nothing was sent (busy, or failed), with the reason in `note` */
export async function askPip(project: string | null | undefined, text: string): Promise<boolean> {
  const key = keyOf(project);
  const local: PipItem = { id: `local-${Date.now().toString(36)}`, at: new Date().toISOString(), kind: "user", text };
  set(key, (s) => ({ ...s, items: [...s.items, local], thinking: true, note: null }));
  quiet(key, true);
  try {
    await client.pipAsk(project || undefined, text);
    return true;
  } catch (e) {
    const busy = e instanceof ApiError && e.status === 409;
    // a busy conversation keeps waiting for the turn that is running
    if (!busy) quiet(key, false);
    set(key, (s) => ({
      ...s,
      items: s.items.filter((x) => x.id !== local.id),
      thinking: busy ? s.thinking : false,
      note: busy
        ? "Pip is still answering. Ask again once the reply is in."
        : `Didn't reach Pip: ${(e as Error).message}. Your words are still in the field.`,
    }));
    return false;
  }
}

/** confirm or decline a card; the card shows its next status right away and the `card` event settles it */
export async function decidePip(
  project: string | null | undefined,
  card: PipCard,
  decision: "confirm" | "decline",
  edit?: string,
) {
  const key = keyOf(project);
  const optimistic: PipCard | null =
    card.type === "plan"
      ? { ...card, status: decision === "confirm" ? "running" : "declined" }
      : card.type === "form" && decision === "confirm"
        ? { ...card, status: "submitted" }
        : null;
  if (optimistic) set(key, (s) => ({ ...s, items: replaceCard(s.items, optimistic) }));
  try {
    const next = await client.pipCard(card.id, {
      ...(project ? { project } : {}),
      decision,
      ...(edit != null ? { edit } : {}),
    });
    if (next) set(key, (s) => ({ ...s, items: replaceCard(s.items, next) }));
  } catch (e) {
    set(key, (s) => ({ ...s, items: replaceCard(s.items, card) }));
    throw e;
  }
}

// ---- the default path: ask Pip, not the crew member ----
const OPEN_EVENT = "pap:pip-open";
/** open Pip's conversation with a draft the person can edit and send; whoever shows Pip opens it */
export function askPipAbout(project: string | null | undefined, text: string) {
  const key = keyOf(project);
  set(key, (s) => ({ ...s, draft: { text, n: (s.draft?.n ?? 0) + 1 } }));
  window.dispatchEvent(new CustomEvent(OPEN_EVENT, { detail: { key } }));
}
/** run `fn` when someone asks to open this conversation */
export function usePipOpenRequest(project: string | null | undefined, fn: () => void) {
  const key = keyOf(project);
  const ref = useRef(fn);
  ref.current = fn;
  useEffect(() => {
    const on = (e: Event) => {
      if ((e as CustomEvent<{ key: string }>).detail?.key === key) ref.current();
    };
    window.addEventListener(OPEN_EVENT, on);
    return () => window.removeEventListener(OPEN_EVENT, on);
  }, [key]);
}

// ---- direct controls: one deliberate step away, and remembered once opened ----
const DIRECT = "pap.direct";
export function directOpened(): boolean {
  try {
    return sessionStorage.getItem(DIRECT) === "1" || localStorage.getItem(DIRECT) === "1";
  } catch {
    return false;
  }
}
export function rememberDirect(on: boolean) {
  try {
    if (on) localStorage.setItem(DIRECT, "1");
    else localStorage.removeItem(DIRECT);
  } catch {}
}

// ---- Pip's face and words ----
export type PipMood = "idle" | "listening" | "thinking" | "happy" | "sorry";
export function pipMood(c: Conv, state: ProjectState | null): PipMood {
  if (c.thinking) return "thinking";
  const last = [...c.items].reverse().find((i) => i.kind !== "thinking");
  if (last?.kind === "pip" && last.cards.some((k) => k.type === "cant" || (k.type === "plan" && k.status === "failed")))
    return "sorry";
  if (state && humanStatus(state).tone === "problem") return "sorry";
  if (c.listening) return "listening";
  if (last?.kind === "pip" && last.cards.some((k) => (k.type === "plan" || k.type === "form") && k.status === "done"))
    return "happy";
  if (state && phaseOf(state) >= PHASES.length) return "happy";
  return "idle";
}

/** 2–4 things to ask, from where the project is; none of them sends itself */
export function suggestions(state: ProjectState | null): string[] {
  if (!state) return ["Start a new video", "What's each project doing?"];
  if (phaseOf(state) >= PHASES.length && hasVideo(state))
    return ["Subtitles in another language", "Change something", "Make another like this"];
  const st = humanStatus(state);
  if (st.tone === "problem") return ["What went wrong?", "What can I do about it?"];
  if (st.tone === "needs") return ["What do they need from me?", "Explain the choice"];
  if (!state.tasks.some((t) => t.startedAt)) return ["What happens when I start?", "How much will it cost?"];
  return ["What's the crew doing?", "How long until it's done?", "Change something"];
}

/** save the person's correction to Pip's summary; Pip uses it from the next turn */
export async function saveSummary(project: string | null | undefined, text: string) {
  const key = keyOf(project);
  const next = await client.pipSummary(project || undefined, text);
  set(key, (s) => ({ ...s, summary: next ?? (s.summary ? { ...s.summary, text } : s.summary) }));
}

// ---- slash commands ----
export const COMMANDS: { name: string; hint: string; example?: string; arg?: boolean }[] = [
  { name: "/undo", hint: "Undo the last change" },
  { name: "/budget", hint: "Change the budget cap", example: "/budget 10", arg: true },
  { name: "/why", hint: "Why Pip answered that" },
  { name: "/compact", hint: "Fold older messages into Pip's summary" },
  { name: "/context", hint: "What's in Pip's memory right now" },
];
