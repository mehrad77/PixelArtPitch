// What an agent is doing, for the person who asks: a side sheet with the crew down the start edge, the chosen
// member's tasks as a calm thread of what it did and found (model calls, tool calls, changes, answers, errors),
// and a message box that sends it a note. Hidden by default; opened from a face's popover or a Studio Details drawer.
// Live lines land at the bottom; the thread follows them only when the reader is already there.
import { Badge, Button, Disclosure, Drawer, Field, Icon, Switch, Tag } from "@shabboo/kit/react";
import {
  type CSSProperties,
  type FormEvent,
  type KeyboardEvent,
  type ReactNode,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import {
  answerStats,
  entryLine,
  groupTitle,
  mergeEntries,
  parseModel,
  parseTool,
  pretty,
  progressLine,
  promptOf,
  type StepWords,
  stepsOf,
  toolWords,
  variantOf,
} from "../lib/activity.ts";
import { client } from "../lib/client.ts";
import { TASK_STATUS } from "../lib/derive.ts";
import { useExperiment } from "../lib/experiments.ts";
import { clock, duration } from "../lib/format.ts";
import { useLoad } from "../lib/hooks.ts";
import { isRecovered, type Member, modelShort, modelWords, retriesOf } from "../lib/human.ts";
import { askPipAbout, type Conv, hasNews, markSeen, pipMood, usePip, usePipOpenRequest } from "../lib/pip.ts";
import { navigate } from "../lib/router.tsx";
import type { ActivityEntry, ProjectState, Role, Task, TaskProgress } from "../lib/types.ts";
import { Clamp } from "./Clamp.tsx";
import { LiveCanvas } from "./LiveCanvas.tsx";

/** a reviewer's verdict word ("fix:", "ship:") reads as plain words */
function plainSummary(s: string | undefined): string | undefined {
  if (!s) return s;
  const m = /^(fix|ship|revise|reject)\s*:\s*/i.exec(s);
  if (!m) return s;
  const words = { fix: "Needs fixes", ship: "Ready to ship", revise: "Needs changes", reject: "Not usable" };
  return `${words[m[1].toLowerCase() as keyof typeof words]}. ${s.slice(m[0].length)}`;
}

import { hasInstances } from "../lib/instances.ts";
import { needsItems } from "../lib/needs.ts";
import { BehindTheScenes } from "./Channel.tsx";
import { CrewDrawer } from "./CrewDrawer.tsx";
import { CrewFace, crewRows, MOOD_WORD, useStep } from "./CrewStrip.tsx";
import { DirectControls } from "./DirectControls.tsx";
import { NeedsItemView } from "./NeedsYouCard.tsx";
import { PipComposer, PipThread } from "./Pip.tsx";
import { PipFace } from "./PipFace.tsx";
import "./AgentActivity.css";

const startOf = (t: Task) => Date.parse(t.startedAt ?? "") || Number.POSITIVE_INFINITY;
const article = (m: Member) => `the ${m.label}`;

export type ActivityProps = {
  projectId: string;
  state: ProjectState;
  /** the member to open on: a CREW id; with instances also an instance id, "pip" or "finished" */
  memberId: string;
  /** a task to show even when it is a retried attempt (Studio's Details) */
  focusTask?: string;
  /** the scene a message is about, when the caller knows one */
  currentScene?: () => string | undefined;
  onClose: () => void;
  /** above the crew: a project picker (the header's Crew button, when there is more than one project) */
  picker?: ReactNode;
  /** Pip, pinned first: whose conversation it shows (null: the workspace); undefined: this project's */
  pipProject?: string | null;
};

/** the crew drawer: the members that come and go once the server sends instances (PIP-JOURNEY §3.3), else the
    departments */
export function AgentActivity(props: ActivityProps) {
  return hasInstances(props.state) ? <CrewDrawer {...props} /> : <DepartmentActivity {...props} />;
}

function DepartmentActivity({
  projectId,
  state,
  memberId,
  focusTask,
  currentScene,
  onClose,
  picker,
  pipProject,
}: ActivityProps) {
  const rows = crewRows(state);
  // the model each role is set to for its next step; the drawer is the place that names models
  const settings = useLoad(() => client.settings(), []);
  const [sel, setSel] = useState(memberId);
  const pipKey = pipProject === undefined ? projectId : pipProject;
  const pip = usePip(pipKey);
  usePipOpenRequest(pipKey, () => setSel("pip"));
  const onPip = sel === "pip";
  const row = rows.find((r) => r.m.id === sel) ?? rows[0];
  const tabIds = ["pip", ...rows.map((r) => r.m.id)];
  const step = useStep(rows.some((r) => r.mood === "working"));
  const focused = focusTask ? state.tasks.find((t) => t.id === focusTask) : undefined;
  const [showRetries, setShowRetries] = useState(focused ? isRecovered(focused, state.tasks) : false);

  // every task of this member, oldest first; superseded tries only on request
  const all = state.tasks.filter((t) => row.m.roles.includes(t.role));
  const shown = all
    .filter((t) => (showRetries ? true : !isRecovered(t, all)))
    .filter((t) => t.startedAt || state.activity?.[t.id]?.length || t.status !== "upcoming")
    .map((t, i) => ({ t, i }))
    .sort((a, b) => startOf(a.t) - startOf(b.t) || a.i - b.i)
    .map((x) => x.t);

  // fetch each task's transcript once; live lines merge in from state.activity
  const [fetched, setFetched] = useState<Record<string, ActivityEntry[] | null | "error">>({});
  const asked = useRef(new Set<string>());
  const fetchedRef = useRef(fetched);
  fetchedRef.current = fetched;
  const ids = all.map((t) => t.id).join(",");
  useEffect(() => {
    let live = true;
    for (const id of ids.split(",").filter(Boolean)) {
      if (asked.current.has(id)) continue;
      asked.current.add(id);
      client.taskTranscript(projectId, id).then(
        (list) => live && setFetched((f) => ({ ...f, [id]: list })),
        () => {
          asked.current.delete(id);
          if (live) setFetched((f) => ({ ...f, [id]: "error" }));
        },
      );
    }
    return () => {
      live = false;
      // StrictMode runs this twice: let the second run ask again for what the first never got
      for (const id of ids.split(",")) if (!(id in fetchedRef.current)) asked.current.delete(id);
    };
  }, [projectId, ids]);

  const groups = shown.map((t) => {
    const f = fetched[t.id];
    return {
      t,
      loading: f === undefined,
      failed: f === "error",
      entries: mergeEntries(f === "error" ? null : f, state.activity?.[t.id]),
    };
  });
  const count = groups.reduce((a, g) => a + g.entries.length, 0);

  // follow new lines only when the reader is already at the bottom; never move focus
  const threadRef = useRef<HTMLDivElement>(null);
  const atBottom = useRef(true);
  const lastCount = useRef(0);
  const [fresh, setFresh] = useState(false);
  const toBottom = () => {
    const el = threadRef.current;
    if (el) el.scrollTop = el.scrollHeight;
    atBottom.current = true;
    setFresh(false);
  };
  // biome-ignore lint/correctness/useExhaustiveDependencies: a new member starts at its newest line
  useLayoutEffect(() => {
    lastCount.current = 0;
    toBottom();
  }, [sel, showRetries]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: runs on the line count alone
  useLayoutEffect(() => {
    if (count > lastCount.current) {
      if (atBottom.current) toBottom();
      else if (lastCount.current > 0) setFresh(true);
    }
    lastCount.current = count;
  }, [count]);
  // a picture decodes after the line lands: keep the bottom in view if the reader was there
  useEffect(() => {
    const el = threadRef.current;
    if (!el) return;
    const h = () => {
      if (atBottom.current) el.scrollTop = el.scrollHeight;
    };
    el.addEventListener("load", h, true);
    return () => el.removeEventListener("load", h, true);
  }, []);
  const onScroll = () => {
    const el = threadRef.current;
    if (!el) return;
    atBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
    if (atBottom.current) setFresh(false);
  };

  // ↑/↓ between members when the switcher has focus (roving tabindex)
  const tabs = useRef<(HTMLButtonElement | null)[]>([]);
  const onTabKey = (e: KeyboardEvent<HTMLButtonElement>, i: number) => {
    const dir = e.key === "ArrowDown" ? 1 : e.key === "ArrowUp" ? -1 : e.key === "Home" ? -i : e.key === "End" ? 99 : 0;
    if (!dir) return;
    e.preventDefault();
    const n = Math.max(0, Math.min(tabIds.length - 1, i + dir));
    setSel(tabIds[n]);
    tabs.current[n]?.focus();
  };

  const lastLine = (tasks: Task[]) => {
    const entries = tasks.flatMap((t) => {
      const f = fetched[t.id];
      return mergeEntries(Array.isArray(f) ? f : null, state.activity?.[t.id]);
    });
    const newest = entries.sort((a, b) => Date.parse(a.at) - Date.parse(b.at)).at(-1);
    return newest ? entryLine(newest) : null;
  };
  const summary = plainSummary([...row.tasks].reverse().find((t) => t.summary)?.summary);
  const headLine =
    row.mood === "working" || row.mood === "needs" || row.mood === "stuck" || !summary ? row.line : summary;
  const role: Role = row.lead?.role ?? row.m.roles[0];
  const panelId = "agent-activity-panel";
  // the model the member's current (or latest) task runs on, and the one Settings assigns for the next step
  const latest = row.lead?.model
    ? row.lead
    : [...all].reverse().find((t) => t.model && (t.startedAt || t.status !== "upcoming"));
  const nowModel = latest?.model;
  const nextModel = settings.data?.roles?.[latest?.role ?? role]?.model;
  const modelChip =
    nowModel && nextModel && nextModel !== nowModel
      ? `now: ${modelWords(nowModel)} · next: ${modelWords(nextModel)}`
      : modelWords(nowModel ?? nextModel);

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
        <div className="activity-layout">
          <div className="activity-crew" role="tablist" aria-orientation="vertical" aria-label="The crew">
            <button
              ref={(el) => {
                tabs.current[0] = el;
              }}
              type="button"
              role="tab"
              id="activity-tab-pip"
              aria-selected={onPip}
              aria-controls={panelId}
              tabIndex={onPip ? 0 : -1}
              className="activity-who activity-who-pip"
              onClick={() => setSel("pip")}
              onKeyDown={(e) => onTabKey(e, 0)}
            >
              <PipFace mood={pipMood(pip, pipKey ? state : null)} size="md" dot={hasNews(pip) && !onPip} />
              <span className="activity-who-text">
                <span className="activity-who-name">Pip</span>
                <span className="activity-who-role">Leads the crew</span>
                <span className="activity-who-line">{pipLine(pip, pipKey ? state : null)}</span>
              </span>
            </button>
            <p className="label activity-crew-label" aria-hidden="true">
              Crew
            </p>
            {rows.map((r, j) => {
              const i = j + 1;
              const on = !onPip && r.m.id === row.m.id;
              return (
                <button
                  key={r.m.id}
                  ref={(el) => {
                    tabs.current[i] = el;
                  }}
                  type="button"
                  role="tab"
                  id={`activity-tab-${r.m.id}`}
                  aria-selected={on}
                  aria-controls={panelId}
                  tabIndex={on ? 0 : -1}
                  className="activity-who"
                  onClick={() => setSel(r.m.id)}
                  onKeyDown={(e) => onTabKey(e, i)}
                >
                  <CrewFace member={r.m} mood={r.mood} step={step + i} />
                  <span className="activity-who-text">
                    <span className="activity-who-name">{r.m.label}</span>
                    <span className="activity-who-line">
                      {lastLine(r.tasks) ?? MOOD_WORD[r.mood].replace(/^./, (c) => c.toUpperCase())}
                    </span>
                  </span>
                </button>
              );
            })}
          </div>

          {onPip ? (
            <PipPane projectId={pipKey} state={pipKey ? state : null} conv={pip} panelId={panelId} />
          ) : (
            <section
              className="activity-main"
              id={panelId}
              role="tabpanel"
              aria-labelledby={`activity-tab-${row.m.id}`}
              style={{ "--who-hue": `var(--category-${row.m.hue})` } as CSSProperties}
            >
              <header className="activity-head">
                <CrewFace member={row.m} mood={row.mood} step={step} size="lg" />
                <div className="activity-head-text">
                  <div className="activity-name-row">
                    <h3 className="activity-name">{row.m.label}</h3>
                    <Tag
                      variant="chip"
                      size="sm"
                      href="/settings/roles"
                      title="Model in use. Change it in Settings › Roles"
                      aria-label={`Model: ${modelChip}. Open Settings, Roles`}
                      onClick={(e) => {
                        if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
                        e.preventDefault();
                        onClose();
                        navigate("/settings/roles");
                      }}
                    >
                      {modelChip}
                    </Tag>
                  </div>
                  <Clamp className="activity-now">
                    <span className="visually-hidden">{MOOD_WORD[row.mood]}: </span>
                    {headLine}
                  </Clamp>
                </div>
                <Switch
                  id="activity-retries"
                  size="sm"
                  label="Show retries"
                  checked={showRetries}
                  onChange={(e) => setShowRetries(e.currentTarget.checked)}
                  className="activity-retries"
                />
              </header>
              <div className="activity-behind">
                <BehindTheScenes projectId={projectId} roles={row.m.roles} />
              </div>

              <div className="activity-thread-wrap">
                <div className="activity-thread" ref={threadRef} onScroll={onScroll}>
                  {!groups.length && (
                    <p className="activity-empty muted">
                      {row.mood === "later"
                        ? `${row.m.label} hasn't started yet. What it does will show up here.`
                        : "Nothing has happened here yet."}
                    </p>
                  )}
                  {groups.map((g) => (
                    <TaskGroup
                      key={g.t.id}
                      task={g.t}
                      tries={retriesOf(g.t, all) + 1}
                      showTry={showRetries}
                      entries={g.entries}
                      loading={g.loading}
                      failed={g.failed}
                      headModel={nowModel}
                      live={state.progress?.[g.t.id]}
                    />
                  ))}
                </div>
                {fresh && (
                  <Button size="sm" variant="primary" className="activity-fresh" onClick={toBottom}>
                    New activity ↓
                  </Button>
                )}
              </div>

              <div className="activity-steer">
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => {
                    setSel("pip");
                    askPipAbout(pipKey, {
                      label: `the ${row.m.label.toLowerCase()}'s work${pipKey ? "" : ` on ${state.doc.title}`}`,
                    });
                  }}
                >
                  Ask Pip about this
                </Button>
                <DirectControls who={article(row.m)}>
                  <Compose
                    key={row.m.id}
                    projectId={projectId}
                    member={row.m}
                    role={role}
                    currentScene={currentScene}
                  />
                </DirectControls>
              </div>
            </section>
          )}
        </div>
      </div>
    </Drawer>
  );
}

