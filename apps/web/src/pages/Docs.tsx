// Docs: the repo's Markdown docs, the studio's own MCP tools and the tools of the person's connections, in one
// place. /docs lists them all (with one search); /docs/read/<path>, /docs/tools/<name> and
// /docs/connections/<server>/<tool> open one beside the list. On a phone the list folds into "Browse" above the
// reader. Connections load on their own, so a slow server never holds up the rest.
import { Badge, Callout, Disclosure, EmptyState, Search, Skeleton } from "@shabboo/kit/react";
import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import {
  byPrefix,
  type ConnDoc,
  connToolHref,
  type DocEntry,
  type DocsRoute,
  docHref,
  docsApi,
  EFFECT_WORD,
  groupLabel,
  type ToolDoc,
  toolHref,
} from "../lib/docs.ts";
import { useLoad } from "../lib/hooks.ts";
import { Link } from "../lib/router.tsx";
import { CONN_STATUS, ConnToolDetail, DocReader, ToolDetail } from "./DocsDetail.tsx";
import "./Docs.css";

const WIDE = "(min-width: 52rem)";
function useWide() {
  return useSyncExternalStore(
    (cb) => {
      const m = matchMedia(WIDE);
      m.addEventListener("change", cb);
      return () => m.removeEventListener("change", cb);
    },
    () => matchMedia(WIDE).matches,
  );
}

const has = (q: string, ...xs: (string | undefined)[]) => xs.some((x) => x?.toLowerCase().includes(q));

type Lists = {
  docs: DocEntry[] | null;
  docsError: Error | null;
  tools: ToolDoc[] | null;
  toolsError: Error | null;
  conns: ConnDoc[] | null;
  connsError: Error | null;
};

