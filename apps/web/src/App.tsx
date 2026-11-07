import { Badge, EmptyState, SkipLink } from "@shabboo/kit/react";
import { SimpleProjectPage } from "./components/SimpleProject.tsx";
import { client } from "./lib/client.ts";
import { isStage } from "./lib/derive.ts";
import { getView } from "./lib/human.ts";
import { Link, match, navigate, usePath } from "./lib/router.tsx";
import { ComposerPage } from "./pages/Composer.tsx";
import { LibraryPage } from "./pages/Library.tsx";
import { ProjectsPage } from "./pages/Projects.tsx";
import { RecordPage } from "./pages/Record.tsx";
import { SETTINGS_TABS, SettingsPage, type SettingsTab } from "./pages/Settings.tsx";
import { WorkspacePage } from "./pages/Workspace.tsx";

function Route({ path }: { path: string }) {
  if (path === "/" || path === "") return <ProjectsPage />;
  if (path === "/new") return <ComposerPage />;
  if (path === "/library") return <LibraryPage />;
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
  if (m)
    return getView() === "studio" ? (
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
  const section = path.startsWith("/library") ? "library" : path.startsWith("/settings") ? "settings" : "projects";
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
        </nav>
        {client.mock && (
          <Badge tone="info" title="Fixture data simulated in the browser; nothing reaches a server.">
            Mock data
          </Badge>
        )}
      </header>
      <Route path={path} />
    </div>
  );
}
