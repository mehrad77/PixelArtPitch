// Settings: providers, models (the capability matrix), roles, defaults and MCP. Tabs are routes (/settings/:tab).
import {
  Badge,
  Button,
  Callout,
  CodeBlock,
  CopyButton,
  Field,
  Fieldset,
  Radio,
  Skeleton,
  Switch,
  Table,
  Tag,
} from "@shabboo/kit/react";
import { type FormEvent, useEffect, useMemo, useState } from "react";
import { client } from "../lib/client.ts";
import { ROLE_LABEL, ROLES } from "../lib/derive.ts";
import { duration, n, usd } from "../lib/format.ts";
import { useLoad } from "../lib/hooks.ts";
import { Link } from "../lib/router.tsx";
import type { Cap, ModelRow, Profile, Provider, ProviderKind, Role, Settings } from "../lib/types.ts";
import { Connections } from "./Connections.tsx";
import "./Settings.css";

export const SETTINGS_TABS = ["setup", "providers", "models", "roles", "defaults", "connections", "mcp"] as const;
export type SettingsTab = (typeof SETTINGS_TABS)[number];
const TAB_LABEL: Record<SettingsTab, string> = {
  setup: "Setup",
  providers: "Providers",
  models: "Models",
  roles: "Roles",
  defaults: "Defaults",
  connections: "Connections",
  mcp: "MCP",
};

export function SettingsPage({ tab }: { tab: SettingsTab }) {
  const s = useLoad(() => client.settings(), []);
  return (
    <main id="main" className="page settings">
      <h1>Settings</h1>
      <nav aria-label="Settings sections" className="settings-tabs">
        <ul>
          {SETTINGS_TABS.map((t) => (
            <li key={t}>
              <Link href={`/settings/${t}`} aria-current={t === tab ? "page" : undefined}>
                {TAB_LABEL[t]}
              </Link>
            </li>
          ))}
        </ul>
      </nav>
      {s.error && (
        <Callout tone="error" title="Settings didn't load">
          {s.error.message}. Start the studio server, then reload this page.
        </Callout>
      )}
      {!s.data && !s.error && <Skeleton lines={5} label="Loading settings" />}
      {s.data && (
        <section aria-labelledby="settings-h2">
          <h2 id="settings-h2">{TAB_LABEL[tab]}</h2>
          {tab === "setup" && <Setup settings={s.data} onSaved={s.reload} />}
          {tab === "providers" && <Providers settings={s.data} onSaved={s.reload} />}
          {tab === "models" && <Models />}
          {tab === "roles" && <Roles settings={s.data} onSaved={s.reload} />}
          {tab === "defaults" && <Defaults settings={s.data} onSaved={s.reload} />}
          {tab === "connections" && <Connections />}
          {tab === "mcp" && <Mcp />}
        </section>
      )}
    </main>
  );
}

// ---- setup: one question, where the crew thinks ----
type Where = "local" | "anthropic" | "both";
const WHERE: { id: Where; label: string; profile: Exclude<Profile, "custom"> }[] = [
  { id: "local", label: "On this Mac (LM Studio): free and private, slower", profile: "local" },
  { id: "anthropic", label: "Anthropic: best quality, about $1–3 per video", profile: "best" },
  { id: "both", label: "Both: local first, Anthropic when it matters", profile: "balanced" },
];
const LM_URL = "http://127.0.0.1:1234/v1";

