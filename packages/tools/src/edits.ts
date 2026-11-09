// The free edits (docs/PIP-ORCHESTRATION.md §1.12, the `edit` tier): writes with no model call that Pip makes in the
// same turn. look_set_time sets the video's time of day (the crew's look.time task does the same); code_set_constants
// sets a code scene's named constants as text, checked in a trial sandbox first and never written when the check fails.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { LoadedProject } from "@pap/render";
import type { AuthorT } from "@pap/schema";
import { z } from "zod";
import { type ConstValue, setConstants } from "./constants.ts";
import { defineTool, fail, ok } from "./registry.ts";
import type { OpenProject } from "./store.ts";

export type TimeOfDay = "night" | "dusk" | "day";
const WORD: Record<TimeOfDay, string> = { night: "night", dusk: "dusk", day: "day" };

/**
 * Set the video, or some of its scenes, at a time of day. The whole video: `canvas.time` (a built-in palette follows
 * it, `paletteFor`), and any scene's own `time` is dropped, so the whole video means every scene. Some scenes: each
 * one's `time` (dropped where it equals the video's), so a day story can end at dusk. Returns whether it changed, and
 * the line for a cue that still says the old time ("Cue 1 still says …"), for Pip to pass on once.
 */
export async function setTimeOfDay(
  p: OpenProject,
  want: TimeOfDay,
  author: AuthorT,
  scenes?: string[],
): Promise<{ changed: boolean; was: TimeOfDay; rev: number; cue?: { id: string; line: string } }> {
  const d = p.doc();
  const base = ((d.canvas as { time?: string }).time ?? "night") as TimeOfDay;
  const own = (s: (typeof d.scenes)[number]) => (s as { time?: TimeOfDay }).time;
  const picked = scenes?.length ? d.scenes.filter((s) => scenes.includes(s.id)) : null;
  if (scenes?.length && !picked?.length) throw new Error(`no such scene: ${scenes.join(", ")}`);
  const was = picked ? (own(picked[0]) ?? base) : base;
  const ops: { op: "add" | "remove"; path: string; value?: TimeOfDay }[] = [];
  if (picked) {
    for (const s of picked) {
      const i = d.scenes.indexOf(s);
      if (want === base) {
        if (own(s)) ops.push({ op: "remove", path: `/scenes/${i}/time` });
      } else if (own(s) !== want) ops.push({ op: "add", path: `/scenes/${i}/time`, value: want });
    }
  } else {
    if (base !== want) ops.push({ op: "add", path: "/canvas/time", value: want });
    d.scenes.forEach((s, i) => {
      if (own(s)) ops.push({ op: "remove", path: `/scenes/${i}/time` });
    });
  }
  if (!ops.length) return { changed: false, was, rev: d.rev };
  const nums = picked?.map((s) => d.scenes.indexOf(s) + 1);
  const r = await p.patch(ops as never, {
    reason: nums
      ? `the person's change: ${nums.length === 1 ? `scene ${nums[0]} is` : `scenes ${nums.join(", ")} are`} set at ${WORD[want]}`
      : `the person's change: the video is set at ${WORD[want]}`,
    author,
  });
  // the cue that says the old time ("Night falls.") is the person's words: say so, never rewrite it (only the
  // changed scenes' cues when some scenes change)
  const old = want === "night" ? /\b(sun|sunny|day|daylight|sunset|dusk)\b/i : /\bnight\b/i;
  const inScope = picked ? new Set(picked.flatMap((s) => s.cues)) : null;
  const c = d.script.cues.find((x) => (!inScope || inScope.has(x.id)) && old.test(x.text));
  return {
    changed: true,
    was,
    rev: r.rev,
    ...(c
      ? {
          cue: {
            id: c.id,
            line: `Cue ${d.script.cues.indexOf(c) + 1} still says "${c.text}" Tell me if its words should change too.`,
          },
        }
      : {}),
  };
}

export const lookSetTime = defineTool({
  name: "look_set_time",
  title: "Set the time of day",
  description:
    "Set the whole video, or only the scenes you name, at night, dusk or day (canvas.time, or each scene's own time; the palette follows). The whole video drops any scene's own time. Recipe scenes and every code scene that draws its sky from TIME follow by themselves: no model call. Says which cue still names the old time.",
  input: z.object({
    time: z.enum(["night", "dusk", "day"]),
    /** scene ids: only these scenes change (a day story whose last scene is at dusk); absent: the whole video */
    scenes: z.array(z.string()).max(40).optional(),
  }),
  output: z.object({ rev: z.number(), changed: z.boolean(), was: z.string(), cueNote: z.string().optional() }),
  roles: ["director", "producer"],
  tier: "basic",
  effects: "write",
  project: true,
  examples: [
    { input: { time: "day" }, note: "make it in daytime" },
    { input: { time: "dusk", scenes: ["finale"] }, note: "the last scene at sunset" },
  ],
  handler: async (i, ctx) => {
    let r: Awaited<ReturnType<typeof setTimeOfDay>>;
    try {
      r = await setTimeOfDay(ctx.project!, i.time, ctx.author, i.scenes);
    } catch (e: any) {
      return fail("bad_input", String(e?.message ?? e));
    }
    return ok({ rev: r.rev, changed: r.changed, was: r.was, ...(r.cue ? { cueNote: r.cue.line } : {}) });
  },
});

