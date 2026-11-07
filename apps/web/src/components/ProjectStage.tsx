// The project stage (PIP-JOURNEY §3.5): one shell from an empty /new, through the draft's conversation, to the
// project it becomes. Before Start it is the empty film (also the drop zone), Pip alone in the crew row, "What are we
// making?" and the field; after Start the same places fill with the film, the crew, the status sentence and what
// needs you. Every part keeps its place in the tree, so the field (and its words, and the focus) never remounts.
// Watching rules as in Studio: nothing the crew does moves the playhead or the focus.
import { Button, Callout, Popover, Skeleton, Steps } from "@shabboo/kit/react";
import { useCallback, useEffect, useRef, useState } from "react";
import { guessType } from "../lib/brief.ts";
import { channelSummary, useChannel } from "../lib/channel.ts";
import { client } from "../lib/client.ts";
import { usePublishProject } from "../lib/current.ts";
import { isControlTarget, type ProjectView, useProject, useThrottled } from "../lib/hooks.ts";
import { crewStateOf, effectOf, humanStatus, PHASES, phaseOf, plainUsd } from "../lib/human.ts";
import { adoptConv, askPip, NEW_TALK, seedConv, usePip, usePipOpenRequest } from "../lib/pip.ts";
import { usePlayback } from "../lib/playback.ts";
import { Link, navigate } from "../lib/router.tsx";
import { adopt, FIRST_LINE, STARTERS } from "../lib/stage.ts";
import type { PipItem, ProjectState } from "../lib/types.ts";
import { drawLogo } from "../mock/art.ts";
import { FLAGS } from "../mock/client.ts";
import { JOURNEY } from "../mock/journey.ts";
import { CrewHero, CrewStrip, hasInstances } from "./CrewStrip.tsx";
import { NeedsYouCard } from "./NeedsYouCard.tsx";
import { type Attach, type AttachFile, PipAsk, PipCrewFace, PipLine } from "./Pip.tsx";
import { SteerPopover } from "./SteerPopover.tsx";
import { Viewer } from "./Viewer.tsx";
import { WaitLine } from "./WaitLine.tsx";
import "./SimpleProject.css";
import "./ProjectStage.css";

const NO_OVERLAYS = { safe: false, captions: true, grid: false };
const NO_RANGE: [null, null] = [null, null];
type Pending = AttachFile & { file: File };

/** Pip's first item in a draft says what the stage already says */
const isFirstLine = (it: PipItem) => it.kind === "pip" && it.text === FIRST_LINE && !it.cards.length;
/** the project a draft's Start made, once its brief card says so */
function startedProject(items: PipItem[]): string | null {
  for (const it of items)
    if (it.kind === "pip")
      for (const c of it.cards) if (c.type === "brief" && c.status === "started" && c.result) return c.result.projectId;
  return null;
}

