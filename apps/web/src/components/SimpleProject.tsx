// The default project screen: the film, one sentence of status, where we are in five plain steps, and the one thing
// that needs the person, if any. Money is one quiet line. Everything else (stages, tracks, models, tasks) is in
// Studio, one toggle away in the app header and remembered (pap.view). Watching rules as in Studio: nothing the crew does moves the
// playhead or the focus.
import { Button, Callout, Popover, Skeleton, Steps } from "@shabboo/kit/react";
import { useCallback, useEffect, useState } from "react";
import { channelSummary, useChannel } from "../lib/channel.ts";
import { client } from "../lib/client.ts";
import { usePublishProject } from "../lib/current.ts";
import { isControlTarget, type ProjectView, useProject, useThrottled } from "../lib/hooks.ts";
import { crewStateOf, effectOf, humanStatus, PHASES, phaseOf, plainUsd } from "../lib/human.ts";
import { usePipOpenRequest } from "../lib/pip.ts";
import { usePlayback } from "../lib/playback.ts";
import { Link } from "../lib/router.tsx";
import type { ProjectState } from "../lib/types.ts";
import { CrewHero, CrewStrip } from "./CrewStrip.tsx";
import { NeedsYouCard } from "./NeedsYouCard.tsx";
import { PipAsk, PipCrewFace, PipLine } from "./Pip.tsx";
import { SteerPopover } from "./SteerPopover.tsx";
import { Viewer } from "./Viewer.tsx";
import { WaitLine } from "./WaitLine.tsx";
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
  const pb = usePlayback(state.timeline.duration, id);
  usePublishProject(id, state);
  const [steer, setSteer] = useState<{ t: number; x: number; y: number } | null>(null);
  // "Ask Pip about this" from a face or the steer popover: the draft lands in the field, which is always on screen
  usePipOpenRequest(id, () => document.getElementById("pip-ask-input")?.scrollIntoView({ block: "nearest" }));
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
      {/* the workers first, quietly; then Pip, who talks to you: the sentence, the thread, the field */}
      <div className="sp-crew">
        <CrewStrip projectId={id} state={state} lead={<PipCrewFace project={id} state={state} />} pipProject={id} />
      </div>
      <StatusLine projectId={id} state={state} onNeeds={focusNeeds} />
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

/** the one sentence, said by Pip, and under it why nothing moves and the one thing to do about it */
function StatusLine({ projectId, state, onNeeds }: { projectId: string; state: ProjectState; onNeeds: () => void }) {
  const st = humanStatus(state);
  const live = useThrottled(st.text, 10000);
  // what Pip and the crew said to each other lately, in one plain sentence
  const behind = channelSummary(useChannel(projectId));
  // while nobody has started yet, a few big faces keep the person company
  const starting = !state.tasks.some((t) => t.startedAt) && st.tone !== "needs";
  return (
    <div className="sp-status">
      <PipLine>
        <div className="sp-said" data-tone={st.tone} data-hero={starting ? "" : undefined}>
          {starting && <CrewHero />}
          <div className="sp-status-text">
            <p dir="auto">{st.text}</p>
            <WaitLine projectId={projectId} state={state} mainText={st.text} onNeeds={onNeeds} hideNeeds />
            {behind && <p className="sp-behind small">{behind}</p>}
          </div>
        </div>
        {/* what needs you is Pip's question, said here, above the field */}
        <NeedsYouCard projectId={projectId} state={state} variant="pip" />
        <PipAsk project={projectId} state={state} />
      </PipLine>
      <p className="visually-hidden" role="status" aria-live="polite">
        {live}
      </p>
    </div>
  );
}

/** a quiet Pause: after this step, or now; while paused, Resume is the primary button */
function PauseControl({ projectId, state }: { projectId: string; state: ProjectState }) {
  const crew = crewStateOf(state);
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
        <Button
          size="sm"
          variant="primary"
          onClick={resume}
          title={effectOf({ kind: "resume" }, state).text || undefined}
        >
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