/** the three lists, filtered by `q`; `compact` is the side list beside a reader (no summaries, no headings) */
function DocsLists({ lists, q, compact, current }: { lists: Lists; q: string; compact: boolean; current: string }) {
  const needle = q.trim().toLowerCase();
  const docs = (lists.docs ?? []).filter((d) => !needle || has(needle, d.title, d.summary, d.path));
  const groups = useMemo(() => {
    const m = new Map<string, DocEntry[]>();
    for (const d of docs) m.set(d.group, [...(m.get(d.group) ?? []), d]);
    return [...m.entries()];
  }, [docs]);
  const tools = (lists.tools ?? []).filter((t) => !needle || has(needle, t.name, t.title, t.description));
  const conns = (lists.conns ?? []).map((c) => ({
    ...c,
    shown: c.tools.filter((t) => !needle || has(needle, t.name, t.title, t.description, c.name)),
  }));
  const H = compact ? "p" : "h2";
  const G = compact ? "p" : "h3";
  const here = (href: string) => (href === current ? ("page" as const) : undefined);
  const total = docs.length + tools.length + conns.reduce((n, c) => n + c.shown.length, 0);

  return (
    <div className={compact ? "docs-lists compact" : "docs-lists"}>
      {needle && (
        <p className="muted small" role="status">
          {total === 0 ? `Nothing matches "${q.trim()}"` : `${total} ${total === 1 ? "match" : "matches"}`}
        </p>
      )}

      <section aria-labelledby="docs-repo-h" className="docs-section">
        <H id="docs-repo-h" className={compact ? "docs-label" : undefined}>
          Repo docs
        </H>
        {!compact && (
          <p className="muted small">
            Every README, AGENTS.md, the guides in docs/ and the crew's skills, read straight from the repo.
          </p>
        )}
        {lists.docsError && (
          <Callout tone="error" title="The docs didn't load">
            {lists.docsError.message}. Start the studio server, then reload this page.
          </Callout>
        )}
        {!lists.docs && !lists.docsError && <Skeleton lines={4} label="Loading the docs" />}
        {lists.docs && needle && docs.length === 0 && <p className="muted small">No doc matches.</p>}
        {groups.map(([g, items]) => (
          <div key={g || "root"} className="docs-group">
            <G className="docs-group-label mono" dir="ltr" id={`docs-g-${compact ? "c" : "i"}-${g || "root"}`}>
              {groupLabel(g)}
            </G>
            <ul className="docs-items" aria-labelledby={`docs-g-${compact ? "c" : "i"}-${g || "root"}`}>
              {items.map((d) => {
                const href = docHref(d.path);
                return (
                  <li key={d.path}>
                    <Link href={href} aria-current={here(href)}>
                      <span className="docs-item-title" dir="auto">
                        {d.title}
                      </span>
                      {!compact && (
                        <span className="docs-item-path mono" dir="ltr">
                          {d.path}
                        </span>
                      )}
                    </Link>
                    {!compact && d.summary && (
                      <p className="docs-item-summary" dir="auto">
                        {d.summary}
                      </p>
                    )}
                  </li>
                );
              })}
            </ul>
          </div>
        ))}
      </section>

      <section aria-labelledby="docs-tools-h" className="docs-section">
        <H id="docs-tools-h" className={compact ? "docs-label" : undefined}>
          Studio tools (MCP)
        </H>
        {!compact && (
          <p className="muted small">
            Everything the crew and Pip can do is one of these tools, and MCP clients get the same list from{" "}
            <code dir="ltr">/mcp</code>. Grouped by the word their name starts with.
          </p>
        )}
        {lists.toolsError && (
          <Callout tone="error" title="The tools didn't load">
            {lists.toolsError.message}. Start the studio server, then reload this page.
          </Callout>
        )}
        {!lists.tools && !lists.toolsError && <Skeleton lines={4} label="Loading the tools" />}
        {lists.tools && needle && tools.length === 0 && <p className="muted small">No tool matches.</p>}
        {byPrefix(tools).map(([prefix, ts]) => (
          <div key={prefix} className="docs-group">
            <G className="docs-group-label mono" dir="ltr" id={`docs-p-${compact ? "c" : "i"}-${prefix}`}>
              {prefix}
            </G>
            <ul className="docs-items" aria-labelledby={`docs-p-${compact ? "c" : "i"}-${prefix}`}>
              {ts.map((t) => {
                const href = toolHref(t.name);
                return (
                  <li key={t.name}>
                    <Link href={href} aria-current={here(href)}>
                      <span className="docs-item-title mono" dir="ltr">
                        {t.name}
                      </span>
                      {!compact && (
                        <span className="docs-item-tags">
                          <span>{EFFECT_WORD[t.effects] ?? t.effects}</span>
                          {t.approval && <span>Needs your OK</span>}
                        </span>
                      )}
                    </Link>
                    {!compact && (
                      <p className="docs-item-summary" dir="auto">
                        {t.title}. {t.description}
                      </p>
                    )}
                  </li>
                );
              })}
            </ul>
          </div>
        ))}
      </section>

      <section aria-labelledby="docs-conn-h" className="docs-section">
        <H id="docs-conn-h" className={compact ? "docs-label" : undefined}>
          Your connections' tools
        </H>
        {!compact && (
          <p className="muted small">
            Tools from your own MCP servers. Pip uses them for you, and lends one to the crew only for a task you
            confirmed. Their keys and settings never show here.
          </p>
        )}
        {lists.connsError && (
          <Callout tone="error" title="Your connections didn't load">
            {lists.connsError.message}. <Link href="/settings/connections">Open Settings › Connections</Link>.
          </Callout>
        )}
        {!lists.conns && !lists.connsError && <Skeleton lines={2} label="Loading your connections" />}
        {lists.conns && lists.conns.length === 0 && (
          <p className="small">
            No connections yet. Add one in <Link href="/settings/connections">Settings › Connections</Link>.
          </p>
        )}
        {conns.map((c) => {
          if (needle && c.shown.length === 0 && !has(needle, c.name)) return null;
          const st = CONN_STATUS[c.status];
          const labelId = `docs-c-${compact ? "c" : "i"}-${c.name}`;
          return (
            <div key={c.name} className="docs-group">
              <div className="docs-conn-head">
                <G className="docs-group-label mono" dir="ltr" id={labelId}>
                  {c.name}
                </G>
                <Badge tone={st.tone} size="sm" caps={false}>
                  {st.word}
                </Badge>
              </div>
              {!compact && (
                <p className="muted small">
                  {c.transport === "stdio" ? "Runs " : "Connects to "}
                  <span className="mono" dir="ltr">
                    {c.runs || "?"}
                  </span>
                  {c.transport === "stdio" ? " on this computer" : ""}
                  {c.description && c.description !== c.runs && !c.runs.includes(c.description) && (
                    <>
                      {" · "}
                      <bdi>{c.description}</bdi>
                    </>
                  )}
                </p>
              )}
              {c.status === "off" && (
                <p className="small">
                  It's turned off, so its tools aren't listed.{" "}
                  <Link href="/settings/connections">Turn it on in Settings › Connections</Link>.
                </p>
              )}
              {c.status === "failed" && (
                <p className="small docs-conn-error">
                  <strong>It can't be reached.</strong> {c.error} {c.fix && <>Next: {c.fix}. </>}
                  <Link href="/settings/connections">Settings › Connections</Link>
                </p>
              )}
              {c.status === "connected" && c.tools.length === 0 && (
                <p className="muted small">It's connected but offers no tools.</p>
              )}
              {c.shown.length > 0 && (
                <ul className="docs-items" aria-labelledby={labelId}>
                  {c.shown.map((t) => {
                    const href = connToolHref(c.name, t.name);
                    return (
                      <li key={t.name}>
                        <Link href={href} aria-current={here(href)}>
                          <span className="docs-item-title mono" dir="ltr">
                            {t.name}
                          </span>
                          {!compact && (
                            <span className="docs-item-tags">
                              <span>{t.readOnly ? "Says it only reads" : "May change things"}</span>
                              {t.approval && <span>Needs your OK</span>}
                            </span>
                          )}
                        </Link>
                        {!compact && t.description && (
                          <p className="docs-item-summary" dir="auto">
                            {t.description}
                          </p>
                        )}
                      </li>
                    );
                  })}
                </ul>
              )}
            </div>
          );
        })}
      </section>
    </div>
  );
}

