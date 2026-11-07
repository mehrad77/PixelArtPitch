// Settings › Roles: which model each member of the crew thinks with (docs/PIP-JOURNEY.md §10). Pip leads, on its own
// row with its crown; then the crew as people see it (the faces and names of the crew row and drawer), each member
// with the roles it covers as sub-rows. A model that lacks what a role needs is never the silent choice: the row says
// so in words, with an icon, says what happens then (the fallback, or that the role stops) and offers the best capable
// model in one press. Costs read as "About $1.08 and 5 min per 60 s video", with the total under the list and each
// profile's total beside its name.
import { Button, Callout, Field, Fieldset, Icon, Radio, Skeleton } from "@shabboo/kit/react";
import { type CSSProperties, useEffect, useMemo, useState } from "react";
import { CrewFace } from "../components/CrewStrip.tsx";
import { PipFace } from "../components/PipFace.tsx";
import { client } from "../lib/client.ts";
import { ROLE_LABEL, ROLES } from "../lib/derive.ts";
import { duration, usd } from "../lib/format.ts";
import { useLoad } from "../lib/hooks.ts";
import { CREW, memberOf } from "../lib/human.ts";
import { Link } from "../lib/router.tsx";
import type { ModelRow, Profile, Role, Settings } from "../lib/types.ts";
import "./SettingsRoles.css";

type Need = "vision" | "structured" | "longOutput";
/** what a role needs, said as a person would */
const NEED_WORD: Record<Need, string> = {
  vision: "see pictures",
  structured: "return structured output",
  longOutput: "write long answers",
};
export const NEEDS: Record<Role, Need[]> = {
  producer: ["structured", "longOutput"],
  writer: ["longOutput"],
  director: ["vision", "structured"],
  "art-director": ["vision"],
  "pixel-artist": ["vision", "structured"],
  animator: ["structured"],
  "scene-coder": ["structured", "longOutput"],
  "sound-designer": ["structured"],
  mixer: ["structured"],
  editor: ["structured"],
  reviewer: ["vision"],
  librarian: ["vision"],
  assistant: ["structured"],
};
/** rough tokens a role spends per 60 s of video: [in, out] */
const TOKENS: Record<Role, [number, number]> = {
  producer: [60000, 8000],
  writer: [20000, 6000],
  director: [40000, 6000],
  "art-director": [50000, 4000],
  "pixel-artist": [120000, 30000],
  animator: [60000, 12000],
  "scene-coder": [60000, 20000],
  "sound-designer": [15000, 3000],
  mixer: [8000, 1500],
  editor: [20000, 3000],
  reviewer: [80000, 4000],
  librarian: [20000, 2000],
  assistant: [30000, 3000],
};

/** "a, b and c" */
const and = (xs: string[]) => (xs.length < 2 ? (xs[0] ?? "") : `${xs.slice(0, -1).join(", ")} and ${xs.at(-1)}`);

/** what a model can do for a role: `cant` are the needs it failed, `unchecked` the ones nobody has tested */
export function fitOf(m: ModelRow | undefined, role: Role): { ok: boolean; cant: Need[]; unchecked: Need[] } {
  if (!m) return { ok: false, cant: [], unchecked: NEEDS[role] };
  const cant = NEEDS[role].filter((nd) => m.caps[nd] === "failed");
  const unchecked = NEEDS[role].filter((nd) => m.caps[nd] === "unknown");
  return { ok: !cant.length && !unchecked.length, cant, unchecked };
}

/** the model the gateway uses for a role its settings leave unset (`modelFor` in packages/crew) */
export const DEFAULT_MODEL = "anthropic/claude-sonnet-5-5";

/** one role's spend (null: no price known) and time per 60 s of video on a model */
export function estimate(m: ModelRow | undefined, role: Role): { usd: number | null; sec: number | null } | null {
  if (!m) return null;
  const [i, o] = TOKENS[role];
  const cost = m.local ? 0 : m.price ? (i * m.price.inPerMTok + o * m.price.outPerMTok) / 1e6 : null;
  const sec = m.speed ? (m.speed.ttftMs / 1000) * 6 + o / m.speed.tokPerSec : null;
  return { usd: cost, sec };
}