export function ProjectStage({
  draftId = null,
  projectId = null,
}: {
  draftId?: string | null;
  projectId?: string | null;
}) {
  const view = useProject(projectId);
  const { state, error } = view;
  const [draftError, setDraftError] = useState<string | null>(null);
  const [pending, setPending] = useState<Pending[]>([]);
  const [dragging, setDragging] = useState(false);
  const creating = useRef<Promise<string> | null>(null);
  const talk = projectId ?? draftId ?? NEW_TALK;
  const conv = usePip(talk);
  const fromDraft = useRef(!!draftId);
  if (draftId) fromDraft.current = true;

  // a draft opened from Projects (or a reload): its conversation comes from the server
  useEffect(() => {
    if (!draftId || projectId || creating.current) return;
    let live = true;
    client.draft(draftId).then(
      (d) => live && seedConv(draftId, d.items),
      (e: Error) => live && setDraftError(e.message),
    );
    return () => {
      live = false;
    };
  }, [draftId, projectId]);

  // Start made the project: move the conversation over and go there, with nothing remounted
  const started = !projectId && draftId ? startedProject(conv.items) : null;
  useEffect(() => {
    if (!started || !draftId) return;
    adoptConv(draftId, started);
    adopt({ draftId, projectId: started });
    navigate(`/p/${encodeURIComponent(started)}`, { replace: true });
  }, [started, draftId]);

  /** the draft is made on the first send or the first drop, never on opening /new (N8) */
  const ensureDraft = useCallback(async (): Promise<string> => {
    if (draftId) return draftId;
    creating.current ??= client.createDraft().then(({ draft, items }) => {
      seedConv(draft.id, items);
      // the address first, then the adoption: a bare /new with a draft adopted reads as a fresh visit
      navigate(`/new/${encodeURIComponent(draft.id)}`, { replace: true });
      adopt({ draftId: draft.id, projectId: null });
      return draft.id;
    });
    try {
      return await creating.current;
    } catch (e) {
      creating.current = null;
      throw e;
    }
  }, [draftId]);

  const addFiles = useCallback(
    (files: File[]) => {
      setPending((xs) => [
        ...xs.filter((x) => !files.some((f) => f.name === x.name)),
        ...files.map((file) => ({ file, name: file.name, type: guessType(file.name, file.type) })),
      ]);
      ensureDraft().catch((e: Error) => setDraftError(e.message));
    },
    [ensureDraft],
  );
  const attach: Attach = {
    files: pending,
    add: addFiles,
    remove: (name) => setPending((xs) => xs.filter((x) => x.name !== name)),
  };

  const send = useCallback(
    async (text: string): Promise<boolean> => {
      let id: string;
      try {
        id = await ensureDraft();
      } catch (e) {
        setDraftError((e as Error).message);
        return false;
      }
      // the files upload with the message
      const files = pending;
      setPending([]);
      try {
        for (const f of files) await client.draftFile(id, f.name, f.file);
      } catch (e) {
        setPending(files);
        setDraftError(`A file didn't upload: ${(e as Error).message}`);
        return false;
      }
      return askPip(id, text, { files: files.map((f) => f.name) });
    },
    [ensureDraft, pending],
  );

  // "Show all options": the composer, filled from the draft (made now if needed, with no model call)
  const allOptions = async () => {
    try {
      const id = await ensureDraft();
      const idea = (document.getElementById("pip-ask-input") as HTMLInputElement | null)?.value.trim();
      if (idea) await client.draftFields(id, { idea });
      navigate(`/new/${encodeURIComponent(id)}/options`);
    } catch (e) {
      setDraftError((e as Error).message);
    }
  };

  // dropping files anywhere on the window, before Start: the film area is the target
  const before = !projectId;
  useEffect(() => {
    if (!before) return;
    let depth = 0;
    const hasFiles = (e: globalThis.DragEvent) => !!e.dataTransfer?.types.includes("Files");
    const enter = (e: globalThis.DragEvent) => {
      if (!hasFiles(e)) return;
      depth++;
      setDragging(true);
    };
    const leave = (e: globalThis.DragEvent) => {
      if (!hasFiles(e)) return;
      depth = Math.max(0, depth - 1);
      if (!depth) setDragging(false);
    };
    const over = (e: globalThis.DragEvent) => {
      if (hasFiles(e)) e.preventDefault();
    };
    const drop = (e: globalThis.DragEvent) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      depth = 0;
      setDragging(false);
      const files = [...(e.dataTransfer?.files ?? [])];
      if (files.length) addFiles(files);
    };
    window.addEventListener("dragenter", enter);
    window.addEventListener("dragleave", leave);
    window.addEventListener("dragover", over);
    window.addEventListener("drop", drop);
    return () => {
      window.removeEventListener("dragenter", enter);
      window.removeEventListener("dragleave", leave);
      window.removeEventListener("dragover", over);
      window.removeEventListener("drop", drop);
    };
  }, [before, addFiles]);

  // mock `auto=1`: the step 2 message and the logo, typed and dropped 3 ticks after an empty /new opens
  const autoSent = useRef(false);
  // biome-ignore lint/correctness/useExhaustiveDependencies: once, on a fresh /new
  useEffect(() => {
    if (!client.mock || !FLAGS.auto || draftId || projectId || autoSent.current) return;
    // set when it fires, not when scheduled: StrictMode runs this twice and clears the first timer
    const t = setTimeout(async () => {
      if (autoSent.current) return;
      autoSent.current = true;
      const blob = await (await fetch(drawLogo(4))).blob();
      const file = new File([blob], JOURNEY.logo, { type: "image/png" });
      const id = await ensureDraft();
      await client.draftFile(id, file.name, file);
      await askPip(id, JOURNEY.say, { files: [file.name] });
    }, 3000 / FLAGS.speed);
    return () => clearTimeout(t);
  }, []);

  if (projectId && !state && !fromDraft.current)
    return error ? (
      <main id="main" className="page-narrow">
        <Callout tone="error" title="This project didn't open">
          <p>{error.message}.</p>
          <p>Check the address, or open it again from Projects. If the server is starting, wait a moment and reload.</p>
        </Callout>
      </main>
    ) : (
      <main id="main" className="page-narrow" aria-busy="true">
        <Skeleton lines={6} label="Opening the project" />
      </main>
    );

  return (
    <Stage
      projectId={projectId}
      state={state}
      view={view}
      talk={talk}
      dragging={dragging}
      draftError={draftError}
      attach={before ? attach : undefined}
      send={before ? send : undefined}
      allOptions={before ? allOptions : undefined}
    />
  );
}