function Setup({ settings, onSaved }: { settings: Settings; onSaved: () => void }) {
  const lm = settings.providers.find((p) => p.kind === "lmstudio");
  const an = settings.providers.find((p) => p.kind === "anthropic");
  const initial: Where =
    settings.profile === "local"
      ? "local"
      : settings.profile === "best"
        ? "anthropic"
        : settings.profile === "balanced"
          ? "both"
          : lm?.enabled && !an?.enabled
            ? "local"
            : an?.enabled && !lm?.enabled
              ? "anthropic"
              : "both";
  const [where, setWhere] = useState<Where>(initial);
  const [url, setUrl] = useState(lm?.baseUrl ?? LM_URL);
  const [key, setKey] = useState("");
  const [hasKey, setHasKey] = useState(an?.hasKey ?? false);
  const [msg, setMsg] = useState<{ tone: "success" | "error"; text: string } | null>(null);
  const [testing, setTesting] = useState(false);
  const useLocal = where !== "anthropic";
  const useCloud = where !== "local";

  /** writes the providers and the profile; returns false when nothing was saved */
  const write = async (): Promise<boolean> => {
    if (useLocal && !url.trim()) {
      setMsg({ tone: "error", text: "Enter LM Studio's address, for example http://127.0.0.1:1234/v1." });
      document.getElementById("setup-url")?.focus();
      return false;
    }
    if (useCloud && !hasKey && !key.trim()) {
      setMsg({ tone: "error", text: "Paste your Anthropic key; it starts with sk-ant-." });
      document.getElementById("setup-key")?.focus();
      return false;
    }
    const lmNext: Provider = {
      id: lm?.id ?? "lmstudio",
      kind: "lmstudio",
      label: lm?.label ?? "LM Studio",
      baseUrl: url.trim() || LM_URL,
      hasKey: lm?.hasKey ?? false,
      enabled: useLocal,
    };
    const anNext: Provider = {
      id: an?.id ?? "anthropic",
      kind: "anthropic",
      label: an?.label ?? "Anthropic",
      baseUrl: an?.baseUrl ?? "https://api.anthropic.com",
      hasKey,
      enabled: useCloud,
    };
    const others = settings.providers.filter((p) => p.kind !== "lmstudio" && p.kind !== "anthropic");
    const profile = WHERE.find((w) => w.id === where)?.profile ?? "balanced";
    try {
      await client.saveSettings({ providers: [...others, lmNext, anNext], profile });
      if (useCloud && key.trim()) {
        await client.saveKey(anNext.id, key.trim());
        setHasKey(true);
        setKey("");
      }
      return true;
    } catch (e) {
      setMsg({ tone: "error", text: `${(e as Error).message}. Nothing was saved; try again.` });
      return false;
    }
  };
  const save = async (e: FormEvent) => {
    e.preventDefault();
    setMsg(null);
    if (await write()) {
      setMsg({ tone: "success", text: "Saved. New work uses this; running steps finish where they started." });
      onSaved();
    }
  };
  const check = async () => {
    setMsg(null);
    setTesting(true);
    try {
      if (!(await write())) return;
      const r = await client.testProvider(lm?.id ?? "lmstudio");
      setMsg(
        r.ok
          ? { tone: "success", text: `Connected. LM Studio has ${r.models.length} models ready.` }
          : { tone: "error", text: r.error ?? "LM Studio didn't answer. Start its local server and check again." },
      );
    } finally {
      setTesting(false);
    }
  };
  return (
    <form className="stack-4 narrow" onSubmit={save} noValidate>
      <Fieldset id="setup-where" legend="Where should the crew think?">
        {WHERE.map((w) => (
          <Radio
            key={w.id}
            id={`setup-${w.id}`}
            name="setup-where"
            value={w.id}
            label={w.label}
            checked={where === w.id}
            onChange={() => setWhere(w.id)}
          />
        ))}
      </Fieldset>
      {useLocal && (
        <div className="stack-2">
          <Field
            id="setup-url"
            label="LM Studio address"
            code
            type="url"
            autoComplete="off"
            value={url}
            onChange={(e) => setUrl(e.currentTarget.value)}
            hint="Start LM Studio's local server; this is the address it shows."
          />
          <div>
            <Button size="sm" variant="ghost" onClick={check}>
              {testing ? "Checking…" : "Check connection"}
            </Button>
          </div>
        </div>
      )}
      {useCloud && (
        <Field
          id="setup-key"
          label={hasKey ? "Replace your Anthropic key" : "Anthropic key"}
          type="password"
          autoComplete="off"
          value={key}
          onChange={(e) => setKey(e.currentTarget.value)}
          placeholder={hasKey ? "A key is saved; paste a new one to replace it" : "sk-ant-…"}
          hint="Stored by the studio server, never shown again."
        />
      )}
      <div className="provider-actions">
        <Button type="submit" variant="primary">
          Save
        </Button>
        {msg && (
          <p className={msg.tone === "error" ? "decision-error" : "ok-text"} role="status">
            {msg.text}
          </p>
        )}
      </div>
    </form>
  );
}

