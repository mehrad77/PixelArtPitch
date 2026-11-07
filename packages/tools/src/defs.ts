// The core tools: projects, script, scenes, renders, library, assets, sound, narration, questions, notes and export.
// Basic tools are small and typed so weak models can use them; `project_patch` is the advanced escape hatch.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { thinSfx } from "@pap/engine/audio";
import { encode, loudness, mix, openDoc, openRenderer, sha256File, subtitles, writeMusic, writeSfx } from "@pap/render";
import { Brief, Cue, PatchOp, type ProjectT, SfxType, TimeExpr } from "@pap/schema";
import { z } from "zod";
import { fitRuns, speechRuns } from "./align.ts";
import { defineTool, fail, ok, QuestionInput, type ToolContext } from "./registry.ts";

const b64 = (u: Uint8Array) => Buffer.from(u).toString("base64");
const pngImg = (data: Uint8Array, caption?: string) => ({ mediaType: "image/png" as const, data, caption });
const author = (ctx: ToolContext) => ctx.author;
const P = (ctx: ToolContext) => ctx.project!;
const words = (s: string) => s.trim().split(/\s+/).filter(Boolean).length;

// ---------------------------------------------------------------- projects
export const projectList = defineTool({
  name: "project_list",
  title: "List projects",
  description: "List the projects this studio knows, with their id, title and folder.",
  input: z.object({}),
  output: z.array(z.object({ id: z.string(), title: z.string(), dir: z.string(), rev: z.number() })),
  roles: [],
  tier: "basic",
  effects: "read",
  project: false,
  handler: async (_i, ctx) => ok(ctx.workspace.list().map(({ id, title, dir, rev }) => ({ id, title, dir, rev }))),
});

export const projectCreate = defineTool({
  name: "project_create",
  title: "Start a project",
  description: "Create a new project folder from a brief. The crew then writes the script, storyboard, art and sound.",
  input: z.object({ title: z.string().min(1).max(120), brief: Brief, budgetUsd: z.number().min(0).max(1000) }),
  output: z.object({ id: z.string(), dir: z.string() }),
  roles: [],
  tier: "basic",
  effects: "write",
  project: false,
  handler: async (i, ctx) => {
    const p = ctx.workspace.create({ title: i.title, brief: i.brief, budgetUsd: i.budgetUsd });
    return ok({ id: p.id, dir: p.dir });
  },
});

const SECTIONS = ["summary", "brief", "script", "scenes", "audio", "assets", "composition", "budget", "all"] as const;
export const projectGet = defineTool({
  name: "project_get",
  title: "Read the project",
  description:
    'Read part of the project document. Use section "summary" first; "scene:<id>" reads one scene. Returns the revision you must pass back as baseRev when you change something.',
  input: z.object({
    section: z.union([z.enum(SECTIONS), z.string().regex(/^scene:[a-z][a-z0-9_]*$/)]).default("summary"),
  }),
  output: z.object({ rev: z.number(), data: z.unknown() }),
  roles: "*",
  tier: "basic",
  effects: "read",
  project: true,
  examples: [{ input: { section: "summary" } }, { input: { section: "scene:intro" } }],
  handler: async (i, ctx) => {
    const d = P(ctx).doc();
    const tl = P(ctx).timeline();
    let data: unknown;
    if (i.section === "summary")
      data = {
        title: d.title,
        idea: d.brief.idea,
        lengthSec: d.brief.lengthSec,
        narration: d.brief.narration,
        cues: tl.cues.map((c) => ({ id: c.id, text: c.text, start: +c.start.toFixed(2), end: +c.end.toFixed(2) })),
        scenes: d.scenes.map((s, k) => ({
          id: s.id,
          title: s.title,
          kind: s.kind,
          from: s.from,
          to: s.to,
          seconds: [+tl.scenes[k].from.toFixed(2), +tl.scenes[k].to.toFixed(2)],
          recipes: s.kind === "decl" ? s.recipes.map((r) => r.id) : [],
        })),
        duration: +tl.duration.toFixed(2),
        assets: d.assets.map((a) => a.id),
        budgetUsd: d.budget.capUsd,
      };
    else if (i.section === "all") data = d;
    else if (i.section.startsWith("scene:")) {
      const s = d.scenes.find((x) => x.id === i.section.slice(6));
      if (!s)
        return fail("not_found", `no scene ${i.section.slice(6)}`, {
          fix: `scenes: ${d.scenes.map((x) => x.id).join(", ")}`,
        });
      data = s;
    } else data = (d as any)[i.section];
    return ok({ rev: d.rev, data });
  },
});

