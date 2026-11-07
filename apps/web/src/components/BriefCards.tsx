// /new's two cards (PIP-JOURNEY §3.5): the one question card (3 fields or fewer, the recommended option picked, a
// file's rights never picked for the person) and the brief card, whose Start makes the project. A card the person
// settles turns into one line; the press that removes a control hands the focus to Pip's field (onHandoff).
import { Badge, Button, Fieldset, Icon, Radio } from "@shabboo/kit/react";
import { type FormEvent, useState } from "react";
import { ApiError } from "../lib/api.ts";
import { isSensitive, REF_TYPE_LABEL } from "../lib/brief.ts";
import { usdPlain } from "../lib/human.ts";
import { decidePip, isDraftKey } from "../lib/pip.ts";
import { LinkButton } from "../lib/router.tsx";
import type { BriefFieldAsk, DraftRef, PipCard, RefType } from "../lib/types.ts";
import "./BriefCards.css";

type FieldsCard = Extract<PipCard, { type: "form"; form: "brief_fields" }>;
type BriefT = Extract<PipCard, { type: "brief" }>;
type FileRow = { name: string; type: RefType; rights?: DraftRef["rights"] };

const RIGHTS_ERROR = "Pick one: Mine, Licensed or Not sure.";
const lower = (s: string) => s.charAt(0).toLowerCase() + s.slice(1);
const optionLabel = (f: BriefFieldAsk, id: unknown) =>
  f.options?.find((o) => o.id === String(id))?.label ?? String(id ?? "");

/** "✓ Investors · only the key picks · logo: mine" */
export function settledFields(card: FieldsCard): string {
  const v = card.values ?? {};
  const parts = card.fields.flatMap((f, i) => {
    if (f.type === "files") {
      const rows = (Array.isArray(v[f.key]) ? v[f.key] : []) as FileRow[];
      return rows.map((r) => `${lower(REF_TYPE_LABEL[r.type])}: ${lower(optionLabel(f, r.rights))}`);
    }
    const label = f.type === "number" ? `${f.unit ?? ""}${v[f.key]}` : optionLabel(f, v[f.key]);
    return [i === 0 ? label : lower(label)];
  });
  return parts.join(" · ");
}

