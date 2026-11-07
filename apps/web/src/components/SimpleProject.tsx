// The default project screen: the film, one sentence of status, where we are in five plain steps, and the one thing
// that needs the person, if any. Money is one quiet line. Everything else (stages, tracks, models, tasks) is in
// Studio, one toggle away and remembered (pap.view). Watching rules as in Studio: nothing the crew does moves the
// playhead or the focus.
import { Button, Callout, Popover, Skeleton, Steps, Timeline, TimelineItem } from "@shabboo/kit/react";
import { useCallback, useEffect, useState } from "react";
import { client } from "../lib/client.ts";
import { clock } from "../lib/format.ts";
import { isControlTarget, type ProjectView, useProject, useThrottled } from "../lib/hooks.ts";
import { humanStatus, milestones, PHASES, phaseOf, plainUsd, setView } from "../lib/human.ts";
import { usePlayback } from "../lib/playback.ts";
import { Link, navigate } from "../lib/router.tsx";
import type { ProjectState } from "../lib/types.ts";
import { CrewHero, CrewStrip } from "./CrewStrip.tsx";
import { NeedsYouCard } from "./NeedsYouCard.tsx";
import { ProblemButton } from "./ProblemButton.tsx";
import { SteerPopover } from "./SteerPopover.tsx";
import { Viewer } from "./Viewer.tsx";
import "./SimpleProject.css";

const NO_OVERLAYS = { safe: false, captions: true, grid: false };
const NO_RANGE: [null, null] = [null, null];

export function SimpleProjectPage({ id }: { id: string }) {
  const view = useProject(id);
  const { state, error } = view;
  if (error && !state)
    return (
      <main id="main" className="page-narrow">
        <Callout tone="error" title="This project didn't open">
          <p>{error.message}.</p>
          <p>Check the address, or open it again from Projects. If the server is starting, wait a moment and reload.</p>
        </Callout>
      </main>
    );
  if (!state)
    return (
      <main id="main" className="page-narrow" aria-busy="true">
        <Skeleton lines={6} label="Opening the project" />
      </main>
    );
  return <SimpleProject id={id} state={state} view={view} />;
}

function SimpleProject({ id, state, view }: { id: string; state: ProjectState; view: ProjectView }) {
  const pb = usePlayback(state.timeline.duration);
  const [steer, setSteer] = useState<{ t: number; x: number; y: number } | null>(null);
  const phase = phaseOf(state);
  const b = state.budget;
  const money = plainUsd(b.spentUsd + b.reservedUsd, b.capUsd);

  const focusNeeds = useCallback(() => {
    const card = document.getElementById("needs-you");
    (card?.querySelector<HTMLElement>(".needs-primary") ?? card)?.focus();
  }, []);

  // Space plays and pauses; Q jumps to what needs you. Nothing else: the shortcuts live in Studio.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey || isControlTarget(e)) return;
      if (e.key === " ") pb.toggle();
      else if (e.key === "q" || e.key === "Q") focusNeeds();
      else return;
      e.preventDefault();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [pb, focusNeeds]);

  const scene = steer ? state.timeline.scenes.find((s) => steer.t >= s.from && steer.t < s.to) : undefined;

  return (
    <main id="main" className="simple">
      <header className="sp-top">
        <Link href="/" className="sp-back">
          ‹ Projects
        </Link>
        <h1 className="sp-title">{state.doc.title}</h1>
        <div className="sp-top-end">
          <span className="sp-money small" data-warn={money.warn ? "" : undefined}>
            {money.text}
          </span>
          <PauseControl projectId={id} state={state} />
        </div>
      </header>
      {view.conn === "retrying" && (
        <p className="small muted" role="status">
          Reconnecting to the server…
        </p>
      )}
      <Steps
        className="sp-steps"
        size="sm"
        items={PHASES.map((p) => ({ label: p.label }))}
        current={phase}
        aria-label="Where your video is"
      />
      <div className="sp-film">
        <Viewer
          projectId={id}
          state={state}
          pb={pb}
          proxy={view.proxy}
          overlays={NO_OVERLAYS}
          setOverlays={() => {}}
          compare={false}
          setCompare={() => {}}
          inOut={NO_RANGE}
          minimal
          onSteer={(t, x, y) => setSteer({ t, x, y })}
        />
      </div>
      <StatusLine projectId={id} state={state} />
      <NeedsYouCard projectId={id} state={state} />
      <CrewStrip projectId={id} state={state} />
      <SoFar state={state} />
      <footer className="sp-foot">
        <button
          type="button"
          className="linkish small"
          onClick={() => {
            setView("studio");
            navigate(`/p/${encodeURIComponent(id)}/${state.stage}`);
          }}
        >
          Studio ▸
        </button>
      </footer>
      {steer && (
        <SteerPopover
          projectId={id}
          t={steer.t}
          scene={scene?.id}
          x={steer.x}
          y={steer.y}
          onClose={() => setSteer(null)}
        />
      )}
    </main>
  );
}

