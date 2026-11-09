// What a project has, as five parts (Idea, Story, Pictures, Sound, Video), each missing, partial, ready or stale.
// Worked out from the document, the scene status, the patch history and the exported versions: never from the
// crew's stage, so a handmade project reads as far as its content goes. Pure and cheap (no fs, no model calls): it
// runs on every state read, and the browser (the mock) can import it as `@pap/tools/parts`. The caller passes the
// one lookup that needs the disk, `resolves(src)`.
import { compileDecl } from "@pap/engine/decl";
import { type ProjectT, resolveTimeline, type SceneT } from "@pap/schema";
import type { RuntimeState, Stage } from "./store.ts";

export type PartId = "idea" | "story" | "pictures" | "sound" | "video";
export type PartState = "missing" | "partial" | "ready" | "stale";
export type Part = { id: PartId; state: PartState; done: number; of: number; why?: string };
/** `next`: the crew stage that makes the first part that isn't ready (null when all five are) */
export type Parts = { parts: Part[]; next: Stage | null };
/** one export (history/versions.jsonl): v1, v2, … with the document rev it was made from */
export type Version = {
  v: number;
  rev: number;
  at: string;
  /** the copy kept for this version, relative to the project folder: out/versions/v<N>.mp4 */
  file: string;
  sec: number;
  sha1: string;
  /** the delivery it was rendered for (its id in `delivery`) */
  delivery?: string;
};
/** what partsOf reads of history/patches.jsonl */
export type PartsHistory = { seq: number; baseRev: number; ops: { path: string }[] }[];

export const PART_IDS: PartId[] = ["idea", "story", "pictures", "sound", "video"];
/** the crew stages that make each part, in order (the studio's five steps were these same groups) */
export const PART_STAGES: Record<PartId, Stage[]> = {
  idea: ["brief"],
  story: ["script", "storyboard"],
  pictures: ["art", "animate"],
  sound: ["narrate", "sound"],
  video: ["review", "deliver"],
};
/** the cue a new project starts with (newProjectDoc): it isn't a script yet */
export const PLACEHOLDER_CUE = /^Placeholder: the Writer replaces this/;

export type PartsInput = {
  doc: ProjectT;
  /** the crew's per-scene status (runs/state.json); empty or absent for a project no crew has run */
  sceneStatus?: RuntimeState["sceneStatus"];
  history?: PartsHistory;
  versions?: Version[];
  /** whether a source resolves: "lib:<id>@<n>" is in the library, "file:<path>" exists in the project. Default: yes */
  resolves?: (src: string) => boolean;
};

/** the op path is `prefix`, under it, or a parent of it (replacing /script replaces /script/cues) */
const touches = (path: string, prefix: string) =>
  path === prefix || path.startsWith(`${prefix}/`) || prefix.startsWith(`${path}/`);
const lastSeq = (h: PartsHistory, prefix: string) =>
  h.reduce((m, e) => (e.ops.some((o) => touches(o.path, prefix)) ? Math.max(m, e.seq) : m), 0);
/** document paths the export doesn't read: a change to them leaves the video as it was */
const NOT_EXPORTED = [
  /^\/notes(\/|$)/,
  /^\/budget(\/|$)/,
  /^\/crew(\/|$)/,
  /^\/brief(\/|$)/,
  /^\/assets\/\d+\/publish$/,
];