/** a trial of a candidate bundle for a scene: loads it, probes it, lints it and renders its stills (scene-code.ts) */
export type BundleTrial = (
  lp: LoadedProject,
  scene: string,
  source: string,
) => Promise<{ ok: boolean; errors: string[]; warnings: string[]; stills: { caption: string; data: Uint8Array }[] }>;

const Literal = z.union([z.number(), z.string(), z.boolean()]);
/** the next free file name for a scene's edited bundle: code/<bundle>.v<n>.mjs (the old file stays for undo) */
function nextFile(dir: string, bundle: string) {
  for (let n = 2; ; n++) {
    const f = `code/${bundle}.v${n}.mjs`;
    if (!existsSync(join(dir, f))) return f;
  }
}

/**
 * code_set_constants: a code scene's named constants (`export const LOGO_Y = 40`) set as text, with no model call.
 * The edited bundle is loaded in a trial sandbox (3 stills, the probes and lints) first; when it fails, nothing is
 * written. When it passes, it is written as a new file and the bundle entry points at it, so /undo brings back the old
 * file.
 */
export function codeSetConstantsTool(trial: BundleTrial) {
  return defineTool({
    name: "code_set_constants",
    title: "Set a code scene's constants",
    description:
      "Change a code scene's named constants (the `export const NAME = value` lines at the top of its code: positions, sizes, colour letters, beat offsets, hold lengths, cast lists) with no model call. The scene is checked in a trial render first and nothing changes when the check fails. project_get lists each code scene's constants.",
    input: z.object({
      scene: z.string(),
      set: z.record(z.string().regex(/^[A-Z][A-Z0-9_]*$/), z.union([Literal, z.array(Literal).max(24)])),
      reason: z.string().min(3).max(300),
    }),
    output: z.object({
      rev: z.number(),
      scene: z.string(),
      file: z.string(),
      changed: z.array(z.object({ name: z.string(), from: z.unknown(), to: z.unknown() })),
    }),
    roles: ["scene-coder", "producer"],
    tier: "basic",
    effects: "write",
    project: true,
    examples: [{ input: { scene: "hub", set: { LOGO_Y: 32 }, reason: "move the logo up a bit" } }],
    handler: async (i, ctx) => {
      const p = ctx.project!;
      const d = p.doc();
      const s = d.scenes.find((x) => x.id === i.scene);
      if (s?.kind !== "code")
        return fail("not_found", `no code scene ${i.scene}`, {
          fix: `code scenes: ${
            d.scenes
              .filter((x) => x.kind === "code")
              .map((x) => x.id)
              .join(", ") || "(none)"
          }`,
        });
      const k = d.code.findIndex((c) => c.id === s.bundle);
      const entry = d.code[k];
      if (!entry) return fail("not_found", `${i.scene} has no code bundle`, { fix: "ask the crew for the change" });
      let src: string;
      try {
        src = readFileSync(join(p.dir, entry.file), "utf8");
      } catch {
        return fail("not_found", `can't read ${entry.file}`, { fix: "ask the crew for the change" });
      }
      const edited = setConstants(src, i.set as Record<string, ConstValue>);
      if ("error" in edited) return fail("unknown_constant", edited.error, { fix: edited.fix });
      if (!edited.changed.length) return ok({ rev: d.rev, scene: s.id, file: entry.file, changed: [] });
      const t = await trial(p.project(), s.id, edited.source);
      if (!t.ok)
        return fail("trial_failed", `the scene doesn't pass with those values: ${t.errors.slice(0, 3).join("; ")}`, {
          fix: "nothing was changed; use values that keep it inside the frame and above the captions (y < 146), or ask the crew",
        });
      const file = nextFile(p.dir, entry.id);
      writeFileSync(join(p.dir, file), edited.source);
      const r = await p.patch([{ op: "replace", path: `/code/${k}/file`, value: file }], {
        reason: i.reason,
        baseRev: d.rev,
        author: ctx.author,
      });
      const mid = t.stills[Math.floor(t.stills.length / 2)];
      return ok(
        { rev: r.rev, scene: s.id, file, changed: edited.changed },
        mid ? { images: [{ mediaType: "image/png", data: mid.data, caption: `${s.id} after: ${mid.caption}` }] } : {},
      );
    },
  });
}

export const EDIT_TOOLS = [lookSetTime];