export const projectPatch = defineTool({
  name: "project_patch",
  title: "Change the project (JSON Patch)",
  description:
    "Apply RFC 6902 JSON Patch operations to the project document with a short reason. The result is validated; pass the baseRev you read. Prefer the small typed tools when one fits.",
  input: z.object({
    ops: z.array(PatchOp).min(1).max(50),
    reason: z.string().min(3).max(300),
    baseRev: z.number().int(),
  }),
  output: z.object({ rev: z.number(), seq: z.number() }),
  roles: [
    "producer",
    "director",
    "animator",
    "scene-coder",
    "editor",
    "sound-designer",
    "mixer",
    "writer",
    "art-director",
  ],
  tier: "advanced",
  effects: "write",
  project: true,
  handler: async (i, ctx) =>
    ok(await P(ctx).patch(i.ops, { reason: i.reason, baseRev: i.baseRev, author: author(ctx) })),
});

export const projectHistory = defineTool({
  name: "project_history",
  title: "Change history",
  description: "List the changes made to the project (author, reason, operations), newest last.",
  input: z.object({ since: z.number().int().default(0) }),
  output: z.array(z.unknown()),
  roles: "*",
  tier: "basic",
  effects: "read",
  project: true,
  handler: async (i, ctx) => ok(await P(ctx).history(i.since)),
});

export const projectUndo = defineTool({
  name: "project_undo",
  title: "Undo a change",
  description: "Undo one change by its number, by appending its inverse.",
  input: z.object({ seq: z.number().int(), reason: z.string().min(3).max(300) }),
  output: z.object({ rev: z.number(), seq: z.number() }),
  roles: ["producer"],
  tier: "basic",
  effects: "write",
  project: true,
  handler: async (i, ctx) => ok(await P(ctx).undo(i.seq, i.reason, author(ctx))),
});

// ---------------------------------------------------------------- script and timing
export const scriptEstimate = defineTool({
  name: "script_estimate",
  title: "Estimate read time",
  description:
    "Words and seconds for lines of script at the project's speaking rate, and whether they fit the target length.",
  input: z.object({ lines: z.array(z.string()).min(1).max(60) }),
  output: z.object({
    lines: z.array(z.object({ text: z.string(), words: z.number(), seconds: z.number(), tooLong: z.boolean() })),
    totalSeconds: z.number(),
    targetSeconds: z.number(),
    wordBudget: z.number(),
  }),
  roles: ["writer", "producer", "editor", "director"],
  tier: "basic",
  effects: "read",
  project: true,
  handler: async (i, ctx) => {
    const d = P(ctx).doc();
    const { wps, pause, minCue, lead } = d.script.timing;
    const lines = i.lines.map((text) => {
      const w = words(text);
      return { text, words: w, seconds: +Math.max(minCue, w / wps).toFixed(2), tooLong: w > 12 };
    });
    const total = lead + lines.reduce((s, l) => s + l.seconds + pause, 0) + d.composition.endHold;
    const target = d.brief.lengthSec;
    const budget = Math.floor(Math.max(0, target - d.composition.hold - d.composition.endHold - lead) * wps);
    return ok({ lines, totalSeconds: +total.toFixed(2), targetSeconds: target, wordBudget: budget });
  },
});

export const scriptSetCues = defineTool({
  name: "script_set_cues",
  title: "Write the script",
  description:
    "Replace the script with these cues (one idea of at most 12 words each, in order). Ids are kept for unchanged positions so scenes stay anchored.",
  input: z.object({
    cues: z
      .array(z.object({ text: z.string().min(1).max(160), id: Cue.shape.id.optional() }))
      .min(1)
      .max(60),
    reason: z.string().min(3).max(300),
  }),
  output: z.object({ rev: z.number(), cues: z.array(z.object({ id: z.string(), text: z.string() })) }),
  roles: ["writer", "producer", "editor"],
  tier: "basic",
  effects: "write",
  project: true,
  handler: async (i, ctx) => {
    const d = P(ctx).doc();
    const cues = i.cues.map((c, k) => ({
      id: c.id ?? d.script.cues[k]?.id ?? `c${String(k + 1).padStart(2, "0")}`,
      text: c.text.trim(),
    }));
    const ids = new Set(cues.map((c) => c.id));
    if (ids.size !== cues.length)
      return fail("duplicate_id", "two cues share an id", { fix: "give every cue its own id or leave ids out" });
    const ops: any[] = [{ op: "replace", path: "/script/cues", value: cues }];
    if (d.script.timing.mode === "aligned") ops.push({ op: "replace", path: "/script/timing/mode", value: "estimate" });
    const r = await P(ctx).patch(ops, { reason: i.reason, baseRev: d.rev, author: author(ctx) });
    return ok({ rev: r.rev, cues });
  },
});

