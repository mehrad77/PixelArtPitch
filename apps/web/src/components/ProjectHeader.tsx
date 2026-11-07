// The workspace header: project name, the HUD (spend and time meters in one PixelFrame), the "Needs you" signal,
// "Pause crew", and the stage nav grouped Plan / Make / Finish, each stage saying done, now, upcoming or needs you.
import { Badge, Button, Menu, Meter, PixelFrame } from "@shabboo/kit/react";
import { useState } from "react";
import { client } from "../lib/client.ts";
import { needsYouCount, STAGE_GROUPS, STAGE_LABEL, STAGE_STATE_WORD, stageStates } from "../lib/derive.ts";
import { duration, usd } from "../lib/format.ts";
import { Link, LinkButton } from "../lib/router.tsx";
import type { ConnState, ProjectState, Stage } from "../lib/types.ts";
import "./ProjectHeader.css";

export function ProjectHeader({
  projectId,
  state,
  stage,
  conn,
  onNeedsYou,
}: {
  projectId: string;
  state: ProjectState;
  stage: Stage;
  conn: ConnState;
  onNeedsYou: () => void;
}) {
  const needs = needsYouCount(state);
  const crew = state.crew?.state ?? "running";
  const [err, setErr] = useState<string | null>(null);
  const b = state.budget;
  const committed = b.spentUsd + b.reservedUsd;
  const askAt = state.doc.budget.askAtFraction * b.capUsd;

  const now = Date.now();
  const started = state.time.startedAt ? Date.parse(state.time.startedAt) : now;
  const elapsed = Math.max(0, (now - started) / 1000);
  const eta = state.time.etaSec;
  const deadline = state.time.deadline ? Date.parse(state.time.deadline) : null;
  let tMax = elapsed + (eta?.[1] ?? 0) || 1;
  let tVal = elapsed;
  let tText = eta ? `Done in ${duration(eta[0])} to ${duration(eta[1])}` : "No estimate yet";
  if (deadline) {
    tMax = Math.max(1, (deadline - started) / 1000);
    tVal = Math.min(tMax * 1.2, elapsed + (eta?.[1] ?? 0));
    const left = (deadline - now) / 1000;
    tText += left > 0 ? `; deadline in ${duration(left)}` : "; the deadline has passed";
  }

  const pause = async (mode: string) => {
    setErr(null);
    try {
      await client.crewPause(projectId, mode === "now" ? "now" : "after_step");
    } catch (e) {
      setErr(`Couldn't pause: ${(e as Error).message}. Try again.`);
    }
  };
  const resume = async () => {
    setErr(null);
    try {
      await client.crewResume(projectId);
    } catch (e) {
      setErr(`Couldn't resume: ${(e as Error).message}. Try again.`);
    }
  };
  const states = stageStates(state);

  return (
    <header className="ws-header">
      <div className="ws-title">
        <h1>{state.doc.title}</h1>
        {conn !== "open" && (
          <Badge tone="warning" variant="text">
            {conn === "connecting" ? "Connecting" : "Reconnecting to the server"}
          </Badge>
        )}
      </div>
      <PixelFrame className="hud" size="sm" tone="muted">
        <Meter
          id="hud-spend"
          label="Spend"
          size="sm"
          layout="row"
          value={committed}
          min={0}
          max={Math.max(b.capUsd, 0.01)}
          low={askAt * 0.75}
          high={askAt}
          optimum={0}
          valueText={`${usd(b.spentUsd)} + ${usd(b.reservedUsd)} in flight of ${usd(b.capUsd)}`}
        />
        <Meter
          id="hud-time"
          label="Time"
          size="sm"
          layout="row"
          value={tVal}
          min={0}
          max={tMax}
          high={deadline ? tMax * 0.9 : undefined}
          optimum={0}
          valueText={tText}
        />
      </PixelFrame>
      <div className="ws-actions">
        {needs > 0 ? (
          <Button size="sm" variant="ghost" onClick={onNeedsYou}>
            <Badge tone="signal" variant="text" live>
              Needs you ({needs})
            </Badge>
          </Button>
        ) : (
          <Badge tone="muted" variant="text">
            Needs you (0)
          </Badge>
        )}
        {crew === "paused" || crew === "pausing" ? (
          <>
            <Badge tone="warning" variant="text">
              {crew === "paused" ? "Crew paused" : "Pausing after this step"}
            </Badge>
            <Button size="sm" variant="primary" onClick={resume}>
              Resume crew
            </Button>
          </>
        ) : crew === "idle" ? (
          <Badge tone="muted" variant="text">
            Crew idle
          </Badge>
        ) : (
          <Menu
            id="pause-menu"
            label="Pause crew"
            variant="ghost"
            items={[
              { label: "After the current step", value: "after_step" },
              { label: "Now", value: "now" },
            ]}
            onSelect={pause}
          />
        )}
        <LinkButton size="sm" variant="ghost" href={`/p/${encodeURIComponent(projectId)}/record`}>
          Record narration
        </LinkButton>
      </div>
      {err && (
        <p className="ws-error" role="status">
          {err}
        </p>
      )}
      <nav className="stage-nav" aria-label="Stages">
        {STAGE_GROUPS.map((g) => (
          <div key={g.label} className="stage-group">
            <span className="label" id={`sg-${g.label}`}>
              {g.label}
            </span>
            <ol aria-labelledby={`sg-${g.label}`}>
              {g.stages.map((s) => (
                <li key={s}>
                  <Link
                    href={`/p/${encodeURIComponent(projectId)}/${s}`}
                    aria-current={s === stage ? "page" : undefined}
                    data-state={states[s]}
                  >
                    <span className="stage-name">{STAGE_LABEL[s]}</span>
                    <span className="stage-state">{STAGE_STATE_WORD[states[s]]}</span>
                  </Link>
                </li>
              ))}
            </ol>
          </div>
        ))}
      </nav>
    </header>
  );
}
