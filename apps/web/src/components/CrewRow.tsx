// The Crew tab: one row per department, expandable to its instances. A row opens a Drawer with the summary,
// the outputs, the decisions and the transcript. Errors stay on the row, with the fix in words; never a toast.
import { Badge, Button, Disclosure, Drawer, EmptyState, ProgressBar, Tag } from "@shabboo/kit/react";
import { useEffect, useState } from "react";
import { client } from "../lib/client.ts";
import { DEPARTMENTS, type Department, leadTask, ROLE_LABEL, TASK_STATUS, taskProgress } from "../lib/derive.ts";
import { duration, usd } from "../lib/format.ts";
import { retriesOf, visibleTasks } from "../lib/human.ts";
import type { ProjectState, Task } from "../lib/types.ts";
import "./CrewRow.css";

const modelName = (m?: string) => (m ? (m.split("/").pop() ?? m) : "Model picked when it starts");

export function CrewPanel({ projectId, state }: { projectId: string; state: ProjectState }) {
  const [open, setOpen] = useState<Task | null>(null);
  const [, force] = useState(0);
  // progress bars read elapsed time; repaint them every few seconds without moving anything
  useEffect(() => {
    const t = setInterval(() => force((x) => x + 1), 3000);
    return () => clearInterval(t);
  }, []);
  return (
    <div className="crew">
      <ul className="crew-list">
        {DEPARTMENTS.map((d) => (
          <CrewRow key={d.id} dept={d} tasks={state.tasks.filter((t) => d.roles.includes(t.role))} onOpen={setOpen} />
        ))}
      </ul>
      {open && (
        <TaskDrawer
          projectId={projectId}
          state={state}
          task={state.tasks.find((t) => t.id === open.id) ?? open}
          onClose={() => setOpen(null)}
        />
      )}
    </div>
  );
}

export function CrewRow({ dept, tasks: all, onOpen }: { dept: Department; tasks: Task[]; onOpen: (t: Task) => void }) {
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
        <div className="crew-main">
          <span className="crew-dept">{dept.label}</span>
          <Badge tone="muted" variant="text">
            Upcoming
          </Badge>
          <span className="crew-line muted">Not started. Joins when {dept.stages.join(" or ")} begins.</span>
        </div>
      </li>
    );
  const st = TASK_STATUS[lead.status];
  const p = taskProgress(lead);
  return (
    <li className="crew-row" data-status={lead.status}>
      <div className="crew-main">
        <span className="crew-dept">{dept.label}</span>
        <Tag variant="chip" size="sm" as="span" title={lead.model}>
          {modelName(lead.model)}
        </Tag>
        <Badge tone={st.tone} live={lead.status === "working"}>
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
        {img && <img className="crew-thumb pixelated" src={img} alt={`Last output from ${dept.label}`} />}
        <p className="crew-line">{lead.title}</p>
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
        <Button size="sm" variant="ghost" onClick={() => onOpen(lead)}>
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
}: {
  projectId: string;
  state: ProjectState;
  task: Task;
  onClose: () => void;
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
