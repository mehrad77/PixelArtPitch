// Pip, the studio's assistant (docs/ASSISTANT.md): one conversation component in three places. The simple view's ask
// bar expands a sheet in place, upward from the bar, so the film stays in view (Esc folds it back); Studio has it as
// the first tab; the header's crew drawer has it on top, for the workspace when no project is open. Replies are
// short, in the serif voice; anything actionable is a card. Nothing here opens itself or moves focus on a reply:
// a dot on Pip's face says there's something new, and one polite live region reads it.
import { Button, Disclosure, Field, Icon, Kbd, Tag } from "@shabboo/kit/react";
import {
  type FormEvent,
  Fragment,
  type KeyboardEvent,
  type ReactNode,
  type RefObject,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { useChannel } from "../lib/channel.ts";
import { bytes, clock, duration } from "../lib/format.ts";
import { type Member, memberOf, modelWords, usdPlain } from "../lib/human.ts";
import {
  askPip,
  COMMANDS,
  type Conv,
  decidePip,
  hasNews,
  markSeen,
  pipMood,
  saveSummary,
  setListening,
  suggestions,
  usePip,
} from "../lib/pip.ts";
import { Link } from "../lib/router.tsx";
import type { PipCard, PipFile, PipItem, PipSummary, ProjectState, RoleT } from "../lib/types.ts";
import { CrewFace } from "./CrewStrip.tsx";
import { McpForm, McpResult } from "./McpForm.tsx";
import { ContextDialog } from "./PipContext.tsx";
import { PipFace } from "./PipFace.tsx";
import "./Pip.css";

type Project = string | null | undefined;

// ---- small words ----
const range = (r: [number, number], f: (n: number) => string) => (r[0] === r[1] ? f(r[0]) : `${f(r[0])}–${f(r[1])}`);
function timeWords(sec: [number, number]): string {
  if (sec[1] < 60) return `Under a minute`;
  const lo = Math.max(1, Math.round(sec[0] / 60));
  const hi = Math.max(lo, Math.round(sec[1] / 60));
  return hi >= 60 ? `About ${duration(sec[1])}` : lo === hi ? `About ${lo} min` : `${lo}–${hi} min`;
}
const and = (xs: string[]) => (xs.length < 2 ? (xs[0] ?? "") : `${xs.slice(0, -1).join(", ")} and ${xs.at(-1)}`);
function membersOf(who: RoleT[]): Member[] {
  const out: Member[] = [];
  for (const r of who) {
    const m = memberOf(r);
    if (!out.includes(m)) out.push(m);
  }
  return out;
}
/** "freesound.search_sounds" → "Freesound search sounds" */
const toolLabel = (t: string) => {
  const [server, ...rest] = t.split(".");
  const name = rest.join(".").replace(/[_-]+/g, " ");
  const s = server.replace(/[_-]+/g, " ");
  return `${s.charAt(0).toUpperCase()}${s.slice(1)}${name ? ` ${name}` : ""}`;
};

/** what the live region reads for a reply: its words and what its cards now say */
function spoken(item: PipItem | undefined): string {
  if (item?.kind !== "pip") return "";
  const cards = item.cards.map((c) => {
    if (c.type === "files") return `${c.files.length} ${c.files.length === 1 ? "file" : "files"} to download.`;
    if (c.type === "cant") return `${c.text}${c.nearest ? ` ${c.nearest}` : ""}`;
    if (c.type === "form") return c.status === "done" || c.status === "failed" ? `${c.title}: ${c.status}.` : c.title;
    return c.status === "done" || c.status === "failed"
      ? (c.result?.text ?? c.result?.error ?? c.title)
      : c.status === "running"
        ? `${c.title}: working on it.`
        : `Proposed: ${c.title}.`;
  });
  return [`Pip: ${item.text}`, ...cards].join(" ");
}

function PipLive({ conv }: { conv: Conv }) {
  const last = [...conv.items].reverse().find((i) => i.kind === "pip");
  const text = conv.thinking ? "Pip is thinking." : spoken(last);
  return (
    <p className="visually-hidden" role="status" aria-live="polite">
      {conv.note ?? text}
    </p>
  );
}

// ---- the thread ----
export type Marker = { id: string; at: string; text: string };

export function PipThread({
  project,
  conv,
  onHandoff,
  markers,
}: {
  project: Project;
  conv: Conv;
  onHandoff?: () => void;
  /** milestones from the project's event log, shown as quiet one-line markers among the messages, by time */
  markers?: Marker[];
}) {
  const items = conv.items.filter((i) => i.kind !== "thinking");
  const marks = [...(markers ?? [])].filter((m) => Number.isFinite(Date.parse(m.at)));
  const before = (at: string) => {
    const t = Date.parse(at);
    const out: Marker[] = [];
    while (marks.length && Date.parse(marks[0].at) <= t) out.push(marks.shift() as Marker);
    return out;
  };
  marks.sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  // after a compact: what the summary covers stays visible, a little quieter, above the divider
  const cut = conv.summary ? items.findIndex((i) => i.id === conv.summary?.upTo) : -1;
  const summaryAt = conv.summary ? (cut >= 0 ? cut : -1) : null;
  return (
    <ol className="pip-thread">
      {conv.unavailable && !items.length && <li className="pip-note small muted">{conv.unavailable}</li>}
      {conv.loaded && !conv.unavailable && !items.length && !marks.length && (
        <li className="pip-note small muted">
          {project
            ? "Ask for your files, a translation, a change to the video, or another one like it."
            : "Ask how a project is doing, start a new one, or add a connection."}
        </li>
      )}
      {summaryAt === -1 && conv.summary && <SummaryDivider project={project} summary={conv.summary} />}
      {items.map((it, i) => {
        const old = summaryAt != null && i <= summaryAt;
        const row =
          it.kind === "user" ? (
            <li key={it.id} className="pip-user" data-old={old ? "" : undefined}>
              <p dir="auto">{it.text}</p>
            </li>
          ) : it.kind === "pip" ? (
            <li key={it.id} className="pip-says" data-old={old ? "" : undefined}>
              {it.text && (
                <p className="pip-text" dir="auto">
                  {it.text}
                </p>
              )}
              {it.why && <WhyTrace why={it.why} />}
              {it.cards.map((c) => (
                <PipCardView key={c.id} project={project} card={c} onHandoff={onHandoff} />
              ))}
            </li>
          ) : null;
        const lead = before(it.at).map((m) => <MarkerRow key={m.id} m={m} />);
        return (
          <Fragment key={it.id}>
            {lead}
            {row}
            {i === summaryAt && conv.summary && <SummaryDivider project={project} summary={conv.summary} />}
          </Fragment>
        );
      })}
      {marks.splice(0).map((m) => (
        <MarkerRow key={m.id} m={m} />
      ))}
      {conv.thinking && (
        <li className="pip-says pip-thinking" aria-hidden="true">
          <p className="pip-text">
            Pip is thinking
            <span className="pip-dots">
              <span>.</span>
              <span>.</span>
              <span>.</span>
            </span>
          </p>
        </li>
      )}
    </ol>
  );
}

/** one message of the thread */
function ItemRow({
  it,
  project,
  old,
  onHandoff,
}: {
  it: PipItem;
  project: Project;
  old?: boolean;
  onHandoff?: () => void;
}) {
  if (it.kind === "user")
    return (
      <li className="pip-user" data-old={old ? "" : undefined}>
        <p dir="auto">{it.text}</p>
      </li>
    );
  if (it.kind !== "pip") return null;
  return (
    <li className="pip-says" data-old={old ? "" : undefined}>
      {it.text && (
        <p className="pip-text" dir="auto">
          {it.text}
        </p>
      )}
      {it.why && <WhyTrace why={it.why} />}
      {it.cards.map((c) => (
        <PipCardView key={c.id} project={project} card={c} onHandoff={onHandoff} />
      ))}
    </li>
  );
}

const Thinking = () => (
  <li className="pip-says pip-thinking" aria-hidden="true">
    <p className="pip-text">
      Pip is thinking
      <span className="pip-dots">
        <span>.</span>
        <span>.</span>
        <span>.</span>
      </span>
    </p>
  </li>
);

type Turn = { key: string; at: number; items: PipItem[]; marker?: Marker; old: boolean; thinking?: boolean };

/** the turns, oldest first: the person's message with Pip's reply under it; a message Pip starts, or a milestone, is a
 * turn of its own */
function turnsOf(items: PipItem[], marks: Marker[], upTo: string | null, thinking: boolean): Turn[] {
  const out: Turn[] = [];
  let folded = upTo != null;
  for (const it of items) {
    const last = out.at(-1);
    const joins = it.kind === "pip" && last && !last.marker && last.items.length === 1 && last.items[0].kind === "user";
    if (joins) last.items.push(it);
    else out.push({ key: it.id, at: Date.parse(it.at) || 0, items: [it], old: folded });
    if (it.id === upTo) folded = false;
  }
  // a milestone older than the last folded message belongs with the folded part
  const cutAt = upTo ? Date.parse(items.find((i) => i.id === upTo)?.at ?? "") || 0 : 0;
  for (const m of marks)
    out.push({ key: m.id, at: Date.parse(m.at), items: [], marker: m, old: !!upTo && Date.parse(m.at) <= cutAt });
  out.sort((a, b) => a.at - b.at);
  if (thinking) {
    const newest = [...out].reverse().find((t) => !t.marker);
    if (newest && newest.items.length === 1 && newest.items[0].kind === "user") newest.thinking = true;
    else out.push({ key: "thinking", at: Date.now(), items: [], old: false, thinking: true });
  }
  return out;
}

/** the simple view's thread: turns newest first, each read top-down; what the summary folded comes last, under its
 * divider */
function NewestThread({
  project,
  conv,
  onHandoff,
  markers,
}: {
  project: Project;
  conv: Conv;
  onHandoff?: () => void;
  markers?: Marker[];
}) {
  const items = conv.items.filter((i) => i.kind !== "thinking");
  const marks = (markers ?? []).filter((m) => Number.isFinite(Date.parse(m.at)));
  const upTo = conv.summary && items.some((i) => i.id === conv.summary?.upTo) ? conv.summary.upTo : null;
  const turns = turnsOf(items, marks, upTo, conv.thinking).reverse();
  const recent = turns.filter((t) => !t.old);
  const folded = turns.filter((t) => t.old);
  const row = (t: Turn) =>
    t.marker ? (
      <MarkerRow key={t.key} m={t.marker} />
    ) : (
      <Fragment key={t.key}>
        {t.items.map((it) => (
          <ItemRow key={it.id} it={it} project={project} old={t.old} onHandoff={onHandoff} />
        ))}
        {t.thinking && <Thinking />}
      </Fragment>
    );
  return (
    <ol className="pip-thread" data-order="newest" aria-label="Conversation, newest first">
      {conv.unavailable && !items.length && <li className="pip-note small muted">{conv.unavailable}</li>}
      {conv.loaded && !conv.unavailable && !items.length && !marks.length && !conv.thinking && (
        <li className="pip-note small muted">
          Ask for your files, a translation, a change to the video, or another one like it.
        </li>
      )}
      {recent.map(row)}
      {conv.summary && <SummaryDivider project={project} summary={conv.summary} />}
      {folded.map(row)}
    </ol>
  );
}

/** "Earlier conversation, summarized": the summary Pip's model sees, which the person can correct in place */
/** a milestone in the thread: one quiet line, a hairline, the time */
function MarkerRow({ m }: { m: Marker }) {
  return (
    <li className="pip-marker">
      <bdi>{m.text}</bdi>
      <span aria-hidden="true"> · </span>
      <time dateTime={m.at}>
        <bdi>{clock(new Date(m.at))}</bdi>
      </time>
    </li>
  );
}

/** "14 messages · about 3,200 tokens freed" */
export function freedWords(f: NonNullable<PipSummary["freed"]>): string {
  const n = new Intl.NumberFormat();
  return `${f.items} ${f.items === 1 ? "message" : "messages"} · ${f.method === "estimate" ? "about " : ""}${n.format(f.freed)} tokens freed`;
}

function SummaryDivider({ project, summary }: { project: Project; summary: PipSummary }) {
  const text = summary.text;
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(text);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const id = useId();
  const edit = useRef<HTMLButtonElement>(null);
  const save = async (e: FormEvent) => {
    e.preventDefault();
    if (!value.trim()) return setErr("Write the summary, or press Cancel.");
    setBusy(true);
    setErr(null);
    try {
      await saveSummary(project, value.trim());
      setEditing(false);
      requestAnimationFrame(() => edit.current?.focus());
    } catch (ex) {
      setErr(`${(ex as Error).message}. Your text is still here.`);
    } finally {
      setBusy(false);
    }
  };
  return (
    <li className="pip-summary">
      <Disclosure
        size="sm"
        id={`pip-summary-${String(project ?? "ws")}`}
        summary={
          <>
            Earlier conversation, summarized
            {summary.freed && <span className="muted"> · {freedWords(summary.freed)}</span>}
          </>
        }
        className="pip-summary-box"
      >
        {editing ? (
          <form className="pip-summary-edit" onSubmit={save} aria-busy={busy ? "true" : undefined}>
            <Field
              id={`${id}-sum`}
              label="Pip's summary"
              control="textarea"
              size="sm"
              rows={6}
              hint="Pip uses this from the next turn."
              value={value}
              onChange={(e) => setValue(e.currentTarget.value)}
            />
            <div className="pip-actions">
              <Button type="submit" size="sm" variant="primary">
                Save
              </Button>
              <Button
                size="sm"
                variant="quiet"
                onClick={() => {
                  setValue(text);
                  setEditing(false);
                  setErr(null);
                  requestAnimationFrame(() => edit.current?.focus());
                }}
              >
                Cancel
              </Button>
            </div>
            <p className="pip-error small" role="status">
              {err ?? ""}
            </p>
          </form>
        ) : (
          <>
            <p className="pip-summary-text small" dir="auto">
              {text}
            </p>
            <button
              ref={edit}
              type="button"
              className="linkish small"
              onClick={() => {
                setValue(text);
                setEditing(true);
                requestAnimationFrame(() => document.getElementById(`${id}-sum`)?.focus());
              }}
            >
              Edit
            </button>
          </>
        )}
      </Disclosure>
    </li>
  );
}

/** a /why reply: how the answer it explains came about, from the stored trace */
function WhyTrace({ why }: { why: NonNullable<Extract<PipItem, { kind: "pip" }>["why"]> }) {
  const tokIn = why.usage?.inTok ?? why.usage?.in;
  const tokOut = why.usage?.outTok ?? why.usage?.out;
  const head = [
    why.model ? modelWords(why.model).split(" · ")[0] : null,
    why.mode === "agent"
      ? "agent mode"
      : why.mode === "menu"
        ? "menu mode"
        : why.mode === "command"
          ? "a command"
          : null,
    why.usd != null ? (why.usd < 0.01 ? "under 1¢" : usdPlain(Math.round(why.usd * 100) / 100)) : null,
  ].filter(Boolean);
  return (
    <div className="pip-why">
      <p className="small">
        {why.about ? (
          <>
            About “<bdi>{why.about}</bdi>”:{" "}
          </>
        ) : null}
        {why.tools.length
          ? `${why.tools.length} ${why.tools.length === 1 ? "step" : "steps"}, ${why.tools.filter((t) => !t.ok).length ? `${why.tools.filter((t) => !t.ok).length} failed` : "all worked"}`
          : "no tools"}
        {head.length ? ` · ${head.join(" · ")}` : ""}
      </p>
      <Disclosure size="sm" summary="Show the details">
        <ul className="pip-why-list small">
          {why.tools.map((t, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: the same tool may run twice; the order is the identity
            <li key={`${t.name}-${i}`} data-ok={t.ok}>
              <span className="pip-mark" aria-hidden="true">
                {t.ok ? "✓" : "✕"}
              </span>{" "}
              <span className="mono ltr" translate="no">
                {t.name}
              </span>
              <span className="visually-hidden">{t.ok ? ", worked" : ", failed"}</span>
              {t.ms != null && (
                <span className="muted">
                  {" · "}
                  <bdi>{t.ms} ms</bdi>
                </span>
              )}
            </li>
          ))}
        </ul>
        <dl className="pip-why-meta small">
          {why.model && (
            <>
              <dt className="label">Model</dt>
              <dd className="mono ltr">{why.model}</dd>
            </>
          )}
          {(tokIn != null || tokOut != null) && (
            <>
              <dt className="label">Tokens</dt>
              <dd className="mono">
                {tokIn ?? 0} in · {tokOut ?? 0} out
              </dd>
            </>
          )}
          {why.promptVersion && (
            <>
              <dt className="label">Prompt</dt>
              <dd className="mono ltr">{why.promptVersion}</dd>
            </>
          )}
        </dl>
        {why.cards && why.cards.length > 0 && (
          <ul className="pip-why-cards small">
            {why.cards.map((c) => (
              <li key={c.title}>
                {c.title}
                {c.why ? <span className="muted"> · {c.why}</span> : null}
              </li>
            ))}
          </ul>
        )}
      </Disclosure>
    </div>
  );
}

// ---- cards ----
export function PipCardView({ project, card, onHandoff }: { project: Project; card: PipCard; onHandoff?: () => void }) {
  if (card.type === "files") return <FilesCard files={card.files} />;
  if (card.type === "cant")
    return (
      <div className="pip-card" data-type="cant">
        <p dir="auto">{card.text}</p>
        {card.nearest && (
          <p className="pip-nearest small">
            <span className="label">Instead</span> <bdi>{card.nearest}</bdi>
          </p>
        )}
      </div>
    );
  if (card.type === "form") return <FormCard project={project} card={card} />;
  return <PlanCard project={project} card={card} onHandoff={onHandoff} />;
}

function FilesCard({ files }: { files: PipFile[] }) {
  if (!files.length) return <p className="small muted">No files yet. They show up once the video is exported.</p>;
  return (
    <ul className="pip-card pip-files" data-type="files" aria-label="Files">
      {files.map((f) => (
        <li key={f.name}>
          {f.url ? (
            <a className="pip-file" href={f.url} download={f.name}>
              <Icon name="download" size="sm" />
              <span className="pip-file-name ltr" translate="no">
                {f.name}
              </span>
              <span className="pip-file-size muted">{f.sizeBytes ? bytes(f.sizeBytes) : f.kind}</span>
            </a>
          ) : (
            <span className="pip-file" data-off="">
              <span className="pip-file-name ltr">{f.name}</span>
              <span className="pip-file-size muted">not ready</span>
            </span>
          )}
        </li>
      ))}
    </ul>
  );
}

function PlanCard({
  project,
  card,
  onHandoff,
}: {
  project: Project;
  card: Extract<PipCard, { type: "plan" }>;
  onHandoff?: () => void;
}) {
  const [edit, setEdit] = useState(card.editable?.value ?? "");
  const [err, setErr] = useState<string | null>(null);
  const crew = membersOf(card.who);
  const working = card.status === "running";
  const meta = [card.sec ? timeWords(card.sec) : null, card.usd ? range(card.usd, usdPlain) : null].filter(Boolean);
  const confirm = async () => {
    if (working) return;
    if (card.editable && !edit.trim()) return setErr(`Write the ${card.editable.label.toLowerCase()} first.`);
    setErr(null);
    try {
      await decidePip(project, card, "confirm", card.editable ? edit : undefined);
      if (crew.length) onHandoff?.();
    } catch (e) {
      setErr(`${(e as Error).message}. Try again.`);
    }
  };
  const decline = async () => {
    setErr(null);
    try {
      await decidePip(project, card, "decline");
    } catch (e) {
      setErr(`${(e as Error).message}. Try again.`);
    }
  };
  return (
    <article className="pip-card" data-type="plan" data-status={card.status} aria-label={card.title}>
      <header className="pip-plan-head">
        <h3 className="pip-plan-title" dir="auto">
          {card.title}
        </h3>
        {crew.length > 0 && (
          <span className="pip-who">
            <span className="pip-who-faces" aria-hidden="true">
              {crew.map((m) => (
                <CrewFace key={m.id} member={m} mood={working ? "working" : card.status === "done" ? "done" : "idle"} />
              ))}
            </span>
            <span className="small muted">{and(crew.map((m) => m.label))}</span>
          </span>
        )}
      </header>
      <p className="pip-plan-detail" dir="auto">
        {card.detail}
      </p>
      {meta.length > 0 && <p className="small muted pip-plan-meta">{meta.join(" · ")}</p>}
      {card.effects.length > 0 && (
        <ul className="pip-effects small">
          {card.effects.map((e) => (
            <li key={e} dir="auto">
              {e}
            </li>
          ))}
        </ul>
      )}
      {card.lend && card.lend.length > 0 && (
        <p className="pip-lend small">
          <span className="label">Lends</span>
          {card.lend.map((t) => (
            <Tag key={t} variant="chip" size="sm" title={t}>
              {toolLabel(t)}
            </Tag>
          ))}
        </p>
      )}
      {card.warning && (
        <p className="pip-warning small">
          <Icon name="warning" size="sm" label="Note" /> {card.warning}
        </p>
      )}
      {card.status === "proposed" || card.status === "running" ? (
        <>
          {card.editable && (
            <Field
              id={`pip-edit-${card.id}`}
              className="pip-edit"
              label={card.editable.label}
              control="textarea"
              size="sm"
              rows={4}
              value={edit}
              readOnly={working}
              onChange={(e) => setEdit(e.currentTarget.value)}
            />
          )}
          <div className="pip-actions">
            <Button size="sm" variant="primary" onClick={confirm} aria-disabled={working ? "true" : undefined}>
              {working ? "Working…" : card.confirmLabel}
            </Button>
            {!working && (
              <Button size="sm" variant="quiet" onClick={decline}>
                Not now
              </Button>
            )}
          </div>
        </>
      ) : (
        <PlanResult card={card} />
      )}
      <p className="pip-error small" role="status">
        {err ?? ""}
      </p>
    </article>
  );
}

function PlanResult({ card }: { card: Extract<PipCard, { type: "plan" }> }) {
  if (card.status === "declined") return <p className="small muted">Not now. Ask again any time.</p>;
  const r = card.result;
  if (card.status === "failed")
    return (
      <div className="pip-result" data-ok="false">
        <p className="small">
          <span className="pip-mark" aria-hidden="true">
            ✕
          </span>{" "}
          Didn't work{r?.error ? `: ${r.error}` : "."}
        </p>
      </div>
    );
  return (
    <div className="pip-result" data-ok="true">
      <p className="small">
        <span className="pip-mark" aria-hidden="true">
          ✓
        </span>{" "}
        {r?.text ?? "Done."}
      </p>
      {r?.files && r.files.length > 0 && <FilesCard files={r.files} />}
      {r?.projectId && (
        <Link href={`/p/${encodeURIComponent(r.projectId)}`} className="small">
          Open the new project
        </Link>
      )}
    </div>
  );
}

function FormCard({ project, card }: { project: Project; card: Extract<PipCard, { type: "form" }> }) {
  const done = card.status === "done" || card.status === "failed";
  return (
    <article className="pip-card" data-type="form" data-status={card.status} aria-label={card.title}>
      <h3 className="pip-plan-title">{card.title}</h3>
      <p className="pip-plan-detail small muted">{card.detail}</p>
      {done && card.result?.added?.length ? (
        <McpResult added={card.result.added} />
      ) : done ? (
        <p className="small muted">Not added.</p>
      ) : (
        <McpForm
          busy={card.status === "submitted"}
          onSubmit={(json) => decidePip(project, card, "confirm", json)}
          onCancel={card.status === "open" ? () => decidePip(project, card, "decline").catch(() => {}) : undefined}
          cancelLabel="Not now"
        />
      )}
    </article>
  );
}

// ---- the field ----
function Composer({
  project,
  inputId,
  inputRef,
  conv,
  onSent,
  onEscape,
  hint,
  label = "Ask Pip",
  menuBelow = false,
}: {
  project: Project;
  inputId: string;
  inputRef?: RefObject<HTMLInputElement | null>;
  conv: Conv;
  onSent?: () => void;
  onEscape?: () => boolean;
  hint?: ReactNode;
  label?: string;
  /** the field sits above the thread (the simple view): the command list opens below it */
  menuBelow?: boolean;
}) {
  const [text, setText] = useState("");
  const [active, setActive] = useState(0);
  const [dismissed, setDismissed] = useState(false);
  // /context opens a view, not a message: nothing goes into the conversation
  const [ctxOpen, setCtxOpen] = useState(false);
  const own = useRef<HTMLInputElement>(null);
  const field = inputRef ?? own;
  // a draft from "Ask Pip about this": fill the field, and focus it when this field is the one on top
  const draft = conv.draft;
  // biome-ignore lint/correctness/useExhaustiveDependencies: runs once per new draft
  useEffect(() => {
    if (!draft) return;
    setText(draft.text);
    requestAnimationFrame(() => {
      const el = field.current;
      if (!el?.offsetParent) return;
      const modal = document.querySelector("dialog[open]");
      if (modal && !modal.contains(el)) return;
      el.focus();
      el.setSelectionRange(el.value.length, el.value.length);
    });
  }, [draft?.n]);

  // the slash menu: "/" as the first character lists the commands, filtered as you type
  const slash = text.startsWith("/");
  const word = slash ? text.slice(1).split(/\s/)[0].toLowerCase() : "";
  const typedArg = /\s/.test(text);
  const matches = slash ? COMMANDS.filter((c) => c.name.slice(1).startsWith(word)) : [];
  const exact = COMMANDS.find((c) => c.name === `/${word}`);
  const menu = slash && !typedArg && !dismissed && matches.length > 0;
  const unknown = slash && !exact && (typedArg || matches.length === 0) && word.length > 0;
  const listId = `${inputId}-cmds`;
  const optId = (i: number) => `${inputId}-cmd-${i}`;
  const cur = Math.min(active, Math.max(0, matches.length - 1));

  const submit = async (body: string) => {
    if (!body) return;
    if (/^\/context\s*$/i.test(body)) {
      setText("");
      setDismissed(false);
      setCtxOpen(true);
      return;
    }
    onSent?.();
    setText("");
    setDismissed(false);
    const ok = await askPip(project, body);
    if (!ok) setText(body);
  };
  const pick = (i: number) => {
    const c = matches[i];
    if (!c) return;
    if (c.arg) {
      setText(`${c.name} `);
      field.current?.focus();
    } else submit(c.name);
  };
  const send = (e?: FormEvent) => {
    e?.preventDefault();
    if (menu && matches[cur] && text.trim() !== matches[cur].name) return pick(cur);
    submit(text.trim());
  };
  const onKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (menu && (e.key === "ArrowDown" || e.key === "ArrowUp")) {
      e.preventDefault();
      const n = matches.length;
      setActive((a) => (Math.min(a, n - 1) + (e.key === "ArrowDown" ? 1 : n - 1)) % n);
      return;
    }
    if (menu && e.key === "Tab" && matches[cur]) {
      e.preventDefault();
      setText(`${matches[cur].name}${matches[cur].arg ? " " : ""}`);
      return;
    }
    if (e.key === "Escape") {
      if (menu) {
        e.preventDefault();
        e.stopPropagation();
        setDismissed(true);
        return;
      }
      if (onEscape?.()) {
        e.preventDefault();
        e.stopPropagation();
      }
    }
  };
  return (
    <>
      <form className="pip-bar" onSubmit={send}>
        <label htmlFor={inputId} className="visually-hidden">
          {label}
        </label>
        <input
          ref={field}
          id={inputId}
          className="pip-input"
          type="text"
          role="combobox"
          aria-autocomplete="list"
          aria-expanded={menu}
          aria-controls={listId}
          aria-activedescendant={menu ? optId(cur) : undefined}
          aria-describedby={unknown ? `${inputId}-unknown` : undefined}
          placeholder={`${label}…`}
          autoComplete="off"
          enterKeyHint="send"
          value={text}
          onChange={(e) => {
            setText(e.currentTarget.value);
            setActive(0);
            if (!e.currentTarget.value.startsWith("/")) setDismissed(false);
          }}
          onFocus={() => setListening(project, true)}
          onBlur={() => setListening(project, false)}
          onKeyDown={onKey}
        />
        {hint && !text && <span className="pip-kbd">{hint}</span>}
        <button type="submit" className="pip-send" aria-label="Send to Pip" data-ready={text.trim() ? "" : undefined}>
          <Icon name="arrow-up" size="sm" />
        </button>
        <div
          id={listId}
          role="listbox"
          aria-label="Commands"
          className="pip-cmds"
          data-below={menuBelow ? "" : undefined}
          hidden={!menu}
        >
          {matches.map((c, i) => (
            <div
              key={c.name}
              id={optId(i)}
              role="option"
              tabIndex={-1}
              aria-selected={i === cur}
              className="pip-cmd"
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => pick(i)}
              onKeyDown={() => {}}
            >
              <span className="pip-cmd-name mono ltr" translate="no">
                {c.example ?? c.name}
              </span>
              <span className="pip-cmd-hint">{c.hint}</span>
            </div>
          ))}
        </div>
        {unknown && (
          <p id={`${inputId}-unknown`} className="pip-bar-note small">
            Not a command — Pip will read it as a message.
          </p>
        )}
        {conv.note && <p className="pip-bar-note small">{conv.note}</p>}
      </form>
      <ContextDialog
        project={project}
        open={ctxOpen}
        onClose={() => {
          setCtxOpen(false);
          requestAnimationFrame(() => field.current?.focus());
        }}
      />
    </>
  );
}

