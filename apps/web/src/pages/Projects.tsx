import { Badge, Button, Callout, Skeleton, Table } from "@shabboo/kit/react";
import { client } from "../lib/client.ts";
import { STAGE_LABEL } from "../lib/derive.ts";
import { ago, duration, usd } from "../lib/format.ts";
import { useLoad } from "../lib/hooks.ts";
import { Link, LinkButton } from "../lib/router.tsx";
import { ComposerPage } from "./Composer.tsx";

export function ProjectsPage() {
  const { data, error, loading, reload } = useLoad(() => client.projects(), []);
  if (!loading && !error && data && data.length === 0) return <ComposerPage first />;
  return (
    <main id="main" className="page" aria-busy={loading ? "true" : undefined}>
      <div className="page-head">
        <h1>Projects</h1>
        <LinkButton href="/new" variant="primary">
          New project
        </LinkButton>
      </div>
      {error && (
        <Callout tone="error" title="Projects didn't load">
          <p>
            {error.message}. Check that the studio server is running (<code>pnpm pap</code>), then{" "}
            <Button variant="quiet" size="sm" onClick={reload}>
              try again
            </Button>
            .
          </p>
        </Callout>
      )}
      {loading && !data && <Skeleton lines={4} label="Loading projects" />}
      {data && data.length > 0 && (
        <Table caption="Your projects" captionHidden framed hover>
          <thead>
            <tr>
              <th scope="col">Project</th>
              <th scope="col">Stage</th>
              <th scope="col">Needs you</th>
              <th scope="col" className="num">
                Spent
              </th>
              <th scope="col" className="num">
                ETA
              </th>
              <th scope="col">Updated</th>
            </tr>
          </thead>
          <tbody>
            {data.map((p) => (
              <tr key={p.id}>
                <td>
                  <Link className="row-link" href={`/p/${encodeURIComponent(p.id)}/${p.stage}`}>
                    {p.title}
                  </Link>
                  <div className="muted mono small ltr">{p.dir}</div>
                </td>
                <td>{STAGE_LABEL[p.stage]}</td>
                <td>
                  {p.needsYou > 0 ? (
                    <Badge tone="signal">{p.needsYou} waiting</Badge>
                  ) : (
                    <span className="muted">Nothing</span>
                  )}
                </td>
                <td className="num">
                  {usd(p.spentUsd)} of {usd(p.capUsd)}
                </td>
                <td className="num">{p.etaSec == null ? "Unknown" : duration(p.etaSec)}</td>
                <td>
                  <time dateTime={p.updatedAt}>{ago(p.updatedAt)}</time>
                </td>
              </tr>
            ))}
          </tbody>
        </Table>
      )}
    </main>
  );
}