/** Pip's one line in the list, like the crew's */
export function pipLine(c: Conv, state?: ProjectState | null): string {
  if (c.thinking) return "Thinking…";
  // what needs you is asked in Pip's pane too
  if (state && needsItems(state).length) return "Waiting for your answer";
  const last = [...c.items].reverse().find((i) => i.kind === "pip");
  if (
    last?.kind === "pip" &&
    last.cards.some((k) => (k.type === "plan" && k.status === "proposed") || (k.type === "form" && k.status === "open"))
  )
    return "Waiting for your answer";
  if (hasNews(c)) return "Has something for you";
  return "Here when you need me";
}

/** Pip in the drawer's right pane: the same header, a thread, and the field at the bottom */
export function PipPane({
  projectId,
  state,
  conv,
  panelId,
}: {
  projectId: string | null;
  state: ProjectState | null;
  conv: Conv;
  panelId: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  // what needs the person, asked here too, at the thread's newest end (the same parts as under Pip's line)
  const needs = projectId && state ? needsItems(state) : [];
  const n = `${conv.items.length}|${conv.thinking}|${JSON.stringify(conv.items.at(-1) ?? "").length}|${needs.map((x) => x.key).join()}|${state?.milestones?.length ?? 0}`;
  // biome-ignore lint/correctness/useExhaustiveDependencies: follows the newest item
  useLayoutEffect(() => {
    const el = ref.current;
    if (el) el.scrollTop = el.scrollHeight;
    markSeen(projectId);
  }, [n]);
  return (
    <section className="activity-main activity-pip" id={panelId} role="tabpanel" aria-labelledby="activity-tab-pip">
      <header className="activity-head">
        <PipFace mood={pipMood(conv, state)} size="lg" />
        <div className="activity-head-text">
          <div className="activity-name-row">
            <h3 className="activity-name">Pip</h3>
            {conv.model && (
              <Tag variant="chip" size="sm" title="Pip's model. Change it in Settings › Roles">
                {modelWords(conv.model)}
              </Tag>
            )}
          </div>
          <p className="activity-now">
            {projectId
              ? "Ask me anything about this video. I'll plan it with the crew."
              : "Ask about any project, or start a new one."}
          </p>
        </div>
      </header>
      {projectId && (
        <div className="activity-behind">
          <BehindTheScenes projectId={projectId} />
        </div>
      )}
      <div className="activity-thread-wrap">
        <div className="activity-thread" ref={ref}>
          <PipThread
            project={projectId}
            conv={conv}
            markers={projectId ? state?.milestones : undefined}
            asks={
              projectId && state && needs.length ? (
                <li className="pip-asks">
                  <p className="label pip-asks-head">
                    Waiting for you{needs.length > 1 ? <bdi>{` · ${needs.length}`}</bdi> : null}
                  </p>
                  <ul className="pip-asks-list">
                    {needs.map((item, i) => (
                      <li key={item.key} className="pip-ask-item" aria-labelledby={`drawer-${i}-needs-title`}>
                        <NeedsItemView projectId={projectId} state={state} item={item} where={`drawer-${i}`} />
                      </li>
                    ))}
                  </ul>
                </li>
              ) : null
            }
          />
        </div>
      </div>
      <div className="activity-compose activity-pip-compose">
        <PipComposer project={projectId} inputId="pip-drawer-input" conv={conv} state={state} />
      </div>
    </section>
  );
}

export function TaskGroup({
  task,
  tries,
  showTry,
  entries,
  loading,
  failed,
  headModel,
  live,
}: {
  task: Task;
  tries: number;
  showTry: boolean;
  entries: ActivityEntry[];
  loading: boolean;
  failed: boolean;
  /** the model the member's header already names: a task on the same one doesn't repeat it */
  headModel?: string;
  /** the working step's model call as it streams (the `progress` event) */
  live?: TaskProgress;
}) {
  const st = TASK_STATUS[task.status];
  const ownModel = task.model && task.model !== "mixed" && task.model !== headModel ? task.model : undefined;
  const from = Date.parse(task.startedAt ?? "");
  // a run without an end time is still going, or stopped at its last line
  const to =
    Date.parse(task.endedAt ?? "") ||
    (task.status === "working" ? Date.now() : Date.parse(entries.at(-1)?.at ?? "") || Date.now());
  const lastAnswer = entries.findLastIndex((e) => e.kind === "answer");
  // each model step named from its prompt card ("Drew variant 2"); an answer takes its call's name
  const steps = stepsOf(entries, task.title);
  const streaming = task.status === "working" && live ? live : undefined;
  const meta = [
    showTry && (task.attempt ?? 1) > 1 ? `try ${task.attempt}` : !showTry && tries > 1 ? `${tries} tries` : null,
    Number.isFinite(from) ? duration((to - from) / 1000) : null,
  ].filter(Boolean);
  return (
    <section className="activity-group" aria-label={groupTitle(task)}>
      <h4 className="activity-group-head">
        <span className="activity-group-title">
          {groupTitle(task)}
          {meta.length > 0 && <span className="muted"> · {meta.join(" · ")}</span>}
          {ownModel && <span className="muted"> · {modelShort(ownModel)}</span>}
        </span>
        <span className="activity-group-side">
          <Badge tone={st.tone} variant="text" size="sm" live={task.status === "working"}>
            {st.word}
          </Badge>
          {Number.isFinite(from) && (
            <time className="muted" dateTime={task.startedAt}>
              {clock(new Date(from))}
            </time>
          )}
        </span>
      </h4>
      {loading && !entries.length && <p className="muted small">Loading what it did…</p>}
      {failed && !entries.length && (
        <p className="muted small">Couldn't load what it did. Close and open this again.</p>
      )}
      {!loading && !failed && !entries.length && !streaming && (
        <p className="muted small">
          {task.status === "upcoming" || task.status === "queued"
            ? "Not started yet."
            : task.status === "working"
              ? "Starting…"
              : "No record kept for this one."}
        </p>
      )}
      <ol className="activity-bubbles">
        {entries.map((e, i) => (
          <li key={`${e.at}|${e.kind}|${e.title}`} className="activity-bubble" data-kind={e.kind}>
            <Bubble entry={e} task={task} last={i === lastAnswer} step={steps[i]} />
          </li>
        ))}
        {streaming && (
          <li className="activity-bubble activity-live" data-kind="live">
            <LiveStep live={streaming} task={task} />
          </li>
        )}
      </ol>
    </section>
  );
}

/** a Disclosure whose body renders only once opened: 500 lines of JSON and pictures add up */
function Lazy({ summary, children, quiet }: { summary: string; children: () => ReactNode; quiet?: boolean }) {
  const [open, setOpen] = useState(false);
  return (
    <Disclosure
      size="sm"
      summary={summary}
      className={quiet ? "activity-more activity-reasoning" : "activity-more"}
      onToggle={(e) => setOpen((e.currentTarget as HTMLDetailsElement).open)}
    >
      {open ? children() : null}
    </Disclosure>
  );
}

const Code = ({ text }: { text: string }) => (
  <pre className="activity-code" dir="ltr" translate="no">
    {text}
  </pre>
);

/** the step's mark: a small icon that stays in view when the step's details are folded */
function StepMark({ step }: { step: StepWords }) {
  return (
    <span className="activity-step-mark" aria-hidden="true">
      <Icon name={step.icon} size="sm" />
    </span>
  );
}

/**
 * The working step, live (docs/API.md `progress`): "Thinking… about 4,200 tokens · 48 s", the answer's newest words
 * as they stream, and, with the live-canvas experiment on, a drawing's grid row by row.
 */
export function LiveStep({ live, task }: { live: TaskProgress; task: Task }) {
  const canvas = useExperiment("liveCanvas");
  const v = variantOf(task.title);
  return (
    <div className="activity-bubble-inner">
      <p className="activity-step">
        <span className="activity-step-mark" aria-hidden="true">
          <Icon name={live.phase === "writing" ? "edit" : "flask"} size="sm" />
        </span>
        <span>{progressLine(live)}</span>
      </p>
      {canvas && live.draft && (
        <LiveCanvas draft={live.draft} palette={live.palette} label={v ? `Variant ${v}` : undefined} />
      )}
      {live.tail && live.phase === "writing" && !(canvas && live.draft) && (
        <p className="activity-tail mono small" dir="auto" translate="no">
          …{live.tail.slice(-280)}
        </p>
      )}
    </div>
  );
}

function Bubble({
  entry: e,
  task,
  last,
  step,
}: {
  entry: ActivityEntry;
  task: Task;
  last: boolean;
  /** the model step this entry is (a call) or answers */
  step?: StepWords | null;
}) {
  const time = (
    <time className="activity-time" dateTime={e.at}>
      {clock(new Date(e.at))}
    </time>
  );
  let body: ReactNode;
  switch (e.kind) {
    case "model": {
      const { model, card } = parseModel(e.title);
      const prompt = promptOf(e.detail);
      body = (
        <>
          {/* the model is in the member's header; a call only names it when it went elsewhere (an escalation) */}
          <p className="activity-step">
            {step && <StepMark step={step} />}
            <span>
              {step?.ask ?? "Sent the prompt"}
              {model && task.model && modelShort(task.model) !== modelShort(model) && (
                <>
                  {" · on "}
                  <span className="muted mono" translate="no" title={model}>
                    {model}
                  </span>
                </>
              )}
            </span>
          </p>
          {prompt && <Lazy summary="Show prompt">{() => <Code text={card ? `${card}\n\n${prompt}` : prompt} />}</Lazy>}
        </>
      );
      break;
    }
    case "tool": {
      const t = parseTool(e.title);
      body = (
        <div className="activity-tool" data-ok={t.ok}>
          <p className="activity-tool-line">
            <span className="activity-tool-mark" aria-hidden="true">
              {t.ok ? "✓" : "✕"}
            </span>
            <span>
              {toolWords(t.name)}
              <span className="visually-hidden">{t.ok ? ", worked" : ", didn't work"}</span>
              {!t.ok && t.code && <span className="muted"> ({t.code.replace(/_/g, " ")})</span>}
            </span>
            <span className="muted mono small" translate="no">
              {t.name}
            </span>
          </p>
          {e.image && (
            <img
              className="activity-image pixelated"
              src={e.image}
              alt={`What ${toolWords(t.name).toLowerCase()} returned`}
              loading="lazy"
            />
          )}
          {e.detail !== undefined && (
            <Lazy summary="Show input and result">{() => <Code text={pretty(e.detail)} />}</Lazy>
          )}
        </div>
      );
      break;
    }
    case "patch":
      body = (
        <>
          <Clamp>{e.title.startsWith("Changed the project") ? e.title : `Changed the project: ${e.title}`}</Clamp>
          {e.detail !== undefined && <Lazy summary="Show the changes">{() => <Code text={pretty(e.detail)} />}</Lazy>}
        </>
      );
      break;
    case "answer":
      body = (
        <>
          <p className="activity-step">
            {step && <StepMark step={step} />}
            <span>{step?.done ?? "Answered"}</span>
          </p>
          {last && task.summary && <Clamp lines={3}>{plainSummary(task.summary)}</Clamp>}
          <p className="muted small">{answerStats(e.title)}</p>
          {e.detail !== undefined && <Lazy summary="Show answer">{() => <Code text={pretty(e.detail)} />}</Lazy>}
        </>
      );
      break;
    case "error":
      body = (
        <>
          <p>
            Something went wrong, so I stopped.
            {task.supersededBy ? " The crew tried again." : ""}
          </p>
          <Lazy summary="Show the error">
            {() => <Code text={e.detail !== undefined ? `${e.title}\n\n${pretty(e.detail)}` : e.title} />}
          </Lazy>
        </>
      );
      break;
    default:
      body = <p>{e.title}</p>;
  }
  return (
    <div className="activity-bubble-inner">
      {body}
      {e.thinking && (
        <Lazy summary="Show its reasoning" quiet>
          {() => <p className="activity-thinking">{e.thinking}</p>}
        </Lazy>
      )}
      {time}
    </div>
  );
}

export function Compose({
  projectId,
  member,
  role,
  currentScene,
}: {
  projectId: string;
  member: Member;
  role: Role;
  currentScene?: () => string | undefined;
}) {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [said, setSaid] = useState<{ ok: boolean; text: string } | null>(null);
  const who = article(member);
  const send = async (e: FormEvent) => {
    e.preventDefault();
    const body = text.trim();
    if (!body || busy) return;
    setBusy(true);
    setSaid(null);
    try {
      const scene = currentScene?.();
      await client.addNote(projectId, {
        target: scene ? { scene } : {},
        category: "other",
        text: body,
        assignee: role,
      });
      setText("");
      setSaid({ ok: true, text: `Sent. ${who.replace(/^t/, "T")} will see it on its next step.` });
    } catch (ex) {
      setSaid({ ok: false, text: `Didn't send: ${(ex as Error).message}. Your message is still here.` });
    } finally {
      setBusy(false);
    }
  };
  return (
    <form className="activity-compose" onSubmit={send} aria-busy={busy ? "true" : undefined}>
      <Field
        id="activity-message"
        label={`Message ${who}`}
        className="activity-compose-field"
        placeholder={`Message ${who}…`}
        value={text}
        autoComplete="off"
        onChange={(ev) => {
          setText(ev.currentTarget.value);
          if (said?.ok) setSaid(null);
        }}
      />
      <Button type="submit" variant="primary" aria-disabled={!text.trim() || busy ? "true" : undefined}>
        Send
      </Button>
      <p className="activity-sent small" role="status" data-ok={said?.ok}>
        {said?.text ?? ""}
      </p>
    </form>
  );
}
