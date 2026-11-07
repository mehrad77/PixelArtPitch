// The asset library, read-only: a grid of cards with pixelated preview sheets, kind and scope filters, and search.
import { Badge, Callout, EmptyState, Field, Search, Skeleton, Tag } from "@shabboo/kit/react";
import { useMemo, useState } from "react";
import { client } from "../lib/client.ts";
import { useLoad } from "../lib/hooks.ts";
import "./Library.css";

export function LibraryPage() {
  const { data, error, loading, reload } = useLoad(() => client.library(), []);
  const [q, setQ] = useState("");
  const [kind, setKind] = useState("all");
  const [scope, setScope] = useState("all");
  const assets = data?.assets ?? [];
  const kinds = useMemo(() => [...new Set(assets.map((a) => a.kind))].sort(), [assets]);
  const shown = assets.filter((a) => {
    const s = a.scope ?? "public";
    if (kind !== "all" && a.kind !== kind) return false;
    if (scope !== "all" && s !== scope) return false;
    const needle = q.trim().toLowerCase();
    return (
      !needle ||
      a.id.includes(needle) ||
      a.tags.some((t) => t.includes(needle)) ||
      (a.description ?? "").toLowerCase().includes(needle)
    );
  });
  return (
    <main id="main" className="page" aria-busy={loading ? "true" : undefined}>
      <div className="page-head">
        <h1>Library</h1>
        {data && <span className="muted small mono">Palette {data.palette}</span>}
      </div>
      <p className="muted">
        Sprites, tiles, icons and fonts the crew can reuse. Private assets (likenesses, logos) stay in their project and
        are never listed as public.
      </p>
      <search className="lib-filters">
        <Search
          id="lib-q"
          label="Search assets"
          value={q}
          onChange={(e) => setQ(e.currentTarget.value)}
          onClear={() => setQ("")}
          placeholder="moon, tile, lamp"
          size="sm"
        />
        <Field
          id="lib-kind"
          label="Kind"
          control="select"
          size="sm"
          value={kind}
          onChange={(e) => setKind(e.currentTarget.value)}
        >
          <option value="all">All kinds</option>
          {kinds.map((k) => (
            <option key={k} value={k}>
              {k}
            </option>
          ))}
        </Field>
        <Field
          id="lib-scope"
          label="Scope"
          control="select"
          size="sm"
          value={scope}
          onChange={(e) => setScope(e.currentTarget.value)}
        >
          <option value="all">Public and private</option>
          <option value="public">Public</option>
          <option value="private">Private to a project</option>
        </Field>
      </search>
      {error && (
        <Callout tone="error" title="The library didn't load">
          {error.message}. Check the library path in Settings, then{" "}
          <button type="button" className="linkish" onClick={reload}>
            try again
          </button>
          .
        </Callout>
      )}
      {loading && !data && <Skeleton lines={4} label="Loading the library" />}
      {data && (
        <p className="muted small" aria-live="polite">
          {shown.length} of {assets.length} assets
        </p>
      )}
      {data && shown.length === 0 && (
        <EmptyState title={q ? `No assets match "${q}"` : "No assets with these filters"}>
          Try a shorter word, or set Kind and Scope back to all.
        </EmptyState>
      )}
      <ul className="lib-grid">
        {shown.map((a) => (
          <li key={a.id} className="lib-card">
            <div className="lib-sheet">
              <img className="pixelated" src={client.sheetUrl(a.id)} alt={`Preview sheet of ${a.id}`} loading="lazy" />
            </div>
            <div className="lib-meta">
              <h2 className="lib-name mono">{a.id}</h2>
              <span className="muted small">
                {a.kind} · {a.w}×{a.h} · {a.frames} {a.frames === 1 ? "frame" : "frames"}
              </span>
              {(a.scope ?? "public") === "private" && (
                <Badge tone="info" caps={false}>
                  Private to a project
                </Badge>
              )}
              {a.description && <p className="small">{a.description}</p>}
              <ul className="lib-tags">
                {a.tags.map((t) => (
                  <Tag key={t} as="li" size="sm" variant="chip">
                    {t}
                  </Tag>
                ))}
              </ul>
            </div>
          </li>
        ))}
      </ul>
    </main>
  );
}
