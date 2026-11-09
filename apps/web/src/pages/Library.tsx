// The asset library, read-only: a grid of cards with pixelated preview sheets, kind and scope filters, and search.
// Assets come from three folders (docs/API.md, GET /api/library): the repo's public seed, the person's own library,
// and each project's assets/, which stay private to it.
import { Badge, Callout, EmptyState, Field, Search, Skeleton, Tag } from "@shabboo/kit/react";
import { useMemo, useState } from "react";
import { client } from "../lib/client.ts";
import { useLoad } from "../lib/hooks.ts";
import type { LibraryAsset, LibraryDirs, LibraryLayer } from "../lib/types.ts";
import "./Library.css";

const layerOf = (a: LibraryAsset): LibraryLayer => a.layer ?? (a.scope === "private" ? "project" : "seed");
const LAYER_WORDS: Record<LibraryLayer, string> = {
  seed: "Public library",
  user: "Your library",
  project: "Private to a project",
};
const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? "" : "s"}`;

/** the three folders, each with what it holds */
function Folders({ dirs, count }: { dirs: LibraryDirs; count: (l: LibraryLayer) => number }) {
  return (
    <section className="lib-dirs" aria-labelledby="lib-dirs-h">
      <h2 id="lib-dirs-h" className="small">
        Assets come from three folders
      </h2>
      <dl>
        <div>
          <dt>{LAYER_WORDS.seed}</dt>
          <dd>
            <span className="mono ltr small">{dirs.seed}</span>
            <span className="muted small">
              {plural(count("seed"), "asset")}, shipped with PixelArtPitch, read-only.
            </span>
          </dd>
        </div>
        <div>
          <dt>{LAYER_WORDS.user}</dt>
          <dd>
            <span className="mono ltr small">{dirs.user}</span>
            <span className="muted small">
              {dirs.userExists
                ? `${plural(count("user"), "asset")} the crew published for you.`
                : "Not made yet. Drawings the crew publishes go here."}
            </span>
          </dd>
        </div>
        <div>
          <dt>{LAYER_WORDS.project}</dt>
          <dd>
            {dirs.projects.length === 0 ? (
              <span className="muted small">No project keeps its own assets yet.</span>
            ) : (
              <ul className="lib-dir-list">
                {dirs.projects.map((p) => (
                  <li key={p.id}>
                    <span className="mono ltr small">{p.dir}/assets</span>
                    <span className="muted small">
                      {p.title}: {plural(p.assets, "asset")}, never copied into a library.
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </dd>
        </div>
      </dl>
    </section>
  );
}

export function LibraryPage() {
  const { data, error, loading, reload } = useLoad(() => client.library(), []);
  const [q, setQ] = useState("");
  const [kind, setKind] = useState("all");
  const [scope, setScope] = useState("all");
  const assets = data?.assets ?? [];
  const kinds = useMemo(() => [...new Set(assets.map((a) => a.kind))].sort(), [assets]);
  const shown = assets.filter((a) => {
    if (kind !== "all" && a.kind !== kind) return false;
    if (scope !== "all" && layerOf(a) !== scope) return false;
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
      {data?.dirs && <Folders dirs={data.dirs} count={(l) => assets.filter((a) => layerOf(a) === l).length} />}
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
          <option value="all">All three</option>
          {(Object.keys(LAYER_WORDS) as LibraryLayer[]).map((l) => (
            <option key={l} value={l}>
              {LAYER_WORDS[l]}
            </option>
          ))}
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
          <li key={`${a.project?.id ?? layerOf(a)}/${a.id}`} className="lib-card">
            <div className="lib-sheet">
              <img
                className="pixelated"
                src={a.sheet ?? client.sheetUrl(a.id)}
                alt={`Preview sheet of ${a.id}`}
                loading="lazy"
              />
            </div>
            <div className="lib-meta">
              <h2 className="lib-name mono">{a.id}</h2>
              <span className="muted small">
                {a.kind} · {a.w}×{a.h} · {a.frames} {a.frames === 1 ? "frame" : "frames"}
              </span>
              {layerOf(a) === "project" && (
                <Badge tone="info" caps={false}>
                  {a.project ? `Private to ${a.project.title}` : "Private to a project"}
                </Badge>
              )}
              {layerOf(a) === "user" && (
                <Badge tone="muted" caps={false}>
                  Your library
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
