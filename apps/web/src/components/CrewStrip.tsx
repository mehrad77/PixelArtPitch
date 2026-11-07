// The crew as faces: one flat disc per department, each in its own category hue, with a two-glyph face in the mono
// face. The face says the state: it blinks and glances while working ("o o" → "- -" → "> <"), smiles when done
// ("^ ^"), looks up when it waits on you, and goes "x x" when it is stuck. Glyph swaps happen in whole steps, at most
// about once a second; the glance and the working ring move only without reduced motion. Names stay plain
// ("Artist, working"). Pressing a face opens one line about it and its last picture.
import { Popover } from "@shabboo/kit/react";
import {
  type AnimationEvent,
  type CSSProperties,
  createContext,
  type ReactNode,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { leadTask } from "../lib/derive.ts";
import { CREW, type Member, memberOf, plainTitle, problemOf, visibleTasks } from "../lib/human.ts";
import {
  bubbleOfReason,
  CONDUCT_MS,
  crewGroups,
  FINISH_HOLD_MS,
  ghostLine,
  ghostWord,
  hasInstances,
  instanceNews,
  instanceOfMsg,
  qualifier,
  ROLE_GLYPH,
  ROLE_HUE,
} from "../lib/instances.ts";
import { askPipAbout, usePip } from "../lib/pip.ts";
import type { ConnState, Instance, ProjectState, Role, Task } from "../lib/types.ts";
import { AgentActivity } from "./AgentActivity.tsx";
import { useReducedMotion } from "./PipFace.tsx";
import { ThoughtLayer, useThoughts } from "./Thoughts.tsx";
import "./CrewStrip.css";

export type Mood = "idle" | "working" | "needs" | "stuck" | "done" | "stopped" | "later";
export const MOOD_WORD: Record<Mood, string> = {
  idle: "waiting",
  stopped: "stopped",
  working: "working",
  needs: "waiting for you",
  stuck: "stuck",
  done: "done",
  later: "not started",
};
/** each member's calm face */
const CALM: Record<string, string> = {
  producer: "o o",
  writer: "• •",
  artist: "* *",
  animator: "o O",
  sound: "~ ~",
  editor: "= =",
  reviewer: "° °",
};
/** each member's one small mark of the trade, drawn in whole cells ("#" filled) inside its own disc, under the eyes
    and in the eyes' ink: the Producer's bow tie, the Writer's pencil, the Artist's palette, the Animator's play
    button, the Sound's note, the Editor's scissors, the Reviewer's magnifier. Pip's crown is the only mark outside. */
const DETAIL: Record<string, string[]> = {
  producer: ["#...#", "#####", "#...#"],
  writer: ["#.####..", "#.######", "#.####.."],
  artist: [".####.", "##.###", "######", ".###.."],
  animator: ["#...", "##..", "###.", "##..", "#..."],
  sound: ["..##", "..#.", "..#.", "###.", "###."],
  editor: ["##.##", "##.##", ".#.#.", "..#..", ".#.#."],
  reviewer: [".##..", "#..#.", "#..#.", ".##..", "...##"],
};
/** one rect per run of filled cells in a row */
const cellsPath = (rows: string[]) =>
  rows
    .flatMap((row, y) => [...row.matchAll(/#+/g)].map((m) => `M${m.index} ${y}h${m[0].length}v1H${m.index}z`))
    .join("");
const DETAIL_PATH = Object.fromEntries(Object.entries(DETAIL).map(([id, rows]) => [id, cellsPath(rows)]));

/** working: look, blink, look, think */
const WORK_FRAMES = (calm: string) => [calm, calm, "- -", calm, "> <"];

export function moodOf(tasks: Task[], stuckIds: Set<string>): { mood: Mood; lead?: Task } {
  const lead = leadTask(tasks);
  if (!lead) return { mood: "later" };
  if (lead.status === "failed") return { mood: stuckIds.has(lead.id) ? "stuck" : "idle", lead };
  if (lead.status === "waiting_user") return { mood: "needs", lead };
  if (lead.status === "working") return { mood: "working", lead };
  if (lead.status === "done" && tasks.every((t) => t.status === "done" || t.status === "cancelled"))
    return { mood: "done", lead };
  return { mood: "idle", lead };
}

/** each member's tasks (retries the crew recovered left out), its mood and the one line about it */
export function crewRows(state: ProjectState) {
  const p = problemOf(state);
  const stuck = new Set(p ? [p.taskId] : []);
  return CREW.map((m) => {
    const tasks = visibleTasks(state.tasks.filter((t) => m.roles.includes(t.role)));
    const img = [...tasks].reverse().find((t) => t.lastImage)?.lastImage;
    const { mood, lead } = moodOf(tasks, stuck);
    const line =
      mood === "working" && lead
        ? plainTitle(lead, state)
        : mood === "needs"
          ? "Waiting for you."
          : mood === "stuck"
            ? (p?.text ?? "Stuck.")
            : mood === "done"
              ? "Done for now."
              : mood === "later"
                ? "Joins later."
                : "Waiting for the others.";
    return { m, img, mood, lead, line, tasks };
  });
}

/** the shared clock for blinking faces: a whole step every 900 ms */
export function useStep(on: boolean) {
  const [n, setN] = useState(0);
  useEffect(() => {
    if (!on) return;
    const t = setInterval(() => setN((x) => x + 1), 900);
    return () => clearInterval(t);
  }, [on]);
  return n;
}

export function CrewFace({
  member,
  role,
  mood,
  step = 0,
  size = "md",
}: {
  member: Member;
  /** an instance's role: its own calm glyphs and hue (PIP-JOURNEY §3.1); the trade mark stays the member's */
  role?: Role;
  mood: Mood;
  step?: number;
  size?: "md" | "lg" | "hero";
}) {
  const calm = (role && ROLE_GLYPH[role]) || CALM[member.id] || "o o";
  const hue = role ? ROLE_HUE[role] : member.hue;
  const frames = WORK_FRAMES(calm);
  const glyphs =
    mood === "working"
      ? frames[step % frames.length]
      : mood === "done"
        ? "^ ^"
        : mood === "stopped"
          ? "– –"
          : mood === "stuck"
            ? "x x"
            : mood === "needs"
              ? "' '"
              : mood === "later"
                ? "· ·"
                : calm;
  // the glance: eyes shift a cell to one side on some working steps
  const glance = mood === "working" ? (["", "start", "", "end", ""] as const)[step % 5] : mood === "needs" ? "up" : "";
  const detail = DETAIL[member.id];
  return (
    <span
      className="crew-face"
      data-mood={mood}
      data-size={size}
      data-glance={glance || undefined}
      data-role={role}
      style={{ "--face-hue": `var(--category-${hue})` } as CSSProperties}
      aria-hidden="true"
    >
      <span className="crew-face-glyphs">{glyphs}</span>
      {(mood === "done" || mood === "stopped") && (
        <span className="crew-face-end" data-end={mood}>
          {mood === "done" ? "✓" : "■"}
        </span>
      )}
      {detail && (
        <span
          className="crew-face-detail"
          data-detail={member.id}
          style={{ "--cells": detail[0].length } as CSSProperties}
        >
          <svg
            viewBox={`0 0 ${detail[0].length} ${detail.length}`}
            shapeRendering="crispEdges"
            aria-hidden="true"
            focusable="false"
          >
            <path fill="currentColor" d={DETAIL_PATH[member.id]} />
          </svg>
        </span>
      )}
    </span>
  );
}

type StripProps = {
  projectId: string;
  /** the stream's state: the row takes a new baseline when it comes back to open, so a reconnect never animates */
  conn?: ConnState;
  state: ProjectState;
  /** first in the row: Pip, the host */
  lead?: ReactNode;
  /** whose conversation Pip's bubbles follow */
  pipProject?: string;
};

/** the crew row: crew instances once there are any (PIP-ORCHESTRATION §2), the departments otherwise */
export { hasInstances };
export function CrewStrip(props: StripProps) {
  return hasInstances(props.state) ? <InstanceStrip {...props} /> : <DepartmentStrip {...props} />;
}

function DepartmentStrip({ projectId, state, lead, pipProject }: StripProps) {
  const rows = crewRows(state);
  const step = useStep(rows.some((r) => r.mood === "working"));
  const pip = usePip(pipProject ?? projectId);
  const thoughts = useThoughts(state, lead ? pip : null, projectId);
  const box = useRef<HTMLElement>(null);
  // hidden by default: the activity view opens only when the person asks for it from a face
  const [watching, setWatching] = useState<string | null>(null);
  const watch = (id: string) => {
    document.getElementById(`crew-face-${id}`)?.hidePopover?.();
    setWatching(id);
  };
  const stopWatching = () => {
    const id = watching;
    setWatching(null);
    if (id) requestAnimationFrame(() => document.getElementById(`crew-face-btn-${id}`)?.focus());
  };
  const holds = (id: string) => ({
    onMouseEnter: () => thoughts.hold(id, true),
    onMouseLeave: () => thoughts.hold(id, false),
    onFocus: () => thoughts.hold(id, true),
    onBlur: () => thoughts.hold(id, false),
  });
  return (
    <section className="crew-strip" aria-labelledby="crew-strip-h" ref={box}>
      <h2 id="crew-strip-h" className="visually-hidden">
        The crew
      </h2>
      <ul className="crew-faces">
        {lead && (
          <li className="crew-lead" data-thought-anchor="pip" {...holds("pip")}>
            {lead}
          </li>
        )}
        {rows.map(({ m, mood, img, line }, i) => {
          const name = `${m.label}, ${MOOD_WORD[mood]}`;
          return (
            <li key={m.id} style={{ "--face-i": i } as CSSProperties} data-thought-anchor={m.id} {...holds(m.id)}>
              <Popover
                id={`crew-face-${m.id}`}
                label={name}
                variant="quiet"
                size="sm"
                trigger={<CrewFace member={m} mood={mood} step={step + i} size={mood === "working" ? "lg" : "md"} />}
                triggerProps={{ className: "crew-face-btn", title: name, id: `crew-face-btn-${m.id}` }}
              >
                <div className="crew-face-panel">
                  <p className="label">{m.label}</p>
                  <p>{line}</p>
                  {img && <img className="pixelated" src={img} alt={`Latest from the ${m.label.toLowerCase()}`} />}
                  <button
                    type="button"
                    className="linkish crew-face-ask"
                    onClick={() => {
                      document.getElementById(`crew-face-${m.id}`)?.hidePopover?.();
                      askPipAbout(projectId, `About the ${m.label.toLowerCase()}'s work: `);
                    }}
                  >
                    Ask Pip about this
                  </button>
                  <button type="button" className="linkish crew-face-watch" onClick={() => watch(m.id)}>
                    See what it's doing
                  </button>
                </div>
              </Popover>
            </li>
          );
        })}
      </ul>
      <ThoughtLayer bubbles={thoughts.bubbles} box={box} />
      <p className="visually-hidden" role="status" aria-live="polite">
        {thoughts.live}
      </p>
      {watching && <AgentActivity projectId={projectId} state={state} memberId={watching} onClose={stopWatching} />}
    </section>
  );
}

/** a few big discs, partly off the edges, behind the status line while the crew is getting started */
export function CrewHero() {
  const step = useStep(true);
  const picks = [CREW[0], CREW[2], CREW[1], CREW[4]];
  const moods: Mood[] = ["working", "idle", "idle", "idle"];
  return (
    <div className="crew-hero" aria-hidden="true">
      {picks.map((m, i) => (
        <span key={m.id} className="crew-hero-slot" data-slot={i}>
          <CrewFace member={m} mood={moods[i]} step={step + i * 2} size="hero" />
        </span>
      ))}
    </div>
  );
}

// ---- crew instances: the members that come and go (PIP-JOURNEY §3.1) ----
// Pip first, then the live faces in join order, then up to 3 ghosts; under the row, one quiet line says how many have
// finished. Every move is stepped: a face enters from Pip's side, a ghost turns solid in place, a finished face holds
// its ✓ for 2 s and then fades and shrinks out in place, a return comes back from Pip's side, and a ghost that leaves
// the horizon fades in place. Only live
// changes move, never what loaded (a baseline on mount and on every reconnect). One polite region says each spawn,
// return and leave; the bubbles are decoration. Focus never moves on its own: a face that holds focus, or whose
// popover is open, stays until the person moves on.

/** Pip conducts while the row brings members in (PIP-JOURNEY §3.2); PipCrewFace reads it */
export const ConductContext = createContext(false);

/** a face's client-side phase: entering, returning, holding its end, folding, or a ghost fading out */
type Phase = "enter" | "return" | "hold" | "fold" | "leave";
type Shown = { inst: Instance; phase?: Phase; order?: number; ghost: boolean };
/** the longest a move may take before the row settles it anyway (4 steps, plus the stagger, with room) */
const SETTLE_MS = 2500;
/** a spawn this recent when the row mounts is still news (the row mounts as Start lands) */
const FRESH_MS = 3000;
const domId = (id: string) => id.replace(/[^a-zA-Z0-9_-]/g, "-");
/** busy: focus is inside it, or its popover is open; it must not go yet */
const busy = (id: string) => {
  const li = document.querySelector(`[data-instance="${CSS.escape(id)}"]`);
  return !!li && (li.contains(document.activeElement) || !!li.querySelector(":popover-open"));
};

function InstanceStrip({ projectId, state, lead, pipProject, conn }: StripProps) {
  const all = state.instances ?? [];
  const still = useReducedMotion();
  const groups = crewGroups(state);
  const stuck = new Set(groups.working.filter((i) => i.state !== "live").map((i) => i.id));
  const waiting = new Set(state.tasks.filter((t) => t.status === "waiting_user").map((t) => t.instance));
  // the server caps the ghosts at 3, nearest first; the row keeps that cap whatever arrives
  const ghosts = all.filter((i) => i.ghost && i.state !== "live" && !stuck.has(i.id)).slice(0, 3);

  const pip = usePip(pipProject ?? projectId);
  const box = useRef<HTMLElement>(null);
  const allRef = useRef(all);
  allRef.current = all;
  const thoughts = useThoughts(state, pip, projectId, {
    announce: false,
    taskKey: (t) => t.instance ?? memberOf(t.role).id,
    msgKey: (m) => {
      const id = instanceOfMsg(m, allRef.current);
      const inst = allRef.current.find((i) => i.id === id);
      if (m.from === "pip") {
        const who = inst ? `the ${inst.label}` : "the crew";
        const words = `${m.text.charAt(0).toLowerCase()}${m.text.slice(1)}`;
        return { key: "pip", text: `${m.kind === "answer" ? "Told" : "Asked"} ${who}: ${words}` };
      }
      return id ? { key: id, text: m.text } : null;
    },
  });
  const { push, say } = thoughts;

  // the phases, and what the row last saw
  const [phases, setPhases] = useState<Map<string, { phase: Phase; inst?: Instance; order?: number }>>(new Map());
  const prev = useRef<Map<string, Instance> | null>(null);
  const shown = useRef(new Set<string>());
  const [conducting, setConducting] = useState(false);
  const conductTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const timers = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  const setPhase = useCallback((id: string, next: { phase: Phase; inst?: Instance; order?: number } | null) => {
    setPhases((m) => {
      const out = new Map(m);
      if (next) out.set(id, next);
      else out.delete(id);
      return out;
    });
  }, []);
  /** a face leaves the row for good, once nobody is on it */
  const drop = useCallback(
    (id: string) => {
      clearTimeout(timers.current.get(id));
      if (busy(id)) {
        timers.current.set(
          id,
          setTimeout(() => drop(id), 500),
        );
        return;
      }
      timers.current.delete(id);
      setPhase(id, null);
    },
    [setPhase],
  );
  /** a move ends on its animationend; a page in the background never sends one, so a timer ends it too */
  const settleTimers = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  const phasesRef = useRef(phases);
  phasesRef.current = phases;
  const settle = useCallback(
    (id: string, phase: Phase) => {
      clearTimeout(settleTimers.current.get(id));
      settleTimers.current.set(
        id,
        setTimeout(() => {
          if (phasesRef.current.get(id)?.phase !== phase) return;
          if (phase === "fold" || phase === "leave") drop(id);
          else setPhase(id, null);
        }, SETTLE_MS),
      );
    },
    [drop, setPhase],
  );
  const stillRef = useRef(still);
  stillRef.current = still;

  // a reconnect takes a new baseline: what arrived while away isn't news
  const wasConn = useRef(conn);
  const reconnected = useRef(false);
  useEffect(() => {
    if (conn === "open" && wasConn.current && wasConn.current !== "open") {
      prev.current = null;
      reconnected.current = true;
    }
    wasConn.current = conn;
  }, [conn]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: runs when the instances change
  useLayoutEffect(() => {
    const now = new Map(all.map((i) => [i.id, i]));
    const visible = (i: Instance) => i.state === "live" || (i.ghost && i.state !== "finished");
    if (!prev.current) {
      // the baseline: what loaded isn't news. On mount, though, members brought in moments ago (Start makes the
      // project and its first spawns together, before this row exists) still enter, and Pip still conducts
      const fresh = (i: Instance) =>
        !reconnected.current && i.state === "live" && Date.now() - Date.parse(i.spawnedAt ?? "") < FRESH_MS;
      reconnected.current = false;
      const base = all.filter((i) => !fresh(i));
      prev.current = new Map(base.map((i) => [i.id, i]));
      shown.current = new Set(base.filter(visible).map((i) => i.id));
      if (base.length === all.length) return;
    }
    const before = prev.current;
    prev.current = now;
    const news = instanceNews(before, all);
    if (news.said.length) say(news.said);
    // Pip's words go last, after the task bubbles this change brings, so the cap of 3 never drops them
    if (news.pip) setTimeout(() => push("pip", news.pip), 50);
    if (news.conduct) {
      setConducting(true);
      clearTimeout(conductTimer.current);
      conductTimer.current = setTimeout(() => setConducting(false), CONDUCT_MS);
    }
    let order = 0;
    for (const i of all) {
      const was = before.get(i.id);
      const wasFinished = was?.state === "finished";
      if (i.state === "finished" && was && !wasFinished) {
        // the ✓ (or ■) holds for 2 s, then the face folds toward the counter
        setPhase(i.id, { phase: "hold", inst: i });
        clearTimeout(timers.current.get(i.id));
        timers.current.set(
          i.id,
          setTimeout(() => {
            // it fades (and, with motion, shrinks) out in place; the line under the row counts it at once
            setPhase(i.id, { phase: "fold", inst: i });
            settle(i.id, "fold");
          }, FINISH_HOLD_MS),
        );
        continue;
      }
      if (wasFinished && i.state !== "finished") {
        // a return cancels a hold on the same face and comes back from the counter's side
        clearTimeout(timers.current.get(i.id));
        timers.current.delete(i.id);
        if (visible(i)) {
          setPhase(i.id, { phase: "return" });
          settle(i.id, "return");
        } else setPhase(i.id, null);
        shown.current.add(i.id);
        continue;
      }
      if (visible(i) && !shown.current.has(i.id)) {
        setPhase(i.id, { phase: "enter", order: order++ });
        settle(i.id, "enter");
        shown.current.add(i.id);
      } else if (!visible(i) && shown.current.has(i.id) && was?.ghost && i.state !== "finished") {
        // a ghost off the horizon fades in place
        shown.current.delete(i.id);
        if (stillRef.current) setPhase(i.id, null);
        else {
          setPhase(i.id, { phase: "leave", inst: was });
          settle(i.id, "leave");
        }
      } else if (visible(i)) {
        shown.current.add(i.id);
        // back on the horizon while fading: it stays
        if (phases.get(i.id)?.phase === "leave") setPhase(i.id, null);
      }
      if (i.state === "finished") shown.current.delete(i.id);
    }
  }, [all]);
  useEffect(
    () => () => {
      clearTimeout(conductTimer.current);
      for (const t of timers.current.values()) clearTimeout(t);
      for (const t of settleTimers.current.values()) clearTimeout(t);
    },
    [],
  );

  const onAnimEnd = (id: string, phase: Phase | undefined) => (e: AnimationEvent<HTMLLIElement>) => {
    if (e.target !== e.currentTarget) return;
    if (phase === "fold" || phase === "leave") drop(id);
    else if (phase === "enter" || phase === "return") setPhase(id, null);
  };

  // the row: live (and stuck) in join order with the holding faces where they were, then the ghosts
  const held = [...phases].filter(([, p]) => p.phase === "hold" || p.phase === "fold");
  const liveRow: Shown[] = [
    ...groups.working.map((inst) => ({ inst, ghost: false })),
    ...held
      .filter(([id]) => !groups.working.some((i) => i.id === id))
      .map(([id, p]) => ({ inst: all.find((i) => i.id === id) ?? (p.inst as Instance), ghost: false })),
  ].sort((a, b) => (a.inst.spawnedAt ?? "").localeCompare(b.inst.spawnedAt ?? ""));
  const ghostRow: Shown[] = ghosts.map((inst) => ({ inst, ghost: true }));
  for (const [id, p] of phases)
    if (
      p.phase === "leave" &&
      p.inst &&
      !ghostRow.some((g) => g.inst.id === id) &&
      !liveRow.some((g) => g.inst.id === id)
    )
      ghostRow.push({ inst: p.inst, ghost: true });
  const holding = new Set(held.filter(([, p]) => p.phase === "hold").map(([id]) => id));
  const finished = all.filter((i) => i.state === "finished" && !holding.has(i.id) && !stuck.has(i.id)).length;
  const step = useStep(liveRow.length > 0);

  // the drawer opens from a face or the counter, and Esc gives focus back to whichever opened it
  const [watching, setWatching] = useState<{ sel: string; from: string } | null>(null);
  const open = (sel: string, from: string) => {
    for (const el of document.querySelectorAll<HTMLElement>(".crew-inst [popover]")) el.hidePopover?.();
    setWatching({ sel, from });
  };
  const close = () => {
    const from = watching?.from;
    setWatching(null);
    requestAnimationFrame(() => {
      const el = (from && document.getElementById(from)) || document.getElementById("crew-finished-btn");
      (el ?? document.querySelector<HTMLElement>(".crew-strip .pip-face-btn"))?.focus();
    });
  };
  const holds = (id: string) => ({
    onMouseEnter: () => thoughts.hold(id, true),
    onMouseLeave: () => thoughts.hold(id, false),
    onFocus: () => thoughts.hold(id, true),
    onBlur: () => thoughts.hold(id, false),
  });

  const face = ({ inst: i, ghost }: Shown, k: number) => {
    const p = phases.get(i.id);
    const ending = p?.phase === "hold" || p?.phase === "fold";
    const endMood: Mood = i.outcome === "stopped" || i.outcome === "failed" ? "stopped" : "done";
    const mood: Mood = ending
      ? endMood
      : ghost
        ? "later"
        : stuck.has(i.id)
          ? "stuck"
          : waiting.has(i.id)
            ? "needs"
            : "working";
    const word = ending ? (endMood === "done" ? "done" : "stopped") : ghost ? ghostWord(i.id, state) : MOOD_WORD[mood];
    const name = `${i.label}, ${word}`;
    const cap = qualifier(i.label);
    const tasks = state.tasks.filter((t) => t.instance === i.id);
    const img = [...tasks].reverse().find((t) => t.lastImage)?.lastImage;
    const working = tasks.find((t) => t.status === "working");
    const line = ending
      ? (i.endReason ?? (endMood === "done" ? "Done." : "Stopped."))
      : ghost
        ? ghostLine(i.id, state)
        : mood === "stuck"
          ? (state.status?.problem?.text ?? "Stuck.")
          : mood === "needs"
            ? "Waiting for you."
            : working
              ? plainTitle(working, state)
              : "Working.";
    const pid = `crew-inst-${domId(i.id)}`;
    return (
      <li
        key={i.id}
        className="crew-inst"
        data-ghost={ghost && !ending ? "" : undefined}
        data-instance={i.id}
        data-phase={p?.phase}
        data-thought-anchor={i.id}
        style={{ "--enter-i": p?.order ?? 0, "--face-i": k } as CSSProperties}
        onAnimationEnd={onAnimEnd(i.id, p?.phase)}
        {...holds(i.id)}
      >
        <Popover
          id={pid}
          label={name}
          variant="quiet"
          size="sm"
          trigger={
            <CrewFace
              member={memberOf(i.role)}
              role={i.role}
              mood={mood}
              step={step + k}
              size={ghost && !ending ? "md" : "lg"}
            />
          }
          triggerProps={{ className: "crew-face-btn", title: name, id: `${pid}-btn` }}
        >
          <div className="crew-face-panel">
            <p className="label" dir="auto">
              {i.label}
            </p>
            {i.reason && (
              <p className="muted" dir="auto">
                {bubbleOfReason(i.reason)}.
              </p>
            )}
            <p dir="auto">{line}</p>
            {img && <img className="pixelated" src={img} alt={`Latest from the ${i.label}`} />}
            <button
              type="button"
              className="linkish crew-face-ask"
              onClick={() => {
                document.getElementById(pid)?.hidePopover?.();
                askPipAbout(projectId, `About the ${i.label}: `, { instance: i.id });
              }}
            >
              Ask Pip about this
            </button>
            <button type="button" className="linkish crew-face-watch" onClick={() => open(i.id, `${pid}-btn`)}>
              See what it's doing
            </button>
          </div>
        </Popover>
        {cap && (
          <span className="crew-inst-cap" aria-hidden="true" dir="auto">
            {cap}
          </span>
        )}
        {ending && (
          <span className="crew-inst-cap crew-inst-end" aria-hidden="true">
            {word}
          </span>
        )}
      </li>
    );
  };
  return (
    <section className="crew-strip" data-instances="" aria-labelledby="crew-strip-h" ref={box}>
      <h2 id="crew-strip-h" className="visually-hidden">
        The crew
      </h2>
      {/* Pip at the row's start, its conversation's rule hanging from it; the crew follows toward the end, and the
          finished line sits under the crew, never under Pip */}
      <div className="crew-inst-row">
        {lead && (
          <div className="crew-lead" data-thought-anchor="pip" {...holds("pip")}>
            <ConductContext.Provider value={conducting}>{lead}</ConductContext.Provider>
          </div>
        )}
        <div className="crew-inst-main">
          <ul className="crew-faces">
            {liveRow.map((x, k) => face(x, k))}
            {ghostRow.map((x, k) => face(x, liveRow.length + k))}
          </ul>
          {/* who has finished: one quiet line under the row, not a face among the faces */}
          {finished > 0 && (
            <p className="crew-finished-line">
              <span dir="auto">
                <span>
                  <bdi>{finished}</bdi> {finished === 1 ? "has" : "have"} finished
                </span>
                {" · "}
                <button
                  type="button"
                  id="crew-finished-btn"
                  className="linkish crew-finished-btn"
                  aria-label={`See who worked, ${finished} ${finished === 1 ? "has" : "have"} finished`}
                  onClick={() => open("finished", "crew-finished-btn")}
                >
                  See who worked
                </button>
              </span>
            </p>
          )}
        </div>
      </div>
      <ThoughtLayer bubbles={thoughts.bubbles} box={box} />
      <p className="visually-hidden" role="status" aria-live="polite">
        {thoughts.live}
      </p>
      {watching && (
        <AgentActivity
          projectId={projectId}
          state={state}
          memberId={watching.sel}
          pipProject={pipProject}
          onClose={close}
        />
      )}
    </section>
  );
}
