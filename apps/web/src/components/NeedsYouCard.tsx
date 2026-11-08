// The one thing that needs the person, under the film: open gates first, then open questions (oldest first), then
// narration to record (the order is lib/needs.ts). One at a time, with "1 of 3" when there are more. A picture on the
// start side (a button: it opens full screen, the rough cut's contact sheet frame by frame), the recommended answer
// preselected, and "Looks good" as the primary button; a pick (the script angles, Pip's own questions) shows every
// option with "Use this one" on each. Nothing here takes the focus; Q does. The parts are exported, so the crew
// drawer's Pip pane asks the same things in its thread (`where` keeps their ids apart).
import { Badge, Button, Checkbox, Field, Fieldset, Radio } from "@shabboo/kit/react";
import { type FormEvent, useEffect, useState } from "react";
import { client } from "../lib/client.ts";
import { GATE_STAGE } from "../lib/derive.ts";
import { signedDuration, signedUsd } from "../lib/format.ts";
import { effectOf, GATE_TITLE, problemOf, theMember } from "../lib/human.ts";
import { isPick, type NeedsItem, needsItems, previewOf } from "../lib/needs.ts";
import { changeEffect, useChangePreview } from "../lib/preview.ts";
import { LinkButton } from "../lib/router.tsx";
import type { Gate, ProjectState, QuestionT } from "../lib/types.ts";
import { DecisionCard } from "./DecisionCard.tsx";
import { EffectButton } from "./EffectAction.tsx";
import { openProvider, ProblemButton } from "./ProblemButton.tsx";
import { PreviewButton } from "./SheetDialog.tsx";
import "./NeedsYouCard.css";

type Item = NeedsItem;
const upFirst = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/** who asks, in Pip's sentence: "The writer needs a pick from you.", or Pip's own "I need you to pick one." */
const asker = (q: QuestionT) =>
  q.from === "pip" ? "I need you to pick one." : `${upFirst(theMember(q.from))} needs a pick from you.`;

/** what Pip says when it hands you the item: in the simple view the item is Pip's question, not a separate card */
function pipSays(item: Item, s: ProjectState): string {
  if (item.kind === "question") return asker(item.q);
  if (item.kind === "gate" && item.pick) return asker(item.pick);
  if (item.kind === "gate")
    return `This one's your call: ${GATE_TITLE[item.gate.id].charAt(0).toLowerCase()}${GATE_TITLE[item.gate.id].slice(1)}`;
  if (item.kind === "narration") return "The pictures are done. Your turn: the narration.";
  return problemOf(s) ? "I need you for this one." : "One thing for you.";
}

/** "From the writer. <why>"; Pip's own question is Pip's sentence already, so only its why */
function FromLine({ q }: { q: QuestionT }) {
  if (!q.why && q.from === "pip") return null;
  return (
    <p className="muted small" dir="auto">
      {q.from === "pip" ? q.why : `From ${theMember(q.from)}. ${q.why}`}
    </p>
  );
}

/** the words for handing a question back: nobody but the person answers a likeness or a hold */
function handBack(q: QuestionT): string | null {
  if (q.rights || q.hold) return null;
  return q.from === "pip" ? "Let Pip decide" : "Let the crew decide";
}

