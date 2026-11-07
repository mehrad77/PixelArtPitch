// The default project screen: the film, one sentence of status, where we are in five plain steps, and the one thing
// that needs the person, if any. Money is one quiet line. Everything else (stages, tracks, models, tasks) is in
// Studio, one toggle away in the app header and remembered (pap.view). It is the same shell as /new
// (ProjectStage), so a project that started from a draft keeps its page.
import { ProjectStage } from "./ProjectStage.tsx";

export function SimpleProjectPage({ id }: { id: string }) {
  return <ProjectStage projectId={id} />;
}