export function BriefFieldsCard({
  project,
  card,
  onHandoff,
}: {
  project: string | null | undefined;
  card: FieldsCard;
  onHandoff?: () => void;
}) {
  const [values, setValues] = useState<Record<string, string>>(() =>
    Object.fromEntries(
      card.fields
        .filter((f) => f.type !== "files")
        .map((f) => [f.key, f.recommended != null ? String(f.recommended) : ""]),
    ),
  );
  const [files, setFiles] = useState<FileRow[]>(() =>
    card.fields.flatMap((f) =>
      f.type === "files" ? ((f.value as DraftRef[]) ?? []).map((r) => ({ name: r.name, type: r.type })) : [],
    ),
  );
  const [missing, setMissing] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const busy = card.status === "submitted";
  const base = `bf-${card.id}`;

  if (card.status === "done" || card.status === "superseded")
    return (
      <p className="pip-card brief-settled small" data-type="brief_fields">
        <span className="pip-mark" aria-hidden="true">
          {card.status === "done" ? "✓" : "–"}
        </span>{" "}
        <bdi>{card.status === "done" ? settledFields(card) : "Replaced by your newer message"}</bdi>
      </p>
    );

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (busy) return;
    // rights are the person's claim: never picked for them, and asked again here
    if (files.some((f) => !f.rights)) return setMissing(true);
    setMissing(false);
    setErr(null);
    const out: Record<string, unknown> = { ...values };
    for (const f of card.fields) if (f.type === "number") out[f.key] = Number(values[f.key]);
    if (files.length) out.references = files;
    try {
      await decidePip(project, card, "confirm", undefined, out);
      onHandoff?.();
    } catch (ex) {
      const a = ex as ApiError;
      setErr(`${a.message}.${a instanceof ApiError && a.fix ? ` ${a.fix}` : " Try again."}`);
    }
  };

  return (
    <form
      className="pip-card brief-fields"
      data-type="brief_fields"
      aria-labelledby={`${base}-h`}
      onSubmit={submit}
      noValidate
    >
      <h3 id={`${base}-h`} className="pip-plan-title" dir="auto">
        {card.title}
      </h3>
      {card.detail && <p className="small muted">{card.detail}</p>}
      {card.fields.map((f) =>
        f.type === "files" ? (
          <div key={f.key} className="brief-files">
            {files.map((r, i) => (
              <div key={r.name} className="brief-file">
                <p className="brief-file-row">
                  <bdi className="ltr brief-file-name" translate="no">
                    {r.name}
                  </bdi>
                  <label className="visually-hidden" htmlFor={`${base}-type-${i}`}>
                    What {r.name} is
                  </label>
                  <select
                    id={`${base}-type-${i}`}
                    className="brief-type"
                    value={r.type}
                    onChange={(e) => {
                      const type = e.currentTarget.value as RefType;
                      setFiles((xs) => xs.map((x) => (x.name === r.name ? { ...x, type } : x)));
                    }}
                  >
                    {(Object.keys(REF_TYPE_LABEL) as RefType[]).map((t) => (
                      <option key={t} value={t}>
                        {REF_TYPE_LABEL[t]}
                      </option>
                    ))}
                  </select>
                  {isSensitive(r.type) && (
                    <Badge tone="info" variant="pill" caps={false} size="sm">
                      Private to this project
                    </Badge>
                  )}
                </p>
                <Fieldset
                  id={`${base}-rights-${i}`}
                  legend={files.length === 1 ? f.label : `Is ${r.name} yours to use?`}
                  size="sm"
                  layout="row"
                  error={missing && !r.rights ? RIGHTS_ERROR : undefined}
                >
                  {(f.options ?? []).map((o) => (
                    <Radio
                      key={o.id}
                      id={`${base}-rights-${i}-${o.id}`}
                      name={`${base}-rights-${i}`}
                      value={o.id}
                      size="sm"
                      label={o.label}
                      // the label is the input's name too, never its value ("mine")
                      aria-label={o.label}
                      checked={r.rights === o.id}
                      onChange={() =>
                        setFiles((xs) =>
                          xs.map((x) => (x.name === r.name ? { ...x, rights: o.id as DraftRef["rights"] } : x)),
                        )
                      }
                    />
                  ))}
                </Fieldset>
              </div>
            ))}
          </div>
        ) : f.type === "number" ? (
          <p key={f.key} className="brief-number">
            <label htmlFor={`${base}-${f.key}`}>{f.label}</label>{" "}
            <input
              id={`${base}-${f.key}`}
              type="number"
              inputMode="decimal"
              min={f.min}
              max={f.max}
              step={f.step}
              value={values[f.key] ?? ""}
              onChange={(e) => setValues((v) => ({ ...v, [f.key]: e.currentTarget.value }))}
            />
          </p>
        ) : (
          <Fieldset key={f.key} id={`${base}-${f.key}`} legend={f.label} size="sm">
            {(f.options ?? []).map((o) => (
              <Radio
                key={o.id}
                id={`${base}-${f.key}-${o.id}`}
                name={`${base}-${f.key}`}
                value={o.id}
                size="sm"
                label={o.label}
                aria-label={String(f.recommended) === o.id ? `${o.label}, recommended` : o.label}
                // "Recommended" is a word after the label, never colour alone
                count={String(f.recommended) === o.id ? "Recommended" : undefined}
                countStyle="plain"
                hint={o.detail}
                checked={values[f.key] === o.id}
                onChange={() => setValues((v) => ({ ...v, [f.key]: o.id }))}
              />
            ))}
          </Fieldset>
        ),
      )}
      <div className="pip-actions">
        <Button type="submit" size="sm" variant="primary" aria-disabled={busy ? "true" : undefined}>
          {busy ? "Saving…" : "Use these"}
        </Button>
        {project && isDraftKey(project) && (
          <LinkButton size="sm" variant="quiet" href={`/new/${encodeURIComponent(project)}/options`}>
            Show all options
          </LinkButton>
        )}
      </div>
      <p className="pip-error small" role="status">
        {err ?? ""}
      </p>
    </form>
  );
}