/** the model a profile gives a role: capable ones only; Best the dearest, Balanced the middle, Local the first local */
export function pickFor(profile: Exclude<Profile, "custom">, role: Role, models: ModelRow[]): string | undefined {
  const ok = models.filter((m) => fitOf(m, role).ok);
  const price = (m: ModelRow) => (m.price ? m.price.inPerMTok + m.price.outPerMTok : 0);
  if (profile === "local") return ok.find((m) => m.local)?.id;
  // a model with a known price first: a profile's cost must mean something
  const all = ok.filter((m) => !m.local);
  const priced = all.filter((m) => m.price);
  const remote = (priced.length ? priced : all).sort((a, b) => price(b) - price(a));
  if (profile === "best") return remote[0]?.id;
  return remote[Math.floor(remote.length / 2)]?.id ?? remote[0]?.id;
}

/** the whole crew's spend and time per 60 s video for an assignment; `missing` roles have no model or price */
export function totalOf(assign: (r: Role) => string | undefined, models: ModelRow[]) {
  let cost = 0;
  let sec = 0;
  let timed = true;
  const missing: Role[] = [];
  const unpriced: Role[] = [];
  for (const r of ROLES) {
    const id = assign(r);
    const e = estimate(
      models.find((m) => m.id === id),
      r,
    );
    if (!e) {
      missing.push(r);
      continue;
    }
    if (e.usd == null) unpriced.push(r);
    else cost += e.usd;
    if (e.sec == null) timed = false;
    else sec += e.sec;
  }
  return { usd: cost, sec: timed ? sec : null, missing, unpriced };
}

/** "About $1.08 and 5 min per 60 s video" */
function costLine(e: { usd: number | null; sec: number | null } | null, local?: boolean): string {
  if (!e) return "No model picked";
  const money = e.usd == null ? "No price known" : e.usd === 0 && local ? "Free on this Mac" : `About ${usd(e.usd)}`;
  const time = e.sec == null ? ", time not measured yet" : ` and ${duration(e.sec)}`;
  return `${money}${time} per 60 s video`;
}

const PROFILES = ["best", "balanced", "local", "custom"] as const;
const PROFILE_WORD: Record<Profile, string> = { best: "Best", balanced: "Balanced", local: "Local", custom: "Custom" };