export function DocsPage({ route, path }: { route: DocsRoute; path: string }) {
  const docs = useLoad(() => docsApi.docs(), []);
  const tools = useLoad(() => docsApi.tools(), []);
  const conns = useLoad(() => docsApi.connections(), []);
  const [q, setQ] = useState("");
  const wide = useWide();
  const lists: Lists = {
    docs: docs.data,
    docsError: docs.error,
    tools: tools.data,
    toolsError: tools.error,
    conns: conns.data,
    connsError: conns.error,
  };

  // a new doc or tool starts at its top (the scroll moves, focus stays where it is)
  // biome-ignore lint/correctness/useExhaustiveDependencies: the address is the trigger
  useEffect(() => {
    if (route.kind !== "index" && !location.hash) window.scrollTo({ top: 0 });
  }, [path, route.kind]);

  const search = (
    <Search
      id={route.kind === "index" ? "docs-q" : "docs-q-side"}
      label="Search docs and tools"
      value={q}
      onChange={(e) => setQ(e.currentTarget.value)}
      onClear={() => setQ("")}
      placeholder="writer, render_still, palette"
      size="sm"
    />
  );

  if (route.kind === "index")
    return (
      <main id="main" className="page docs-page">
        <div className="page-head">
          <h1>Docs</h1>
        </div>
        <p className="muted">
          The repo's guides, every tool the studio serves over MCP, and the tools your own MCP servers add.
        </p>
        <search className="docs-search">{search}</search>
        <DocsLists lists={lists} q={q} compact={false} current={path} />
      </main>
    );

  const nav = (
    <div className="stack-3">
      <search>{search}</search>
      <DocsLists lists={lists} q={q} compact current={path} />
    </div>
  );

  return (
    <main id="main" className="page docs-page docs-split">
      <nav aria-label="Docs and tools" className="docs-side">
        {wide ? (
          nav
        ) : (
          <Disclosure summary="Browse docs and tools" boxed size="sm">
            {nav}
          </Disclosure>
        )}
      </nav>
      <div className="docs-main">
        {route.kind === "doc" && <DocReader path={route.path} known={docs.data} />}
        {route.kind === "tool" && <ToolDetail name={route.name} tools={tools.data} />}
        {route.kind === "conn" && <ConnToolDetail server={route.server} tool={route.tool} conns={conns.data} />}
        {route.kind === "missing" && (
          <article className="docs-reader">
            <h1>This page doesn't exist</h1>
            <EmptyState
              size="sm"
              title="No doc or tool at this address"
              action={<Link href="/docs">See every doc</Link>}
            >
              Pick one from the list.
            </EmptyState>
          </article>
        )}
      </div>
    </main>
  );
}
