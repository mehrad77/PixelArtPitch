// The one thing that needs the person, under the film: open gates first, then open questions (oldest first), then
// narration to record. One at a time, with "1 of 3" when there are more. A picture on the start side, the
// recommended answer preselected, and "Looks good" as the primary button. Nothing here takes the focus; Q does.
import { Button, Checkbox, Field, Fieldset, Radio } from "@shabboo/kit/react";
import { type FormEvent, useState } from "react";
import { client } from "../lib/client.ts";
import { GATE_STAGE } from "../lib/derive.ts";
import { signedDuration, signedUsd } from "../lib/format.ts";
import { effectOf, GATE_TITLE, memberOf, needsNarration, problemOf } from "../lib/human.ts";
import { LinkButton } from "../lib/router.tsx";
import type { Gate, GateId, ProjectState, QuestionT, Role } from "../lib/types.ts";
import { DecisionCard } from "./DecisionCard.tsx";
import { EffectButton } from "./EffectAction.tsx";
import { ProblemButton } from "./ProblemButton.tsx";
import "./NeedsYouCard.css";

type Item =
  | { key: string; kind: "gate"; gate: Gate }
  | { key: string; kind: "question"; q: QuestionT }
  | {
      key: string;
      kind: "narration";
    }
  | {
      key: string;
      kind: "problem";
    };
const GATE_ORDER: GateId[] = ["g0_brief", "g1_script", "g2_animatic", "g3_rough", "g4_final"];

export function needsItems(s: ProjectState): Item[] {
  const gates = s.gates
    .filter((g) => g.status === "open")
    .sort((a, b) => GATE_ORDER.indexOf(a.id) - GATE_ORDER.indexOf(b.id))
    .map((gate): Item => ({ key: `g:${gate.id}`, kind: "gate", gate }));
  const qs = s.questions
    .filter((q) => q.status === "open")
    .sort((a, b) => Date.parse(a.askedAt) - Date.parse(b.askedAt))
    .map((q): Item => ({ key: `q:${q.id}`, kind: "question", q }));
  const nar: Item[] = needsNarration(s) ? [{ key: "narration", kind: "narration" }] : [];
  // a question that blocks a gate's stage is the real choice behind that gate ("which angle?" before "happy with
  // the script?"): it goes just ahead of its gate
  const out: Item[] = [];
  const used = new Set<string>();
  for (const g of gates) {
    if (g.kind !== "gate") continue;
    for (const q of qs)
      if (q.kind === "question" && !used.has(q.key) && q.q.blocks.includes(GATE_STAGE[g.gate.id])) {
        out.push(q);
        used.add(q.key);
      }
    out.push(g);
  }
  const all = [...out, ...qs.filter((q) => !used.has(q.key)), ...nar];
  // a problem only the person can fix: the status line carries it alone; behind other asks it waits in the queue
  if (all.length && problemOf(s)) all.push({ key: "problem", kind: "problem" });
  return all;
}

/** what Pip says when it hands you the item: in the simple view the item is Pip's question, not a separate card */
function pipSays(item: Item, s: ProjectState): string {
  if (item.kind === "question")
    return `The ${memberOf(item.q.from as Role).label.toLowerCase()} needs a pick from you.`;
  if (item.kind === "gate")
    return `This one's your call: ${GATE_TITLE[item.gate.id].charAt(0).toLowerCase()}${GATE_TITLE[item.gate.id].slice(1)}`;
  if (item.kind === "narration") return "The pictures are done. Your turn: the narration.";
  return problemOf(s) ? "I need you for this one." : "One thing for you.";
}

