import { Badge, EmptyState, Icon, SkipLink } from "@shabboo/kit/react";
import { useEffect, useState } from "react";
import { CrewButton, ModeSwitch } from "./components/AppHeader.tsx";
import { ProjectStage } from "./components/ProjectStage.tsx";
import { SimpleProjectPage } from "./components/SimpleProject.tsx";
import { client } from "./lib/client.ts";
import { isStage } from "./lib/derive.ts";
import { docsRoute } from "./lib/docs.ts";
import { useView } from "./lib/hooks.ts";
import type { View } from "./lib/human.ts";
import { Link, match, navigate, usePath } from "./lib/router.tsx";
import { type Adopted, freshStage, useAdopted } from "./lib/stage.ts";
import { ComposerPage } from "./pages/Composer.tsx";
import { DocsPage } from "./pages/Docs.tsx";
import { LibraryPage } from "./pages/Library.tsx";
import { ProjectsPage } from "./pages/Projects.tsx";
import { RecordPage } from "./pages/Record.tsx";
import { SETTINGS_TABS, SettingsPage, type SettingsTab } from "./pages/Settings.tsx";
import { WorkspacePage } from "./pages/Workspace.tsx";

/** the project a path is about, and its view: a stage is Studio, the bare address the remembered view */
function projectRoute(path: string, view: View): { id: string; mode: View | null } | null {
  let m = match("/p/:id/:stage", path);
  if (m) return { id: m.id, mode: isStage(m.stage) ? "studio" : null };
  m = match("/p/:id", path);
  return m ? { id: m.id, mode: view } : null;
}

function Route({ path, view, adopted }: { path: string; view: View; adopted: Adopted }) {
  // one shell, kept mounted: /new, /new/:draftId and the project it became (PIP-JOURNEY §3.5); "Show all options"
  // (/new/:draftId/options) is the composer
  const stageKey = `stage:new:${adopted.n}`;
  if (path === "/" || path === "") return <ProjectsPage />;
  if (path === "/new") return <ProjectStage key={stageKey} />;
  let n = match("/new/:draftId/options", path);
  if (n) return <ComposerPage draftId={n.draftId} />;
  n = match("/new/:draftId", path);
  if (n) return <ProjectStage key={stageKey} draftId={n.draftId} />;
  if (path === "/library") return <LibraryPage />;
  const docs = docsRoute(path);
  if (docs) return <DocsPage route={docs} path={path} />;
  if (path === "/settings") {
    navigate("/settings/setup", { replace: true });
    return null;
  }
  let m = match("/settings/:tab", path);
  if (m && (SETTINGS_TABS as readonly string[]).includes(m.tab)) return <SettingsPage tab={m.tab as SettingsTab} />;
  m = match("/p/:id/record", path);
  if (m) return <RecordPage id={m.id} />;
  m = match("/p/:id/:stage", path);
  if (m && isStage(m.stage)) return <WorkspacePage key={m.id} id={m.id} stage={m.stage} />;
  // the project's own address opens the simple view, or Studio when the person last chose it; a stage is Studio
  m = match("/p/:id", path);
  // the project the stage just made keeps the stage, until the person switches to Studio (or back)
  if (m && m.id === adopted.projectId && view === adopted.view)
    return <ProjectStage key={stageKey} draftId={adopted.draftId} projectId={m.id} />;
  if (m)
    return view === "studio" ? (
      <WorkspacePage key={`studio-${m.id}`} id={m.id} />
    ) : (
      <SimpleProjectPage key={m.id} id={m.id} />
    );
  return (
    <main id="main" className="page-narrow">
      <EmptyState title="This page doesn't exist" action={<Link href="/">Go to projects</Link>}>
        The address doesn't match a studio page.
      </EmptyState>
    </main>
  );
}

export function App() {
  const path = usePath();
  const view = useView();
  const proj = projectRoute(path, view);
  const adopted = useAdopted();
  // a fresh /new (New video, or back to it) is a new stage; one the stage itself just left is not
  useEffect(() => {
    if (path === "/new") freshStage();
  }, [path]);
  const section = path.startsWith("/library")
    ? "library"
    : path.startsWith("/settings")
      ? "settings"
      : docsRoute(path)
        ? "docs"
        : "projects";
  return (
    <div className="app">
      <SkipLink href="#main" label="Skip to content" />
      <header className="topbar">
        <Link href="/" className="brand">
          PixelArtPitch
        </Link>
        <nav aria-label="Studio" className="topnav">
          <Link href="/" aria-current={section === "projects" ? "page" : undefined}>
            Projects
          </Link>
          <Link href="/library" aria-current={section === "library" ? "page" : undefined}>
            Library
          </Link>
          <Link href="/settings/setup" aria-current={section === "settings" ? "page" : undefined}>
            Settings
          </Link>
          <Link href="/docs" aria-current={section === "docs" ? "page" : undefined}>
            Docs
          </Link>
        </nav>
        <div className="topbar-end">
          {proj?.mode && <ModeSwitch projectId={proj.id} mode={proj.mode} />}
          {client.mock && (
            <Badge tone="info" title="Fixture data simulated in the browser; nothing reaches a server.">
              Mock data
            </Badge>
          )}
          <CrewButton routeId={proj?.id ?? null} />
        </div>
      </header>
      <StaleBuild />
      <Route path={path} view={view} adopted={adopted} />
    </div>
  );
}

/**
 * The served UI is older than its sources (GET /api/build): one quiet line under the header, with how to rebuild.
 * Asked once per page load; a server without the route says nothing, and so does this.
 */
function StaleBuild() {
  const [stale, setStale] = useState(false);
  const [hidden, setHidden] = useState(false);
  useEffect(() => {
    let live = true;
    client.build().then(
      (b) => live && setStale(!!b?.webStale),
      () => {},
    );
    return () => {
      live = false;
    };
  }, []);
  if (!stale || hidden) return null;
  return (
    <p className="build-stale small" role="status">
      <Icon name="warning" size="sm" label="Note" />
      <span>
        This studio is running an old build. Rebuild with{" "}
        <code className="ltr" translate="no">
          pnpm --filter @pap/web build
        </code>
        .
      </span>
      <button type="button" className="linkish small build-stale-hide" onClick={() => setHidden(true)}>
        Hide
      </button>
    </p>
  );
}
