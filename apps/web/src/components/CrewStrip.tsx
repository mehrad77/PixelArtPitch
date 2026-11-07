// The crew as faces: one flat disc per department, each in its own category hue, with a two-glyph face in the mono
// face. The face says the state: it blinks and glances while working ("o o" → "- -" → "> <"), smiles when done
// ("^ ^"), looks up when it waits on you, and goes "x x" when it is stuck. Glyph swaps happen in whole steps, at most
// about once a second; the glance and the working ring move only without reduced motion. Names stay plain
// ("Artist, working"). Pressing a face opens one line about it and its last picture.
import { Popover } from "@shabboo/kit/react";
import { type CSSProperties, useEffect, useState } from "react";
import { leadTask } from "../lib/derive.ts";
import { CREW, type Member, plainTitle, problemOf, visibleTasks } from "../lib/human.ts";
import type { ProjectState, Task } from "../lib/types.ts";
import "./CrewStrip.css";

export type Mood = "idle" | "working" | "needs" | "stuck" | "done" | "later";
const MOOD_WORD: Record<Mood, string> = {
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
/** working: look, blink, look, think */
const WORK_FRAMES = (calm: string) => [calm, calm, "- -", calm, "> <"];

function moodOf(tasks: Task[], stuckIds: Set<string>): { mood: Mood; lead?: Task } {
  const lead = leadTask(tasks);
  if (!lead) return { mood: "later" };
  if (lead.status === "failed") return { mood: stuckIds.has(lead.id) ? "stuck" : "idle", lead };
  if (lead.status === "waiting_user") return { mood: "needs", lead };
  if (lead.status === "working") return { mood: "working", lead };
  if (lead.status === "done" && tasks.every((t) => t.status === "done" || t.status === "cancelled"))
    return { mood: "done", lead };
  return { mood: "idle", lead };
}

/** the shared clock for blinking faces: a whole step every 900 ms */
function useStep(on: boolean) {
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
    </span>
  );
}

export function CrewStrip({ state }: { state: ProjectState }) {
  const p = problemOf(state);
  const stuck = new Set(p ? [p.taskId] : []);
  const rows = CREW.map((m) => {
    const tasks = visibleTasks(state.tasks.filter((t) => m.roles.includes(t.role)));
    const img = [...tasks].reverse().find((t) => t.lastImage)?.lastImage;
    return { m, img, ...moodOf(tasks, stuck) };
  });
  const step = useStep(rows.some((r) => r.mood === "working"));
  return (
    <section className="crew-strip" aria-labelledby="crew-strip-h">
      <h2 id="crew-strip-h" className="visually-hidden">
        The crew
      </h2>
      <ul className="crew-faces">
        {rows.map(({ m, mood, lead, img }, i) => {
          const name = `${m.label}, ${MOOD_WORD[mood]}`;
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
          return (
            <li key={m.id} style={{ "--face-i": i } as CSSProperties}>
              <Popover
                id={`crew-face-${m.id}`}
                label={name}
                variant="quiet"
                size="sm"
                trigger={<CrewFace member={m} mood={mood} step={step + i} size={mood === "working" ? "lg" : "md"} />}
                triggerProps={{ className: "crew-face-btn", title: name }}
              >
                <div className="crew-face-panel">
                  <p className="label">{m.label}</p>
                  <p>{line}</p>
                  {img && <img className="pixelated" src={img} alt={`Latest from the ${m.label.toLowerCase()}`} />}
                </div>
              </Popover>
            </li>
          );
        })}
      </ul>
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