export function NeedsYouCard({
  projectId,
  state,
  variant = "card",
}: {
  projectId: string;
  state: ProjectState;
  /** pip: said by Pip, inside Pip's block, instead of a card of its own */
  variant?: "card" | "pip";
}) {
  const items = needsItems(state);
  const [cur, setCur] = useState<string | null>(null);
  if (!items.length) return null;
  const i = Math.max(
    0,
    items.findIndex((x) => x.key === cur),
  );
  const item = items[i];
  const tl = state.timeline;
  let img: string | undefined;
  if (item.kind === "gate") {
    const ref = item.gate.items.find((x) => x.ref)?.ref;
    const sc = ref ? tl.scenes.find((x) => x.id === ref) : undefined;
    if (sc) img = client.frameUrl(projectId, (sc.from + sc.to) / 2, 1) || undefined;
  } else if (item.kind === "question") {
    img = [...state.tasks].reverse().find((t) => t.role === item.q.from && t.lastImage)?.lastImage;
  }
  return (
    <section
      id="needs-you"
      className={variant === "pip" ? "needs needs-pip" : "needs"}
      aria-labelledby="needs-title"
      tabIndex={-1}
    >
      {variant === "pip" && <p className="visually-hidden">{pipSays(item, state)}</p>}
      <p className="needs-head label" role="status">
        {variant === "pip" ? (
          items.length > 1 ? (
            <bdi>{`${i + 1} of ${items.length}`}</bdi>
          ) : (
            ""
          )
        ) : (
          `The crew needs you${items.length > 1 ? ` · ${i + 1} of ${items.length}` : ""}`
        )}
        {items.length > 1 && (
          <button
            type="button"
            className="linkish small needs-next"
            onClick={() => setCur(items[(i + 1) % items.length].key)}
          >
            Show next
          </button>
        )}
      </p>
      <div className="needs-body" data-image={img ? "" : undefined}>
        {img && <img className="needs-preview pixelated" src={img} alt="" />}
        <div className="needs-main">
          {item.kind === "gate" ? (
            <GateItem key={item.key} projectId={projectId} gate={item.gate} state={state} />
          ) : item.kind === "question" ? (
            item.q.kind === "multi" || item.q.kind === "number" ? (
              <>
                <h2 id="needs-title" className="h4">
                  {item.q.question}
                </h2>
                <DecisionCard key={item.key} projectId={projectId} q={item.q} where="simple" />
              </>
            ) : (
              <QuestionItem key={item.key} projectId={projectId} q={item.q} />
            )
          ) : item.kind === "problem" ? (
            <ProblemItem projectId={projectId} state={state} />
          ) : (
            <>
              <h2 id="needs-title" className="h4">
                Record your narration
              </h2>
              <p className="muted small">
                The pictures are done. Read the script aloud and the editor lines it up with the scenes.
              </p>
              <div className="needs-actions">
                <LinkButton
                  className="needs-primary"
                  size="sm"
                  variant="primary"
                  href={`/p/${encodeURIComponent(projectId)}/record`}
                >
                  Record narration
                </LinkButton>
              </div>
            </>
          )}
        </div>
      </div>
    </section>
  );
}

/** cost and time against the recommended option, only when they matter ($0.25 or a minute) */
function delta(o: QuestionT["options"][number], rec?: QuestionT["options"][number]) {
  const parts: string[] = [];
  const dc = (o.costUsd ?? 0) - (rec?.costUsd ?? 0);
  const dt = (o.timeSec ?? 0) - (rec?.timeSec ?? 0);
  if (Math.abs(dc) >= 0.25) parts.push(signedUsd(dc));
  if (Math.abs(dt) >= 60) parts.push(signedDuration(dt));
  return parts.join(" · ");
}

function QuestionItem({ projectId, q }: { projectId: string; q: QuestionT }) {
  const [choice, setChoice] = useState(q.recommendedId);
  const [open, setOpen] = useState(false);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const rec = q.options.find((o) => o.id === q.recommendedId);
  const pick = q.options.find((o) => o.id === choice) ?? rec;
  const base = `needs-q-${q.id}`;
  const send = async (a: { optionId?: string; note?: string }) => {
    setBusy(true);
    setErr(null);
    try {
      await client.answer(projectId, q.id, a);
    } catch (e) {
      setErr(`${(e as Error).message}. Try again, or let the crew decide.`);
      setBusy(false);
    }
  };
  const submit = (e: FormEvent) => {
    e.preventDefault();
    send({ optionId: choice, note: note.trim() || undefined });
  };
  return (
    <form onSubmit={submit} aria-busy={busy ? "true" : undefined}>
      <h2 id="needs-title" className="h4">
        {q.question}
      </h2>
      <p className="muted small">
        From the {memberOf(q.from as Role).label.toLowerCase()}. {q.why}
      </p>
      {!open && pick && (
        <div className="needs-option">
          <p>
            {pick.label}
            {pick.id === q.recommendedId && <span className="muted small"> · recommended</span>}
          </p>
          <p className="muted small">{pick.detail}</p>
        </div>
      )}
      {open && (
        <>
          <Fieldset id={`${base}-fs`} legend="Pick one" size="sm">
            {q.options.map((o) => (
              <Radio
                key={o.id}
                id={`${base}-${o.id}`}
                name={base}
                value={o.id}
                size="sm"
                label={o.id === q.recommendedId ? `${o.label} (recommended)` : o.label}
                hint={[o.detail, delta(o, rec)].filter(Boolean).join(" · ")}
                checked={choice === o.id}
                onChange={() => setChoice(o.id)}
              />
            ))}
          </Fieldset>
          <Field
            id={`${base}-note`}
            label="Anything to add"
            control="textarea"
            rows={2}
            size="sm"
            value={note}
            onChange={(e) => setNote(e.currentTarget.value)}
            hint="Optional."
          />
        </>
      )}
      {err && (
        <p className="decision-error" role="status">
          {err}
        </p>
      )}
      <div className="needs-actions">
        <Button className="needs-primary" type="submit" size="sm" variant="primary">
          {open ? "Send to the crew" : "Looks good"}
        </Button>
        {!open && (
          <Button size="sm" variant="ghost" onClick={() => setOpen(true)}>
            Change something
          </Button>
        )}
        <button
          type="button"
          className="linkish small"
          onClick={() => send({ optionId: q.recommendedId, note: "Let Producer decide" })}
        >
          Let the crew decide
        </button>
      </div>
    </form>
  );
}

