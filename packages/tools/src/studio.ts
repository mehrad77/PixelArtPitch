// The studio's private art (docs/RIGHTS.md): the likenesses, logos and other `file:assets/…` art kept in the
// projects of this workspace. It is private to the studio, not to one project: any project here may use it. It never
// goes into the public library or the public repo. The Library page lists it; the crew casts it by copying the file in.
import { copyFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { AssetRefT } from "@pap/schema";
import type { ToolContext } from "./registry.ts";
import type { OpenProject, Workspace } from "./store.ts";

export type StudioAsset = {
  id: string;
  /** the file's name in its project's assets/ folder, without .json */
  file: string;
  kind: string;
  w: number;
  h: number;
  frames: string[];
  tags: string[];
  description?: string;
  flags: AssetRefT["flags"];
  project: { id: string; title: string; dir: string };
};

/**
 * Every project's own drawn assets (`file:assets/<name>.json` with a readable grid), in workspace order. `except` leaves
 * out one project (the one asking: it already has its own).
 */
export function studioAssets(workspace: Pick<Workspace, "list">, opts: { except?: string } = {}): StudioAsset[] {
  return workspace.list().flatMap((x) => {
    if (x.id === opts.except) return [];
    try {
      const refs: { id: string; src: string; flags?: AssetRefT["flags"] }[] =
        JSON.parse(readFileSync(join(x.dir, "pitch.json"), "utf8")).assets ?? [];
      return refs.flatMap((r) => {
        const m = /^file:assets\/([a-zA-Z0-9_.-]+)\.json$/.exec(r.src);
        const f = m && join(x.dir, "assets", `${m[1]}.json`);
        if (!m || !f || !existsSync(f)) return [];
        const a = JSON.parse(readFileSync(f, "utf8"));
        if (typeof a?.kind !== "string" || !Array.isArray(a.frames)) return [];
        return [
          {
            id: r.id,
            file: m[1],
            kind: a.kind,
            w: a.w,
            h: a.h,
            frames: a.frames.map(String),
            tags: Array.isArray(a.tags) ? a.tags : [],
            description: typeof a.description === "string" ? a.description : undefined,
            flags: r.flags ?? { private: false },
            project: { id: x.id, title: x.title, dir: x.dir },
          },
        ];
      });
    } catch {
      return [];
    }
  });
}

/**
 * The studio art a project may cast: other projects' assets whose name the project and the public library don't
 * already use, one per name (the first project that has it).
 */
export function studioArtFor(
  workspace: Pick<Workspace, "list">,
  p: OpenProject,
  taken: Set<string> = new Set(),
): StudioAsset[] {
  const have = new Set([...p.doc().assets.map((a) => a.id), ...taken]);
  const out: StudioAsset[] = [];
  for (const a of studioAssets(workspace, { except: p.id }))
    if (!have.has(a.id)) {
      have.add(a.id);
      out.push(a);
    }
  return out;
}

/**
 * Cast a studio asset into `p`: its `.json` (and `.png`) copied into the project's assets/, listed as
 * `file:assets/<name>.json` with all its flags (private, likeness, brand) and `copiedFrom`, so a likeness or a brand
 * asks its rights again here. Never into the library.
 */
export async function bringStudioAsset(p: OpenProject, a: StudioAsset, author: ToolContext["author"]) {
  if (p.doc().assets.some((x) => x.id === a.id)) return false;
  mkdirSync(join(p.dir, "assets"), { recursive: true });
  let name = a.file;
  for (let n = 2; existsSync(join(p.dir, "assets", `${name}.json`)); n++) name = `${a.file}-${n}`;
  copyFileSync(join(a.project.dir, "assets", `${a.file}.json`), join(p.dir, "assets", `${name}.json`));
  const png = join(a.project.dir, "assets", `${a.file}.png`);
  if (existsSync(png)) copyFileSync(png, join(p.dir, "assets", `${name}.png`));
  const ref: AssetRefT = { id: a.id, src: `file:assets/${name}.json`, flags: a.flags, copiedFrom: a.project.id };
  await p.patch([{ op: "add", path: "/assets/-", value: ref }], {
    reason: `cast ${a.id} from ${a.project.title}: studio art, private`,
    author,
  });
  return true;
}

/** a likeness or a brand: the person's OK before a scene uses it, in every project it is cast into */
export const needsRights = (a: Pick<AssetRefT, "flags">) => !!(a.flags.likeness || a.flags.brand);
