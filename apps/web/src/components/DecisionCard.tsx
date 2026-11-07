// A question from the crew: a Fieldset whose legend is the question, with why it matters and what it blocks.
// Each option shows its cost and time against the recommended one; the recommended option is pre-checked and labelled.
// "Let Producer decide" hands the choice back. Gates use GateCard below: approve, approve with notes, or changes.
import { Badge, Button, Callout, Checkbox, Field, Fieldset, Radio } from "@shabboo/kit/react";
import { type FormEvent, useState } from "react";
import { client } from "../lib/client.ts";
import { GATE_LABEL, GATE_STAGE, isStage, ROLE_LABEL, STAGE_LABEL } from "../lib/derive.ts";
import { clock, signedDuration, signedUsd } from "../lib/format.ts";
import { effectOf } from "../lib/human.ts";
import type { Gate, ProjectState, QuestionT, Role } from "../lib/types.ts";
import { EffectButton } from "./EffectAction.tsx";
import "./DecisionCard.css";

const fromLabel = (from: string) => ROLE_LABEL[from as Role] ?? from;
const blockWord = (b: string) => (isStage(b) ? STAGE_LABEL[b] : b.replace(/^t_/, "").replace(/_/g, " "));

/** `where` keeps ids unique when the same question shows in two places (the stage panel and the Inbox) */
export function DecisionCard({ projectId, q, where = "inbox" }: { projectId: string; q: QuestionT; where?: string }) {
  const [choice, setChoice] = useState<string>(q.recommendedId);
  const [multi, setMulti] = useState<string[]>([q.recommendedId]);
  const [num, setNum] = useState("");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const base = `${where}-q-${q.id}`;
  const answered = q.status !== "open";

  const send = async (a: { optionId?: string; value?: unknown; note?: string }) => {
    setBusy(true);
    setErr(null);
    try {
      await client.answer(projectId, q.id, a);
    } catch (e) {
      setErr(`${(e as Error).message}. Try again, or let the Producer decide.`);
    } finally {
      setBusy(false);
    }
  };
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (q.kind === "multi") send({ value: multi, note: note || undefined });
    else if (q.kind === "number") {
      const v = Number(num);
      if (!num || !Number.isFinite(v)) {
        setErr("Enter a number, or let the Producer decide.");
        document.getElementById(`${base}-num`)?.focus();
        return;
      }
      send({ value: v, note: note || undefined });
    } else send({ optionId: choice, note: note || undefined });
  };

  const rec = q.options.find((o) => o.id === q.recommendedId);
  const delta = (o: QuestionT["options"][number]) => {
    if (o.id === q.recommendedId) return "Recommended";
    const parts: string[] = [];
    if (o.costUsd != null) parts.push(signedUsd(o.costUsd - (rec?.costUsd ?? 0)));
    if (o.timeSec != null) parts.push(signedDuration(o.timeSec - (rec?.timeSec ?? 0)));
    return parts.length ? `${parts.join(", ")} vs recommended` : "";
  };
  const hint = [q.why, q.blocks.length ? `Blocks ${q.blocks.map(blockWord).join(", ")}.` : ""]
    .filter(Boolean)
    .join(" ");
  const deadline = q.timeoutSec ? new Date(Date.parse(q.askedAt) + q.timeoutSec * 1000) : null;

  if (answered)
    return (
      <article className="decision" data-answered="">
        <p className="label">From {fromLabel(q.from)}</p>
        <p>{q.question}</p>
        <p className="muted small">
          {q.status === "defaulted"
            ? "Nobody answered in time; the crew took "
            : q.status === "withdrawn"
              ? "Withdrawn by the crew."
              : "Answered: "}
          {q.status !== "withdrawn" && (q.options.find((o) => o.id === q.answer?.optionId)?.label ?? "a value")}
          {q.answer?.by === "producer" && " (the Producer decided)"}
        </p>
      </article>
    );

  return (
    <form className="decision" onSubmit={submit} aria-busy={busy ? "true" : undefined}>
      <p className="label">
        From {fromLabel(q.from)} <Badge tone="signal">Needs you</Badge>
      </p>
      <Fieldset id={`${base}-fs`} legend={q.question} hint={hint || undefined}>
        {q.kind === "number" ? (
          <Field
            id={`${base}-num`}
            label="Value"
            type="number"
            value={num}
            onChange={(e) => setNum(e.currentTarget.value)}
          />
        ) : q.kind === "multi" ? (
          q.options.map((o) => (
            <Checkbox
              key={o.id}
              id={`${base}-${o.id}`}
              name={base}
              value={o.id}
              label={o.id === q.recommendedId ? `${o.label} (recommended)` : o.label}
              hint={[o.detail, delta(o)].filter(Boolean).join(" · ")}
              checked={multi.includes(o.id)}
              onChange={(e) => {
                const on = e.currentTarget.checked;
                setMulti((m) => (on ? [...m, o.id] : m.filter((x) => x !== o.id)));
              }}
            />
          ))
        ) : (
          q.options.map((o) => (
            <Radio
              key={o.id}
              id={`${base}-${o.id}`}
              name={base}
              value={o.id}
              label={o.id === q.recommendedId ? `${o.label} (recommended)` : o.label}
              hint={[o.detail, delta(o)].filter(Boolean).join(" · ")}
              checked={choice === o.id}
              onChange={() => setChoice(o.id)}
            />
          ))
        )}
      </Fieldset>
      <Field
        id={`${base}-note`}
        label="Note to the crew"
        control="textarea"
        rows={2}
        size="sm"
        value={note}
        onChange={(e) => setNote(e.currentTarget.value)}
        hint="Optional."
      />
      {deadline && (
        <p className="muted small">If nobody answers by {clock(deadline)}, the crew takes the recommended option.</p>
      )}
      {err && (
        <p className="decision-error" role="status">
          {err}
        </p>
      )}
      <div className="decision-actions">
        <Button type="submit" variant="primary" size="sm">
          Send answer
        </Button>
        <Button
          size="sm"
          variant="ghost"
          onClick={() => send({ optionId: q.recommendedId, note: "Let Producer decide" })}
        >
          Let Producer decide
        </Button>
      </div>
    </form>
  );
}

