// The Docs page's reader: one doc as Markdown, one of the studio's tools, or one tool from a connection. Each is the
// page's one h1. Nothing here moves focus; a #section in the address only scrolls to it once the doc has loaded.
import {
  Badge,
  Callout,
  CodeBlock,
  DescriptionList,
  Disclosure,
  EmptyState,
  Skeleton,
  Table,
} from "@shabboo/kit/react";
import { useEffect, useMemo } from "react";
import { Markdown } from "../components/Markdown.tsx";
import {
  type ConnDoc,
  type ConnToolDoc,
  type DocEntry,
  docsApi,
  EFFECT_WORD,
  rolesWord,
  type ToolDoc,
  type ToolField,
} from "../lib/docs.ts";
import { useLoad } from "../lib/hooks.ts";
import { parseMarkdown, slugger } from "../lib/markdown.ts";
import { Link } from "../lib/router.tsx";

const ID_PREFIX = "doc-";

/** a crumb trail of in-app links back to /docs */
function Crumbs({ items }: { items: string[] }) {
  return (
    <nav aria-label="Breadcrumb" className="label docs-crumbs">
      <Link href="/docs">Docs</Link>
      {items.map((x) => (
        <span key={x}>
          <span aria-hidden="true"> / </span>
          <bdi>{x}</bdi>
        </span>
      ))}
    </nav>
  );
}

export function DocReader({ path, known }: { path: string; known: DocEntry[] | null }) {
  const doc = useLoad(() => docsApi.doc(path), [path]);
  const knownSet = useMemo(() => new Set((known ?? []).map((d) => d.path)), [known]);
  const blocks = useMemo(() => {
    if (!doc.data) return [];
    const bs = parseMarkdown(doc.data.markdown, slugger());
    // the doc's own first heading is the page's h1, shown above it
    return bs[0]?.t === "h" && bs[0].level === 1 ? bs.slice(1) : bs;
  }, [doc.data]);

  // a #section in the address: scroll there once the text is in (no focus change)
  useEffect(() => {
    if (!doc.data || !location.hash) return;
    const el = document.getElementById(decodeURIComponent(location.hash.slice(1)));
    el?.scrollIntoView({ block: "start" });
  }, [doc.data]);

  if (doc.error)
    return (
      <article className="docs-reader">
        <Crumbs items={[path]} />
        <h1 dir="auto">That doc didn't open</h1>
        <Callout tone="error" title={doc.error.message}>
          {(doc.error as { fix?: string }).fix ?? "Pick a doc from the list."} <Link href="/docs">See every doc</Link>.
        </Callout>
      </article>
    );
  if (!doc.data)
    return (
      <article className="docs-reader" aria-busy="true">
        <Crumbs items={[path]} />
        <Skeleton lines={8} label="Opening the doc" />
      </article>
    );
  const d = doc.data;
  return (
    <article className="docs-reader">
      <Crumbs items={[d.group || "Repo root"]} />
      <h1 dir="auto">{d.title}</h1>
      <p className="docs-path mono small muted" dir="ltr">
        {d.path}
      </p>
      {d.meta.description && (
        <p className="docs-lede" dir="auto">
          {d.meta.description}
        </p>
      )}
      <Markdown blocks={blocks} links={{ from: d.path, known: knownSet, idPrefix: ID_PREFIX }} />
    </article>
  );
}

// ---------------------------------------------------------------- tools

const EFFECT_TONE: Record<string, "muted" | "info" | "warning" | "error"> = {
  read: "muted",
  write: "info",
  spend: "warning",
  destructive: "error",
};

const show = (v: unknown) => (typeof v === "string" ? JSON.stringify(v) : JSON.stringify(v));