// ---- providers ----
const KINDS: { kind: ProviderKind; label: string; baseUrl: string; local: boolean }[] = [
  { kind: "anthropic", label: "Anthropic", baseUrl: "https://api.anthropic.com", local: false },
  { kind: "openai", label: "OpenAI", baseUrl: "https://api.openai.com/v1", local: false },
  { kind: "openrouter", label: "OpenRouter", baseUrl: "https://openrouter.ai/api/v1", local: false },
  { kind: "lmstudio", label: "LM Studio", baseUrl: "http://127.0.0.1:1234/v1", local: true },
  { kind: "ollama", label: "Ollama", baseUrl: "http://127.0.0.1:11434", local: true },
  { kind: "llamacpp", label: "llama.cpp", baseUrl: "http://127.0.0.1:8080", local: true },
  { kind: "custom", label: "Custom (OpenAI-compatible)", baseUrl: "", local: false },
];

function Providers({ settings, onSaved }: { settings: Settings; onSaved: () => void }) {
  return (
    <div className="stack-4">
      <p className="muted">
        Keys are stored by the server, outside any project folder, and are never shown again after you save them.
      </p>
      {KINDS.map((k) => {
        const p = settings.providers.find((x) => x.kind === k.kind);
        return <ProviderCard key={k.kind} meta={k} provider={p} settings={settings} onSaved={onSaved} />;
      })}
    </div>
  );
}

function ProviderCard({
  meta,
  provider,
  settings,
  onSaved,
}: {
  meta: (typeof KINDS)[number];
  provider?: Provider;
  settings: Settings;
  onSaved: () => void;
}) {
  const id = provider?.id ?? meta.kind;
  const [baseUrl, setBaseUrl] = useState(provider?.baseUrl ?? meta.baseUrl);
  const [enabled, setEnabled] = useState(provider?.enabled ?? false);
  const [key, setKey] = useState("");
  const [hasKey, setHasKey] = useState(provider?.hasKey ?? false);
  const [msg, setMsg] = useState<{ tone: "success" | "error"; text: string } | null>(null);
  const [testing, setTesting] = useState(false);
  const f = `prov-${meta.kind}`;

  const save = async () => {
    setMsg(null);
    if (!baseUrl.trim()) {
      setMsg({ tone: "error", text: "Enter the base URL, for example http://127.0.0.1:8080/v1." });
      document.getElementById(`${f}-url`)?.focus();
      return;
    }
    const next: Provider = { id, kind: meta.kind, label: meta.label, baseUrl: baseUrl.trim(), enabled, hasKey };
    const providers = provider
      ? settings.providers.map((x) => (x.id === id ? next : x))
      : [...settings.providers, next];
    try {
      await client.saveSettings({ providers });
      if (key.trim()) {
        await client.saveKey(id, key.trim());
        setHasKey(true);
        setKey("");
      }
      setMsg({ tone: "success", text: "Saved." });
      onSaved();
    } catch (e) {
      setMsg({ tone: "error", text: `${(e as Error).message}. Nothing was saved; try again.` });
    }
  };
  const test = async () => {
    setTesting(true);
    setMsg(null);
    try {
      const r = await client.testProvider(id);
      setMsg(
        r.ok
          ? {
              tone: "success",
              text: `Connected. ${r.models.length} models: ${r.models.slice(0, 4).join(", ")}${r.models.length > 4 ? "…" : ""}`,
            }
          : { tone: "error", text: r.error ?? "It didn't answer." },
      );
    } catch (e) {
      setMsg({ tone: "error", text: `${(e as Error).message}. Save the provider first, then test.` });
    } finally {
      setTesting(false);
    }
  };
  return (
    <section className="provider" aria-labelledby={`${f}-t`}>
      <div className="provider-head">
        <h3 id={`${f}-t`} className="h4">
          {meta.label}
        </h3>
        {meta.local && <Tag size="sm">Runs on this Mac</Tag>}
        {!provider && <Badge tone="muted">Not set up</Badge>}
        {hasKey && <Badge tone="success">Key saved</Badge>}
      </div>
      <div className="provider-fields">
        <Field
          id={`${f}-url`}
          label="Base URL"
          code
          value={baseUrl}
          onChange={(e) => setBaseUrl(e.currentTarget.value)}
          type="url"
          size="sm"
          autoComplete="off"
        />
        {(!meta.local || meta.kind === "custom") && (
          <Field
            id={`${f}-key`}
            label={hasKey ? "Replace key" : "API key"}
            type="password"
            size="sm"
            autoComplete="off"
            value={key}
            onChange={(e) => setKey(e.currentTarget.value)}
            placeholder={hasKey ? "Paste a new key to replace the saved one" : "Paste the key"}
            hint="Write-only: the saved key is never read back."
          />
        )}
        <Switch
          id={`${f}-on`}
          label="Use this provider"
          checked={enabled}
          onChange={(e) => setEnabled(e.currentTarget.checked)}
          size="sm"
        />
      </div>
      <div className="provider-actions">
        <Button size="sm" variant="primary" onClick={save}>
          Save {meta.label}
        </Button>
        <Button size="sm" variant="ghost" onClick={test}>
          {testing ? "Testing…" : "Test connection"}
        </Button>
        {msg && (
          <p className={msg.tone === "error" ? "decision-error" : "ok-text"} role="status">
            {msg.tone === "error" ? "Didn't work: " : ""}
            {msg.text}
          </p>
        )}
      </div>
    </section>
  );
}

