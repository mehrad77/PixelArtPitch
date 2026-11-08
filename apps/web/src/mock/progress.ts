// The mock's live model calls (docs/API.md `progress`): while a journey task works, its call "thinks" for a few
// seconds, then "writes"; a Pixel Artist's answer streams a 16×16 grid a row at a time, so the live canvas
// (Settings › Experimental) has something to paint. The colours come from the kit's tokens at runtime, as in art.ts:
// no colour literal lives here.
import type { Task, TaskProgress } from "../lib/types.ts";

/** a small moth, lit from the upper left (letters as in pap-night: k ink, K ground, e limb, p paper-dim, P paper, b bloom) */
const MOTH = [
  "................",
  "....k......k....",
  ".....k....k.....",
  "......kkkk......",
  "..kkk.kPPk.kkk..",
  ".kPPpkkppkkpppk.",
  "kPPbbpkppkpbbppk",
  "kPpbbpkeekpbbpek",
  "kPpppkkeekkpppek",
  ".kpppk.ee.kpeek.",
  "..kkk..ee..kkk..",
  "......keek......",
  ".....kpeepk.....",
  ".....kkeekk.....",
  "......kkkk......",
  "................",
];
/** the letters, as the kit's tokens */
const INK: Record<string, string> = {
  k: "--ink",
  K: "--ink-3",
  e: "--line-control",
  p: "--paper-dim",
  P: "--paper",
  b: "--art-bloom",
};
let palette: Record<string, string> | null = null;
function paletteOf(): Record<string, string> {
  if (palette) return palette;
  const cs = typeof document !== "undefined" ? getComputedStyle(document.documentElement) : null;
  palette = Object.fromEntries(Object.entries(INK).map(([k, v]) => [k, cs?.getPropertyValue(v).trim() || "gray"]));
  return palette;
}

const CODE_ONLY = new Set(["asset.import", "art.cast", "sound.mix", "deliver.export", "lib.publish"]);

const THINK =
  "The brief asks for this to read at a glance against the night sky, so the light comes from the upper left; ";
const WRITE =
  '{"notes":"A moth with pale wings and a bloom spot on each, outlined in ink.","frames":[{"name":"idle0","rows":[';

/** the call `t` is making now, `sec` seconds in (the run's own clock, sped up by `speed`) */
export function mockProgress(t: Task, sec: number, speed = 1): TaskProgress | null {
  // code-only steps (an import, a cast, the mix, an export) make no model call: the server sends nothing for them
  if (t.status !== "working" || CODE_ONLY.has(t.kind)) return null;
  const s = Math.max(0, sec * speed);
  const draws = t.role === "pixel-artist";
  // a drawing thinks briefly and streams its rows fast: the journey's draw is a few ticks long
  const think = draws ? 1.5 : 4;
  if (s < think)
    return { taskId: t.id, phase: "thinking", tokens: Math.round(s * 160), seconds: Math.round(sec), tail: "" };
  const w = s - think;
  const tokens = Math.round(think * 160 + w * 60);
  if (!draws) {
    const said = `${THINK}so the answer keeps to the scenes the board already has and names each change.`;
    return {
      taskId: t.id,
      phase: "writing",
      tokens,
      seconds: Math.round(sec),
      tail: said.slice(0, Math.min(said.length, 20 + Math.round(w * 30))),
    };
  }
  const rows = Math.min(MOTH.length, Math.floor(w * 4));
  // a row still being written: half of it, with no closing quote yet
  const partial = rows < MOTH.length ? `,"${MOTH[rows].slice(0, 8)}` : "]}]}";
  const draft = `${WRITE}${MOTH.slice(0, rows)
    .map((r) => `"${r}"`)
    .join(",")}${rows ? partial : partial.slice(1)}`;
  return {
    taskId: t.id,
    phase: "writing",
    tokens,
    seconds: Math.round(sec),
    tail: draft.slice(-200),
    draft,
    palette: paletteOf(),
  };
}
