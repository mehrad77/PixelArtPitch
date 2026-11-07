// Thought bubbles over the crew's faces: when a member's step starts, finishes, fails or waits on you (and when Pip
// thinks or answers), a few plain words float over its face for about four seconds. Only live changes count, never
// the history on load. One bubble per face, three at most (the oldest goes first); they are laid out so they never
// overlap each other or leave the row, stacking upward when there's no room. Hover or focus on a face holds its
// bubble. Bubbles are decoration (aria-hidden); one polite region says what changed, at most every few seconds.
import { type RefObject, useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { bubbleOf, memberIdOf, useChannelLive } from "../lib/channel.ts";
import { CREW } from "../lib/human.ts";
import type { Conv } from "../lib/pip.ts";
import { pipThought, snapshot, taskChanges } from "../lib/thoughts.ts";
import type { ChannelMsg, ProjectState, Task } from "../lib/types.ts";
import "./Thoughts.css";

const SHOW_MS = 4000;
const FADE_MS = 300;
const MAX = 3;
const GAP = 6;

export type Bubble = { id: number; member: string; text: string; left: number; leaving: boolean };
const nameOf = (member: string) => (member === "pip" ? "Pip" : (CREW.find((m) => m.id === member)?.label ?? member));

export type ThoughtOpts = {
  /** whose face a task's words float over (the instance row keys them by instance) */
  taskKey?: (t: Task) => string;
  /** whose face a channel message floats over, and its words; null drops it */
  msgKey?: (m: ChannelMsg) => { key: string; text: string } | null;
  /** the face's name in the region; the region is fed by `say` alone when `announce` is false */
  announce?: boolean;
};

export function useThoughts(
  state: ProjectState | null,
  pip?: Conv | null,
  channelOf?: string | null,
  opts: ThoughtOpts = {},
) {
  const optsRef = useRef(opts);
  optsRef.current = opts;
  const [bubbles, setBubbles] = useState<Bubble[]>([]);
  const [live, setLive] = useState("");
  const held = useRef(new Set<string>());
  const queue = useRef<string[]>([]);
  const seq = useRef(0);

  const push = useCallback((member: string, text: string) => {
    if (!text) return;
    const id = ++seq.current;
    if (optsRef.current.announce !== false) queue.current.push(`${nameOf(member)}: ${text}`);
    setBubbles((bs) => {
      const rest = bs.filter((b) => b.member !== member);
      const next = [...rest, { id, member, text, left: SHOW_MS, leaving: false }];
      return next.slice(-MAX);
    });
  }, []);

  // the crew: diff every new state against the last one seen; the first one is the baseline
  const prev = useRef<Map<string, Task> | null>(null);
  const tasks = state?.tasks;
  // biome-ignore lint/correctness/useExhaustiveDependencies: runs when the tasks change
  useEffect(() => {
    if (!state || !tasks) return;
    if (!prev.current) {
      prev.current = snapshot(tasks);
      return;
    }
    const changes = taskChanges(prev.current, state, optsRef.current.taskKey);
    prev.current = snapshot(tasks);
    for (const c of changes) push(c.member, c.text);
  }, [tasks, push]);

  // Pip: thinking, then what came back; the conversation loading isn't news
  const last = pip ? [...pip.items].reverse().find((i) => i.kind === "pip") : undefined;
  const pipKey = pip
    ? `${pip.thinking}|${last?.id ?? ""}|${last?.kind === "pip" ? last.cards.map((c) => ("status" in c ? c.status : "")).join(",") : ""}`
    : "";
  const pipPrev = useRef<{ key: string; loaded: boolean } | null>(null);
  const loaded = !!pip?.loaded;
  // biome-ignore lint/correctness/useExhaustiveDependencies: keyed on what Pip shows
  useEffect(() => {
    if (!pip) return;
    const was = pipPrev.current;
    pipPrev.current = { key: pipKey, loaded: pip.loaded };
    if (!was?.loaded || was.key === pipKey) return;
    push("pip", pipThought(pip.thinking, last));
  }, [pipKey, loaded]);

  // the crew channel: a brief, report, ask or answer floats over the sender's face
  const onChannel = useCallback(
    (m: ChannelMsg) => {
      const at = optsRef.current.msgKey ? optsRef.current.msgKey(m) : { key: memberIdOf(m.from), text: bubbleOf(m) };
      if (at) push(at.key, at.text);
    },
    [push],
  );
  useChannelLive(channelOf, onChannel);

  // the clock: held bubbles wait; the rest count down, fade, then go
  const any = bubbles.length > 0;
  useEffect(() => {
    if (!any) return;
    const t = setInterval(
      () =>
        setBubbles((bs) =>
          bs
            .map((b) => {
              if (held.current.has(b.member) && !b.leaving) return b;
              const left = b.left - 250;
              if (left > 0) return { ...b, left };
              return b.leaving ? null : { ...b, left: FADE_MS, leaving: true };
            })
            .filter((b): b is Bubble => !!b),
        ),
      250,
    );
    return () => clearInterval(t);
  }, [any]);

  // one combined announcement every few seconds at most
  useEffect(() => {
    const t = setInterval(() => {
      if (!queue.current.length) return;
      setLive(
        `${queue.current
          .slice(-3)
          .map((l) => l.replace(/\.$/, ""))
          .join(". ")}.`,
      );
      queue.current = [];
    }, 5000);
    return () => clearInterval(t);
  }, []);

  /** sentences for the region only (the instance row's spawns, returns and leaves), no bubble */
  const say = useCallback((lines: string[]) => {
    queue.current.push(...lines);
  }, []);

  const hold = useCallback((member: string, on: boolean) => {
    if (on) held.current.add(member);
    else held.current.delete(member);
  }, []);

  return { bubbles, hold, live, push, say };
}

type Spot = { x: number; y: number; tail: number; rtl: boolean; w: number };

/** the bubbles, laid out over the faces inside `box` (each face carries data-thought-anchor="<member>") */
export function ThoughtLayer({ bubbles, box }: { bubbles: Bubble[]; box: RefObject<HTMLElement | null> }) {
  const refs = useRef(new Map<number, HTMLDivElement>());
  const [spots, setSpots] = useState<Record<number, Spot>>({});
  const key = bubbles.map((b) => `${b.id}`).join(",");
  // biome-ignore lint/correctness/useExhaustiveDependencies: lays out again when the set of bubbles changes
  useLayoutEffect(() => {
    const el = box.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    // the row, kept inside the viewport too
    const lo = Math.max(0, 8 - rect.left);
    const W = Math.min(rect.width, document.documentElement.clientWidth - rect.left - 8);
    const rtl = getComputedStyle(el).direction === "rtl";
    const items = bubbles
      .map((b) => {
        const node = refs.current.get(b.id);
        const face = el.querySelector<HTMLElement>(`[data-thought-anchor="${b.member}"]`);
        if (!node || !face) return null;
        const f = face.getBoundingClientRect();
        return { b, w: Math.min(node.offsetWidth, W - lo), h: node.offsetHeight, cx: f.left + f.width / 2 - rect.left };
      })
      .filter((x): x is NonNullable<typeof x> => !!x)
      .sort((a, z) => a.cx - z.cx);
    // left to right; a bubble that can't fit beside the last one on a tier goes up a tier
    const tierRight: number[] = [];
    const tierH: number[] = [];
    const placed: { id: number; x: number; tier: number; w: number; cx: number }[] = [];
    for (const it of items) {
      let x = Math.max(lo, Math.min(W - it.w, it.cx - it.w / 2));
      let tier = 0;
      for (;;) {
        const right = tierRight[tier] ?? Number.NEGATIVE_INFINITY;
        if (x >= right + GAP) break;
        const shifted = right + GAP;
        if (shifted + it.w <= W) {
          x = shifted;
          break;
        }
        tier++;
        x = Math.max(lo, Math.min(W - it.w, it.cx - it.w / 2));
      }
      tierRight[tier] = x + it.w;
      tierH[tier] = Math.max(tierH[tier] ?? 0, it.h);
      placed.push({ id: it.b.id, x, tier, w: it.w, cx: it.cx });
    }
    const next: Record<number, Spot> = {};
    for (const p of placed) {
      let y = 0;
      for (let t = 0; t < p.tier; t++) y += (tierH[t] ?? 0) + GAP + 10;
      const tail = Math.max(14, Math.min(p.w - 14, p.cx - p.x));
      next[p.id] = { x: rtl ? rect.width - p.x - p.w : p.x, y, tail: rtl ? p.w - tail : tail, rtl, w: p.w };
    }
    setSpots((s) => (JSON.stringify(s) === JSON.stringify(next) ? s : next));
  }, [key]);

  return (
    <div className="thoughts" aria-hidden="true">
      {bubbles.map((b) => {
        const s = spots[b.id];
        return (
          <div
            key={b.id}
            ref={(n) => {
              if (n) refs.current.set(b.id, n);
              else refs.current.delete(b.id);
            }}
            className="thought"
            data-leaving={b.leaving ? "" : undefined}
            data-placed={s ? "" : undefined}
            style={s ? { insetInlineStart: `${s.x}px`, insetBlockEnd: `calc(100% + ${s.y + 12}px)` } : undefined}
          >
            <span className="thought-text" dir="auto">
              {b.text}
            </span>
            {s && (
              <>
                <span className="thought-dot" data-n="1" style={{ insetInlineStart: `${s.tail}px` }} />
                <span className="thought-dot" data-n="2" style={{ insetInlineStart: `${s.tail}px` }} />
              </>
            )}
          </div>
        );
      })}
    </div>
  );
}