export const timelineGet = defineTool({
  name: "timeline_get",
  title: "Resolved timing",
  description: "Every cue, scene and event time in seconds, as the renderer sees them.",
  input: z.object({}),
  output: z.unknown(),
  roles: "*",
  tier: "basic",
  effects: "read",
  project: true,
  handler: async (_i, ctx) => {
    const { at: _at, ...tl } = P(ctx).timeline();
    return ok(tl);
  },
});

export const timeEval = defineTool({
  name: "time_eval",
  title: "Check a time expression",
  description: 'Evaluate a time expression such as "S(c02)+0.4" or "intro.to" to seconds, or get a fix hint.',
  input: z.object({ expr: TimeExpr }),
  output: z.object({ seconds: z.number() }),
  roles: "*",
  tier: "basic",
  effects: "read",
  project: true,
  handler: async (i, ctx) => ok({ seconds: P(ctx).timeline().at(i.expr) }),
});

// ---------------------------------------------------------------- scenes
const SceneWindow = z.object({
  id: z.string().regex(/^[a-z][a-z0-9_]*$/),
  title: z.string().max(80).default(""),
  from: TimeExpr,
  to: TimeExpr,
  cues: z.array(z.string()).default([]),
});
export const storyboardSet = defineTool({
  name: "storyboard_set",
  title: "Lay out the scenes",
  description:
    "Replace the list of scenes: ids, titles, cue-anchored windows and the cues each carries. New scenes start as declarative scenes with a night backdrop; existing ones keep their recipes and layers.",
  input: z.object({ scenes: z.array(SceneWindow).min(1).max(20), reason: z.string().min(3).max(300) }),
  output: z.object({ rev: z.number() }),
  roles: ["director", "producer", "editor"],
  tier: "basic",
  effects: "write",
  project: true,
  handler: async (i, ctx) => {
    const d = P(ctx).doc();
    const scenes = i.scenes.map((s) => {
      const old = d.scenes.find((x) => x.id === s.id);
      return old
        ? { ...old, title: s.title, from: s.from, to: s.to, cues: s.cues }
        : { ...s, kind: "decl" as const, notes: "", recipes: [{ id: "backdrop_night", params: {} }], layers: [] };
    });
    const r = await P(ctx).patch([{ op: "replace", path: "/scenes", value: scenes }], {
      reason: i.reason,
      baseRev: d.rev,
      author: author(ctx),
    });
    return ok({ rev: r.rev });
  },
});

export const sceneSetRecipes = defineTool({
  name: "scene_set_recipes",
  title: "Fill a scene with recipes",
  description:
    "Set the recipes a declarative scene is built from (in drawing order), each with its params. Use recipe_list to see the menu and each recipe's params. Errors come back with a fix.",
  input: z.object({
    scene: z.string(),
    recipes: z.array(z.object({ id: z.string(), params: z.record(z.string(), z.unknown()).default({}) })).max(12),
    reason: z.string().min(3).max(300),
  }),
  output: z.object({ rev: z.number(), stills: z.array(z.number()) }),
  roles: ["animator", "director", "producer"],
  tier: "basic",
  effects: "write",
  project: true,
  examples: [
    {
      input: { scene: "intro", recipes: [{ id: "backdrop_night", params: {} }], reason: "night sky behind the intro" },
    },
  ],
  handler: async (i, ctx) => {
    const p = P(ctx);
    const d = p.doc();
    const k = d.scenes.findIndex((s) => s.id === i.scene);
    if (k < 0)
      return fail("not_found", `no scene ${i.scene}`, { fix: `scenes: ${d.scenes.map((s) => s.id).join(", ")}` });
    if (d.scenes[k].kind !== "decl")
      return fail("code_scene", `${i.scene} is a code scene`, { fix: "only declarative scenes take recipes" });
    const { checkRecipeParams } = await import("@pap/engine/recipes");
    const tl = p.timeline();
    const issues = i.recipes.flatMap((r, n) => checkRecipeParams(r.id, r.params, tl.at, `recipes[${n}]`));
    if (issues.length)
      return fail("invalid_recipe", issues.map((x: any) => `${x.path}: ${x.message}`).join("; "), {
        fix: issues.map((x: any) => x.fix).join("; "),
        retryable: true,
      });
    const r = await p.patch([{ op: "replace", path: `/scenes/${k}/recipes`, value: i.recipes }], {
      reason: i.reason,
      baseRev: d.rev,
      author: author(ctx),
    });
    const w = tl.scenes[k];
    return ok({ rev: r.rev, stills: [w.from + 0.5, (w.from + w.to) / 2, w.to - 0.3].map((t) => +t.toFixed(2)) });
  },
});

