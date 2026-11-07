// The crew drawer once the members come and go (docs/PIP-JOURNEY.md §3.3): Pip pinned first, then three groups,
// Working, Up next and Finished, each a list of buttons with aria-current on the one shown. A working member's pane is
// its live thread with a way to message it; a finished member's is its kept log, read-only, with "Ask Pip about this"
// in place of a message box. Opened from a face, the "+N finished" counter, the header's Crew button or Studio.
import { Button, Drawer, Tag } from "@shabboo/kit/react";
import { type CSSProperties, Fragment, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { mergeEntries } from "../lib/activity.ts";
import { useChannel } from "../lib/channel.ts";
import { client } from "../lib/client.ts";
import { clock, duration, usd } from "../lib/format.ts";
import { memberOf, modelShort, modelWords, problemOf, visibleTasks } from "../lib/human.ts";
import { bubbleOfReason, crewGroups, ghostLine, msgsOf, OUTCOME_WORD, ROLE_HUE, timeAlive } from "../lib/instances.ts";
import { askPipAbout, hasNews, pipMood, usePip, usePipOpenRequest } from "../lib/pip.ts";
import type { ActivityEntry, ChannelMsg, Instance, InstanceLog, ProjectState, Task } from "../lib/types.ts";
import { type ActivityProps, Compose, PipPane, pipLine, TaskGroup } from "./AgentActivity.tsx";
import { BehindTheScenes } from "./Channel.tsx";
import { CrewFace, type Mood, useStep } from "./CrewStrip.tsx";
import { DirectControls } from "./DirectControls.tsx";
import { PipFace } from "./PipFace.tsx";
import "./AgentActivity.css";

type Kind = "working" | "upNext" | "finished";
const GROUP_WORD: Record<Kind, string> = { working: "Working", upNext: "Up next", finished: "Finished" };

const startOf = (t: Task) => Date.parse(t.startedAt ?? "") || Number.POSITIVE_INFINITY;

/** the face an instance shows in the drawer */
function moodOf(i: Instance, kind: Kind, s: ProjectState, stuck: Set<string>): Mood {
  if (kind === "finished") return i.outcome === "stopped" || i.outcome === "failed" ? "stopped" : "done";
  if (kind === "upNext") return "later";
  if (stuck.has(i.id)) return "stuck";
  if (s.tasks.some((t) => t.instance === i.id && t.status === "waiting_user")) return "needs";
  return "working";
}

/** "Sonnet 5.5 · 3 min · $0.31 · ✓ done" */
const finishedLine = (i: Instance) =>
  [i.model ? modelShort(i.model) : null, duration(timeAlive(i)), usd(i.usd), i.outcome ? OUTCOME_WORD[i.outcome] : null]
    .filter(Boolean)
    .join(" · ");

/** where the drawer opens: an instance id, "pip", "finished" (its newest), or a department's (its first member) */
function initialSel(
  memberId: string,
  focusTask: string | undefined,
  s: ProjectState,
  g: ReturnType<typeof crewGroups>,
) {
  const all = s.instances ?? [];
  const byTask = focusTask ? s.tasks.find((t) => t.id === focusTask)?.instance : undefined;
  if (byTask && all.some((i) => i.id === byTask)) return byTask;
  if (memberId === "pip") return "pip";
  if (memberId === "finished") return g.finished[0]?.id ?? "pip";
  if ([...g.working, ...g.upNext, ...g.finished].some((i) => i.id === memberId)) return memberId;
  const dept = [...g.working, ...g.upNext, ...g.finished].find((i) => memberOf(i.role).id === memberId);
  return dept?.id ?? "pip";
}

export function CrewDrawer({
  projectId,
  state,
  memberId,
  focusTask,
  currentScene,
  onClose,
  picker,
  pipProject,
}: ActivityProps) {
  const groups = crewGroups(state);
  const [sel, setSel] = useState(() => initialSel(memberId, focusTask, state, groups));
  const pipKey = pipProject === undefined ? projectId : pipProject;
  const pip = usePip(pipKey);
  usePipOpenRequest(pipKey, () => setSel("pip"));
  const p = problemOf(state);
  const stuck = new Set(state.tasks.filter((t) => t.id === p?.taskId && t.instance).map((t) => t.instance as string));
  const step = useStep(groups.working.length > 0);
  const kinds: Kind[] = ["working", "upNext", "finished"];
  const kindOf = (id: string): Kind | null => kinds.find((k) => groups[k].some((i) => i.id === id)) ?? null;
  const inst =
    sel === "pip" ? null : [...groups.working, ...groups.upNext, ...groups.finished].find((i) => i.id === sel);
  const onPip = !inst;

  // opened on Finished: its group is in view
  const rail = useRef<HTMLDivElement>(null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: once, on open
  useLayoutEffect(() => {
    if (sel === "pip") return;
    rail.current?.querySelector(`[data-sel="${CSS.escape(sel)}"]`)?.scrollIntoView({ block: "nearest" });
  }, []);

  return (
    <Drawer
      id="agent-activity"
      title="What the crew is doing"
      open
      onClose={onClose}
      closedby="closerequest"
      closeLabel="Close"
      size="lg"
      className="activity"
    >
      <div className="activity-frame">
        {picker && <div className="activity-picker">{picker}</div>}
        <div className="activity-layout" data-instances="">
          <nav className="activity-crew" aria-label="The crew" ref={rail}>
            <button
              type="button"
              className="activity-who activity-who-pip"
              aria-current={onPip ? "true" : undefined}
              data-sel="pip"
              onClick={() => setSel("pip")}
            >
              <PipFace mood={pipMood(pip, pipKey ? state : null)} size="md" dot={hasNews(pip) && !onPip} />
              <span className="activity-who-text">
                <span className="activity-who-name">Pip</span>
                <span className="activity-who-role">Leads the crew</span>
                <span className="activity-who-line">{pipLine(pip)}</span>
              </span>
            </button>
            {kinds.map((k) =>
              groups[k].length ? (
                <section key={k} className="activity-group-list" aria-labelledby={`activity-g-${k}`}>
                  <h3 className="label activity-crew-label" id={`activity-g-${k}`}>
                    {GROUP_WORD[k]} · <bdi>{groups[k].length}</bdi>
                  </h3>
                  <ul className="activity-rows">
                    {groups[k].map((i, j) => (
                      <li key={i.id}>
                        <button
                          type="button"
                          className="activity-who"
                          data-kind={k}
                          data-sel={i.id}
                          aria-current={sel === i.id ? "true" : undefined}
                          onClick={() => setSel(i.id)}
                        >
                          <CrewFace
                            member={memberOf(i.role)}
                            role={i.role}
                            mood={moodOf(i, k, state, stuck)}
                            step={step + j}
                          />
                          <span className="activity-who-text">
                            <span className="activity-who-name" dir="auto">
                              {i.label}
                            </span>
                            <span className="activity-who-line" dir="auto">
                              {k === "finished" ? (
                                <bdi>{finishedLine(i)}</bdi>
                              ) : k === "upNext" ? (
                                ghostLine(i.id, state)
                              ) : (
                                lineOf(i, state, stuck)
                              )}
                            </span>
                          </span>
                        </button>
                      </li>
                    ))}
                  </ul>
                </section>
              ) : null,
            )}
          </nav>
          {onPip || !inst ? (
            <PipPane projectId={pipKey} state={pipKey ? state : null} conv={pip} panelId="agent-activity-panel" />
          ) : (
            <InstancePane
              key={inst.id}
              projectId={projectId}
              state={state}
              inst={inst}
              kind={kindOf(inst.id) ?? "upNext"}
              mood={moodOf(inst, kindOf(inst.id) ?? "upNext", state, stuck)}
              step={step}
              currentScene={currentScene}
              onAsk={() => {
                setSel("pip");
                askPipAbout(pipKey, `About the ${inst.label}${pipKey ? "" : ` on ${state.doc.title}`}: `, {
                  instance: inst.id,
                });
              }}
            />
          )}
        </div>
      </div>
    </Drawer>
  );
}

/** a working member's one line: its task, or that it waits on you, or the problem */
function lineOf(i: Instance, s: ProjectState, stuck: Set<string>): string {
  if (stuck.has(i.id)) return s.status?.problem?.text ?? "Stuck";
  const t = s.tasks.find((x) => x.instance === i.id && (x.status === "working" || x.status === "waiting_user"));
  if (t?.status === "waiting_user") return "Waiting for you";
  return t?.title ?? "Working";
}

const timeEl = (iso: string | null | undefined) =>
  iso ? (
    <time dateTime={iso}>
      <bdi>{clock(new Date(iso))}</bdi>
    </time>
  ) : null;

function InstancePane({
  projectId,
  state,
  inst,
  kind,
  mood,
  step,
  currentScene,
  onAsk,
}: {
  projectId: string;
  state: ProjectState;
  inst: Instance;
  kind: Kind;
  mood: Mood;
  step: number;
  currentScene?: () => string | undefined;
  onAsk: () => void;
}) {
  const kept = kind === "finished";
  const tasks = visibleTasks(state.tasks.filter((t) => t.instance === inst.id))
    .map((t, i) => ({ t, i }))
    .sort((a, b) => startOf(a.t) - startOf(b.t) || a.i - b.i)
    .map((x) => x.t);

  // the kept log (finished), or each task's transcript (working); live lines merge in from state.activity
  const [log, setLog] = useState<InstanceLog | null | "error" | undefined>(undefined);
  const [fetched, setFetched] = useState<Record<string, ActivityEntry[] | null | "error">>({});
  const ids = tasks.map((t) => t.id).join(",");
  useEffect(() => {
    let live = true;
    if (kept)
      client.instanceLog(projectId, inst.id).then(
        (l) => live && setLog(l),
        () => live && setLog("error"),
      );
    return () => {
      live = false;
    };
  }, [projectId, inst.id, kept]);
  const asked = useRef(new Set<string>());
  useEffect(() => {
    // a kept log covers its tasks; the transcripts are only asked for while working, or when no log is kept
    if (kept && log !== null && log !== "error") return;
    for (const id of ids.split(",").filter(Boolean)) {
      if (asked.current.has(id)) continue;
      asked.current.add(id);
      client.taskTranscript(projectId, id).then(
        (list) => setFetched((f) => ({ ...f, [id]: list })),
        () => {
          asked.current.delete(id);
          setFetched((f) => ({ ...f, [id]: "error" }));
        },
      );
    }
  }, [projectId, ids, kept, log]);

  const fromLog = log && log !== "error" ? log.entries : null;
  const groups = tasks.map((t) => {
    const f = fetched[t.id];
    const base = fromLog
      ? fromLog.flatMap((e) => {
          if (e.source !== "task" || e.taskId !== t.id) return [];
          const { source: _s, taskId: _t, ...rest } = e;
          return [rest as ActivityEntry];
        })
      : f === "error"
        ? null
        : (f ?? null);
    return {
      t,
      loading: !fromLog && f === undefined && !(kept && log === undefined),
      failed: !fromLog && f === "error",
      entries: mergeEntries(base, state.activity?.[t.id]),
    };
  });

  // its messages with Pip: the log's when it is kept, else the channel's, by instance
  const channel = useChannel(projectId);
  const msgs: ChannelMsg[] = useMemo(
    () =>
      fromLog
        ? fromLog.flatMap((e) => (e.source === "channel" ? [e.msg] : []))
        : msgsOf(inst, channel, state.instances ?? []),
    [fromLog, channel, inst, state.instances],
  );

  // a return shows as a hairline marker before the first task that started in its life
  const marks = new Map<string, string>();
  for (const life of inst.lives.slice(1)) {
    const t = tasks.find((x) => Date.parse(x.startedAt ?? "") >= Date.parse(life.from) && !marks.has(x.id));
    if (t) marks.set(t.id, life.from);
  }

  const word =
    kind === "finished" && inst.outcome
      ? OUTCOME_WORD[inst.outcome]
      : kind === "upNext"
        ? "Up next"
        : mood === "stuck"
          ? "Stuck"
          : mood === "needs"
            ? "Waiting for you"
            : "Working";
  const joined = inst.lives[0]?.from ?? inst.spawnedAt;
  return (
    <section
      className="activity-main"
      id="agent-activity-panel"
      aria-labelledby="activity-inst-name"
      style={{ "--who-hue": `var(--category-${ROLE_HUE[inst.role]})` } as CSSProperties}
    >
      <header className="activity-head">
        <CrewFace member={memberOf(inst.role)} role={inst.role} mood={mood} step={step} size="lg" />
        <div className="activity-head-text">
          <div className="activity-name-row">
            <h3 className="activity-name" id="activity-inst-name" dir="auto">
              {inst.label}
            </h3>
            {inst.model && (
              <Tag variant="chip" size="sm" as="span" title="The model its latest task ran on">
                <bdi>{modelWords(inst.model)}</bdi>
              </Tag>
            )}
          </div>
          <p className="activity-now" dir="auto">
            <bdi>{word}</bdi>
            {inst.usd > 0 && (
              <>
                {" · "}
                <bdi>{usd(inst.usd)}</bdi>
              </>
            )}
            {kept && joined && (
              <>
                {" · "}Joined {timeEl(joined)}
                {inst.endedAt && <> · Left {timeEl(inst.endedAt)}</>}
              </>
            )}
          </p>
          {kind === "upNext" && (
            <p className="activity-now" dir="auto">
              {ghostLine(inst.id, state)}
            </p>
          )}
          {inst.reason && (
            <p className="activity-now activity-reason" dir="auto">
              Joined “{bubbleOfReason(inst.reason)}.”
              {kept && inst.endReason && <> Left “{inst.endReason.replace(/\.?$/, ".")}”</>}
            </p>
          )}
        </div>
      </header>
      <div className="activity-thread-wrap">
        <div className="activity-thread">
          {!groups.length && (
            <p className="activity-empty muted">
              {kind === "upNext"
                ? `${inst.label} hasn't started yet. What it does will show up here.`
                : "Nothing to show yet."}
            </p>
          )}
          {groups.map((g) => (
            <Fragment key={g.t.id}>
              {marks.has(g.t.id) && (
                <p className="activity-return small muted">Back for a fix · {timeEl(marks.get(g.t.id))}</p>
              )}
              <TaskGroup
                task={g.t}
                tries={1}
                showTry={false}
                entries={g.entries}
                loading={g.loading}
                failed={g.failed}
                headModel={inst.model ?? undefined}
              />
            </Fragment>
          ))}
          {msgs.length > 0 && (
            <div className="activity-behind activity-behind-kept">
              <BehindTheScenes projectId={projectId} only={msgs} />
            </div>
          )}
        </div>
      </div>
      <div className="activity-steer">
        <Button size="sm" variant={kept ? "primary" : "ghost"} onClick={onAsk}>
          Ask Pip about this
        </Button>
        {!kept && (
          <DirectControls who={`the ${inst.label}`}>
            <Compose
              key={inst.id}
              projectId={projectId}
              member={memberOf(inst.role)}
              role={inst.role}
              currentScene={currentScene}
            />
          </DirectControls>
        )}
      </div>
    </section>
  );
}
