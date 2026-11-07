// The Crew tab: one row per department, expandable to its instances. A row opens a Drawer with the summary,
// the outputs, the decisions and the transcript. Errors stay on the row, with the fix in words; never a toast.
import { Badge, Button, Disclosure, Drawer, EmptyState, ProgressBar, Tag } from "@shabboo/kit/react";
import { useEffect, useState } from "react";
import { client } from "../lib/client.ts";
import { DEPARTMENTS, type Department, leadTask, ROLE_LABEL, TASK_STATUS, taskProgress } from "../lib/derive.ts";
import { clock, duration, usd } from "../lib/format.ts";
import { memberOf, modelShort, plainTitle, retriesOf, STAGE_WORD, visibleTasks } from "../lib/human.ts";
import { crewGroups, ghostLine, hasInstances, OUTCOME_WORD, revisionLine, timeAlive } from "../lib/instances.ts";
import { askPipAbout } from "../lib/pip.ts";
import type { Instance, PlanRevisionSummary, ProjectState, Task } from "../lib/types.ts";
import { AgentActivity } from "./AgentActivity.tsx";
import { BehindTheScenes } from "./Channel.tsx";
import { CrewFace, type Mood } from "./CrewStrip.tsx";
import { PipPanel } from "./Pip.tsx";
import "./CrewRow.css";

const modelName = (m?: string) => (m ? modelShort(m) : "Model picked when it starts");

type PanelProps = {
  projectId: string;
  state: ProjectState;
  /** the scene at the playhead, for a message sent from the activity view */
  currentScene?: () => string | undefined;
};

/** the Crew tab: instance rows once the server sends instances (PIP-JOURNEY §3.4), the departments otherwise */
export function CrewPanel(props: PanelProps) {
  return hasInstances(props.state) ? <InstancePanel {...props} /> : <DepartmentPanel {...props} />;
}

function DepartmentPanel({ projectId, state, currentScene }: PanelProps) {
  const [open, setOpen] = useState<Task | null>(null);
  const [watch, setWatch] = useState<Task | null>(null);
  const [, force] = useState(0);
  // progress bars read elapsed time; repaint them every few seconds without moving anything
  useEffect(() => {
    const t = setInterval(() => force((x) => x + 1), 3000);
    return () => clearInterval(t);
  }, []);
  return (
    <div className="crew">
      <ul className="crew-list">
        {/* Pip, pinned first: the one to ask; the rows below are the workers */}
        <li className="crew-row crew-row-pip">
          <PipPanel project={projectId} state={state} inputId="pip-studio-input" />
          <BehindTheScenes projectId={projectId} />
        </li>
        {DEPARTMENTS.map((d) => (
          <CrewRow
            key={d.id}
            dept={d}
            state={state}
            tasks={state.tasks.filter((t) => d.roles.includes(t.role))}
            onOpen={setOpen}
          />
        ))}
      </ul>
      {open && (
        <TaskDrawer
          projectId={projectId}
          state={state}
          task={state.tasks.find((t) => t.id === open.id) ?? open}
          onClose={() => setOpen(null)}
          onWatch={(t) => {
            setOpen(null);
            setWatch(t);
          }}
        />
      )}
      {watch && (
        <AgentActivity
          projectId={projectId}
          state={state}
          memberId={memberOf(watch.role).id}
          focusTask={watch.id}
          currentScene={currentScene}
          onClose={() => setWatch(null)}
        />
      )}
    </div>
  );
}