function GateItem({ projectId, gate, state }: { projectId: string; gate: Gate; state: ProjectState }) {
  const [open, setOpen] = useState(false);
  const [checked, setChecked] = useState<string[]>([]);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const base = `needs-gate-${gate.id}`;
  const hasChanges = () => {
    if (note.trim() || checked.length) return true;
    setErr("Tick what needs another pass, or say what to change.");
    document.getElementById(`${base}-why`)?.focus();
    return false;
  };
  const send = async (verdict: "approve" | "changes") => {
    const text = note.trim();
    if (verdict === "changes" && !hasChanges()) return;
    setBusy(true);
    setErr(null);
    try {
      await client.gate(projectId, gate.id, {
        verdict: verdict === "changes" ? "changes" : text ? "approve_notes" : "approve",
        items: verdict === "changes" && checked.length ? checked : undefined,
        reasons: text ? [text] : undefined,
      });
    } catch (e) {
      setErr(`${(e as Error).message}. Try again in a moment.`);
      setBusy(false);
    }
  };
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        send("approve");
      }}
      aria-busy={busy ? "true" : undefined}
    >
      <h2 id="needs-title" className="h4">
        {GATE_TITLE[gate.id]}
      </h2>
      {!open && gate.items.length > 0 && <p className="muted small">{gate.items.map((x) => x.label).join(" · ")}</p>}
      {open && (
        <>
          <Field
            id={`${base}-why`}
            label="What should change"
            control="textarea"
            rows={3}
            size="sm"
            value={note}
            onChange={(e) => setNote(e.currentTarget.value)}
          />
          {gate.items.length > 0 && (
            <Fieldset id={`${base}-fs`} legend="Needs another pass" size="sm">
              {gate.items.map((it, i) => (
                <Checkbox
                  key={it.label}
                  id={`${base}-${i}`}
                  size="sm"
                  label={it.label}
                  checked={checked.includes(it.label)}
                  onChange={(e) => {
                    const on = e.currentTarget.checked;
                    setChecked((c) => (on ? [...c, it.label] : c.filter((x) => x !== it.label)));
                  }}
                />
              ))}
            </Fieldset>
          )}
        </>
      )}
      {err && (
        <p className="decision-error" role="status">
          {err}
        </p>
      )}
      <div className="needs-actions">
        <Button className="needs-primary" type="submit" size="sm" variant="primary">
          Looks good
        </Button>
        {open ? (
          <EffectButton
            label="Send changes"
            variant="ghost"
            effect={effectOf({ kind: "gate_changes", stage: GATE_STAGE[gate.id], items: checked }, state)}
            check={hasChanges}
            onRun={() => send("changes")}
          />
        ) : (
          <Button size="sm" variant="ghost" onClick={() => setOpen(true)}>
            Change something
          </Button>
        )}
      </div>
    </form>
  );
}

function ProblemItem({ projectId, state }: { projectId: string; state: ProjectState }) {
  const p = problemOf(state);
  if (!p) return null;
  return (
    <>
      <h2 id="needs-title" className="h4">
        {p.text}
      </h2>
      <p className="muted small">The crew can't get past this on its own.</p>
      <div className="needs-actions">
        <ProblemButton className="needs-primary" projectId={projectId} state={state} problem={p} />
      </div>
    </>
  );
}