/** the brief card's three lines: the estimate, the crew, the picks */
export function briefLines(card: BriefT): string[] {
  const [lo, hi] = card.estimate.usd;
  const min = Math.max(1, Math.round(card.estimate.sec[0] / 60));
  const fmt = new Intl.NumberFormat(
    typeof document !== "undefined" ? document.documentElement.lang || undefined : undefined,
  );
  return [
    `About ${usdPlain(lo)}–${usdPlain(hi)}, ready in roughly ${fmt.format(min)} ${min === 1 ? "minute" : "minutes"}, plus the time your picks take.`,
    card.preview.line,
    card.picks ?? "",
  ].filter(Boolean);
}

export function BriefCard({
  project,
  card,
  onHandoff,
}: {
  project: string | null | undefined;
  card: BriefT;
  onHandoff?: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [est, crew, picks] = briefLines(card);
  const start = async () => {
    if (busy) return;
    setBusy(true);
    setErr(null);
    try {
      await decidePip(project, card, "confirm");
      onHandoff?.();
    } catch (e) {
      setErr(`${(e as Error).message}. Try again.`);
      setBusy(false);
    }
  };
  const bdi = (key: string, v: string) =>
    key === "lengthSec" || key === "budget" ? <bdi>{v}</bdi> : <span dir="auto">{v}</span>;
  return (
    <article className="pip-card brief-card" data-type="brief" data-status={card.status} aria-label={card.title}>
      <h3 className="pip-plan-title" dir="auto">
        {card.title}
      </h3>
      <dl className="brief-dl">
        {card.fields.map((f) => (
          <div key={f.key} className="brief-row">
            <dt className="label">{f.label}</dt>
            <dd>{bdi(f.key, f.value)}</dd>
          </div>
        ))}
        {card.refs.length > 0 && (
          <div className="brief-row">
            <dt className="label">Files</dt>
            <dd>
              <ul className="brief-refs">
                {card.refs.map((r) => (
                  <li key={r.name}>
                    <bdi className="ltr" translate="no">
                      {r.name}
                    </bdi>
                    {" · "}
                    {REF_TYPE_LABEL[r.type]}
                    {" · "}
                    {r.rights === "mine" ? "Mine" : r.rights === "licensed" ? "Licensed" : "Not sure"}
                    {r.label && (
                      <>
                        {" "}
                        <Badge tone="info" variant="pill" caps={false} size="sm">
                          {r.label}
                        </Badge>
                      </>
                    )}
                  </li>
                ))}
              </ul>
            </dd>
          </div>
        )}
      </dl>
      <p className="brief-line">{est}</p>
      <p className="brief-line">{crew}</p>
      {picks && <p className="brief-line">{picks}</p>}
      {card.warning && (
        <p className="pip-warning small">
          <Icon name="warning" size="sm" label="Note" /> {card.warning}
        </p>
      )}
      {card.status === "open" ? (
        <div className="pip-actions">
          <Button size="sm" variant="primary" onClick={start} aria-disabled={busy ? "true" : undefined}>
            {busy ? "Starting…" : "Start"}
          </Button>
          {project && isDraftKey(project) && (
            <LinkButton size="sm" variant="quiet" href={`/new/${encodeURIComponent(project)}/options`}>
              Show all options
            </LinkButton>
          )}
        </div>
      ) : (
        <p className="small">
          <span className="pip-mark" aria-hidden="true">
            {card.status === "started" ? "✓" : "–"}
          </span>{" "}
          {card.status === "started" ? "Started" : "Replaced by a newer brief"}
        </p>
      )}
      <p className="pip-error small" role="status">
        {err ?? ""}
      </p>
    </article>
  );
}