export function Roles({ settings, onSaved }: { settings: Settings; onSaved: () => void }) {
  const m = useLoad(() => client.models(), []);
  const [roles, setRoles] = useState(settings.roles);
  const [profile, setProfile] = useState<Profile>(settings.profile);
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const models = m.data ?? [];
  useEffect(() => setRoles(settings.roles), [settings.roles]);
  const preview = useMemo(() => {
    if (profile === "custom" || !models.length) return [];
    return ROLES.flatMap((r): { r: Role; from?: string; to?: string }[] => {
      const to = pickFor(profile, r, models);
      const from = roles[r]?.model;
      return to && to !== from ? [{ r, from, to }] : to ? [] : [{ r, from, to: undefined }];
    });
  }, [profile, models, roles]);
  if (m.error)
    return (
      <Callout tone="error" title="Models didn't load">
        {m.error.message}.
      </Callout>
    );
  if (!m.data) return <Skeleton lines={5} label="Loading roles" />;
  const set = (r: Role, patch: Partial<{ model: string; fallback?: string }>) => {
    setRoles((x) => ({ ...x, [r]: { ...x[r], ...patch } }));
    setProfile("custom");
    setMsg(null);
  };
  const applyProfile = () => {
    const next = { ...roles };
    for (const p of preview) if (p.to) next[p.r] = { ...next[p.r], model: p.to };
    setRoles(next);
  };
  const save = async () => {
    setErr(null);
    try {
      await client.saveSettings({ roles, profile });
      setMsg("Saved. New tasks use these models; running ones finish on theirs.");
      onSaved();
    } catch (e) {
      setErr(`${(e as Error).message}. Nothing was saved.`);
    }
  };
  const label = (id?: string) => models.find((x) => x.id === id)?.label ?? id ?? "none";
  const modelOf = (r: Role) => roles[r]?.model || DEFAULT_MODEL;
  const total = totalOf(modelOf, models);
  const profileTotal = (p: Profile) =>
    p === "custom" ? total : totalOf((r) => pickFor(p, r, models) ?? modelOf(r), models);
  const anyUnchecked = ROLES.some(
    (r) =>
      fitOf(
        models.find((x) => x.id === modelOf(r)),
        r,
      ).unchecked.length,
  );
  const row = (r: Role, sub: boolean) => (
    <RoleRow
      key={r}
      role={r}
      sub={sub}
      models={models}
      cur={roles[r] ?? { model: "" }}
      // Pip falls back to the Producer's model when it names none (the gateway's rule)
      fallbackDefault={r === "assistant" ? roles.producer?.model : undefined}
      onChange={(patch) => set(r, patch)}
    />
  );
  return (
    <div className="stack-4 roles">
      <Fieldset
        id="role-profile"
        legend="Profile"
        layout="row"
        hint="A profile picks a model for every role. The price is the whole crew's, per 60 s video. Change any role to make it Custom."
      >
        {PROFILES.map((p) => {
          const t = profileTotal(p);
          return (
            <Radio
              key={p}
              id={`rp-${p}`}
              name="role-profile"
              variant="chip"
              indicator={false}
              label={PROFILE_WORD[p]}
              count={
                t.missing.length === ROLES.length ? "no models" : `about ${usd(t.usd)}${t.unpriced.length ? "+" : ""}`
              }
              countStyle="plain"
              checked={profile === p}
              onChange={() => setProfile(p)}
            />
          );
        })}
      </Fieldset>
      {profile !== "custom" && (
        <Callout tone="aside" title="What changes">
          {preview.length === 0 ? (
            <p>Nothing: every role already uses the {PROFILE_WORD[profile].toLowerCase()} pick.</p>
          ) : (
            <>
              <ul className="plain-list">
                {preview.map((p) => (
                  <li key={p.r}>
                    {ROLE_LABEL[p.r]}: <bdi>{label(p.from)}</bdi> →{" "}
                    {p.to ? <bdi>{label(p.to)}</bdi> : <strong>no capable model; keeps {label(p.from)}</strong>}
                  </li>
                ))}
              </ul>
              <Button size="sm" variant="ghost" onClick={applyProfile}>
                Use these models
              </Button>
            </>
          )}
        </Callout>
      )}

      <section className="roles-group" aria-labelledby="roles-lead-h">
        <h3 id="roles-lead-h" className="roles-member">
          <PipFace mood="idle" size="sm" />
          <span>Pip</span>
          <span className="roles-member-what muted" dir="auto">
            plans the video, runs the crew and answers you
          </span>
        </h3>
        <ul className="roles-list">{row("assistant", false)}</ul>
      </section>

      <section className="roles-group" aria-labelledby="roles-crew-h">
        <h3 id="roles-crew-h" className="label roles-crew-label">
          The crew
        </h3>
        {CREW.map((mem) => (
          <section
            key={mem.id}
            className="roles-group roles-crew-member"
            aria-labelledby={`roles-m-${mem.id}`}
            style={{ "--who-hue": `var(--category-${mem.hue})` } as CSSProperties}
          >
            <h4 id={`roles-m-${mem.id}`} className="roles-member">
              <CrewFace member={mem} mood="idle" />
              <span>{mem.label}</span>
            </h4>
            <ul className="roles-list">
              {mem.roles.map((r) => row(r, mem.roles.length > 1 || mem.label !== ROLE_LABEL[r]))}
            </ul>
          </section>
        ))}
      </section>

      <p className="roles-note small muted" dir="auto">
        Each list puts the models that can do the role first; the ones nobody has checked yet, and the ones that can't,
        come after, marked.{" "}
        {anyUnchecked && (
          <>
            Check a model's skills from <Link href="/settings/providers">Providers</Link> (Test).
          </>
        )}
      </p>
      <p className="roles-total" aria-live="polite" dir="auto">
        <strong>With these models:</strong>{" "}
        {total.missing.length === ROLES.length ? "no models picked yet" : costLine(total).replace(/^About/, "about")}
        {total.missing.length > 0 && total.missing.length < ROLES.length
          ? ` (${and(total.missing.map((r) => ROLE_LABEL[r]))} not counted: no model)`
          : ""}
        {total.unpriced.length > 0 ? `, plus ${and(total.unpriced.map((r) => ROLE_LABEL[r]))} (no price known)` : ""}.
      </p>
      <div className="provider-actions">
        <Button variant="primary" onClick={save}>
          Save roles
        </Button>
        {msg && !err && (
          <p className="ok-text" role="status">
            {msg}
          </p>
        )}
        {err && (
          <p className="decision-error" role="status">
            {err}
          </p>
        )}
      </div>
    </div>
  );
}

