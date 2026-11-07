// The muted line under the status: why nothing is moving and what it waits for (waitReason), with at most one
// action, which says what it causes before it runs. The words are a polite live region; the action sits beside them.
import { Button, Icon } from "@shabboo/kit/react";
import type { ReactNode } from "react";
import { client } from "../lib/client.ts";
import { useThrottled } from "../lib/hooks.ts";
import { effectOf, waitReason } from "../lib/human.ts";
import type { ProjectState } from "../lib/types.ts";
import { EffectButton } from "./EffectAction.tsx";
import { ProblemButton } from "./ProblemButton.tsx";
import "./WaitLine.css";

export function WaitLine({
  projectId,
  state,
  mainText,
  onNeeds,
  needsLabel = "Show me",
}: {
  projectId: string;
  state: ProjectState;
  /** the status sentence above; a reason that repeats it shows only its action */
  mainText?: string;
  /** jump to what needs the person (the NeedsYouCard, or Studio's Inbox) */
  onNeeds: () => void;
  /** the jump's words; empty when the page already links there (Studio's "Inbox (n)") */
  needsLabel?: string;
}) {
  const r = waitReason(state);
  const text = r.text === mainText ? "" : r.text;
  const live = useThrottled(text, 5000);
  const video = state.files.find((f) => f.kind === "video");
  let action: ReactNode = null;
  if (r.action === "needs") {
    if (needsLabel)
      action = (
        <button type="button" className="linkish" onClick={onNeeds}>
          {needsLabel}
        </button>
      );
  } else if (r.action === "problem" && r.problem)
    action = <ProblemButton projectId={projectId} state={state} problem={r.problem} />;
  else if (r.action === "resume")
    action = (
      <EffectButton
        label="Resume"
        effect={effectOf({ kind: "resume" }, state)}
        onRun={() => client.crewResume(projectId)}
      />
    );
  else if (r.action === "start")
    action = (
      <EffectButton label="Start" effect={effectOf({ kind: "start" }, state)} onRun={() => client.crewRun(projectId)} />
    );
  else if (r.action === "continue" && r.stage) {
    const stage = r.stage;
    action = (
      <EffectButton
        label="Continue"
        effect={effectOf({ kind: "continue", stage }, state)}
        onRun={() => client.crewRun(projectId, stage)}
      />
    );
  } else if (r.action === "open" && video) {
    const subs = state.files.find((f) => f.kind === "subtitles" && /\.srt$/i.test(f.name) && f.url);
    action = video.url ? (
      <>
        <Button size="sm" variant="primary" href={video.url} download={video.name}>
          <Icon name="download" size="sm" /> Download
        </Button>
        {subs && (
          <Button size="sm" variant="quiet" href={subs.url} download={subs.name}>
            Subtitles
          </Button>
        )}
        <Button size="sm" variant="quiet" href={video.url} target="_blank" rel="noreferrer">
          Open
        </Button>
      </>
    ) : null;
  }
  return (
    <div className="wait-line" data-kind={r.kind}>
      <p className="wait-text">{text}</p>
      <p className="visually-hidden" role="status" aria-live="polite">
        {live}
      </p>
      {action && <div className="wait-action">{action}</div>}
    </div>
  );
}
