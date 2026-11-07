// Pip, the studio's assistant (docs/ASSISTANT.md): one conversation component in three places. The simple view's ask
// bar expands a sheet in place, upward from the bar, so the film stays in view (Esc folds it back); Studio has it as
// the first tab; the header's crew drawer has it on top, for the workspace when no project is open. Replies are
// short, in the serif voice; anything actionable is a card. Nothing here opens itself or moves focus on a reply:
// a dot on Pip's face says there's something new, and one polite live region reads it.
import { Button, Field, Icon, Kbd, Tag } from "@shabboo/kit/react";
import {
  type FormEvent,
  type KeyboardEvent,
  type ReactNode,
  type RefObject,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { bytes, duration } from "../lib/format.ts";
import { type Member, memberOf, usdPlain } from "../lib/human.ts";
import {
  askPip,
  type Conv,
  decidePip,
  hasNews,
  markSeen,
  pipMood,
  setListening,
  suggestions,
  usePip,
} from "../lib/pip.ts";
import { Link } from "../lib/router.tsx";
import type { PipCard, PipFile, PipItem, ProjectState, RoleT } from "../lib/types.ts";
import { CrewFace } from "./CrewStrip.tsx";
import { McpForm, McpResult } from "./McpForm.tsx";
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
export function PipThread({ project, conv, onHandoff }: { project: Project; conv: Conv; onHandoff?: () => void }) {
  const items = conv.items.filter((i) => i.kind !== "thinking");
  return (
    <ol className="pip-thread">
      {conv.unavailable && !items.length && <li className="pip-note small muted">{conv.unavailable}</li>}
      {conv.loaded && !conv.unavailable && !items.length && (
        <li className="pip-note small muted">
          {project
            ? "Ask for your files, a translation, a change to the video, or another one like it."
            : "Ask how a project is doing, start a new one, or add a connection."}
        </li>
      )}
      {items.map((it) =>
        it.kind === "user" ? (
          <li key={it.id} className="pip-user">
            <p>{it.text}</p>
          </li>
        ) : it.kind === "pip" ? (
          <li key={it.id} className="pip-says">
            {it.text && <p className="pip-text">{it.text}</p>}
            {it.cards.map((c) => (
              <PipCardView key={c.id} project={project} card={c} onHandoff={onHandoff} />
            ))}
          </li>
        ) : null,
      )}
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

// ---- cards ----
export function PipCardView({ project, card, onHandoff }: { project: Project; card: PipCard; onHandoff?: () => void }) {
  if (card.type === "files") return <FilesCard files={card.files} />;
  if (card.type === "cant")
    return (
      <div className="pip-card" data-type="cant">
        <p>{card.text}</p>
        {card.nearest && (
          <p className="pip-nearest small">
            <span className="label">Instead</span> {card.nearest}
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
        <h3 className="pip-plan-title">{card.title}</h3>
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
      <p className="pip-plan-detail">{card.detail}</p>
      {meta.length > 0 && <p className="small muted pip-plan-meta">{meta.join(" · ")}</p>}
      {card.effects.length > 0 && (
        <ul className="pip-effects small">
          {card.effects.map((e) => (
            <li key={e}>{e}</li>
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
}: {
  project: Project;
  inputId: string;
  inputRef?: RefObject<HTMLInputElement | null>;
  conv: Conv;
  onSent?: () => void;
  onEscape?: () => boolean;
  hint?: ReactNode;
  label?: string;
}) {
  const [text, setText] = useState("");
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
  const send = async (e?: FormEvent) => {
    e?.preventDefault();
    const body = text.trim();
    if (!body) return;
    onSent?.();
    setText("");
    const ok = await askPip(project, body);
    if (!ok) setText(body);
  };
  const onKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Escape" && onEscape?.()) {
      e.preventDefault();
      e.stopPropagation();
    }
  };
  return (
    <form className="pip-bar" onSubmit={send}>
      <label htmlFor={inputId} className="visually-hidden">
        {label}
      </label>
      <input
        ref={field}
        id={inputId}
        className="pip-input"
        type="text"
        placeholder={`${label}…`}
        autoComplete="off"
        enterKeyHint="send"
        value={text}
        onChange={(e) => setText(e.currentTarget.value)}
        onFocus={() => setListening(project, true)}
        onBlur={() => setListening(project, false)}
        onKeyDown={onKey}
      />
      {hint && !text && <span className="pip-kbd">{hint}</span>}
      <button type="submit" className="pip-send" aria-label="Send to Pip" data-ready={text.trim() ? "" : undefined}>
        <Icon name="arrow-up" size="sm" />
      </button>
      {conv.note && <p className="pip-bar-note small">{conv.note}</p>}
    </form>
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

/** keeps the newest line in view while the thread is shown; `also` runs after, e.g. to keep the bar on screen */
function useFollow(conv: Conv, active: boolean, also?: () => void) {
  const ref = useRef<HTMLDivElement>(null);
  // the newest item and its cards' states: a reply, a card turning done, Pip starting to think
  const n = `${conv.items.length}|${conv.thinking}|${JSON.stringify(conv.items.at(-1) ?? "").length}`;
  // biome-ignore lint/correctness/useExhaustiveDependencies: follows the newest item
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || !active) return;
    el.scrollTop = el.scrollHeight;
    also?.();
  }, [n, active]);
  return ref;
}

// ---- simple view: the ask bar and its sheet ----
export function PipAsk({
  project,
  state,
  open,
  setOpen,
}: {
  project: string;
  state: ProjectState;
  open: boolean;
  setOpen: (v: boolean) => void;
}) {
  const conv = usePip(project);
  const input = useRef<HTMLInputElement>(null);
  const bar = useRef<HTMLDivElement>(null);
  const before = useRef<number | null>(null);
  // the sheet grows with the reply: the field stays on screen, without moving focus
  const scroll = useFollow(conv, open, () => bar.current?.scrollIntoView({ block: "nearest" }));
  const hasItems = conv.items.some((i) => i.kind !== "thinking");

  // the sheet grows upward: keep the bar where the eye left it
  const change = (v: boolean) => {
    if (v === open) return;
    before.current = bar.current?.getBoundingClientRect().top ?? null;
    setOpen(v);
  };
  // biome-ignore lint/correctness/useExhaustiveDependencies: runs when the sheet opens or closes
  useLayoutEffect(() => {
    const top = before.current;
    before.current = null;
    if (top == null || !bar.current) return;
    const delta = bar.current.getBoundingClientRect().top - top;
    if (delta) window.scrollBy({ top: delta, behavior: "instant" as ScrollBehavior });
  }, [open]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: a reply that lands while the sheet is open is seen
  useEffect(() => {
    if (open) markSeen(project);
  }, [open, project, conv.items.length]);

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

  const collapse = () => {
    if (!open) return false;
    change(false);
    input.current?.focus();
    return true;
  };
  const handoff = () => {
    change(false);
    requestAnimationFrame(() => input.current?.focus());
  };

  return (
    <section
      className="pip-ask"
      aria-labelledby="pip-ask-h"
      data-open={open ? "" : undefined}
      onKeyDown={(e) => {
        if (e.key === "Escape" && collapse()) {
          e.preventDefault();
          e.stopPropagation();
        }
      }}
    >
      <h2 id="pip-ask-h" className="visually-hidden">
        Ask Pip
      </h2>
      <div className="pip-sheet" id="pip-sheet" hidden={!open}>
        <div className="pip-sheet-head">
          <Button size="sm" variant="quiet" onClick={collapse} title="Esc">
            Hide
          </Button>
        </div>
        <div className="pip-scroll" ref={scroll}>
          <PipThread project={project} conv={conv} onHandoff={handoff} />
        </div>
      </div>
      <div ref={bar} className="pip-bar-wrap">
        <Composer
          project={project}
          inputId="pip-ask-input"
          inputRef={input}
          conv={conv}
          onSent={() => change(true)}
          onEscape={collapse}
          hint={<Kbd size="sm">/</Kbd>}
        />
      </div>
      <div className="pip-under">
        {!conv.thinking && <Chips project={project} items={suggestions(state)} onSent={() => change(true)} />}
        {hasItems && !open && (
          <button
            type="button"
            className="linkish small pip-show"
            aria-controls="pip-sheet"
            aria-expanded="false"
            onClick={() => change(true)}
          >
            {hasNews(conv) ? "Pip replied · show" : "Show conversation"}
          </button>
        )}
      </div>
      <PipLive conv={conv} />
    </section>
  );
}

/** Pip at the head of the crew row: the host's face, which opens and folds the conversation */
export function PipCrewFace({
  project,
  state,
  open,
  setOpen,
}: {
  project: string;
  state: ProjectState;
  open: boolean;
  setOpen: (v: boolean) => void;
}) {
  const conv = usePip(project);
  const news = hasNews(conv) && !open;
  const mood = pipMood(conv, state);
  return (
    <button
      type="button"
      className="pip-face-btn"
      aria-label={`Pip${mood === "thinking" ? ", thinking" : ""}${news ? ", has something for you" : ""}. ${open ? "Hide" : "Show"} the conversation`}
      title="Pip"
      aria-expanded={open}
      aria-controls="pip-sheet"
      onClick={() => {
        setOpen(!open);
        if (!open) document.getElementById("pip-ask-input")?.focus();
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
  const scroll = useFollow(conv, true);
  // biome-ignore lint/correctness/useExhaustiveDependencies: a reply that lands while shown is seen
  useEffect(() => {
    markSeen(project);
  }, [project, conv.items.length]);
  return (
    <div className="pip-panel">
      <div className="pip-panel-head">
        <PipFace mood={pipMood(conv, state)} size="sm" />
        <span className="label">Pip</span>
      </div>
      <div className="pip-scroll" ref={scroll}>
        <PipThread project={project} conv={conv} />
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
  const scroll = useFollow(conv, true);
  const hasItems = conv.items.some((i) => i.kind !== "thinking");
  // biome-ignore lint/correctness/useExhaustiveDependencies: a reply that lands while shown is seen
  useEffect(() => {
    markSeen(project);
  }, [project, conv.items.length]);
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
        <div className="pip-scroll pip-inline-scroll" ref={scroll}>
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