export function CrewRow({
  dept,
  state,
  tasks: all,
  onOpen,
}: {
  dept: Department;
  state: ProjectState;
  tasks: Task[];
  onOpen: (t: Task) => void;
}) {
  // a failure a later try recovered isn't news: hide it, and say "Retried 1×" on the try that took over
  const tasks = visibleTasks(all);
  const retried = (t: Task) => retriesOf(t, all);
  const lead = leadTask(tasks);
  const spent = all.reduce((a, t) => a + t.usd, 0);
  const eta = tasks.filter((t) => t.status === "working").reduce((a, t) => Math.max(a, t.etaSec ?? 0), 0);
  const img = [...tasks].reverse().find((t) => t.lastImage)?.lastImage;
  const pid = `crew-${dept.id}`;
  if (!lead)
    return (
      <li className="crew-row" data-status="upcoming">
        <p className="crew-later">
          <span className="crew-dept">{dept.label}</span>
          <span className="muted">Joins with {dept.stages.map((st) => STAGE_WORD[st]).join(" or ")}</span>
        </p>
      </li>
    );
  const st = TASK_STATUS[lead.status];
  const p = taskProgress(lead);
  return (
    <li className="crew-row" data-status={lead.status}>
      <div className="crew-main">
        <div className="crew-top">
          <span className="crew-dept">{dept.label}</span>
          {img && <img className="crew-thumb pixelated" src={img} alt={`Last output from ${dept.label}`} />}
        </div>
        <div className="crew-meta">
          <Tag variant="chip" size="sm" as="span" title={lead.model}>
            {modelName(lead.model)}
          </Tag>
          <Badge tone={st.tone} size="sm">
            {st.word}
          </Badge>
          {retried(lead) > 0 && (
            <span className="muted small" title="An earlier try stopped; the crew retried it on its own.">
              Retried {retried(lead)}×
            </span>
          )}
          <span className="crew-money mono small">
            {usd(spent)}
            {eta > 0 && ` · ${duration(eta)} left`}
          </span>
        </div>
        <p className="crew-line" title={lead.title}>
          {plainTitle(lead, state)}
        </p>
        {lead.status === "working" && (
          <ProgressBar
            id={pid}
            label={`${dept.label} progress`}
            className="crew-progress"
            size="sm"
            value={p == null ? undefined : Math.round(p * 100)}
            max={100}
          />
        )}
        {lead.status === "failed" && lead.error && (
          <div className="crew-error" role="status">
            <p>
              <strong>Stopped:</strong> {lead.error.message}
            </p>
            {lead.error.fix && <p>{lead.error.fix}</p>}
          </div>
        )}
      </div>
      <div className="crew-actions">
        <Button
          size="sm"
          variant="ghost"
          onClick={() =>
            askPipAbout(
              state.doc.id,
              `About the ${dept.label.toLowerCase()}'s ${plainTitle(lead, state).toLowerCase()}: `,
            )
          }
        >
          Ask Pip
        </Button>
        <Button size="sm" variant="quiet" onClick={() => onOpen(lead)}>
          Details
        </Button>
      </div>
      {tasks.length > 1 && (
        <Disclosure size="sm" summary={`${tasks.length} tasks`} className="crew-instances">
          <ul className="crew-sublist">
            {tasks.map((t) => (
              <li key={t.id}>
                <Badge tone={TASK_STATUS[t.status].tone} variant="text">
                  {TASK_STATUS[t.status].word}
                </Badge>{" "}
                <span>{ROLE_LABEL[t.role]}:</span> {t.title} <span className="muted mono small">{usd(t.usd)}</span>{" "}
                {retried(t) > 0 && <span className="muted small">Retried {retried(t)}× </span>}
                <Button size="sm" variant="quiet" onClick={() => onOpen(t)}>
                  Details
                </Button>
              </li>
            ))}
          </ul>
        </Disclosure>
      )}
    </li>
  );
}