function RoleRow({
  role: r,
  sub,
  models,
  cur,
  fallbackDefault,
  onChange,
}: {
  role: Role;
  /** shown under its crew member, with its own name */
  sub: boolean;
  models: ModelRow[];
  cur: { model: string; fallback?: string };
  fallbackDefault?: string;
  onChange: (patch: Partial<{ model: string; fallback?: string }>) => void;
}) {
  const needs = NEEDS[r];
  // a role left unset runs on the gateway's default model
  const effective = cur.model || DEFAULT_MODEL;
  const chosen = models.find((x) => x.id === effective);
  const fit = fitOf(chosen, r);
  const groups = {
    ok: models.filter((x) => fitOf(x, r).ok),
    unchecked: models.filter((x) => !fitOf(x, r).ok && !fitOf(x, r).cant.length),
    cant: models.filter((x) => fitOf(x, r).cant.length > 0),
  };
  const fbId = cur.fallback ?? fallbackDefault;
  const fb = models.find((x) => x.id === fbId);
  const fbOk = !!fb && fitOf(fb, r).ok && fb.id !== effective;
  const best = pickFor("best", r, models);
  const name = ROLE_LABEL[r];
  const est = estimate(chosen, r);
  const opt = (x: ModelRow, why?: string) => (
    <option key={x.id} value={x.id}>
      {x.label}
      {why ? ` (${why})` : ""}
    </option>
  );
  const cantWord = (x: ModelRow) => `can't ${and(fitOf(x, r).cant.map((nd) => NEED_WORD[nd]))}`;
  const then = fbOk
    ? `If a task fails on it, the crew falls back to ${fb?.label}.`
    : `If a task fails on it, the role stops${fb ? `: its fallback, ${fb.label}, can't do it either` : ": it has no fallback"}.`;
  return (
    <li
      className="roles-row"
      data-sub={sub ? "" : undefined}
      data-fit={!chosen ? "none" : fit.cant.length ? "cant" : fit.ok ? "ok" : "unchecked"}
    >
      <div className="roles-name">
        {sub && (
          <span className="roles-role">
            <CrewFace member={memberOf(r)} role={r} mood="idle" />
            {name}
          </span>
        )}
        <span className="roles-needs small muted" dir="auto">
          Needs to {and(needs.map((nd) => NEED_WORD[nd]))}.
        </span>
      </div>
      <Field
        id={`role-${r}`}
        label={`${name} model`}
        control="select"
        size="sm"
        className="roles-model"
        value={cur.model}
        onChange={(e) => onChange({ model: e.currentTarget.value })}
      >
        {!cur.model && <option value="">Default ({chosen?.label ?? DEFAULT_MODEL})</option>}
        {cur.model && !chosen && <option value={cur.model}>{cur.model} (not in the model list)</option>}
        <optgroup label="Can do this role">{groups.ok.map((x) => opt(x))}</optgroup>
        {groups.unchecked.length > 0 && (
          <optgroup label="Not checked yet">{groups.unchecked.map((x) => opt(x, "not checked"))}</optgroup>
        )}
        {groups.cant.length > 0 && (
          <optgroup label="Can't do this role">{groups.cant.map((x) => opt(x, cantWord(x)))}</optgroup>
        )}
      </Field>
      <Field
        id={`role-fb-${r}`}
        label={`${name} fallback`}
        control="select"
        size="sm"
        className="roles-fallback"
        value={cur.fallback ?? ""}
        onChange={(e) => onChange({ fallback: e.currentTarget.value || undefined })}
      >
        <option value="">
          {fallbackDefault
            ? `The Producer's (${models.find((x) => x.id === fallbackDefault)?.label ?? fallbackDefault})`
            : "None"}
        </option>
        {groups.ok.map((x) => opt(x))}
      </Field>
      <p className="roles-cost small" dir="auto">
        <bdi>{costLine(est, chosen?.local)}</bdi>
      </p>
      {chosen && !fit.ok && (
        <div className="roles-warn" role="note" data-kind={fit.cant.length ? "cant" : "unchecked"}>
          <p dir="auto">
            {fit.cant.length ? (
              <>
                <Icon name="warning" size="sm" label="Can't" /> <strong>Can't:</strong> this model can't{" "}
                {and(fit.cant.map((nd) => NEED_WORD[nd]))}. {then}
              </>
            ) : (
              <>
                <span className="roles-warn-mark" aria-hidden="true">
                  ?
                </span>{" "}
                <strong>Not checked:</strong> nobody has tested whether this model can{" "}
                {and(fit.unchecked.map((nd) => NEED_WORD[nd]))}. {then}
              </>
            )}
          </p>
          {best && best !== effective && (
            <Button size="sm" variant="ghost" onClick={() => onChange({ model: best })}>
              Use {models.find((x) => x.id === best)?.label ?? best}
            </Button>
          )}
        </div>
      )}
    </li>
  );
}
