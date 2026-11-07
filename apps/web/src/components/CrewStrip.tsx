// The crew as faces: one flat disc per department, each in its own category hue, with a two-glyph face in the mono
// face. The face says the state: it blinks and glances while working ("o o" → "- -" → "> <"), smiles when done
// ("^ ^"), looks up when it waits on you, and goes "x x" when it is stuck. Glyph swaps happen in whole steps, at most
// about once a second; the glance and the working ring move only without reduced motion. Names stay plain
// ("Artist, working"). Pressing a face opens one line about it and its last picture.
import { Popover } from "@shabboo/kit/react";
import { type CSSProperties, type ReactNode, useEffect, useRef, useState } from "react";
import { leadTask } from "../lib/derive.ts";
import { CREW, type Member, plainTitle, problemOf, visibleTasks } from "../lib/human.ts";
import { askPipAbout, usePip } from "../lib/pip.ts";
import type { ProjectState, Task } from "../lib/types.ts";
import { AgentActivity } from "./AgentActivity.tsx";
import { ThoughtLayer, useThoughts } from "./Thoughts.tsx";
import "./CrewStrip.css";

export type Mood = "idle" | "working" | "needs" | "stuck" | "done" | "later";
export const MOOD_WORD: Record<Mood, string> = {
  idle: "waiting",
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
  mood,
  step = 0,
  size = "md",
}: {
  member: Member;
  mood: Mood;
  step?: number;
  size?: "md" | "lg" | "hero";
}) {
  const calm = CALM[member.id] ?? "o o";
  const frames = WORK_FRAMES(calm);
  const glyphs =
    mood === "working"
      ? frames[step % frames.length]
      : mood === "done"
        ? "^ ^"
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
      style={{ "--face-hue": `var(--category-${member.hue})` } as CSSProperties}
      aria-hidden="true"
    >
      <span className="crew-face-glyphs">{glyphs}</span>
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

export function CrewStrip({
  projectId,
  state,
  lead,
  pipProject,
}: {
  projectId: string;
  state: ProjectState;
  /** first in the row: Pip, the host */
  lead?: ReactNode;
  /** whose conversation Pip's bubbles follow */
  pipProject?: string;
}) {
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