function TaskDrawer({
  projectId,
  state,
  task,
  onClose,
  onWatch,
}: {
  projectId: string;
  state: ProjectState;
  task: Task;
  onClose: () => void;
  onWatch: (t: Task) => void;
}) {
  const [transcript, setTranscript] = useState<string | null | undefined>(undefined);
  const decisions = state.questions.filter((q) => q.from === task.role);
  const st = TASK_STATUS[task.status];
  return (
    <Drawer
      id="task-drawer"
      title={`${ROLE_LABEL[task.role]}: ${task.title}`}
      open
      onClose={onClose}
      closeLabel="Close"
      size="md"
    >
      <div className="stack-4">
        <p>
          <Badge tone={st.tone}>{st.word}</Badge>{" "}
          <span className="mono small">{task.model ?? "Model picked when it starts"}</span> ·{" "}
          <span className="mono small">
            {usd(task.usd)}
            {task.estUsd != null && ` of about ${usd(task.estUsd)}`}
          </span>
        </p>
        {task.error && (
          <div className="crew-error">
            <p>
              <strong>Stopped:</strong> {task.error.message}
            </p>
            {task.error.fix && <p>{task.error.fix}</p>}
          </div>
        )}
        <section>
          <h3 className="label">Summary</h3>
          <p>{task.summary ?? "No summary yet. The agent writes one when it finishes."}</p>
        </section>
        <section>
          <h3 className="label">Outputs</h3>
          {task.lastImage ? (
            <img className="drawer-output pixelated" src={task.lastImage} alt={`Latest output of ${task.title}`} />
          ) : (
            <p className="muted">Nothing drawn or written yet.</p>
          )}
        </section>
        <section>
          <h3 className="label">Decisions</h3>
          {decisions.length ? (
            <ul>
              {decisions.map((q) => (
                <li key={q.id}>
                  {q.question}{" "}
                  <span className="muted">
                    {q.status === "open"
                      ? "Waiting for you"
                      : `Answered: ${q.options.find((o) => o.id === q.answer?.optionId)?.label ?? "a note"}${q.answer?.by === "producer" ? " (by the Producer)" : ""}`}
                  </span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="muted">No decisions asked by this role.</p>
          )}
        </section>
        <p className="crew-drawer-actions">
          <Button
            size="sm"
            variant="primary"
            onClick={() => {
              onClose();
              askPipAbout(
                projectId,
                `About the ${ROLE_LABEL[task.role].toLowerCase()}'s ${plainTitle(task, state).toLowerCase()}: `,
              );
            }}
          >
            Ask Pip about this
          </Button>
          <Button size="sm" variant="ghost" onClick={() => onWatch(task)}>
            See what it's doing
          </Button>
        </p>
        <Disclosure
          summary="Transcript"
          onToggle={(e) => {
            if ((e.currentTarget as HTMLDetailsElement).open && transcript === undefined)
              client.transcript(projectId, task.id).then(setTranscript);
          }}
        >
          {transcript === undefined ? (
            <p className="muted">Loading…</p>
          ) : transcript === null ? (
            <EmptyState size="sm" title="No transcript">
              The server doesn't keep a transcript for this task.
            </EmptyState>
          ) : (
            <pre className="transcript">{transcript}</pre>
          )}
        </Disclosure>
      </div>
    </Drawer>
  );
}

// ---- instances (PIP-JOURNEY §3.4): Working, Up next, then Finished · N and the plan's revisions ----
function InstancePanel({ projectId, state, currentScene }: PanelProps) {
  const groups = crewGroups(state);
  const [watch, setWatch] = useState<{ id: string; from: string } | null>(null);
  // Finished is open while nothing is live, until the person toggles it; then it is theirs
  const [finOpen, setFinOpen] = useState<boolean | null>(null);
  const finishedOpen = finOpen ?? groups.working.length === 0;
  const rev = state.plan?.rev ?? 0;
  const [revs, setRevs] = useState<PlanRevisionSummary[] | null>(null);
  useEffect(() => {
    let live = true;
    if (rev)
      client.planRevisions(projectId).then(
        (r) => live && setRevs(r),
        () => live && setRevs([]),
      );
    return () => {
      live = false;
    };
  }, [projectId, rev]);
  const [, force] = useState(0);
  useEffect(() => {
    const t = setInterval(() => force((x) => x + 1), 3000);
    return () => clearInterval(t);
  }, []);
  const row = (i: Instance, kind: "working" | "upNext" | "finished") => (
    <InstanceRow key={i.id} inst={i} kind={kind} state={state} onDetails={(from) => setWatch({ id: i.id, from })} />
  );
  return (
    <div className="crew">
      <ul className="crew-list">
        <li className="crew-row crew-row-pip">
          <PipPanel project={projectId} state={state} inputId="pip-studio-input" />
          <BehindTheScenes projectId={projectId} />
        </li>
      </ul>
      {groups.working.length > 0 && (
        <section className="crew-group" aria-labelledby="crew-g-working">
          <h3 className="label crew-group-head" id="crew-g-working">
            Working · <bdi>{groups.working.length}</bdi>
          </h3>
          <ul className="crew-list">{groups.working.map((i) => row(i, "working"))}</ul>
        </section>
      )}
      {groups.upNext.length > 0 && (
        <section className="crew-group" aria-labelledby="crew-g-next">
          <h3 className="label crew-group-head" id="crew-g-next">
            Up next · <bdi>{groups.upNext.length}</bdi>
          </h3>
          <ul className="crew-list">{groups.upNext.map((i) => row(i, "upNext"))}</ul>
        </section>
      )}
      {groups.finished.length > 0 && (
        <Disclosure
          size="sm"
          summary={`Finished · ${groups.finished.length}`}
          className="crew-group crew-finished-group"
          open={finishedOpen}
          onToggle={(e) => {
            const o = (e.currentTarget as HTMLDetailsElement).open;
            if (o !== finishedOpen) setFinOpen(o);
          }}
        >
          <ul className="crew-list">{groups.finished.map((i) => row(i, "finished"))}</ul>
        </Disclosure>
      )}
      {rev > 0 && (
        <Disclosure size="sm" summary={`Plan · rev ${rev}`} className="crew-group crew-plan">
          {revs === null ? (
            <p className="muted small">Loading the plan's changes…</p>
          ) : revs.length === 0 ? (
            <p className="muted small">No changes kept for this plan.</p>
          ) : (
            <ol className="crew-revs">
              {[...revs].reverse().map((r) => (
                <li key={r.rev} className="small" dir="auto">
                  {revisionLine(r, clock)}
                </li>
              ))}
            </ol>
          )}
        </Disclosure>
      )}
      {watch && (
        <AgentActivity
          projectId={projectId}
          state={state}
          memberId={watch.id}
          currentScene={currentScene}
          onClose={() => {
            const from = watch.from;
            setWatch(null);
            requestAnimationFrame(() => document.getElementById(from)?.focus());
          }}
        />
      )}
    </div>
  );
}

function InstanceRow({
  inst: i,
  kind,
  state,
  onDetails,
}: {
  inst: Instance;
  kind: "working" | "upNext" | "finished";
  state: ProjectState;
  onDetails: (from: string) => void;
}) {
  const tasks = state.tasks.filter((t) => t.instance === i.id);
  const needs = tasks.some((t) => t.status === "waiting_user");
  const failed = kind === "working" && i.state !== "live";
  const mood: Mood =
    kind === "finished"
      ? i.outcome === "stopped" || i.outcome === "failed"
        ? "stopped"
        : "done"
      : kind === "upNext"
        ? "later"
        : failed
          ? "stuck"
          : needs
            ? "needs"
            : "working";
  const badge =
    kind === "finished" && i.outcome
      ? {
          word: OUTCOME_WORD[i.outcome],
          tone: i.outcome === "done" ? "success" : i.outcome === "failed" ? "error" : "muted",
        }
      : kind === "upNext"
        ? { word: "Up next", tone: "muted" }
        : failed
          ? { word: "Stuck", tone: "error" }
          : needs
            ? { word: "Needs you", tone: "signal" }
            : { word: "Working", tone: "accent" };
  const working = tasks.find((t) => t.status === "working" || t.status === "waiting_user");
  const line = kind === "upNext" ? ghostLine(i.id, state) : kind === "finished" ? i.endReason : working?.title;
  const id = `crew-inst-row-${i.id.replace(/[^a-zA-Z0-9_-]/g, "-")}`;
  const alive = timeAlive(i);
  return (
    <li
      className="crew-row crew-inst-row"
      data-kind={kind}
      data-status={needs ? "waiting_user" : failed ? "failed" : undefined}
    >
      <div className="crew-main">
        <div className="crew-top">
          <CrewFace member={memberOf(i.role)} role={i.role} mood={mood} />
          <span className="crew-dept crew-inst-label" dir="auto">
            {i.label}
          </span>
        </div>
        <div className="crew-meta">
          {i.model && (
            <Tag variant="chip" size="sm" as="span" title={i.model}>
              <bdi>{modelName(i.model)}</bdi>
            </Tag>
          )}
          <Badge tone={badge.tone as "muted"} size="sm">
            {badge.word}
          </Badge>
          <span className="crew-money mono small">
            <bdi>{usd(i.usd)}</bdi>
            {alive > 0 && (
              <>
                {" · "}
                <bdi>{duration(alive)}</bdi>
                {i.lives.length > 1 && ` · ${i.lives.length} lives`}
              </>
            )}
          </span>
        </div>
        {line && (
          <p className="crew-line" dir="auto">
            {line}
          </p>
        )}
      </div>
      <div className="crew-actions">
        <Button
          size="sm"
          variant="ghost"
          onClick={() => askPipAbout(state.doc.id, `About the ${i.label}: `, { instance: i.id })}
        >
          Ask Pip
        </Button>
        <Button size="sm" variant="quiet" id={id} onClick={() => onDetails(id)}>
          Details
        </Button>
      </div>
    </li>
  );
}
