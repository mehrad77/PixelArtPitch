// Pip's conversations, one store for the whole tab: the simple view's sheet, Studio's Pip tab and the header drawer can
// show the same conversation at once without each loading it. A project's `pip` events arrive on its existing stream
// (useProject forwards them here); the workspace conversation (no project) listens on /api/events only while shown.
import { useEffect, useRef, useSyncExternalStore } from "react";
import { ApiError } from "./api.ts";
import { findCard, laterCard, revertCard } from "./cards.ts";
import { client } from "./client.ts";
import { hasVersionIdle, humanStatus } from "./human.ts";
import { navigate } from "./router.tsx";
import { freshStage } from "./stage.ts";
import type {
  BriefFieldKey,
  PipCard,
  PipEvent,
  PipEventOnWire,
  PipItem,
  PipSummary,
  ProjectState,
  ServerEvent,
} from "./types.ts";

export const WORKSPACE = "_workspace";
/** /new before its first send: a conversation that lives only here (the draft is made on the first send or drop) */
export const NEW_TALK = "_new";
export const keyOf = (project?: string | null) => project || WORKSPACE;
/** a draft's conversation is keyed by the draft id (PIP-ORCHESTRATION §3.1: "draft_…") */
export const isDraftKey = (key: string) => key.startsWith("draft_");
/** what the client needs to address a conversation */
const target = (key: string): { project?: string; draft?: string } =>
  key === WORKSPACE || key === NEW_TALK ? {} : isDraftKey(key) ? { draft: key } : { project: key };

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
  /** words put in the field (the /new examples, the steer popover), bumped each time; the field takes them once */
  draft?: { text: string; n: number };
  /**
   * "Ask Pip about this": what the next message is about, shown as a clearable chip in the field ("About the moth ×")
   * and never as text the person has to edit around. Sent as the turn's `about` (an instance) and as an "About …:"
   * lead the server strips before it matches commands; cleared once a message goes.
   */
  about?: { label: string; instance?: string; n: number };
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
  if (key === NEW_TALK) {
    set(key, (s) => ({ ...s, loaded: true }));
    return;
  }
  const t = target(key);
  client.pip(t.project, t.draft ? { draft: t.draft } : undefined).then(
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
      // a draft that is gone (started elsewhere, or removed): the stage says so, with "Start again"
      if (isDraftKey(key) && e instanceof ApiError && e.status === 404 && e.code !== "no_route") {
        set(key, (s) => ({ ...s, loaded: true }));
        return;
      }
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
      ? { ...i, cards: i.cards.map((c) => (c.id === card.id ? keepCrew(c, card) : c)) }
      : i,
  );
/** a card's update keeps who it named: a "done" that carries only its result still shows the Director it re-planned
 * with (its `whoInstances` and `revision` stay when the update leaves them out) */
function keepCrew(prev: PipCard, next: PipCard): PipCard {
  if (prev.type !== "plan" || next.type !== "plan") return next;
  return {
    ...next,
    ...(next.whoInstances || !prev.whoInstances ? {} : { whoInstances: prev.whoInstances }),
    ...(next.revision || !prev.revision ? {} : { revision: prev.revision }),
    ...(next.who.length || !prev.who.length ? {} : { who: prev.who }),
  };
}

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
    landed(e.card);
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
      // a draft's turns stream here too, each event naming its draft
      if (e.event === "pip") pipEvent((e.data as PipEventOnWire).draft || WORKSPACE, e.data);
    });
  return () => {
    if (--wsRefs === 0) {
      wsOff?.();
      wsOff = null;
    }
  };
}

/** a conversation as it stands, outside React (a press that resends the last message) */
export const peekPip = (project?: string | null): Conv => get(keyOf(project));

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
    // a fresh /new holds the stream too: the first send makes the draft and asks at once, and a rules-mode reply can
    // land before the stage re-renders under the draft's key; its events are kept by draft id either way
    if (key === WORKSPACE || key === NEW_TALK || isDraftKey(key)) return holdWorkspace();
  }, [key]);
  return conv;
}

