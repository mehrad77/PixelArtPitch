// The workspace header: project name, the HUD (spend and time meters in one PixelFrame, two short rows; the full
// sentence is the tooltip and the accessible value), "Pause crew", "Record narration" in the Narrate and Sound stages,
// and the stage nav grouped Plan / Make / Finish, each stage saying done, now, upcoming or needs you. "Needs you" is
// on the app header's Crew button.
import { Badge, Button, Menu, Meter, PixelFrame } from "@shabboo/kit/react";
import { useState } from "react";
import { client } from "../lib/client.ts";
import { STAGE_GROUPS, STAGE_LABEL, STAGE_STATE_WORD, stageStates } from "../lib/derive.ts";
import { duration, usd } from "../lib/format.ts";
import { crewStateOf, effectOf } from "../lib/human.ts";
import { Link, LinkButton } from "../lib/router.tsx";
import type { ConnState, ProjectState, Stage } from "../lib/types.ts";
import "./ProjectHeader.css";

/** "40 min", "2 h": whole hours past the first, for the HUD's short row */
const roughly = (sec: number) => (sec < 3600 ? duration(sec) : `${Math.round(sec / 3600)} h`);

export function ProjectHeader({
  projectId,
  state,
  stage,
  conn,
}: {
  projectId: string;
  state: ProjectState;
  stage: Stage;
  conn: ConnState;
}) {
  const crew = crewStateOf(state);
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
  // the short row: "≈ 28 min left · due in 2 h"
  let tShort = eta ? `≈ ${duration((eta[0] + eta[1]) / 2)} left` : "No estimate";
  if (deadline) {
    tMax = Math.max(1, (deadline - started) / 1000);
    tVal = Math.min(tMax * 1.2, elapsed + (eta?.[1] ?? 0));
    const left = (deadline - now) / 1000;
    tText += left > 0 ? `; deadline in ${duration(left)}` : "; the deadline has passed";
    tShort += left > 0 ? ` · due in ${roughly(left)}` : " · past due";
  }
  const sText = `${usd(b.spentUsd)} spent and ${usd(b.reservedUsd)} in flight, of ${usd(b.capUsd)}`;
  const sShort = `${usd(b.spentUsd)} of ${usd(b.capUsd)} · ${usd(b.reservedUsd)} reserved`;

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
          valueText={sShort}
          aria-valuetext={sText}
          title={sText}
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
          valueText={tShort}
          aria-valuetext={tText}
          title={tText}
        />
      </PixelFrame>
      <div className="ws-actions">
        {crew === "paused" || crew === "pausing" ? (
          <>
            <Badge tone="warning" variant="text">
              {crew === "paused" ? "Crew paused" : "Pausing after this step"}
            </Badge>
            <Button
              size="sm"
              variant="primary"
              onClick={resume}
              title={effectOf({ kind: "resume" }, state).text || undefined}
            >
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
        {(stage === "narrate" || stage === "sound") && (
          <LinkButton size="sm" variant="ghost" href={`/p/${encodeURIComponent(projectId)}/record`}>
            Record narration
          </LinkButton>
        )}
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