// ---- models ----
const CAP_WORD: Record<Cap, string> = { passed: "Passed", claimed: "Claimed", failed: "Failed", unknown: "Unknown" };
const CAP_TONE: Record<Cap, "success" | "muted" | "error" | "info"> = {
  passed: "success",
  claimed: "info",
  failed: "error",
  unknown: "muted",
};
type SortKey = "label" | "provider" | "ctx" | "price" | "speed" | "spend";

function CapBadge({ c }: { c: Cap }) {
  return (
    <Badge tone={CAP_TONE[c]} variant="text">
      {CAP_WORD[c]}
    </Badge>
  );
}

function Models() {
  const m = useLoad(() => client.models(), []);
  const [sort, setSort] = useState<{ key: SortKey; dir: 1 | -1 }>({ key: "label", dir: 1 });
  const [status, setStatus] = useState("");
  const rows = useMemo(() => {
    const val = (r: ModelRow): string | number => {
      switch (sort.key) {
        case "label":
          return r.label.toLowerCase();
        case "provider":
          return r.provider;
        case "ctx":
          return r.ctx;
        case "price":
          return r.price ? r.price.inPerMTok + r.price.outPerMTok : 0;
        case "speed":
          return r.speed?.tokPerSec ?? -1;
        case "spend":
          return r.spend30dUsd;
      }
    };
    return [...(m.data ?? [])].sort((a, b) => {
      const x = val(a);
      const y = val(b);
      return (x < y ? -1 : x > y ? 1 : 0) * sort.dir;
    });
  }, [m.data, sort]);
  if (m.error)
    return (
      <Callout tone="error" title="Models didn't load">
        {m.error.message}. Check a provider in Providers, then reload.
      </Callout>
    );
  if (!m.data) return <Skeleton lines={4} label="Loading models" />;
  const th = (key: SortKey, label: string, num = false) => {
    const on = sort.key === key;
    return (
      <th
        scope="col"
        className={num ? "num" : undefined}
        aria-sort={on ? (sort.dir === 1 ? "ascending" : "descending") : "none"}
      >
        <button
          type="button"
          onClick={() => {
            const dir = on ? (-sort.dir as 1 | -1) : 1;
            setSort({ key, dir });
            setStatus(`Sorted by ${label}, ${dir === 1 ? "ascending" : "descending"}`);
          }}
        >
          {label}
        </button>
      </th>
    );
  };
  return (
    <div className="stack-3">
      <p className="muted small">
        Passed: PAP tested it. Claimed: the provider says so, untested. Failed: it broke on PAP's test.
      </p>
      <Table
        caption="Models and what they can do"
        captionHidden
        sortable
        sortStatus={status}
        framed
        size="sm"
        stickyHeader
      >
        <thead>
          <tr>
            {th("label", "Model")}
            {th("provider", "Provider")}
            <th scope="col">Vision</th>
            <th scope="col">Structured output</th>
            <th scope="col">Long output</th>
            {th("ctx", "Context", true)}
            {th("price", "Price in / out per Mtok", true)}
            {th("speed", "Speed", true)}
            {th("spend", "30-day spend", true)}
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.id}>
              <td>
                {r.label}
                <div className="muted small mono ltr">{r.id}</div>
              </td>
              <td>{r.provider}</td>
              <td>
                <CapBadge c={r.caps.vision} />
              </td>
              <td>
                <CapBadge c={r.caps.structured} />
              </td>
              <td>
                <CapBadge c={r.caps.longOutput} />
              </td>
              <td className="num">{n(Math.round(r.ctx / 1000))}k</td>
              <td className="num">
                {r.local
                  ? "Free, runs on this Mac"
                  : r.price
                    ? `${usd(r.price.inPerMTok)} / ${usd(r.price.outPerMTok)}`
                    : "Unknown"}
              </td>
              <td className="num">
                {r.speed
                  ? `${n(r.speed.tokPerSec)} tok/s, ${n(r.speed.ttftMs)} ms first token, ${n(r.speed.samples)} samples`
                  : "Not measured"}
              </td>
              <td className="num">{usd(r.spend30dUsd)}</td>
            </tr>
          ))}
        </tbody>
      </Table>
    </div>
  );
}