export function NeedsYouCard({
  projectId,
  state,
  variant = "card",
  want,
}: {
  projectId: string;
  state: ProjectState;
  /** pip: said by Pip, inside Pip's block, instead of a card of its own */
  variant?: "card" | "pip";
  /** show this item (a new ask the page just scrolled to); `n` changes for each new request */
  want?: { key: string; n: number } | null;
}) {
  const items = needsItems(state);
  const [cur, setCur] = useState<string | null>(null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: each new request (its n) shows its item once
  useEffect(() => {
    if (want) setCur(want.key);
  }, [want?.n]);
  if (!items.length) return null;
  const i = Math.max(
    0,
    items.findIndex((x) => x.key === cur),
  );
  const item = items[i];
  return (
    <section
      id="needs-you"
      className={variant === "pip" ? "needs needs-pip" : "needs"}
      aria-labelledby="needs-title"
      tabIndex={-1}
      data-key={item.key}
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
      <NeedsItemView projectId={projectId} state={state} item={item} where="needs" />
    </section>
  );
}

/** the title the full-screen picture gets: the gate item's own words ("Rough cut"), or who drew it */
function previewTitle(item: Item, s: ProjectState): string {
  if (item.kind === "gate") {
    const it = item.gate.items.find((x) => x.ref?.startsWith("out/")) ?? item.gate.items.find((x) => x.ref);
    if (it?.ref?.startsWith("out/")) return it.label || "Rough cut";
    const sc = it?.ref ? s.doc.scenes.find((x) => x.id === it.ref) : undefined;
    return sc?.title || it?.label || GATE_TITLE[item.gate.id];
  }
  if (item.kind === "question") return `${upFirst(theMember(item.q.from))}'s latest picture`;
  return "Picture";
}

/**
 * One thing that needs the person, with its picture and its answers: a gate, a pick, a question, the narration or a
 * problem. `where` prefixes every id, so the page's card and the drawer's copy never share one.
 */
export function NeedsItemView({
  projectId,
  state,
  item,
  where,
}: {
  projectId: string;
  state: ProjectState;
  item: Item;
  where: string;
}) {
  const img = previewOf(item, state, {
    frame: (t) => client.frameUrl(projectId, t, 1),
    file: (name) => client.fileUrl(projectId, name),
  });
  const titleId = `${where === "needs" ? "" : `${where}-`}needs-title`;
  return (
    <div className="needs-body" data-image={img ? "" : undefined}>
      {img && (
        <PreviewButton
          className="needs-preview"
          src={img}
          title={previewTitle(item, state)}
          duration={state.timeline.duration}
        />
      )}
      <div className="needs-main">
        {item.kind === "gate" && item.pick ? (
          <PickItem key={item.key} projectId={projectId} q={item.pick} where={where} titleId={titleId} />
        ) : item.kind === "gate" ? (
          <GateItem
            key={item.key}
            projectId={projectId}
            gate={item.gate}
            state={state}
            where={where}
            titleId={titleId}
          />
        ) : item.kind === "question" ? (
          isPick(item.q, state) ? (
            <PickItem key={item.key} projectId={projectId} q={item.q} where={where} titleId={titleId} />
          ) : item.q.kind === "multi" || item.q.kind === "number" ? (
            <>
              <h2 id={titleId} className="h4" dir="auto">
                {item.q.question}
              </h2>
              <DecisionCard key={item.key} projectId={projectId} q={item.q} where={`${where}-simple`} />
            </>
          ) : (
            <QuestionItem key={item.key} projectId={projectId} q={item.q} where={where} titleId={titleId} />
          )
        ) : item.kind === "problem" ? (
          <ProblemItem projectId={projectId} state={state} titleId={titleId} />
        ) : (
          <>
            <h2 id={titleId} className="h4">
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

type Part = { projectId: string; where: string; titleId: string };

export function QuestionItem({ projectId, q, where, titleId }: Part & { q: QuestionT }) {
  const [choice, setChoice] = useState(q.recommendedId);
  const [open, setOpen] = useState(false);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const rec = q.options.find((o) => o.id === q.recommendedId);
  const pick = q.options.find((o) => o.id === choice) ?? rec;
  const base = `${where}-q-${q.id}`;
  const back = handBack(q);
  const send = async (a: { optionId?: string; note?: string }) => {
    setBusy(true);
    setErr(null);
    try {
      await client.answer(projectId, q.id, a);
    } catch (e) {
      setErr(`${(e as Error).message}. Try again${back ? `, or ${back.toLowerCase()}` : ""}.`);
      setBusy(false);
    }
  };
  const submit = (e: FormEvent) => {
    e.preventDefault();
    send({ optionId: choice, note: note.trim() || undefined });
  };
  return (
    <form onSubmit={submit} aria-busy={busy ? "true" : undefined}>
      <h2 id={titleId} className="h4" dir="auto">
        {q.question}
      </h2>
      <FromLine q={q} />
      {!open && pick && (
        <div className="needs-option">
          <p dir="auto">
            {pick.label}
            {pick.id === q.recommendedId && <span className="muted small"> · recommended</span>}
          </p>
          {pick.detail && (
            <p className="muted small" dir="auto">
              {pick.detail}
            </p>
          )}
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
        {/* a likeness or a logo is the person's call (docs/RIGHTS.md §3): the crew never decides it */}
        {q.rights ? (
          <Badge tone="info" variant="pill" caps={false} size="sm">
            Private to this project
          </Badge>
        ) : back ? (
          <button
            type="button"
            className="linkish small"
            onClick={() => send({ optionId: q.recommendedId, note: back ?? "Let the crew decide" })}
          >
            {back}
          </button>
        ) : null}
      </div>
    </form>
  );
}

/**
 * A pick (the script angles, Pip's hold): every option at once, each with "Use this one"; the recommended one says so
 * in words and takes the primary button. Answering it passes the gate it stands for (the server's pickScript waits on
 * it), or lifts the hold.
 */
export function PickItem({ projectId, q, where, titleId }: Part & { q: QuestionT }) {
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [telling, setTelling] = useState(false);
  const [note, setNote] = useState("");
  const base = `${where}-pick-${q.id}`;
  // "Write it" opens the note field: the words go there, not into Pip's box
  useEffect(() => {
    if (telling) document.getElementById(`${base}-note`)?.focus();
  }, [telling, base]);
  const back = handBack(q);
  const send = async (a: { optionId: string; note?: string }) => {
    setBusy(a.optionId);
    setErr(null);
    try {
      await client.answer(projectId, q.id, a);
    } catch (e) {
      setErr(`${(e as Error).message}. Try again${back && q.kind !== "yesno" ? `, or ${back.toLowerCase()}` : ""}.`);
      setBusy(null);
    }
  };
  // a yes/no (the Librarian's "Add it to your library?"): its two answers are the buttons, and nobody else decides
  if (q.kind === "yesno")
    return (
      <div className="needs-pick-wrap" aria-busy={busy ? "true" : undefined}>
        <h2 id={titleId} className="h4" dir="auto">
          {q.question}
        </h2>
        <FromLine q={q} />
        <div className="needs-actions">
          {q.options.map((o) => (
            <Button
              key={o.id}
              className={o.id === q.recommendedId ? "needs-primary" : undefined}
              size="sm"
              variant={o.id === q.recommendedId ? "primary" : "ghost"}
              aria-busy={busy === o.id ? "true" : undefined}
              onClick={() => !busy && send({ optionId: o.id })}
            >
              {o.label}
            </Button>
          ))}
        </div>
        {err && (
          <p className="decision-error" role="status">
            {err}
          </p>
        )}
      </div>
    );
  return (
    <div className="needs-pick-wrap" aria-busy={busy ? "true" : undefined}>
      <h2 id={titleId} className="h4" dir="auto">
        {q.question}
      </h2>
      <FromLine q={q} />
      <ul className="needs-picks" aria-labelledby={titleId}>
        {q.options.map((o) => {
          const rec = o.id === q.recommendedId;
          return (
            <li key={o.id} className="needs-pick" data-rec={rec ? "" : undefined}>
              <div className="needs-pick-text">
                <p id={`${base}-${o.id}`} dir="auto">
                  {o.label}
                  {rec && (
                    <>
                      {" "}
                      <Badge tone="info" variant="text" size="sm">
                        Recommended
                      </Badge>
                    </>
                  )}
                </p>
                {o.detail && (
                  <p className="muted small" dir="auto">
                    {o.detail}
                  </p>
                )}
              </div>
              <Button
                className={rec ? "needs-primary" : undefined}
                size="sm"
                variant={rec ? "primary" : "ghost"}
                aria-describedby={`${base}-${o.id}`}
                aria-busy={busy === o.id ? "true" : undefined}
                aria-expanded={q.hold && o.id === "tell" ? telling : undefined}
                onClick={() => {
                  if (busy) return;
                  // a hold's two answers that can't act on a click: the key is fixed in Settings (saving it lifts
                  // the hold), and "Tell Pip" needs the person's words as the note
                  if (q.hold && o.id === "fix_key") return openProvider();
                  if (q.hold && o.id === "tell") return setTelling((t) => !t);
                  send({ optionId: o.id });
                }}
              >
                {q.hold && o.id === "fix_key"
                  ? "Open Settings"
                  : q.hold && o.id === "tell"
                    ? "Write it"
                    : "Use this one"}
              </Button>
            </li>
          );
        })}
      </ul>
      {q.hold && telling && (
        <form
          className="needs-tell"
          onSubmit={(e) => {
            e.preventDefault();
            if (!busy && note.trim()) send({ optionId: "tell", note: note.trim() });
          }}
        >
          <Field
            id={`${base}-note`}
            label="What should change?"
            control="textarea"
            rows={3}
            size="sm"
            value={note}
            onChange={(e) => setNote(e.currentTarget.value)}
          />
          <div className="needs-actions">
            <Button
              type="submit"
              size="sm"
              variant="primary"
              disabled={!note.trim()}
              aria-busy={busy === "tell" ? "true" : undefined}
            >
              Send to Pip
            </Button>
            <button type="button" className="linkish small" onClick={() => setTelling(false)}>
              Cancel
            </button>
          </div>
        </form>
      )}
      {err && (
        <p className="decision-error" role="status">
          {err}
        </p>
      )}
      {back && (
        <div className="needs-actions">
          <button
            type="button"
            className="linkish small"
            onClick={() => !busy && send({ optionId: q.recommendedId, note: back ?? "Let the crew decide" })}
          >
            {back}
          </button>
        </div>
      )}
    </div>
  );
}

/** a gate item the person can tick for another pass: a scene, never the rough cut's sheet or a question */
export const passItems = (gate: Gate, s: ProjectState) =>
  gate.items.filter((it) => !!it.ref && !it.ref.startsWith("out/") && s.timeline.scenes.some((x) => x.id === it.ref));

export function GateItem({ projectId, gate, state, where, titleId }: Part & { gate: Gate; state: ProjectState }) {
  const [open, setOpen] = useState(false);
  const [checked, setChecked] = useState<string[]>([]);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const base = `${where}-gate-${gate.id}`;
  const pass = passItems(gate, state);
  const preview = useChangePreview(projectId, gate.id, note, checked, open);
  const effect = changeEffect(
    preview,
    (p) => effectOf({ kind: "gate_changes", stage: GATE_STAGE[gate.id], items: checked, preview: p }, state),
    !!note.trim(),
  );
  const hasChanges = () => {
    if (note.trim() || checked.length) return true;
    setErr("Say what to change, so the crew knows where to start.");
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
  // what the person looks at: the rough cut's sheet is the picture, so it isn't listed again under the title
  const looks = gate.items.filter((x) => !x.ref?.startsWith("out/")).map((x) => x.label);
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        send("approve");
      }}
      aria-busy={busy ? "true" : undefined}
    >
      <h2 id={titleId} className="h4">
        {GATE_TITLE[gate.id]}
      </h2>
      {!open && looks.length > 0 && <p className="muted small">{looks.join(" · ")}</p>}
      {open && (
        <>
          <Field
            id={`${base}-why`}
            label="What should change"
            control="textarea"
            rows={3}
            size="sm"
            value={note}
            hint="For example: the owl should sit on the roof in scene 3."
            onChange={(e) => {
              setNote(e.currentTarget.value);
              if (err) setErr(null);
            }}
          />
          {pass.length > 0 && (
            <Fieldset
              id={`${base}-fs`}
              legend="Which scenes need another pass"
              hint="Optional. Ticked scenes go to the crew with your note."
              size="sm"
            >
              {pass.map((it, i) => (
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
        {open ? (
          <>
            <EffectButton
              className="needs-primary"
              label="Send changes"
              variant="primary"
              effect={effect}
              check={hasChanges}
              onRun={() => send("changes")}
            />
            <Button
              size="sm"
              variant="quiet"
              onClick={() => {
                setOpen(false);
                setErr(null);
              }}
            >
              Cancel
            </Button>
          </>
        ) : (
          <>
            <Button className="needs-primary" type="submit" size="sm" variant="primary">
              Looks good
            </Button>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => {
                setOpen(true);
                requestAnimationFrame(() => document.getElementById(`${base}-why`)?.focus());
              }}
            >
              Change something
            </Button>
          </>
        )}
      </div>
    </form>
  );
}

function ProblemItem({ projectId, state, titleId }: { projectId: string; state: ProjectState; titleId: string }) {
  const p = problemOf(state);
  if (!p) return null;
  return (
    <>
      <h2 id={titleId} className="h4">
        {p.text}
      </h2>
      <p className="muted small">The crew can't get past this on its own.</p>
      <div className="needs-actions">
        <ProblemButton className="needs-primary" projectId={projectId} state={state} problem={p} />
      </div>
    </>
  );
}