export const sceneSetLayers = defineTool({
  name: "scene_set_layers",
  title: "Set a scene's own layers",
  description:
    "Replace the hand-placed layers of a declarative scene (drawn above its recipes). Advanced: prefer recipes.",
  input: z.object({
    scene: z.string(),
    layers: z.array(z.record(z.string(), z.unknown())).max(60),
    reason: z.string().min(3),
  }),
  output: z.object({ rev: z.number() }),
  roles: ["animator", "scene-coder"],
  tier: "advanced",
  effects: "write",
  project: true,
  handler: async (i, ctx) => {
    const d = P(ctx).doc();
    const k = d.scenes.findIndex((s) => s.id === i.scene);
    if (k < 0) return fail("not_found", `no scene ${i.scene}`);
    return ok(
      await P(ctx).patch([{ op: "replace", path: `/scenes/${k}/layers`, value: i.layers }], {
        reason: i.reason,
        baseRev: d.rev,
        author: author(ctx),
      }),
    );
  },
});

export const recipeList = defineTool({
  name: "recipe_list",
  title: "The recipe menu",
  description:
    "Every scene recipe: what it is for, its asset slots, params with defaults and ranges, and its minimum length. Recipes are the building blocks of declarative scenes.",
  input: z.object({ id: z.string().optional() }),
  output: z.unknown(),
  roles: "*",
  tier: "basic",
  effects: "read",
  project: false,
  handler: async (i) => {
    const { recipeCatalog } = await import("@pap/engine/recipes");
    const all = recipeCatalog();
    return ok(i.id ? all.filter((r: any) => r.id === i.id) : all);
  },
});

// ---------------------------------------------------------------- renders
export const renderStill = defineTool({
  name: "render_still",
  title: "Render a still",
  description: "Render the frame at a scene time (seconds, or a time expression) as a PNG image you can look at.",
  input: z.object({ t: TimeExpr, scale: z.number().int().min(1).max(6).default(3) }),
  output: z.object({ t: z.number(), scene: z.string() }),
  roles: "*",
  tier: "basic",
  effects: "read",
  project: true,
  handler: async (i, ctx) => {
    const p = P(ctx);
    const tl = p.timeline();
    const t = tl.at(i.t);
    const img = await p.still(t, i.scale);
    const sc = tl.scenes.find((s) => t >= s.from && t < s.to) ?? tl.scenes.at(-1)!;
    return ok({ t, scene: sc.id }, { images: [pngImg(img, `t=${t.toFixed(2)}s (${sc.id})`)] });
  },
});

export const renderContact = defineTool({
  name: "render_contact",
  title: "Contact sheet",
  description: "One frame per interval across the whole video in one image: the fastest way to judge pacing.",
  input: z.object({ every: z.number().min(0.25).max(10).default(1) }),
  output: z.object({ frames: z.number() }),
  roles: "*",
  tier: "basic",
  effects: "read",
  project: true,
  handler: async (i, ctx) => {
    const { contactSheet } = await import("@pap/render");
    const r = await P(ctx).renderer_();
    const img = await contactSheet(r, { every: i.every });
    return ok(
      { frames: Math.ceil(P(ctx).timeline().duration / i.every) },
      { images: [pngImg(img, `every ${i.every}s`)] },
    );
  },
});