function Chips({ project, items, onSent }: { project: Project; items: string[]; onSent?: () => void }) {
  return (
    <ul className="pip-chips" aria-label="Suggestions">
      {items.map((s) => (
        <li key={s}>
          <button
            type="button"
            className="pip-chip"
            dir="auto"
            onClick={() => {
              onSent?.();
              askPip(project, s);
            }}
          >
            {s}
          </button>
        </li>
      ))}
    </ul>
  );
}

/** keeps the newest line in view, unless the reader scrolled up to read: then a "New message" pill instead */
function useFollow(conv: Conv, project: Project, extra = "") {
  const ref = useRef<HTMLDivElement>(null);
  const atBottom = useRef(true);
  const [fresh, setFresh] = useState(false);
  // the newest item and its cards' states: a reply, a card turning done, Pip starting to think, a crew message
  const n = `${conv.items.length}|${conv.thinking}|${JSON.stringify(conv.items.at(-1) ?? "").length}|${conv.items.map((i) => (i.kind === "pip" ? i.cards.map((c) => ("status" in c ? c.status : "")).join() : "")).join()}|${extra}`;
  const toBottom = () => {
    const el = ref.current;
    if (el) el.scrollTop = el.scrollHeight;
    atBottom.current = true;
    setFresh(false);
    markSeen(project);
  };
  // biome-ignore lint/correctness/useExhaustiveDependencies: follows the newest item
  useLayoutEffect(() => {
    if (atBottom.current) toBottom();
    else setFresh(true);
  }, [n]);
  const onScroll = () => {
    const el = ref.current;
    if (!el) return;
    atBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
    if (atBottom.current && fresh) {
      setFresh(false);
      markSeen(project);
    }
  };
  return { ref, fresh, toBottom, onScroll };
}