const part = (id: PartId, state: PartState, done: number, of: number, why?: string): Part => ({
  id,
  state,
  done,
  of,
  ...(why ? { why } : {}),
});
const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? "" : "s"}`;
const hasContent = (doc: ProjectT, s: SceneT) =>
  s.kind === "decl" ? s.recipes.length > 0 || s.layers.length > 0 : doc.code.some((c) => c.id === s.bundle);

export function partsOf(i: PartsInput): Parts {
  const { doc } = i;
  const status = i.sceneStatus ?? {};
  const history = i.history ?? [];
  const resolves = i.resolves ?? (() => true);
  const parts: Part[] = [];

  // ---- idea
  parts.push(doc.brief.idea.trim() ? part("idea", "ready", 1, 1) : part("idea", "missing", 0, 1, "no idea yet"));

  // ---- story: a script, and every scene boarded (recipes, layers or code)
  const cues = doc.script.cues.filter((c) => !PLACEHOLDER_CUE.test(c.text));
  const scenes = cues.length ? doc.scenes : [];
  const boarded = scenes.filter((s) => hasContent(doc, s));
  const cuesAt = lastSeq(history, "/script/cues");
  const boardAt = lastSeq(history, "/scenes");
  // a cue change after the storyboard makes it stale only when the cues the scenes carry aren't the script's cues any
  // more: a caption fix (the Editor's script_set_cues, same ids) keeps the board. With no scene naming its cues, any change counts
  const carried = new Set(scenes.flatMap((s) => s.cues));
  const sameCues = carried.size > 0 && carried.size === cues.length && cues.every((c) => carried.has(c.id));
  if (!cues.length) parts.push(part("story", "missing", 0, 0, "no script yet"));
  else if (boardAt && cuesAt > boardAt && !sameCues)
    parts.push(part("story", "stale", boarded.length, scenes.length, "the script changed after the storyboard"));
  else if (scenes.length && boarded.length === scenes.length)
    parts.push(part("story", "ready", boarded.length, scenes.length));
  else
    parts.push(
      part(
        "story",
        "partial",
        boarded.length,
        scenes.length,
        scenes.length ? `${plural(scenes.length - boarded.length, "scene")} not boarded` : "no storyboard yet",
      ),
    );

  // ---- pictures: per scene, everything it draws resolves and the crew isn't redoing it
  const assetBy = new Map(doc.assets.map((a) => [a.id, a]));
  let at: ((e: string | number) => number) | null = null;
  try {
    at = resolveTimeline(doc).at;
  } catch {}
  const drawn = (s: SceneT): string[] | null => {
    if (s.kind === "code") return doc.assets.map((a) => a.id);
    if (!at) return null;
    try {
      return compileDecl(s, at).assets;
    } catch {
      return null;
    }
  };
  const problems: string[] = [];
  let ready = 0;
  let stale = 0;
  for (const s of scenes) {
    const st = status[s.id];
    if (st?.state === "stale") {
      stale++;
      continue;
    }
    if (st ? st.state !== "ready" || st.version !== "render" : !hasContent(doc, s)) continue;
    if (s.kind === "code") {
      const b = doc.code.find((c) => c.id === s.bundle);
      if (!b || !resolves(`file:${b.file}`)) {
        problems.push(`${s.id}'s code is missing`);
        continue;
      }
    }
    const ids = drawn(s);
    if (!ids) {
      problems.push(`${s.id} doesn't compile`);
      continue;
    }
    const bad = ids.find((id) => {
      const a = assetBy.get(id);
      return !a || a.standIn || !resolves(a.src);
    });
    if (bad) {
      problems.push(
        assetBy.get(bad)?.standIn
          ? `${s.id} uses a stand-in for ${bad}`
          : `${s.id} draws ${bad}, which isn't there yet`,
      );
      continue;
    }
    ready++;
  }
  if (!scenes.length || (!ready && !stale && !boarded.length))
    parts.push(part("pictures", "missing", 0, scenes.length, "no scenes yet"));
  else if (ready === scenes.length) parts.push(part("pictures", "ready", ready, scenes.length));
  else
    parts.push(
      part(
        "pictures",
        "partial",
        ready,
        scenes.length,
        stale
          ? `${plural(stale, "scene")} older than your changes`
          : (problems[0] ?? `${plural(scenes.length - ready, "scene")} not drawn yet`),
      ),
    );

  // ---- sound: some audio, and with the person's narration, every cue narrated (aligned to the take)
  const vo = doc.audio.vo.length > 0;
  const bed = doc.audio.music != null || doc.audio.sfx.events.length > 0 || doc.audio.sfx.source !== "doc";
  const aligned = doc.script.timing.mode === "aligned" ? (doc.script.timing.aligned ?? {}) : {};
  if (!cues.length) parts.push(part("sound", "missing", 0, 0, "no script to voice yet"));
  else if (doc.brief.narration === "user") {
    const said = vo ? cues.filter((c) => aligned[c.id]).length : 0;
    if (said === cues.length) parts.push(part("sound", "ready", said, cues.length));
    else if (vo || said || bed)
      parts.push(
        part(
          "sound",
          "partial",
          said,
          cues.length,
          vo ? `${plural(cues.length - said, "cue")} without narration` : "no narration yet",
        ),
      );
    else parts.push(part("sound", "missing", 0, cues.length, "no sound yet"));
  } else parts.push(vo || bed ? part("sound", "ready", 1, 1) : part("sound", "missing", 0, 1, "no sound yet"));

  // ---- video: the latest version, and whether anything it shows changed since
  const latest = (i.versions ?? []).reduce<Version | null>((m, v) => (!m || v.v > m.v ? v : m), null);
  if (!latest) parts.push(part("video", "missing", 0, 1, "no video yet"));
  else {
    const since = history.filter((h) => h.baseRev >= latest.rev);
    const changed =
      latest.rev < doc.rev &&
      // a rev with no patch on record (pitch.json edited by hand) counts as a change
      (!since.length || since.some((h) => h.ops.some((o) => !NOT_EXPORTED.some((re) => re.test(o.path)))));
    // a scene the crew is redoing (stale, or drafting its new version) keeps the video older than the document
    const redoing = scenes.some((s) => ["stale", "drafting"].includes(status[s.id]?.state ?? ""));
    parts.push(
      changed || redoing
        ? part("video", "stale", 0, 1, `v${latest.v} is older than your changes`)
        : part("video", "ready", 1, 1),
    );
  }

  const first = parts.find((p) => p.state !== "ready");
  return { parts, next: first ? PART_STAGES[first.id][0] : null };
}