/** the one sentence; a problem the crew can't fix alone adds its one button */
function StatusLine({ projectId, state }: { projectId: string; state: ProjectState }) {
  const st = humanStatus(state);
  const live = useThrottled(st.text, 10000);
  // while nobody has started yet, a few big faces keep the person company
  const starting = !state.tasks.some((t) => t.startedAt) && st.tone !== "needs";
  return (
    <div className="sp-status" data-tone={st.tone} data-hero={starting ? "" : undefined}>
      {starting && <CrewHero />}
      <p>{st.text}</p>
      {st.problem && <ProblemButton projectId={projectId} state={state} problem={st.problem} />}
      <p className="visually-hidden" role="status" aria-live="polite">
        {live}
      </p>
    </div>
  );
}

/** a quiet Pause: after this step, or now; while paused, Resume is the primary button */
function PauseControl({ projectId, state }: { projectId: string; state: ProjectState }) {
  const crew = state.crew?.state ?? "running";
  const [err, setErr] = useState<string | null>(null);
  const run = async (fn: () => Promise<void>) => {
    setErr(null);
    document.getElementById("sp-pause")?.hidePopover?.();
    try {
      await fn();
    } catch (e) {
      setErr(`${(e as Error).message}. Try again.`);
    }
  };
  const resume = () => run(() => client.crewResume(projectId));
  return (
    <>
      {crew === "paused" ? (
        <Button size="sm" variant="primary" onClick={resume}>
          Resume
        </Button>
      ) : crew === "idle" ? null : (
        <Popover id="sp-pause" label="Pause" variant="quiet" size="sm" placement="block-end">
          <div className="sp-pause-panel">
            {crew === "pausing" ? (
              <>
                <p className="small muted">Pausing after this step.</p>
                <Button size="sm" variant="primary" onClick={resume}>
                  Resume
                </Button>
              </>
            ) : (
              <>
                <Button size="sm" variant="ghost" onClick={() => run(() => client.crewPause(projectId, "after_step"))}>
                  Pause after this step
                </Button>
                <Button size="sm" variant="ghost" onClick={() => run(() => client.crewPause(projectId, "now"))}>
                  Pause now
                </Button>
              </>
            )}
          </div>
        </Popover>
      )}
      {err && (
        <p className="decision-error small" role="status">
          {err}
        </p>
      )}
    </>
  );
}

/** what's done, on one line; Show all opens the whole list */
function SoFar({ state }: { state: ProjectState }) {
  const ms = milestones(state);
  return (
    <section className="sp-sofar" aria-labelledby="sp-sofar-h">
      <h2 id="sp-sofar-h" className="label">
        So far
      </h2>
      {ms.length === 0 ? (
        <p className="small muted">Nothing finished yet. Milestones show here as the crew reaches them.</p>
      ) : (
        <>
          <ol className="sp-sofar-line small">
            {ms.slice(-4).map((m) => (
              <li key={m.id}>{m.text}</li>
            ))}
          </ol>
          {ms.length > 0 && (
            <Popover id="sp-sofar-all" label="Show all" variant="quiet" size="lg" placement="block-start">
              <Timeline label="Everything so far">
                {[...ms].reverse().map((m, i) => (
                  <TimelineItem
                    key={m.id}
                    title={m.text}
                    start={m.at || undefined}
                    dates={m.at ? clock(new Date(m.at)) : ""}
                    current={i === 0}
                    headingLevel={3}
                  >
                    {m.image && <img className="sp-ms-img pixelated" src={m.image} alt="" />}
                  </TimelineItem>
                ))}
              </Timeline>
            </Popover>
          )}
        </>
      )}
    </section>
  );
}
