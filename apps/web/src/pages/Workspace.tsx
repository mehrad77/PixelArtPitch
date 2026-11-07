// The project workspace: header with HUD and stage nav; stage panel (left), viewer (centre), Crew / Inbox / Notes /
// Changes (right), and the track timeline (bottom). Watching rules: nothing the crew does moves the playhead, the
// scroll or the focus, or opens a dialog; errors stay on the crew row. The Producer's digest is a throttled polite
// live region.
import { Badge, Callout, EmptyState, Skeleton } from "@shabboo/kit/react";
import { type KeyboardEvent as ReactKeyboardEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { CrewPanel } from "../components/CrewRow.tsx";
import { DecisionCard, GateCard } from "../components/DecisionCard.tsx";
import { NoteForm } from "../components/NoteForm.tsx";
import { PatchSummary } from "../components/PatchSummary.tsx";
import { ProjectHeader } from "../components/ProjectHeader.tsx";
import { ShortcutsDialog } from "../components/ShortcutsDialog.tsx";
import { StagePanel } from "../components/StagePanel.tsx";
import { TrackTimeline } from "../components/TrackTimeline.tsx";
import { type Overlays, Viewer } from "../components/Viewer.tsx";
import { WaitLine } from "../components/WaitLine.tsx";
import { client } from "../lib/client.ts";
import { usePublishProject } from "../lib/current.ts";
import { buildClips, type Clip, NOTE_CATEGORY, ROLE_LABEL, type TrackId } from "../lib/derive.ts";
import { ago, FPS, timecode } from "../lib/format.ts";
import { isControlTarget, useProject, useThrottled } from "../lib/hooks.ts";
import { isStaleDigest } from "../lib/human.ts";
import { usePlayback } from "../lib/playback.ts";
import type { NoteStatus, NoteTarget, ProjectState, Role, Stage } from "../lib/types.ts";
import "./Workspace.css";

type Tab = "crew" | "inbox" | "notes" | "changes";
const TABS: { id: Tab; label: string }[] = [
  { id: "crew", label: "Crew" },
  { id: "inbox", label: "Inbox" },
  { id: "notes", label: "Notes" },
  { id: "changes", label: "Changes" },
];
const NOTE_STATUS: Record<NoteStatus, { word: string; tone: "muted" | "accent" | "signal" | "success" }> = {
  open: { word: "Open", tone: "muted" },
  picked_up: { word: "Picked up", tone: "accent" },
  proposed: { word: "Proposed", tone: "signal" },
  done: { word: "Done", tone: "success" },
  declined: { word: "Declined", tone: "muted" },
};

/** `stage` comes from the URL; without one (/p/:id with the Studio view remembered) the crew's stage shows */
export function WorkspacePage({ id, stage }: { id: string; stage?: Stage }) {
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
      <main id="main" className="page" aria-busy="true">
        <Skeleton lines={6} label="Opening the project" />
      </main>
    );
  return <Workspace id={id} stage={stage ?? state.stage} state={state} view={view} />;
}