// ---- roles ----
type Need = "vision" | "structured" | "longOutput";
const NEED_WORD: Record<Need, string> = {
  vision: "vision",
  structured: "structured output",
  longOutput: "long output",
};
const NEEDS: Record<Role, Need[]> = {
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
const capable = (m: ModelRow, needs: Need[]) => needs.find((nd) => m.caps[nd] === "failed" || m.caps[nd] === "unknown");
function estimate(m: ModelRow | undefined, role: Role) {
  if (!m) return null;
  const [i, o] = TOKENS[role];
  const cost = m.local || !m.price ? 0 : (i * m.price.inPerMTok + o * m.price.outPerMTok) / 1e6;
  const sec = m.speed ? (m.speed.ttftMs / 1000) * 6 + o / m.speed.tokPerSec : null;
  return { cost, sec };
}
function pickFor(profile: Exclude<Profile, "custom">, role: Role, models: ModelRow[]): string | undefined {
  const ok = models.filter((m) => !capable(m, NEEDS[role]));
  const price = (m: ModelRow) => (m.price ? m.price.inPerMTok + m.price.outPerMTok : 0);
  if (profile === "local") return ok.find((m) => m.local)?.id;
  const remote = ok.filter((m) => !m.local).sort((a, b) => price(b) - price(a));
  if (profile === "best") return remote[0]?.id;
  return remote[Math.floor(remote.length / 2)]?.id ?? remote[0]?.id;
}

function Roles({ settings, onSaved }: { settings: Settings; onSaved: () => void }) {
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
  return (
    <div className="stack-4">
      <Fieldset
        id="role-profile"
        legend="Profile"
        layout="row"
        hint="A profile picks a model for every role. Change any role to make it Custom."
      >
        {(["best", "balanced", "local", "custom"] as const).map((p) => (
          <Radio
            key={p}
            id={`rp-${p}`}
            name="role-profile"
            variant="chip"
            indicator={false}
            label={p[0].toUpperCase() + p.slice(1)}
            checked={profile === p}
            onChange={() => setProfile(p)}
          />
        ))}
      </Fieldset>
      {profile !== "custom" && (
        <Callout tone="aside" title="What changes">
          {preview.length === 0 ? (
            <p>Nothing: every role already uses the {profile} pick.</p>
          ) : (
            <>
              <ul className="plain-list">
                {preview.map((p) => (
                  <li key={p.r}>
                    {ROLE_LABEL[p.r]}: {label(p.from)} →{" "}
                    {p.to ? label(p.to) : <strong>no capable model; keeps {label(p.from)}</strong>}
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
      <Table caption="Model for each role" captionHidden size="sm" framed>
        <thead>
          <tr>
            <th scope="col">Role</th>
            <th scope="col">Needs</th>
            <th scope="col">Model</th>
            <th scope="col">Fallback</th>
            <th scope="col" className="num">
              Per 60 s
            </th>
          </tr>
        </thead>
        <tbody>
          {ROLES.map((r) => {
            const needs = NEEDS[r];
            const ok = models.filter((x) => !capable(x, needs));
            const hidden = models.filter((x) => capable(x, needs));
            const why = needs
              .map((nd) => ({ nd, count: hidden.filter((x) => capable(x, needs) === nd).length }))
              .filter((x) => x.count);
            const hint = hidden.length
              ? `${hidden.length} hidden: ${why.map((w) => `no ${NEED_WORD[w.nd]}`).join(", ")}`
              : undefined;
            const cur = roles[r] ?? { model: "" };
            const est = estimate(
              models.find((x) => x.id === cur.model),
              r,
            );
            return (
              <tr key={r}>
                <th scope="row">{ROLE_LABEL[r]}</th>
                <td>
                  {needs.map((nd) => (
                    <Tag key={nd} size="sm" as="span">
                      {NEED_WORD[nd]}
                    </Tag>
                  ))}
                </td>
                <td>
                  <Field
                    id={`role-${r}`}
                    label={`${ROLE_LABEL[r]} model`}
                    control="select"
                    size="sm"
                    value={cur.model}
                    hint={hint}
                    onChange={(e) => set(r, { model: e.currentTarget.value })}
                  >
                    {!ok.some((x) => x.id === cur.model) && (
                      <option value={cur.model}>{cur.model || "Pick a model"} (not capable)</option>
                    )}
                    {ok.map((x) => (
                      <option key={x.id} value={x.id}>
                        {x.label}
                      </option>
                    ))}
                  </Field>
                </td>
                <td>
                  <Field
                    id={`role-fb-${r}`}
                    label={`${ROLE_LABEL[r]} fallback`}
                    control="select"
                    size="sm"
                    value={cur.fallback ?? ""}
                    onChange={(e) => set(r, { fallback: e.currentTarget.value || undefined })}
                  >
                    <option value="">None</option>
                    {ok.map((x) => (
                      <option key={x.id} value={x.id}>
                        {x.label}
                      </option>
                    ))}
                  </Field>
                </td>
                <td className="num">
                  {est
                    ? `${est.cost === 0 ? "Free" : usd(est.cost)}, ${est.sec == null ? "time unknown" : duration(est.sec)}`
                    : "–"}
                </td>
              </tr>
            );
          })}
        </tbody>
      </Table>
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

// ---- defaults ----
function Defaults({ settings, onSaved }: { settings: Settings; onSaved: () => void }) {
  const d = settings.defaults;
  const [cap, setCap] = useState(String(d.capUsd));
  const [ask, setAsk] = useState(String(Math.round(d.askAtFraction * 100)));
  const [inv, setInv] = useState(d.involvement);
  const [conc, setConc] = useState(String(d.concurrency));
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [msg, setMsg] = useState<string | null>(null);
  const save = async (e: FormEvent) => {
    e.preventDefault();
    const er: Record<string, string> = {};
    if (!(Number(cap) > 0)) er["d-cap"] = "Enter a cap above $0.";
    if (!(Number(ask) >= 10 && Number(ask) <= 100)) er["d-ask"] = "Pick 10 to 100 percent.";
    if (!(Number.isInteger(Number(conc)) && Number(conc) >= 1 && Number(conc) <= 16))
      er["d-conc"] = "Run 1 to 16 tasks at once.";
    setErrors(er);
    const first = Object.keys(er)[0];
    if (first) return document.getElementById(first)?.focus();
    try {
      await client.saveSettings({
        defaults: {
          capUsd: Number(cap),
          askAtFraction: Number(ask) / 100,
          involvement: inv,
          concurrency: Number(conc),
        },
      });
      setMsg("Saved. New projects start with these.");
      onSaved();
    } catch (ex) {
      setMsg(`${(ex as Error).message}. Nothing was saved.`);
    }
  };
  return (
    <form className="stack-4 narrow" onSubmit={save} noValidate>
      <Field
        id="d-cap"
        label="Budget cap ($)"
        type="number"
        min={0}
        step="0.5"
        value={cap}
        onChange={(e) => setCap(e.currentTarget.value)}
        error={errors["d-cap"]}
      />
      <Field
        id="d-ask"
        label="Ask me at (% of the cap)"
        type="number"
        min={10}
        max={100}
        value={ask}
        onChange={(e) => setAsk(e.currentTarget.value)}
        error={errors["d-ask"]}
      />
      <Field
        id="d-inv"
        label="Involvement"
        control="select"
        value={inv}
        onChange={(e) => setInv(e.currentTarget.value as Settings["defaults"]["involvement"])}
      >
        <option value="every">Every gate</option>
        <option value="key">Key gates</option>
        <option value="auto">Run on its own</option>
      </Field>
      <Field
        id="d-conc"
        label="Tasks at once"
        type="number"
        min={1}
        max={16}
        value={conc}
        onChange={(e) => setConc(e.currentTarget.value)}
        hint="More is faster, but spends faster too."
        error={errors["d-conc"]}
      />
      <div className="provider-actions">
        <Button type="submit" variant="primary">
          Save defaults
        </Button>
        {msg && (
          <p className="ok-text" role="status">
            {msg}
          </p>
        )}
      </div>
    </form>
  );
}

// ---- mcp ----
function Mcp() {
  const s = useLoad(() => client.session(), []);
  if (s.error)
    return (
      <Callout tone="error" title="No session">
        {s.error.message}. Open the studio from the launch link the server printed.
      </Callout>
    );
  if (!s.data) return <Skeleton lines={3} label="Loading the MCP details" />;
  const endpoint = `${location.protocol}//${location.hostname}:5141/mcp`;
  const token: string = (s.data as any).mcpToken ?? "";
  const cliPath: string = (s.data as any).cli ?? "apps/server/src/cli.ts";
  const cli = `claude mcp add --transport http pap ${endpoint} --header "Authorization: Bearer ${token}"`;
  const stdio = `claude mcp add pap -- node ${cliPath} mcp`;
  const json = JSON.stringify(
    { mcpServers: { pap: { type: "http", url: endpoint, headers: { Authorization: `Bearer ${token}` } } } },
    null,
    2,
  );
  return (
    <div className="stack-4">
      <p>Any MCP client can drive a project or join the crew through the same tools the crew uses.</p>
      <dl className="mcp-dl">
        <dt className="label">Endpoint</dt>
        <dd className="mono ltr">{endpoint}</dd>
        <dt className="label">Token</dt>
        <dd>
          <span className="mono ltr">{`${token.slice(0, 4)}${"•".repeat(12)}`}</span>{" "}
          <CopyButton value={token} size="sm" variant="ghost" copiedLabel="Copied">
            Copy token
          </CopyButton>
        </dd>
      </dl>
      <p className="muted small">The token stays the same across restarts. Treat it like a password.</p>
      <CodeBlock label="Claude Code (HTTP)" code={cli} copy copyLabel="Copy command" copiedLabel="Copied" />
      <CodeBlock
        label="Claude Code (stdio, no token: it talks to this studio when it's running)"
        code={stdio}
        copy
        copyLabel="Copy command"
        copiedLabel="Copied"
      />
      <CodeBlock label=".mcp.json" lang="json" code={json} copy copyLabel="Copy config" copiedLabel="Copied" />
    </div>
  );
}