// ---------------------------------------------------------------- library and assets
type LibIndex = { assets: { id: string; kind: string; w: number; h: number; frames: number; tags: string[] }[] };
const libIndex = (dir: string): LibIndex => JSON.parse(readFileSync(join(dir, "index.json"), "utf8"));
export const librarySearch = defineTool({
  name: "library_search",
  title: "Search the asset library",
  description:
    "Find reusable public assets by words, kind or size. Reuse beats drawing: check here before asking for new art.",
  input: z.object({
    query: z.string().default(""),
    kind: z.string().optional(),
    limit: z.number().int().min(1).max(50).default(20),
  }),
  output: z.array(
    z.object({
      id: z.string(),
      kind: z.string(),
      w: z.number(),
      h: z.number(),
      frames: z.array(z.string()),
      description: z.string(),
      ref: z.string(),
    }),
  ),
  roles: "*",
  tier: "basic",
  effects: "read",
  project: false,
  handler: async (i, ctx) => {
    const q = i.query.toLowerCase().split(/\s+/).filter(Boolean);
    const out = libIndex(ctx.workspace.libraryDir)
      .assets.filter((a) => !i.kind || a.kind === i.kind)
      .map((a) => {
        const f = JSON.parse(readFileSync(join(ctx.workspace.libraryDir, a.id, "asset.json"), "utf8"));
        const hay = `${a.id} ${a.kind} ${a.tags.join(" ")} ${f.description} ${f.frames.join(" ")}`.toLowerCase();
        return { a, f, score: q.reduce((s, w) => s + (hay.includes(w) ? 1 : 0), 0) };
      })
      .filter((x) => !q.length || x.score > 0)
      .sort((x, y) => y.score - x.score)
      .slice(0, i.limit)
      .map(({ a, f }) => ({
        id: a.id,
        kind: a.kind,
        w: a.w,
        h: a.h,
        frames: f.frames,
        description: f.description.slice(0, 300),
        ref: `lib:${a.id}@${f.version}`,
      }));
    return ok(out);
  },
});

export const libraryGet = defineTool({
  name: "library_get",
  title: "Look at a library asset",
  description: "An asset's metadata and its preview sheet image; with grid=true also its letter-grid frames.",
  input: z.object({ id: z.string(), grid: z.boolean().default(false) }),
  output: z.unknown(),
  roles: "*",
  tier: "basic",
  effects: "read",
  project: false,
  handler: async (i, ctx) => {
    const dir = join(ctx.workspace.libraryDir, i.id);
    if (!existsSync(join(dir, "asset.json")))
      return fail("not_found", `no library asset ${i.id}`, { fix: "use library_search" });
    const f = JSON.parse(readFileSync(join(dir, "asset.json"), "utf8"));
    const { grid, ...meta } = f;
    return ok(i.grid ? f : meta, { images: [pngImg(readFileSync(join(dir, "sheet.png")), i.id)] });
  },
});

export const castAsset = defineTool({
  name: "cast_asset",
  title: "Use a library asset in this project",
  description:
    "Add a public library asset to the project under a name scenes use. Optional frameAlias maps names the project uses to the asset's frame names.",
  input: z.object({
    name: z.string().regex(/^[a-z0-9][a-z0-9_-]*$/),
    libraryId: z.string(),
    frameAlias: z.record(z.string(), z.string()).optional(),
  }),
  output: z.object({ rev: z.number() }),
  roles: ["art-director", "producer", "director"],
  tier: "basic",
  effects: "write",
  project: true,
  handler: async (i, ctx) => {
    const p = P(ctx);
    const d = p.doc();
    const file = join(ctx.workspace.libraryDir, i.libraryId, "asset.json");
    if (!existsSync(file)) return fail("not_found", `no library asset ${i.libraryId}`, { fix: "use library_search" });
    const v = JSON.parse(readFileSync(file, "utf8")).version ?? 1;
    const ref = {
      id: i.name,
      src: `lib:${i.libraryId}@${v}`,
      ...(i.frameAlias ? { frameAlias: i.frameAlias } : {}),
      flags: { private: false },
    };
    const k = d.assets.findIndex((a) => a.id === i.name);
    const op =
      k < 0 ? { op: "add", path: "/assets/-", value: ref } : { op: "replace", path: `/assets/${k}`, value: ref };
    return ok(
      await p.patch([op as any], { reason: `cast ${i.libraryId} as ${i.name}`, baseRev: d.rev, author: author(ctx) }),
    );
  },
});

