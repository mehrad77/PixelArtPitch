// The studio's private art for the crew (docs/RIGHTS.md): other projects' likenesses, logos and drawn assets, listed
// for the Director and cast by the Art Director like library art, except that casting copies the file into the
// project (flags and all) and a likeness or a brand waits for the person's rights OK (rules.ts `copiedRights`).
import { bringStudioAsset, type OpenProject, type StudioAsset, studioArtFor, type Workspace } from "@pap/tools";

const frameList = (fs: string[]) => `${fs.slice(0, 10).join(", ")}${fs.length > 10 ? ", …" : ""}`;

/** one line per asset, the library list's shape plus where it comes from and that it is private */
export function studioLine(a: StudioAsset) {
  const rights = a.flags.likeness ? ", a likeness" : a.flags.brand ? ", a brand" : "";
  return `${a.id}: ${a.kind} ${a.w}x${a.h}, frames ${frameList(a.frames)} (private studio art from ${a.project.title}${rights}; never public)`;
}

/** the studio art `p` may use: other projects' own assets whose names the project and the library don't take */
export function studioArt(workspace: Pick<Workspace, "list">, p: OpenProject, library: Iterable<string>) {
  return studioArtFor(workspace, p, new Set(library));
}

/** cast the named studio assets into `p` (the Art Director's cast); returns the names brought in */
export async function castStudioArt(
  workspace: Pick<Workspace, "list">,
  p: OpenProject,
  names: Iterable<string>,
  library: Iterable<string>,
  task: string,
) {
  const want = new Set(names);
  const brought: string[] = [];
  for (const a of studioArt(workspace, p, library))
    if (want.has(a.id) && (await bringStudioAsset(p, a, { kind: "agent", role: "art-director", task })))
      brought.push(a.id);
  return brought;
}
