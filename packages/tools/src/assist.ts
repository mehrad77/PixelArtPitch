// The tools Pip (the studio's assistant, docs/ASSISTANT.md) adds to the registry, so MCP clients get them too:
// files_list, project_fork and feature_request here, and two that need the crew, built by factories the server wires:
// subtitles_translate (a model call) and crew_request_change (the orchestrator reopens the owner's stage).
import { appendFileSync, copyFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { missingGlyphs } from "@pap/engine/core";
import { subtitles } from "@pap/render";
import type { ProjectT, RoleT } from "@pap/schema";
import { z } from "zod";
import { defineTool, fail, ok, type ToolContext } from "./registry.ts";
import { type Note, type OpenProject, PAP_HOME, type Stage } from "./store.ts";

const P = (ctx: ToolContext) => ctx.project!;

export const PipFile = z.object({ name: z.string(), kind: z.string(), sizeBytes: z.number(), url: z.string() });
export type PipFileT = z.infer<typeof PipFile>;

/** a project's out/ files with their download URLs */
export function outFiles(p: OpenProject, only?: string[]): PipFileT[] {
  return p
    .files()
    .filter((f) => !only || only.includes(f.name))
    .map((f) => ({
      name: f.name,
      kind: f.kind,
      sizeBytes: f.bytes,
      url: `/api/p/${p.id}/files/${encodeURIComponent(f.name)}`,
    }));
}

// ---------------------------------------------------------------- files_list
export const filesList = defineTool({
  name: "files_list",
  title: "The project's files",
  description:
    "List the finished files in the project's out/ folder (videos, subtitles, sound, stills) with their size and download URL.",
  input: z.object({}),
  output: z.object({ files: z.array(PipFile) }),
  roles: "*",
  tier: "basic",
  effects: "read",
  project: true,
  examples: [{ input: {} }],
  handler: async (_i, ctx) => ok({ files: outFiles(P(ctx)) }),
});

// ---------------------------------------------------------------- feature_request
export const featureRequestFile = () => join(PAP_HOME, "feature-requests.jsonl");
export const featureRequest = defineTool({
  name: "feature_request",
  title: "Log a feature request",
  description:
    "Write down something a person asked for that the studio can't do yet, with the context it came up in. It only appends one line to a log.",
  input: z.object({ text: z.string().min(3).max(500), context: z.string().max(2000).default("") }),
  output: z.object({ logged: z.boolean() }),
  roles: "*",
  tier: "basic",
  effects: "write",
  project: false,
  examples: [{ input: { text: "vertical 9:16 video", context: "asked for a phone story version" } }],
  handler: async (i, ctx) => {
    mkdirSync(PAP_HOME, { recursive: true });
    appendFileSync(
      featureRequestFile(),
      `${JSON.stringify({
        at: new Date().toISOString(),
        text: i.text,
        context: i.context,
        project: ctx.project?.id ?? null,
        by: ctx.author.via ?? ctx.author.client ?? ctx.author.role ?? ctx.author.kind,
      })}\n`,
    );
    return ok({ logged: true });
  },
});

// ---------------------------------------------------------------- project_fork
/**
 * A new project takes an old one's look: its cast (project-drawn members are files, copied; never out/, runs/ or
 * private/), crew models, mix, subtitles, canvas, holds and deliveries, and (unless `budget: false`) its budget.
 * `skipPrivate` leaves out a likeness or a logo: those stay private to the project they were made for.
 */
export async function copyLook(
  src: OpenProject,
  np: OpenProject,
  author: ToolContext["author"],
  opts: { skipPrivate?: boolean; budget?: boolean } = {},
) {
  const d = src.doc();
  const assets = d.assets.filter((a) => !(opts.skipPrivate && a.flags.private));
  for (const a of assets)
    if (a.src.startsWith("file:")) {
      const rel = a.src.slice(5);
      for (const f of [rel, rel.replace(/\.json$/, ".png")])
        if (existsSync(join(src.dir, f))) {
          mkdirSync(join(np.dir, "assets"), { recursive: true });
          copyFileSync(join(src.dir, f), join(np.dir, f));
        }
    }
  const nd = np.doc();
  const slugOut = nd.delivery[0]?.out ?? `${nd.id}.mp4`;
  await np.patch(
    [
      { op: "replace", path: "/assets", value: assets },
      { op: "replace", path: "/crew", value: d.crew },
      { op: "replace", path: "/mix", value: d.mix },
      { op: "replace", path: "/subtitles", value: d.subtitles },
      { op: "replace", path: "/canvas", value: d.canvas },
      {
        op: "replace",
        path: "/composition",
        value: { ...d.composition, duration: nd.composition.duration },
      },
      {
        op: "replace",
        path: "/delivery",
        value: (d.delivery.length ? d.delivery : nd.delivery).map((x, k) => ({
          ...x,
          out: k === 0 ? slugOut : slugOut.replace(/\.mp4$/, `-${x.id}.mp4`),
        })),
      },
      ...(opts.budget === false ? [] : [{ op: "replace" as const, path: "/budget", value: d.budget }]),
    ],
    { reason: `made from ${src.id}: its settings, cast and style`, author },
  );
}

export const projectFork = defineTool({
  name: "project_fork",
  title: "Make another one like this",
  description:
    "Start a new project from this one: it keeps the settings, cast and style, and gets a new brief. The script, storyboard and renders are not copied. The new project waits at the brief for the person.",
  input: z.object({ title: z.string().min(1).max(120).optional(), brief: z.string().min(10).max(4000) }),
  output: z.object({ projectId: z.string(), dir: z.string() }),
  roles: [],
  tier: "basic",
  effects: "write",
  project: true,
  examples: [{ input: { title: "Bakery launch", brief: "A 20 s launch video for a small bakery's new sourdough." } }],
  handler: async (i, ctx) => {
    const src = P(ctx);
    const d = src.doc();
    const title = i.title ?? `${d.title} (new)`;
    // the brief's form carries over; what was about the old product does not
    const brief: ProjectT["brief"] = {
      ...d.brief,
      idea: i.brief,
      audience: "",
      ask: "",
      mustSay: [],
      mustAvoid: [],
      references: [],
      deadline: undefined,
    };
    const np = ctx.workspace.create({ title, brief, budgetUsd: d.budget.capUsd });
    await copyLook(src, np, ctx.author);
    np.setGate("g0_brief", { status: "open", items: [{ label: "Brief and budget" }] });
    np.setStatus({ line: "Waiting for you: check the brief", phase: 0 });
    np.setDigest(`Made from ${d.title}. Check the brief, then start the crew.`);
    return ok({ projectId: np.id, dir: np.dir });
  },
});

// ---------------------------------------------------------------- subtitles_translate
export type Translator = (
  p: OpenProject,
  req: { lang: string; label: string; cues: { id: string; text: string }[]; tooLong?: string[] },
  signal?: AbortSignal,
) => Promise<{ cues: { id: string; text: string }[] }>;

const LANG = /^[a-z]{2,3}(-[A-Za-z0-9]{2,8})?$/;
/** "Persian" for "fa" */
export const languageName = (lang: string) => {
  try {
    return new Intl.DisplayNames(["en"], { type: "language" }).of(lang) ?? lang;
  } catch {
    return lang;
  }
};

function fontFrames(p: OpenProject): Record<string, unknown> | null {
  const hit = p.project().assets.find(([id]) => id === "font");
  return hit ? (hit[1] as Record<string, unknown>) : null;
}

export function subtitlesTranslateTool(translate: Translator) {
  return defineTool({
    name: "subtitles_translate",
    title: "Translate the subtitles",
    description:
      "Translate the subtitle lines into another language and write out/<id>.<lang>.srt and .vtt. Cue ids and timings stay the project's; the pixel font draws basic Latin only, so burnInPossible says whether the picture could show them.",
    input: z.object({
      lang: z.string().regex(LANG, "an ISO 639-1 code such as fa, de, ja"),
      label: z.string().max(40).optional(),
    }),
    output: z.object({
      lang: z.string(),
      files: z.array(PipFile),
      burnInPossible: z.boolean(),
      missingGlyphs: z.array(z.string()),
      cues: z.number(),
      long: z.array(z.string()),
    }),
    roles: ["writer"],
    tier: "basic",
    effects: "spend",
    project: true,
    examples: [{ input: { lang: "fa" } }, { input: { lang: "de", label: "Deutsch" } }],
    handler: async (i, ctx) => {
      const p = P(ctx);
      const d = p.doc();
      const cues = p.timeline().cues.map((c) => ({ id: c.id, text: c.text }));
      const label = i.label ?? languageName(i.lang);
      const byId = new Map<string, string>();
      // ids come from the project: a model's "c2" for "c02" is matched by number, anything else is dropped,
      // and a line with no letters ("???") doesn't count
      const num = (id: string) => /(\d+)$/.exec(id)?.[1].replace(/^0+/, "");
      const take = (got: { id: string; text: string }[], asked = cues) => {
        for (const c of got) {
          const hit = asked.find((x) => x.id === c.id) ?? asked.find((x) => num(x.id) && num(x.id) === num(c.id));
          if (hit && /\p{L}/u.test(c.text)) byId.set(hit.id, c.text.trim());
        }
      };
      take((await translate(p, { lang: i.lang, label, cues }, ctx.signal)).cues);
      const tooLong = () =>
        cues.filter((c) => !byId.has(c.id) || [...byId.get(c.id)!].length > Math.ceil([...c.text].length * 1.6));
      // one repair: the missing and too-long lines again, with the limit spelled out
      const first = tooLong();
      if (first.length)
        take(
          (await translate(p, { lang: i.lang, label, cues: first, tooLong: first.map((c) => c.id) }, ctx.signal)).cues,
          first,
        );
      // a weak model that still skips lines gets them one at a time (at most 8)
      for (const c of cues.filter((x) => !byId.has(x.id)).slice(0, 8)) {
        const one = (await translate(p, { lang: i.lang, label, cues: [c] }, ctx.signal)).cues;
        take(
          one.map((x) => ({ ...x, id: c.id })),
          [c],
        );
      }
      const missing = cues.filter((c) => !byId.has(c.id));
      if (missing.length)
        return fail("translation_incomplete", `no translation for ${missing.map((c) => c.id).join(", ")}`, {
          fix: "try again, or use a stronger model for the writer",
          retryable: true,
        });
      const texts = Object.fromEntries(byId);
      // written as given: no plainText, the file never passes through the pixel font
      const st = subtitles(p.project(), { texts });
      const base = (d.delivery[0]?.out ?? `${d.id}.mp4`).replace(/\.mp4$/, "");
      const names = [`${base}.${i.lang}.srt`, `${base}.${i.lang}.vtt`];
      mkdirSync(join(p.dir, "out"), { recursive: true });
      writeFileSync(join(p.dir, "out", names[0]), st.srt);
      writeFileSync(join(p.dir, "out", names[1]), st.vtt);
      const frames = fontFrames(p);
      const lacking = frames ? missingGlyphs(Object.values(texts).join(" "), frames) : ["(no font)"];
      ctx.emit({ type: "render", kind: "subtitles", files: names });
      return ok({
        lang: i.lang,
        files: outFiles(p, names),
        burnInPossible: lacking.length === 0,
        missingGlyphs: lacking.slice(0, 20),
        cues: cues.length,
        long: tooLong().map((c) => c.id),
      });
    },
  });
}

// ---------------------------------------------------------------- crew_request_change
export type ChangeHandler = (
  p: OpenProject,
  note: Note,
  /** open review notes the person chose to include (listed on the card) */
  extra: Note[],
) => ChangeOutcome | Promise<ChangeOutcome>;
/**
 * what a change did right away: `started` (a run took it on now), `resumed` (that run was held and goes on with it),
 * `queued` (the crew is working; the note waits for the next review), `waiting` (the crew still waits on this question)
 */
export type ChangeOutcome = { queued: boolean; stage: Stage; started: boolean; resumed?: boolean; waiting?: string };

/** what a production change is about; it picks the owner */
export const CHANGE_CATEGORIES = ["story", "scene", "art", "timing", "text", "sound", "other"] as const;
export type ChangeCategory = (typeof CHANGE_CATEGORIES)[number];
/** words that mean new beats on screen: characters, actors, scenes, props (a storyboard change) */
const STORY_WORDS =
  /\b(npcs?|characters?|actors?|cast|people|person|someone|friend|crowd|walk(s|ing)? in|joins?|new (beat|scene|shot)s?|add(ing)? (a |an |two |three |some |more |another )?(new )?\w*\s*(scenes?|characters?|npcs?|people|items?|props?|beats?|shots?))\b/i;

/**
 * Who owns a person's production change. Never the Producer: a new beat, character or scene is the Director's
 * (re-board those scenes), how a scene moves or looks is the Animator's, the words of the script the Writer's,
 * sound the Sound Designer's, a drawn asset the Pixel Artist's.
 */
export function changeOwner(
  target: { scene?: string; cue?: string; asset?: string },
  category: ChangeCategory,
  text = "",
): RoleT {
  if (target.asset) return "pixel-artist";
  if (category === "sound") return "sound-designer";
  if (category === "story" || (category !== "text" && category !== "timing" && STORY_WORDS.test(text)))
    return "director";
  if (category === "text") return target.cue || !target.scene ? "writer" : "animator";
  if (target.cue && category === "other") return "writer";
  if (target.scene || category === "scene" || category === "art" || category === "timing") return "animator";
  return "director";
}

/** the stage whose work a role's note changes */
export const OWNER_STAGE: Record<string, Stage> = {
  producer: "review",
  writer: "script",
  director: "storyboard",
  "art-director": "art",
  "pixel-artist": "art",
  animator: "animate",
  "scene-coder": "animate",
  "sound-designer": "sound",
  mixer: "sound",
  editor: "review",
  reviewer: "review",
  librarian: "review",
};

/** who owns a change (the crew's one router, `routeChange`); without one, `changeOwner` */
export type ChangeRouter = (note: {
  text: string;
  target: { scene?: string; cue?: string; asset?: string };
  category: ChangeCategory;
}) => RoleT;
export function crewRequestChangeTool(onChange: ChangeHandler, route?: ChangeRouter) {
  return defineTool({
    name: "crew_request_change",
    title: "Ask the crew for a change",
    description:
      "Turn a person's change request into a note for the role that owns it: new characters, beats or scenes (category story) to the Director, who re-plans just those scenes; how a scene looks or moves (art, scene, timing) to the Animator; script words (text) to the Writer; sound to the Sound Designer. If the crew is idle it reopens that stage and runs from there, keeping finished work outside the change; if the crew is held, the change answers the hold and the crew goes on with it; if the crew is working, the note waits for the next review. Put only the person's request in text; to include open review notes, pass their ids in alsoNotes.",
    input: z.object({
      text: z.string().min(3).max(1000),
      /** a scene id, or its number ("2" is the second scene) */
      scene: z.string().optional(),
      cue: z.string().optional(),
      /** a time in seconds; picks the scene when none is given */
      at: z.number().min(0).optional(),
      category: z.enum(CHANGE_CATEGORIES).default("other"),
      /** open review notes to fix in the same run (their ids, from note_list); each is shown on the card */
      alsoNotes: z.array(z.string()).max(10).default([]),
    }),
    output: z.object({
      noteId: z.string(),
      owner: z.string(),
      stage: z.string(),
      queued: z.boolean(),
      started: z.boolean(),
      /** the crew was held and goes on now with this change */
      resumed: z.boolean(),
      /** the crew still waits for the person on this question (a held provider) */
      waiting: z.string().optional(),
    }),
    roles: [],
    tier: "basic",
    effects: "spend",
    project: true,
    examples: [
      { input: { text: "make the hero bigger", scene: "2", category: "art" } },
      { input: { text: "add a friend who tells the hero about the app", scene: "1", category: "story" } },
      { input: { text: "the music is too loud at the end", category: "sound" } },
    ],
    handler: async (i, ctx) => {
      // a slash command (/context, /budget…) is never a change, even after a scope prefix ("About the moth: /context")
      if (/^\/[a-z]/i.test(i.text.replace(/^About [^:\n]{1,120}:\s*/i, "").trim()))
        return fail("not_a_change", "that is a slash command, not a change", {
          fix: "send it to Pip as a command; crew_request_change takes the person's words about the video",
        });
      const p = P(ctx);
      const d = p.doc();
      let scene = i.scene;
      if (scene !== undefined) {
        const n = /^(?:scene\s*)?(\d+)$/i.exec(scene.trim());
        const hit = n ? d.scenes[Number(n[1]) - 1] : d.scenes.find((s) => s.id === scene);
        if (!hit)
          return fail("not_found", `no scene ${scene}`, {
            fix: `use a scene id (${d.scenes.map((s) => s.id).join(", ")}) or its number 1-${d.scenes.length}`,
          });
        scene = hit.id;
      }
      if (i.cue && !d.script.cues.some((c) => c.id === i.cue))
        return fail("not_found", `no cue ${i.cue}`, { fix: `cues: ${d.script.cues.map((c) => c.id).join(", ")}` });
      if (!scene && i.at !== undefined) {
        const tl = p.timeline();
        scene = (tl.scenes.find((s) => i.at! >= s.from && i.at! < s.to) ?? tl.scenes.at(-1))?.id;
      }
      const target = {
        ...(scene ? { scene } : {}),
        ...(i.cue ? { cue: i.cue } : {}),
        ...(i.at !== undefined ? { range: [i.at, i.at] as [number, number] } : {}),
      };
      const owner: RoleT = route
        ? route({ text: i.text, target, category: i.category })
        : changeOwner(target, i.category, i.text);
      const extra: Note[] = [];
      for (const id of i.alsoNotes) {
        const n = p.state.notes.find((x) => x.id === id);
        if (!n) return fail("not_found", `no note ${id}`, { fix: "use ids from note_list" });
        extra.push(p.updateNote(id, { status: "open" }));
      }
      const note = p.addNote({ target, category: i.category, text: i.text, assignee: owner, by: "user" });
      const r = await onChange(p, note, extra);
      return ok({
        noteId: note.id,
        owner,
        stage: r.stage,
        queued: r.queued,
        started: r.started,
        resumed: !!r.resumed,
        ...(r.waiting ? { waiting: r.waiting } : {}),
      });
    },
  });
}

export const ASSIST_TOOLS = [filesList, projectFork, featureRequest];