// ---------------------------------------------------------------- questions and notes
export const askUser = defineTool({
  name: "ask_user",
  title: "Ask the user",
  description:
    "Ask the user one multiple-choice question only they can answer (names, order, claims, rights, budget or deadline). Give 2-6 options and a recommended one. Waits for the answer.",
  input: QuestionInput,
  output: z.object({ id: z.string(), optionId: z.string().optional(), note: z.string().optional(), by: z.string() }),
  roles: ["producer"],
  tier: "basic",
  effects: "read",
  project: true,
  handler: async (i, ctx) => {
    const p = P(ctx);
    const q = p.ask(i, ctx.author.role ?? ctx.author.kind);
    const a = await p.waitAnswer(q.id, ctx.signal);
    return ok({ id: a.id, optionId: a.answer?.optionId, note: a.answer?.note, by: a.answer?.by ?? "user" });
  },
});

export const questionList = defineTool({
  name: "question_list",
  title: "Open questions",
  description: "Questions the crew asked that wait for an answer.",
  input: z.object({ all: z.boolean().default(false) }),
  output: z.array(z.unknown()),
  roles: "*",
  tier: "basic",
  effects: "read",
  project: true,
  handler: async (i, ctx) => ok(P(ctx).state.questions.filter((q) => i.all || q.status === "open")),
});

export const questionAnswer = defineTool({
  name: "question_answer",
  title: "Answer a question",
  description: "Answer one of the crew's questions by option id.",
  input: z.object({ id: z.string(), optionId: z.string(), note: z.string().max(500).optional() }),
  output: z.unknown(),
  roles: [],
  tier: "basic",
  effects: "write",
  project: true,
  handler: async (i, ctx) =>
    ok(await P(ctx).answer(i.id, { optionId: i.optionId, note: i.note }, ctx.author.client ?? ctx.author.kind)),
});

export const noteAdd = defineTool({
  name: "note_add",
  title: "Leave a note",
  description: "Pin a note to a scene, cue, asset or time range; it is routed to the role that owns it.",
  input: z.object({
    target: z.object({
      scene: z.string().optional(),
      cue: z.string().optional(),
      asset: z.string().optional(),
      range: z.tuple([z.number(), z.number()]).optional(),
      track: z.string().optional(),
    }),
    category: z.enum(["too_fast", "too_slow", "unclear", "art", "sound", "text", "other"]),
    text: z.string().max(1000).default(""),
    assignee: z.string().optional(),
  }),
  output: z.unknown(),
  roles: ["reviewer", "director", "producer"],
  tier: "basic",
  effects: "write",
  project: true,
  handler: async (i, ctx) => {
    const assignee =
      i.assignee ??
      (i.target.asset
        ? "pixel-artist"
        : i.target.cue
          ? "writer"
          : i.category === "sound"
            ? "sound-designer"
            : i.target.scene
              ? "animator"
              : "producer");
    return ok(
      P(ctx).addNote({
        target: i.target,
        category: i.category,
        text: i.text,
        assignee,
        by: ctx.author.role ?? ctx.author.kind,
      }),
    );
  },
});

export const noteList = defineTool({
  name: "note_list",
  title: "Notes",
  description: "Notes from the user and the reviewers, optionally only those for one role.",
  input: z.object({ assignee: z.string().optional(), open: z.boolean().default(true) }),
  output: z.array(z.unknown()),
  roles: "*",
  tier: "basic",
  effects: "read",
  project: true,
  handler: async (i, ctx) =>
    ok(
      P(ctx).state.notes.filter(
        (n) =>
          (!i.assignee || n.assignee === i.assignee) && (!i.open || n.status === "open" || n.status === "picked_up"),
      ),
    ),
});

export const noteResolve = defineTool({
  name: "note_resolve",
  title: "Resolve a note",
  description: "Mark a note done (with what changed) or declined (with why).",
  input: z.object({
    id: z.string(),
    status: z.enum(["picked_up", "proposed", "done", "declined"]),
    reason: z.string().max(500).default(""),
  }),
  output: z.unknown(),
  roles: "*",
  tier: "basic",
  effects: "write",
  project: true,
  handler: async (i, ctx) => ok(P(ctx).updateNote(i.id, { status: i.status, reason: i.reason })),
});