export function GateCard({
  projectId,
  gate,
  where = "inbox",
  state,
}: {
  projectId: string;
  gate: Gate;
  where?: string;
  /** with the project state, "Ask for changes" says what it redoes before it runs */
  state?: ProjectState;
}) {
  const [checked, setChecked] = useState<string[]>([]);
  const [reasons, setReasons] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const base = `${where}-gate-${gate.id}`;
  const hasReasons = () => {
    if (reasons.trim()) return true;
    setErr("Say what to change, so the crew knows where to start.");
    document.getElementById(`${base}-why`)?.focus();
    return false;
  };
  const send = async (verdict: "approve" | "approve_notes" | "changes") => {
    if (verdict === "changes" && !hasReasons()) return;
    setBusy(true);
    setErr(null);
    try {
      await client.gate(projectId, gate.id, {
        verdict,
        items: checked.length ? checked : undefined,
        reasons: reasons.trim() ? [reasons.trim()] : undefined,
      });
    } catch (e) {
      setErr(`${(e as Error).message}. Try again in a moment.`);
    } finally {
      setBusy(false);
    }
  };
  if (gate.status !== "open")
    return (
      <Callout
        tone={gate.status === "passed" ? "success" : gate.status === "changes" ? "warning" : "aside"}
        title={GATE_LABEL[gate.id]}
      >
        {gate.status === "passed"
          ? "Approved."
          : gate.status === "changes"
            ? "Sent back with your changes; the crew is on it."
            : `Opens when ${STAGE_LABEL[GATE_STAGE[gate.id]]} is ready.`}
      </Callout>
    );
  return (
    <form
      className="decision gate"
      onSubmit={(e) => {
        e.preventDefault();
        send("approve");
      }}
      aria-busy={busy ? "true" : undefined}
    >
      <p className="label">
        Gate <Badge tone="signal">Needs you</Badge>
      </p>
      <Fieldset
        id={`${base}-fs`}
        legend={`${GATE_LABEL[gate.id]}: approve ${STAGE_LABEL[GATE_STAGE[gate.id]].toLowerCase()}?`}
        hint="Tick anything that needs another pass."
      >
        {gate.items.map((it, i) => (
          <Checkbox
            key={it.label}
            id={`${base}-${i}`}
            label={it.label}
            hint={it.ref ? `In ${it.ref}` : undefined}
            checked={checked.includes(it.label)}
            onChange={(e) => {
              const on = e.currentTarget.checked;
              setChecked((c) => (on ? [...c, it.label] : c.filter((x) => x !== it.label)));
            }}
          />
        ))}
      </Fieldset>
      <Field
        id={`${base}-why`}
        label="Notes or changes"
        control="textarea"
        rows={2}
        size="sm"
        value={reasons}
        onChange={(e) => setReasons(e.currentTarget.value)}
      />
      {err && (
        <p className="decision-error" role="status">
          {err}
        </p>
      )}
      <div className="decision-actions">
        <Button type="submit" variant="primary" size="sm">
          Approve
        </Button>
        <Button size="sm" variant="ghost" onClick={() => send("approve_notes")}>
          Approve with notes
        </Button>
        {state ? (
          <EffectButton
            label="Ask for changes"
            variant="danger"
            effect={effectOf({ kind: "gate_changes", stage: GATE_STAGE[gate.id], items: checked }, state)}
            check={hasReasons}
            onRun={() => send("changes")}
          />
        ) : (
          <Button size="sm" variant="danger" onClick={() => send("changes")}>
            Ask for changes
          </Button>
        )}
      </div>
    </form>
  );
}