/** a tool's input as a table of fields */
export function Fields({ fields, schema }: { fields: ToolField[]; schema: Record<string, unknown> }) {
  return (
    <section aria-labelledby="docs-input-h" className="stack-3">
      <h2 id="docs-input-h">Input</h2>
      {fields.length === 0 ? (
        <p className="muted">It takes no input.</p>
      ) : (
        <Table size="sm" label="Input fields" className="docs-fields">
          <thead>
            <tr>
              <th scope="col">Field</th>
              <th scope="col">Type</th>
              <th scope="col">Required</th>
              <th scope="col">What it is</th>
            </tr>
          </thead>
          <tbody>
            {fields.map((f) => (
              <tr key={f.name}>
                <td className="ltr">
                  <code dir="ltr">{f.name}</code>
                </td>
                <td className="ltr mono small" dir="ltr">
                  {f.type}
                </td>
                <td>{f.required ? <strong>Required</strong> : <span className="muted">Optional</span>}</td>
                <td>
                  {f.description && <span dir="auto">{f.description}</span>}
                  {f.enum && (
                    <span className="docs-field-extra">
                      One of:{" "}
                      {f.enum.map((e, i) => (
                        <span key={String(e)}>
                          {i > 0 && ", "}
                          <code dir="ltr">{show(e)}</code>
                        </span>
                      ))}
                    </span>
                  )}
                  {f.default !== undefined && (
                    <span className="docs-field-extra">
                      Default: <code dir="ltr">{show(f.default)}</code>
                    </span>
                  )}
                  {!f.description && !f.enum && f.default === undefined && <span className="muted">—</span>}
                </td>
              </tr>
            ))}
          </tbody>
        </Table>
      )}
      <Disclosure summary="Show JSON Schema" size="sm">
        <CodeBlock code={JSON.stringify(schema, null, 2)} lang="json" label="input schema" copy />
      </Disclosure>
    </section>
  );
}

export function ToolDetail({ name, tools }: { name: string; tools: ToolDoc[] | null }) {
  if (!tools)
    return (
      <article className="docs-reader" aria-busy="true">
        <Crumbs items={["Studio tools"]} />
        <Skeleton lines={8} label="Loading the tools" />
      </article>
    );
  const t = tools.find((x) => x.name === name);
  if (!t)
    return (
      <article className="docs-reader">
        <Crumbs items={["Studio tools"]} />
        <h1>No tool by that name</h1>
        <EmptyState
          size="sm"
          title={`There is no tool "${name.slice(0, 60)}"`}
          action={<Link href="/docs">See every tool</Link>}
        >
          Tool names are lower case with underscores, like project_get.
        </EmptyState>
      </article>
    );
  return (
    <article className="docs-reader stack-4">
      <Crumbs items={["Studio tools", t.name.split("_")[0]]} />
      <header className="stack-2">
        <h1 className="docs-tool-name mono" dir="ltr">
          {t.name}
        </h1>
        <p className="docs-lede" dir="auto">
          {t.title}
        </p>
        <div className="docs-badges">
          <Badge tone={EFFECT_TONE[t.effects] ?? "muted"} caps={false}>
            {EFFECT_WORD[t.effects] ?? t.effects}
          </Badge>
          <Badge tone="muted" caps={false}>
            {t.tier === "basic" ? "Basic tier" : "Advanced tier"}
          </Badge>
          {t.approval && (
            <Badge tone="signal" caps={false}>
              Needs your OK
            </Badge>
          )}
        </div>
      </header>
      <p dir="auto">{t.description}</p>
      <DescriptionList size="sm" stackBelow="24rem">
        <dt>Effects</dt>
        <dd dir="auto">
          {EFFECT_WORD[t.effects] ?? t.effects} <span className="muted mono small">({t.effects})</span>
        </dd>
        <dt>Tier</dt>
        <dd dir="auto">
          {t.tier === "basic" ? "Basic: in every tool list" : "Advanced: only in lists that ask for the full set"}
        </dd>
        <dt>Who gets it</dt>
        <dd dir="auto">{rolesWord(t.roles)}</dd>
        <dt>Needs your OK</dt>
        <dd dir="auto">
          {t.approval
            ? "Yes, when Pip uses it: Pip proposes it as a card, and it runs only after you confirm."
            : "No: Pip runs it without asking."}
        </dd>
        <dt>Project</dt>
        <dd dir="auto">{t.project ? "Works on one project: pass project_id." : "Works on the whole studio."}</dd>
      </DescriptionList>
      <Fields fields={t.fields} schema={t.inputSchema} />
      {t.examples.length > 0 && (
        <section aria-labelledby="docs-examples-h" className="stack-3">
          <h2 id="docs-examples-h">Examples</h2>
          {t.examples.map((e, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: a doc's parts never reorder
            <div key={`ex${i}`} className="stack-2">
              {e.note && <p dir="auto">{e.note}</p>}
              <CodeBlock
                code={JSON.stringify({ tool: t.name, input: e.input }, null, 2)}
                lang="json"
                label={`example ${i + 1}`}
                copy
              />
            </div>
          ))}
        </section>
      )}
    </article>
  );
}