function Stage({
  projectId,
  state,
  view,
  talk,
  dragging,
  draftError,
  attach,
  send,
  allOptions,
}: {
  projectId: string | null;
  state: ProjectState | null;
  view: ProjectView;
  talk: string;
  dragging: boolean;
  draftError: string | null;
  attach?: Attach;
  send?: (text: string) => Promise<boolean>;
  allOptions?: () => void;
}) {
  const pb = usePlayback(state?.timeline.duration ?? 30, projectId ?? "_new");
  usePublishProject(projectId ?? "", state);
  const [steer, setSteer] = useState<{ t: number; x: number; y: number } | null>(null);
  // "Ask Pip about this" from a face or the steer popover: the draft lands in the field, which is always on screen
  usePipOpenRequest(talk, () => document.getElementById("pip-ask-input")?.scrollIntoView({ block: "nearest" }));
  const focusNeeds = useCallback(() => {
    const card = document.getElementById("needs-you");
    (card?.querySelector<HTMLElement>(".needs-primary") ?? card)?.focus();
  }, []);

  // Space plays and pauses; Q jumps to what needs you. Nothing else: the shortcuts live in Studio.
  useEffect(() => {
    if (!state) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey || isControlTarget(e)) return;
      if (e.key === " ") pb.toggle();
      else if (e.key === "q" || e.key === "Q") focusNeeds();
      else return;
      e.preventDefault();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [pb, focusNeeds, state]);

  const scene = steer && state ? state.timeline.scenes.find((s) => steer.t >= s.from && steer.t < s.to) : undefined;
  const b = state?.budget;
  const money = b ? plainUsd(b.spentUsd + b.reservedUsd, b.capUsd) : null;

  return (
    <main id="main" className="simple" data-stage={state ? "project" : "new"}>
      <header className="sp-top">
        <Link href="/" className="sp-back">
          ‹ Projects
        </Link>
        <h1 className="sp-title" dir="auto">
          {state?.doc.title ?? "New video"}
        </h1>
        <div className="sp-top-end">
          {money && (
            <span className="sp-money small" dir="auto" data-warn={money.warn ? "" : undefined}>
              {money.text}
            </span>
          )}
          {state && projectId && <PauseControl projectId={projectId} state={state} />}
        </div>
      </header>
      {view.conn === "retrying" && state && (
        <p className="small muted" role="status">
          Reconnecting to the server…
        </p>
      )}
      {state ? (
        <Steps
          className="sp-steps"
          size="sm"
          items={PHASES.map((p) => ({ label: p.label }))}
          current={phaseOf(state)}
          aria-label="Where your video is"
        />
      ) : null}
      <div className="sp-film">
        {state && projectId ? (
          <Viewer
            projectId={projectId}
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
        ) : (
          <EmptyFilm dragging={dragging} />
        )}
      </div>
      {/* the workers first, quietly; then Pip, who talks to you: the sentence, the thread, the field */}
      <div className="sp-crew">
        {state && projectId ? (
          <CrewStrip
            projectId={projectId}
            state={state}
            lead={<PipCrewFace project={projectId} state={state} />}
            pipProject={projectId}
          />
        ) : (
          <section className="crew-strip" aria-label="The crew">
            <ul className="crew-faces">
              <li className="crew-lead">
                <PipCrewFace project={talk} state={null} />
              </li>
            </ul>
          </section>
        )}
      </div>
      <StageTalk
        projectId={projectId}
        talk={talk}
        state={state}
        onNeeds={focusNeeds}
        draftError={draftError}
        attach={attach}
        send={send}
        allOptions={allOptions}
      />
      {steer && projectId && (
        <SteerPopover
          projectId={projectId}
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

/** the empty stage's film: a dark 16:9 box at the film's size; while files are dragged over the window (the drop
 * lands anywhere), it outlines and says so */
function EmptyFilm({ dragging }: { dragging: boolean }) {
  return (
    <div className="stage-empty" data-drag={dragging ? "" : undefined}>
      <p className="small">{dragging ? "Drop to add to this video" : "Your video shows here"}</p>
    </div>
  );
}

/** the one sentence, said by Pip, and under it what needs you, the field and the thread. One component in every
 * phase, so PipAsk keeps its place */
function StageTalk({
  projectId,
  talk,
  state,
  onNeeds,
  draftError,
  attach,
  send,
  allOptions,
}: {
  projectId: string | null;
  talk: string;
  state: ProjectState | null;
  onNeeds: () => void;
  draftError: string | null;
  attach?: Attach;
  send?: (text: string) => Promise<boolean>;
  allOptions?: () => void;
}) {
  const st = state ? humanStatus(state) : null;
  const line = st?.text ?? (projectId ? "The crew is getting ready." : FIRST_LINE);
  const live = useThrottled(st ? st.text : "", 10000);
  // what Pip and the crew said to each other lately, in one plain sentence
  const behind = channelSummary(useChannel(projectId));
  // while nobody has started yet, a few big faces keep the person company; never on the stage, where Pip is alone
  const starting =
    !!state && !hasInstances(state) && !state.plan && !state.tasks.some((t) => t.startedAt) && st?.tone !== "needs";
  return (
    <div className="sp-status">
      <PipLine>
        <div className="sp-said" data-tone={st?.tone} data-hero={starting ? "" : undefined}>
          {starting && <CrewHero />}
          <div className="sp-status-text">
            <p dir="auto">{line}</p>
            {state && projectId ? (
              <WaitLine projectId={projectId} state={state} mainText={line} onNeeds={onNeeds} hideNeeds />
            ) : null}
            {behind && <p className="sp-behind small">{behind}</p>}
            {draftError && (
              <p className="small" role="status">
                {draftError}. <Link href="/new">Start again</Link>
              </p>
            )}
          </div>
        </div>
        {/* what needs you is Pip's question, said here, above the field */}
        {state && projectId ? <NeedsYouCard projectId={projectId} state={state} variant="pip" /> : null}
        <PipAsk
          project={talk}
          state={state}
          label={projectId ? undefined : "Your idea"}
          placeholder={projectId ? undefined : "For example: a 30 s pitch for my bakery, no voice"}
          starters={projectId ? undefined : STARTERS}
          under={
            allOptions ? (
              <button type="button" className="linkish small stage-options" onClick={allOptions}>
                Show all options
              </button>
            ) : null
          }
          onSend={send}
          attach={attach}
          emptyNote={projectId ? undefined : null}
          skip={isFirstLine}
        />
      </PipLine>
      <p className="visually-hidden" role="status" aria-live="polite">
        {live}
      </p>
    </div>
  );
}

/** a quiet Pause: after this step, or now; while paused, Resume is the primary button */
export function PauseControl({ projectId, state }: { projectId: string; state: ProjectState }) {
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