function NewPill({ show, onClick }: { show: boolean; onClick: () => void }) {
  if (!show) return null;
  return (
    <button type="button" className="pip-new" onClick={onClick}>
      New message ↓
    </button>
  );
}

// ---- simple view: the field on top, the conversation under it, newest first ----
export function PipAsk({ project, state }: { project: string; state: ProjectState }) {
  const conv = usePip(project);
  const input = useRef<HTMLInputElement>(null);
  const top = useRef<HTMLDivElement>(null);
  const channel = useChannel(project);
  const [fresh, setFresh] = useState(false);
  // new things land at the top, next to the field: nothing scrolls; if the reader is further down, a pill says so
  const n = `${conv.items.length}|${conv.thinking}|${channel.length}|${state.milestones?.length ?? 0}`;
  const inView = () => (top.current?.getBoundingClientRect().bottom ?? 0) > 0;
  // biome-ignore lint/correctness/useExhaustiveDependencies: runs when something new arrives
  useEffect(() => {
    if (inView()) markSeen(project);
    else setFresh(true);
  }, [n]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: inView reads a ref
  useEffect(() => {
    if (!fresh) return;
    const on = () => {
      if (inView()) {
        setFresh(false);
        markSeen(project);
      }
    };
    window.addEventListener("scroll", on, { passive: true });
    return () => window.removeEventListener("scroll", on);
  }, [fresh, project]);

  // / focuses the field from anywhere outside a text field
  useEffect(() => {
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key !== "/" || e.metaKey || e.ctrlKey || e.altKey || e.defaultPrevented) return;
      const t = e.target as HTMLElement | null;
      if (t?.closest("input, textarea, select, [contenteditable], dialog[open]")) return;
      e.preventDefault();
      input.current?.focus();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // after a handoff the card that was pressed is done: the field takes the focus, not the page
  const handoff = () => requestAnimationFrame(() => input.current?.focus());

  return (
    <section className="pip-ask" data-order="newest" aria-labelledby="pip-ask-h">
      <h2 id="pip-ask-h" className="visually-hidden">
        Conversation with Pip
      </h2>
      <div ref={top} className="pip-bar-wrap">
        <Composer
          project={project}
          inputId="pip-ask-input"
          inputRef={input}
          conv={conv}
          menuBelow
          hint={<Kbd size="sm">/</Kbd>}
        />
      </div>
      <div className="pip-under">{!conv.thinking && <Chips project={project} items={suggestions(state)} />}</div>
      <div className="pip-sheet" id="pip-sheet">
        <NewestThread project={project} conv={conv} onHandoff={handoff} markers={state.milestones} />
      </div>
      {fresh && (
        <button
          type="button"
          className="pip-new pip-new-up"
          onClick={() => {
            top.current?.scrollIntoView({ block: "start", behavior: "smooth" });
            setFresh(false);
            markSeen(project);
          }}
        >
          New from Pip ↑
        </button>
      )}
      <PipLive conv={conv} />
    </section>
  );
}

/** Pip at the head of the crew row: the host's face; pressing it goes to the field to ask Pip */
export function PipCrewFace({ project, state }: { project: string; state: ProjectState }) {
  const conv = usePip(project);
  const news = hasNews(conv);
  const mood = pipMood(conv, state);
  return (
    <button
      type="button"
      className="pip-face-btn"
      aria-label={`Pip${mood === "thinking" ? ", thinking" : ""}${news ? ", has something for you" : ""}. Ask Pip`}
      title="Pip"
      aria-controls="pip-sheet"
      onClick={() => {
        const el = document.getElementById("pip-ask-input");
        el?.scrollIntoView({ block: "nearest" });
        el?.focus();
      }}
    >
      <PipFace mood={mood} size="row" dot={news} />
    </button>
  );
}

/** Pip's words under the crew row: a quiet "Pip" label, the status sentence, then the thread and the field */
export function PipLine({ children }: { children: ReactNode }) {
  return (
    <div className="pip-line">
      <p className="label pip-line-label" aria-hidden="true">
        Pip
      </p>
      <div className="pip-line-text">{children}</div>
    </div>
  );
}

// ---- Studio: the Pip tab ----
export function PipPanel({ project, state, inputId }: { project: string; state: ProjectState; inputId: string }) {
  const conv = usePip(project);
  const follow = useFollow(conv, project);
  return (
    <div className="pip-panel">
      <div className="pip-panel-head">
        <PipFace mood={pipMood(conv, state)} size="sm" />
        <span className="label">Pip</span>
      </div>
      <div className="pip-panel-thread">
        <div className="pip-scroll" ref={follow.ref} onScroll={follow.onScroll}>
          <PipThread project={project} conv={conv} />
        </div>
        <NewPill show={follow.fresh} onClick={follow.toBottom} />
      </div>
      <div className="pip-panel-foot">
        {!conv.thinking && <Chips project={project} items={suggestions(state)} />}
        <Composer project={project} inputId={inputId} conv={conv} hint={<Kbd size="sm">/</Kbd>} />
      </div>
      <PipLive conv={conv} />
    </div>
  );
}

/** the field and its chips, for a pane that shows the thread itself (the crew drawer) */
export function PipComposer({
  project,
  inputId,
  conv,
  state,
}: {
  project: string | null;
  inputId: string;
  conv: Conv;
  state: ProjectState | null;
}) {
  return (
    <div className="pip-composer">
      {!conv.thinking && <Chips project={project} items={suggestions(state)} />}
      <Composer project={project} inputId={inputId} conv={conv} />
      <PipLive conv={conv} />
    </div>
  );
}

// ---- the header drawer: Pip on top, for this project or the workspace ----
export function PipInline({ project, state }: { project: string | null; state: ProjectState | null }) {
  const conv = usePip(project);
  const follow = useFollow(conv, project);
  const hasItems = conv.items.some((i) => i.kind !== "thinking");
  return (
    <section className="pip-inline" aria-labelledby="pip-inline-h">
      <div className="pip-inline-head">
        <PipFace mood={pipMood(conv, state)} size="sm" />
        <h3 id="pip-inline-h" className="pip-inline-title">
          Pip
        </h3>
        <span className="small muted">{project ? "about this project" : "about all your projects"}</span>
      </div>
      {hasItems || conv.thinking ? (
        <div className="pip-scroll pip-inline-scroll" ref={follow.ref} onScroll={follow.onScroll}>
          <PipThread project={project} conv={conv} />
        </div>
      ) : (
        !conv.thinking && <Chips project={project} items={suggestions(state)} />
      )}
      <Composer project={project} inputId="pip-header-input" conv={conv} />
      <PipLive conv={conv} />
    </section>
  );
}