export const CONN_STATUS: Record<ConnDoc["status"], { word: string; tone: "success" | "error" | "muted" }> = {
  connected: { word: "Connected", tone: "success" },
  failed: { word: "Didn't connect", tone: "error" },
  off: { word: "Off", tone: "muted" },
};

export function ConnToolDetail({ server, tool, conns }: { server: string; tool: string; conns: ConnDoc[] | null }) {
  if (!conns)
    return (
      <article className="docs-reader" aria-busy="true">
        <Crumbs items={["Your connections", server]} />
        <Skeleton lines={6} label="Loading your connections" />
      </article>
    );
  const c = conns.find((x) => x.name === server);
  const t: ConnToolDoc | undefined = c?.tools.find((x) => x.name === tool);
  if (!c || !t)
    return (
      <article className="docs-reader">
        <Crumbs items={["Your connections", server]} />
        <h1 dir="auto">That tool isn't loaded</h1>
        <Callout
          tone="info"
          title={c ? `${c.name} is ${CONN_STATUS[c.status].word.toLowerCase()}` : `No connection ${server}`}
        >
          {c?.status === "off"
            ? "It's turned off, so its tools aren't listed. "
            : c?.status === "failed"
              ? `${c.error ?? "It didn't connect."} `
              : "It may have been removed or renamed. "}
          <Link href="/settings/connections">Open Settings › Connections</Link>.
        </Callout>
      </article>
    );
  return (
    <article className="docs-reader stack-4">
      <Crumbs items={["Your connections", c.name]} />
      <header className="stack-2">
        <h1 className="docs-tool-name mono" dir="ltr">
          {t.name}
        </h1>
        {t.title && (
          <p className="docs-lede" dir="auto">
            {t.title}
          </p>
        )}
        <div className="docs-badges">
          <Badge tone={t.readOnly ? "muted" : "info"} caps={false}>
            {t.readOnly ? "Says it only reads" : "May change things"}
          </Badge>
          {t.approval && (
            <Badge tone="signal" caps={false}>
              Needs your OK
            </Badge>
          )}
        </div>
      </header>
      <p dir="auto">{t.description}</p>
      <DescriptionList size="sm">
        <dt>Connection</dt>
        <dd dir="auto">
          <bdi>{c.name}</bdi> · {CONN_STATUS[c.status].word} ·{" "}
          <span className="mono small" dir="ltr">
            {c.runs}
          </span>
        </dd>
        <dt>Needs your OK</dt>
        <dd dir="auto">
          {t.approval
            ? c.trust === "read" && !t.readOnly
              ? "Yes: it doesn't say it only reads, so Pip asks with a card first."
              : "Yes: Pip asks with a card first. Trust the connection for reads in Settings › Connections to skip the card for read-only tools."
            : "No: it only reads, and you trust this connection for reads."}
        </dd>
        <dt>Who gets it</dt>
        <dd dir="auto">Pip, and a crew member only when a card you confirmed lends it for one task.</dd>
        {t.destructive && (
          <>
            <dt>Warning</dt>
            <dd dir="auto">The server marks it as destructive.</dd>
          </>
        )}
      </DescriptionList>
      <Fields fields={t.fields} schema={t.inputSchema} />
    </article>
  );
}