/** Start moved a draft's conversation to its project: show it there at once, before the project's GET lands */
export function adoptConv(from: string, to: string) {
  const c = convs.get(from);
  if (!c || from === to) return;
  set(to, (s) => {
    const items = [...c.items, ...s.items.filter((x) => !c.items.some((y) => y.id === x.id))];
    return { ...s, ...c, items, seen: Math.max(s.seen, c.seen), draft: s.draft };
  });
}
/** seed a conversation with what the server already returned (POST /api/drafts gives Pip's first item) */
export function seedConv(key: string, items: PipItem[]) {
  asked.add(key);
  set(key, (s) => ({
    ...s,
    loaded: true,
    items: [...items, ...s.items.filter((x) => !items.some((y) => y.id === x.id))],
    seen: Math.max(s.seen, pipCount(items)),
  }));
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
export async function askPip(
  project: string | null | undefined,
  text: string,
  opts: { files?: string[]; about?: { instance: string } } = {},
): Promise<boolean> {
  const key = keyOf(project);
  const local: PipItem = {
    id: `local-${Date.now().toString(36)}`,
    at: new Date().toISOString(),
    kind: "user",
    text,
    ...(opts.files?.length ? { files: opts.files } : {}),
  };
  set(key, (s) => ({ ...s, items: [...s.items, local], thinking: true, note: null }));
  quiet(key, true);
  try {
    const t = target(key);
    await client.pipAsk(t.project, text, {
      ...(t.draft ? { draft: t.draft } : {}),
      ...(opts.about ? { about: opts.about } : {}),
    });
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
  values?: Partial<Record<BriefFieldKey, unknown>>,
) {
  const key = keyOf(project);
  const optimistic: PipCard | null =
    card.type === "plan"
      ? { ...card, status: decision === "confirm" ? "running" : "declined" }
      : card.type === "form" && decision === "confirm"
        ? { ...card, status: "submitted" }
        : null;
  if (optimistic) set(key, (s) => ({ ...s, items: replaceCard(s.items, optimistic) }));
  if (decision === "confirm") pressed.add(card.id);
  try {
    const next = await client.pipCard(card.id, {
      ...target(key),
      decision,
      ...(edit != null ? { edit } : {}),
      ...(values ? { values } : {}),
    });
    // the card's own events can beat this reply (a fork or a rules-mode form finishes in milliseconds): a reply never
    // moves a card back from where its events already took it ("done" stays done, not "running" or "submitted")
    if (next) {
      set(key, (s) => {
        const now = findCard(s.items, next.id);
        return laterCard(now, next) === now ? s : { ...s, items: replaceCard(s.items, next) };
      });
      landed(next);
    }
  } catch (e) {
    pressed.delete(card.id);
    // back to how it was, unless its events moved it on meanwhile (a 409 "already decided" after its done event)
    set(key, (s) => {
      const back = revertCard(findCard(s.items, card.id), optimistic, card);
      return back ? { ...s, items: replaceCard(s.items, back) } : s;
    });
    throw e;
  }
}

/** the cards the person confirmed in this tab: only those may take the page somewhere when they finish */
const pressed = new Set<string>();
/** a "Make another like this" card the person confirmed here ends on the new draft's stage, as Start ends on the
 * project's; once, whether its event or the reply says so first */
function landed(card: PipCard) {
  if (card.type !== "plan" || card.status !== "done" || !card.result?.draftId || !pressed.has(card.id)) return;
  pressed.delete(card.id);
  openDraft(card.result.draftId);
}

/** "Make another like this" (PIP-JOURNEY §3.6): a draft that copies the project's settings, then /new/:draftId */
export async function makeAnother(projectId: string): Promise<string> {
  const { draft, items } = await client.createDraft(projectId);
  seedConv(draft.id, items);
  openDraft(draft.id);
  return draft.id;
}
/** go to a draft's stage: a new stage, since the one on screen may still hold the project it copies */
export function openDraft(draftId: string) {
  freshStage();
  navigate(`/new/${encodeURIComponent(draftId)}`);
}
/** the same, from a chip in a conversation: a failure is a calm line under that conversation's field */
export async function makeAnotherFrom(project: string | null | undefined) {
  const key = keyOf(project);
  if (key === WORKSPACE || key === NEW_TALK || isDraftKey(key)) return;
  set(key, (s) => ({ ...s, note: null }));
  try {
    await makeAnother(key);
  } catch (e) {
    const fix = e instanceof ApiError && e.fix ? ` ${e.fix}` : "";
    set(key, (s) => ({ ...s, note: `Didn't start another one: ${(e as Error).message}.${fix}` }));
  }
}
export const MAKE_ANOTHER = "Make another like this";

// ---- the default path: ask Pip, not the crew member ----
const OPEN_EVENT = "pap:pip-open";
/** one counter for every fill and scope, so a consumed draft's number never comes back */
let bumps = 0;
/**
 * Open Pip's conversation scoped to something ("the moth", "the writer's work"): the field shows it as a chip the
 * person can clear, and the message they type goes with it. Whoever shows Pip opens it.
 */
export function askPipAbout(project: string | null | undefined, about: { label: string; instance?: string }) {
  const key = keyOf(project);
  set(key, (s) => ({ ...s, about: { ...about, n: ++bumps } }));
  window.dispatchEvent(new CustomEvent(OPEN_EVENT, { detail: { key } }));
}
/** clear the scope chip (its ×, or a sent message) */
export function clearAbout(project: string | null | undefined) {
  const key = keyOf(project);
  if (get(key).about) set(key, (s) => ({ ...s, about: undefined }));
}
export { scoped, splitAbout } from "./about.ts";
/** put words in a conversation's field without opening anything (the /new examples: they fill, never send) */
export function fillPip(project: string | null | undefined, text: string) {
  const key = keyOf(project);
  set(key, (s) => ({ ...s, draft: { text, n: ++bumps } }));
}
/** words for the field that open Pip too (the steer popover's "At 0:12 (scene 2): too dark") */
export function openPipWith(project: string | null | undefined, text: string) {
  fillPip(project, text);
  window.dispatchEvent(new CustomEvent(OPEN_EVENT, { detail: { key: keyOf(project) } }));
}
/** the field took its words: they are gone from the store, so a field that mounts later doesn't fill again */
export function consumeDraft(project: string | null | undefined, n: number) {
  const key = keyOf(project);
  if (get(key).draft?.n === n) set(key, (s) => ({ ...s, draft: undefined }));
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
/** `conducting` is never derived here: the crew row sets it while Pip brings members in (PIP-JOURNEY §3.2) */
export type PipMood = "idle" | "listening" | "thinking" | "happy" | "sorry" | "conducting";
export function pipMood(c: Conv, state: ProjectState | null): PipMood {
  if (c.thinking) return "thinking";
  const last = [...c.items].reverse().find((i) => i.kind !== "thinking");
  if (last?.kind === "pip" && last.cards.some((k) => k.type === "cant" || (k.type === "plan" && k.status === "failed")))
    return "sorry";
  if (state && humanStatus(state).tone === "problem") return "sorry";
  if (c.listening) return "listening";
  if (last?.kind === "pip" && last.cards.some((k) => (k.type === "plan" || k.type === "form") && k.status === "done"))
    return "happy";
  if (state && hasVersionIdle(state)) return "happy";
  return "idle";
}

/** 2–4 things to ask, from where the project is; none of them sends itself */
export function suggestions(state: ProjectState | null): string[] {
  if (!state) return ["Start a new video", "What's each project doing?"];
  // a version and no crew making the next one
  if (hasVersionIdle(state)) return ["Subtitles in another language", "Change something", MAKE_ANOTHER];
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