// ---------------------------------------------------------------- sound
export const sfxList = defineTool({
  name: "sfx_list",
  title: "Sound effect types",
  description: "The 8-bit sound effects the synth can play, and the keep table used when there is a voice.",
  input: z.object({}),
  output: z.object({ types: z.array(z.string()), voiceKeep: z.record(z.string(), z.number()) }),
  roles: "*",
  tier: "basic",
  effects: "read",
  project: false,
  handler: async () => {
    const { SFX_TYPES, VOICE_KEEP } = await import("@pap/engine/audio");
    return ok({ types: [...SFX_TYPES], voiceKeep: VOICE_KEEP });
  },
});

export const sfxSet = defineTool({
  name: "sfx_set",
  title: "Set the sound plan",
  description:
    "Extra sound effects on cue-anchored times, and the keep table (null keeps every effect the scenes emit; with a voice use the voice table).",
  input: z.object({
    events: z
      .array(z.object({ t: TimeExpr, type: SfxType }))
      .max(80)
      .default([]),
    keep: z.record(z.string(), z.number().int().min(0)).nullable(),
    reason: z.string().min(3),
  }),
  output: z.object({ rev: z.number() }),
  roles: ["sound-designer", "mixer", "producer"],
  tier: "basic",
  effects: "write",
  project: true,
  handler: async (i, ctx) => {
    const d = P(ctx).doc();
    return ok(
      await P(ctx).patch(
        [
          { op: "replace", path: "/audio/sfx/events", value: i.events },
          { op: "replace", path: "/audio/sfx/keep", value: i.keep },
        ],
        { reason: i.reason, baseRev: d.rev, author: author(ctx) },
      ),
    );
  },
});

export const audioRender = defineTool({
  name: "audio_render",
  title: "Render and measure the sound",
  description: "Render SFX, music and the mix (with the narration if any) and report loudness against the target.",
  input: z.object({}),
  output: z.object({
    sfx: z.object({ events: z.number(), kept: z.number() }),
    music: z.boolean(),
    mix: z.object({ lufs: z.number(), truePeakDb: z.number(), gainDb: z.number(), targetLufs: z.number() }),
  }),
  roles: ["sound-designer", "mixer", "editor", "producer"],
  tier: "basic",
  effects: "write",
  project: true,
  handler: async (_i, ctx) => {
    const p = P(ctx);
    const r = await p.renderer_();
    const out = join(p.dir, "out");
    mkdirSync(out, { recursive: true });
    const s = await writeSfx(p.project(), r, join(out, "sfx.wav"));
    const m = writeMusic(p.project(), join(out, "music.wav"));
    const mx = mix(p.project(), {
      sfx: join(out, "sfx.wav"),
      music: m ? join(out, "music.wav") : undefined,
      out: join(out, "audio.wav"),
    });
    ctx.emit({ type: "render", kind: "audio" });
    return ok({
      sfx: { events: s.events, kept: s.kept },
      music: m,
      mix: { lufs: mx.lufs, truePeakDb: mx.truePeakDb, gainDb: mx.gainDb, targetLufs: p.doc().mix.lufs },
    });
  },
});

// ---------------------------------------------------------------- narration
export const voAlign = defineTool({
  name: "vo_align",
  title: "Align the narration",
  description:
    "Find where each cue is spoken in a narration file (pauses + word counts) and propose cue times. With apply=true the times are written and everything anchored to the cues moves with them.",
  input: z.object({
    file: z.string().regex(/^[a-zA-Z0-9_./-]+\.(wav|webm|m4a|mp3)$/),
    apply: z.boolean().default(false),
    noiseDb: z.number().default(-40),
    minSilence: z.number().default(0.25),
  }),
  output: z.object({
    proposal: z.array(z.object({ cue: z.string(), start: z.number(), end: z.number() })),
    duration: z.number(),
    rev: z.number().optional(),
  }),
  roles: ["editor", "producer"],
  tier: "basic",
  effects: "write",
  project: true,
  handler: async (i, ctx) => {
    const p = P(ctx);
    const f = join(p.dir, i.file);
    if (!f.startsWith(p.dir) || !existsSync(f)) return fail("not_found", `no file ${i.file} in the project`);
    const d = p.doc();
    const { runs, duration } = speechRuns(f, { noiseDb: i.noiseDb, minSilence: i.minSilence });
    const spans = fitRuns(
      runs,
      d.script.cues.map((c) => words(c.text)),
    );
    const proposal = d.script.cues.map((c, k) => ({ cue: c.id, start: spans[k][0], end: spans[k][1] }));
    if (!i.apply) return ok({ proposal, duration });
    const aligned = Object.fromEntries(proposal.map((x) => [x.cue, [x.start, x.end]]));
    const r = await p.patch(
      [
        { op: "replace", path: "/script/timing/mode", value: "aligned" },
        { op: d.script.timing.aligned ? "replace" : "add", path: "/script/timing/aligned", value: aligned },
        { op: "replace", path: "/audio/vo", value: [{ file: i.file, offset: 0 }] },
      ] as any,
      { reason: `align the cues to ${i.file}`, baseRev: d.rev, author: author(ctx) },
    );
    return ok({ proposal, duration, rev: r.rev });
  },
});