function Workspace({
  id,
  stage,
  state,
  view,
}: {
  id: string;
  stage: Stage;
  state: ProjectState;
  view: ReturnType<typeof useProject>;
}) {
  const pb = usePlayback(state.timeline.duration, id);
  usePublishProject(id, state);
  const [overlays, setOverlays] = useState<Overlays>({ safe: false, captions: true, grid: false });
  const [compare, setCompare] = useState(false);
  const [inOut, setInOut] = useState<[number | null, number | null]>([null, null]);
  const [zoom, setZoom] = useState(24);
  const [selected, setSelected] = useState<Clip | null>(null);
  const [tab, setTab] = useState<Tab>("crew");
  const [note, setNote] = useState<{ target: NoteTarget; track: TrackId } | null>(null);
  const [help, setHelp] = useState(false);
  const tabRefs = useRef<Record<Tab, HTMLButtonElement | null>>({
    crew: null,
    inbox: null,
    notes: null,
    changes: null,
  });
  const clips = useMemo(() => buildClips(state), [state]);
  // "The crew stopped: …" outlives the failure it reports; once a retry recovered it, say nothing
  const openQs = state.questions.filter((q) => q.status === "open");
  const openGates = state.gates.filter((g) => g.status === "open");
  const inboxCount = openQs.length + openGates.length;
  // the Inbox already shows an open gate: drop the digest's sentence that repeats it ("Approve it (G2)…")
  const digestText = (isStaleDigest(state) ? "" : state.digest)
    .split(/(?<=[.!?])\s+/)
    .filter((sentence) => !(openGates.length && /\(G\d\)/.test(sentence)))
    .join(" ");
  const digest = useThrottled(digestText, 20000);

  const sceneAt = useCallback(
    (t: number) => state.timeline.scenes.find((s) => t >= s.from && t < s.to),
    [state.timeline.scenes],
  );

  const openNote = useCallback(() => {
    const [i, o] = inOut;
    const range: [number, number] = i != null && o != null && o > i ? [i, o] : [pb.t, pb.t];
    const sc = sceneAt(range[0]);
    const cue = state.timeline.cues.find((c) => range[0] >= c.start && range[0] <= c.end);
    setNote({ target: { range, scene: sc?.id, cue: cue?.id }, track: selected?.track ?? "scenes" });
  }, [inOut, pb.t, sceneAt, selected, state.timeline.cues]);

  /** Q: show the Inbox and focus the next open question (or gate), cycling */
  const nextQuestion = useCallback(() => {
    setTab("inbox");
    requestAnimationFrame(() => {
      const cards = [...document.querySelectorAll<HTMLElement>("#panel-inbox form.decision")];
      if (!cards.length) {
        tabRefs.current.inbox?.focus();
        return;
      }
      const cur = cards.findIndex((c) => c.contains(document.activeElement));
      const next = cards[(cur + 1) % cards.length];
      next.querySelector<HTMLElement>("input:checked, input, textarea, button")?.focus();
    });
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey;
      if (mod && e.key === ".") {
        e.preventDefault();
        client.crewPause(id, "after_step").catch(() => {});
        return;
      }
      if (mod || e.altKey || isControlTarget(e)) return;
      const tl = state.timeline;
      const k = e.key;
      let handled = true;
      if (k === " ") pb.toggle();
      else if (k === "j" || k === "J") pb.shuttle(-1);
      else if (k === "k" || k === "K") pb.pause();
      else if (k === "l" || k === "L") pb.shuttle(1);
      else if (k === "ArrowLeft") pb.step(e.shiftKey ? -FPS : -1);
      else if (k === "ArrowRight") pb.step(e.shiftKey ? FPS : 1);
      else if (k === "ArrowUp") {
        const prev = [...tl.scenes].reverse().find((s) => s.from < pb.t - 0.05);
        pb.pause();
        pb.seek(prev?.from ?? 0);
      } else if (k === "ArrowDown") {
        const next = tl.scenes.find((s) => s.from > pb.t + 0.01);
        pb.pause();
        if (next) pb.seek(next.from);
      } else if (k === "Home") pb.seek(0);
      else if (k === "End") pb.seek(pb.duration);
      else if (k === "i" || k === "I")
        setInOut(([i, o]) => [i != null && Math.abs(i - pb.t) < 1 / FPS ? null : pb.t, o]);
      else if (k === "o" || k === "O")
        setInOut(([i, o]) => [i, o != null && Math.abs(o - pb.t) < 1 / FPS ? null : pb.t]);
      else if (k === "m" || k === "M") openNote();
      else if (k === "\\") setCompare((c) => !c);
      else if (k === "q" || k === "Q") nextQuestion();
      else if (k === "?") setHelp(true);
      else handled = false;
      if (handled) e.preventDefault();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [id, pb, state.timeline, openNote, nextQuestion]);

  const onTabKey = (e: ReactKeyboardEvent<HTMLButtonElement>) => {
    const i = TABS.findIndex((t) => t.id === tab);
    const rtl = getComputedStyle(e.currentTarget).direction === "rtl";
    let n = -1;
    if (e.key === "ArrowRight") n = rtl ? i - 1 : i + 1;
    else if (e.key === "ArrowLeft") n = rtl ? i + 1 : i - 1;
    else if (e.key === "Home") n = 0;
    else if (e.key === "End") n = TABS.length - 1;
    if (n < 0 && e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
    e.preventDefault();
    const next = TABS[(n + TABS.length) % TABS.length];
    setTab(next.id);
    tabRefs.current[next.id]?.focus();
  };

  const undone = new Set(view.history.filter((h) => h.undoes != null).map((h) => h.undoes as number));

  return (
    <main id="main" className="workspace" data-density="compact" data-grain="off">
      <ProjectHeader projectId={id} state={state} stage={stage} conn={view.conn} />
      <div className="digest">
        <span className="label">Producer</span>
        <div className="digest-text">
          <p>{digestText}</p>
          <WaitLine projectId={id} state={state} onNeeds={nextQuestion} needsLabel="" />
        </div>
        {inboxCount > 0 && (
          <button type="button" className="linkish small" onClick={nextQuestion}>
            Inbox ({inboxCount})
          </button>
        )}
        <button type="button" className="linkish small" onClick={() => setHelp(true)}>
          Shortcuts (?)
        </button>
      </div>
      <p className="visually-hidden" role="status" aria-live="polite">
        {digest}
      </p>
      <div className="ws-main">
        <aside className="ws-left" aria-label="Stage">
          <StagePanel
            projectId={id}
            state={state}
            stage={stage}
            lastStill={view.lastStill}
            onSeek={(t) => {
              pb.pause();
              pb.seek(t);
            }}
          />
        </aside>
        <Viewer
          projectId={id}
          state={state}
          pb={pb}
          proxy={view.proxy}
          overlays={overlays}
          setOverlays={setOverlays}
          compare={compare}
          setCompare={setCompare}
          inOut={inOut}
        />
        <aside className="ws-right" aria-label="Crew and inbox">
          <div className="tabs" data-ready="" data-size="sm" data-shab-tabs="">
            <div className="tab-list" role="tablist" aria-label="Side panel" data-shab-tabs="">
              {TABS.map((t) => (
                <button
                  key={t.id}
                  ref={(el) => {
                    tabRefs.current[t.id] = el;
                  }}
                  type="button"
                  role="tab"
                  className="tab"
                  id={`tab-${t.id}`}
                  aria-controls={`panel-${t.id}`}
                  aria-selected={tab === t.id ? "true" : "false"}
                  tabIndex={tab === t.id ? 0 : -1}
                  onClick={() => setTab(t.id)}
                  onKeyDown={onTabKey}
                  data-shab-tabs=""
                >
                  {t.label}
                  {t.id === "inbox" && inboxCount > 0 && ` (${inboxCount})`}
                </button>
              ))}
            </div>
          </div>
          <section
            id="panel-crew"
            role="tabpanel"
            aria-labelledby="tab-crew"
            hidden={tab !== "crew"}
            className="tab-panel"
          >
            <CrewPanel projectId={id} state={state} currentScene={() => sceneAt(pb.t)?.id} />
          </section>
          <section
            id="panel-inbox"
            role="tabpanel"
            aria-labelledby="tab-inbox"
            hidden={tab !== "inbox"}
            className="tab-panel"
          >
            <div className="stack-3 pad">
              {inboxCount === 0 && (
                <EmptyState size="sm" title="Nothing waiting for you">
                  Questions and gates from the crew land here. Press Q to jump to the next one.
                </EmptyState>
              )}
              {openGates.map((g) => (
                <GateCard key={g.id} projectId={id} gate={g} state={state} />
              ))}
              {openQs.map((q) => (
                <DecisionCard key={q.id} projectId={id} q={q} />
              ))}
              {state.questions.some((q) => q.status !== "open") && (
                <details className="answered">
                  <summary className="label">Answered</summary>
                  <div className="stack-2">
                    {state.questions
                      .filter((q) => q.status !== "open")
                      .map((q) => (
                        <DecisionCard key={q.id} projectId={id} q={q} />
                      ))}
                  </div>
                </details>
              )}
            </div>
          </section>
          <section
            id="panel-notes"
            role="tabpanel"
            aria-labelledby="tab-notes"
            hidden={tab !== "notes"}
            className="tab-panel"
          >
            <div className="pad stack-2">
              <p className="small muted">
                Press M to add a note at the playhead, or set In and Out (I, O) first for a range.
              </p>
              {state.notes.length === 0 ? (
                <EmptyState size="sm" title="No notes yet">
                  Notes you leave go to the crew member who owns that part.
                </EmptyState>
              ) : (
                <ul className="notes-list">
                  {[...state.notes].reverse().map((n) => (
                    <li key={n.id}>
                      <div className="note-head">
                        <Badge tone={NOTE_STATUS[n.status].tone}>{NOTE_STATUS[n.status].word}</Badge>
                        <span className="mono small">{NOTE_CATEGORY[n.category]}</span>
                        <span className="muted small">
                          to {n.assignee === "producer" ? "Producer" : ROLE_LABEL[n.assignee as Role]}
                        </span>
                        <time className="muted small" dateTime={n.createdAt}>
                          {ago(n.createdAt)}
                        </time>
                      </div>
                      {n.text && <p>{n.text}</p>}
                      <button
                        type="button"
                        className="linkish small"
                        onClick={() => {
                          const t =
                            n.target.range?.[0] ??
                            state.timeline.scenes.find((s) => s.id === n.target.scene)?.from ??
                            0;
                          pb.pause();
                          pb.seek(t);
                        }}
                      >
                        {n.target.range
                          ? `At ${timecode(n.target.range[0])}`
                          : n.target.scene
                            ? `In ${n.target.scene}`
                            : "Go to it"}
                      </button>
                      {n.reason && <p className="muted small">{n.reason}</p>}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </section>
          <section
            id="panel-changes"
            role="tabpanel"
            aria-labelledby="tab-changes"
            hidden={tab !== "changes"}
            className="tab-panel"
          >
            {view.history.length === 0 ? (
              <EmptyState size="sm" title="No changes yet">
                Every edit to the project, by you or the crew, shows here and can be reverted.
              </EmptyState>
            ) : (
              [...view.history]
                .reverse()
                .map((h) => <PatchSummary key={h.seq} projectId={id} entry={h} undone={undone.has(h.seq)} />)
            )}
          </section>
        </aside>
      </div>
      <TrackTimeline
        projectId={id}
        narration={state.doc.brief.narration}
        clips={clips}
        pb={pb}
        zoom={zoom}
        setZoom={setZoom}
        inOut={inOut}
        selected={selected?.id ?? null}
        onSelect={setSelected}
      />
      {note && <NoteForm projectId={id} target={note.target} track={note.track} onClose={() => setNote(null)} />}
      {help && <ShortcutsDialog onClose={() => setHelp(false)} />}
    </main>
  );
}