// ---------------------------------------------------------------- delivery
export const exportVideo = defineTool({
  name: "export_video",
  title: "Export the video",
  description: "Render the final video for one delivery (with sound and subtitles) into the project's out/ folder.",
  input: z.object({
    delivery: z.string().optional(),
    /** "burned": captions drawn into the pixels (the project default); "none": a clean picture, subtitles as files only */
    captions: z.enum(["burned", "none"]).optional(),
  }),
  output: z.object({
    file: z.string(),
    seconds: z.number(),
    frames: z.number(),
    lufs: z.number().nullable(),
    subtitles: z.array(z.string()),
  }),
  roles: ["editor", "producer"],
  tier: "basic",
  effects: "write",
  project: true,
  cost: () => ({ sec: 60 }),
  handler: async (i, ctx) => {
    const p = P(ctx);
    const d = p.doc();
    const del = (i.delivery ? d.delivery.find((x) => x.id === i.delivery) : d.delivery[0]) ?? {
      id: "hd",
      scale: 6 as const,
      crf: 16,
      out: `${d.id}.mp4`,
    };
    const out = join(p.dir, "out");
    mkdirSync(out, { recursive: true });
    const burned = d.composition.captions.enabled;
    const want = i.captions ? i.captions === "burned" : burned;
    // a clean export renders a copy of the document with captions off; the project itself is unchanged
    const r =
      want === burned
        ? await p.renderer_()
        : await openRenderer(
            openDoc(p.dir, {
              ...d,
              composition: { ...d.composition, captions: { ...d.composition.captions, enabled: want } },
            }),
          );
    await writeSfx(p.project(), r, join(out, "sfx.wav"));
    const m = writeMusic(p.project(), join(out, "music.wav"));
    const mx = mix(p.project(), {
      sfx: join(out, "sfx.wav"),
      music: m ? join(out, "music.wav") : undefined,
      out: join(out, "audio.wav"),
    });
    const subs: string[] = [];
    const st = subtitles(p.project());
    if (d.subtitles.srt) {
      writeFileSync(join(out, del.out.replace(/\.mp4$/, ".srt")), st.srt);
      subs.push(del.out.replace(/\.mp4$/, ".srt"));
    }
    if (d.subtitles.vtt) {
      writeFileSync(join(out, del.out.replace(/\.mp4$/, ".vtt")), st.vtt);
      subs.push(del.out.replace(/\.mp4$/, ".vtt"));
    }
    const res = await encode(r, {
      out: join(out, del.out),
      scale: del.scale,
      crf: del.crf,
      audio: join(out, "audio.wav"),
      onProgress: (f) => ctx.emit({ type: "progress", what: "export", fraction: f }),
    });
    ctx.emit({ type: "render", kind: "final", url: `files/${del.out}` });
    return ok({
      file: `out/${del.out}`,
      seconds: res.seconds,
      frames: res.frames,
      lufs: Number.isFinite(mx.lufs) ? mx.lufs : null,
      subtitles: subs,
    });
  },
});

export const CORE_TOOLS = [
  projectList,
  projectCreate,
  projectGet,
  projectPatch,
  projectHistory,
  projectUndo,
  scriptEstimate,
  scriptSetCues,
  timelineGet,
  timeEval,
  storyboardSet,
  sceneSetRecipes,
  sceneSetLayers,
  recipeList,
  renderStill,
  renderContact,
  librarySearch,
  libraryGet,
  castAsset,
  askUser,
  questionList,
  questionAnswer,
  noteAdd,
  noteList,
  noteResolve,
  sfxList,
  sfxSet,
  audioRender,
  voAlign,
  exportVideo,
];

export type { ProjectT };
export { b64, loudness, sha256File, thinSfx };
