// What PAP draws on top of every scene when no code bundle owns the whole frame: the pixel-block dissolve into each
// scene, the fade out at the very end, and the burned-in captions. Same look as the first video.
import { type Engine, rnd } from "./core.ts";

export type ComposeCtx = {
  cues: { text: string; start: number; end: number }[];
  scenes: { id: string; from: number; to: number }[];
  duration: number;
  captions: { enabled: boolean; wrapW: number; pre: number; post: number };
  dissolveIn: number;
  fadeOut: number;
};

/** the scene that owns time t (the last one past the end) */
export const sceneAt = <S extends { from: number; to: number }>(scenes: S[], t: number): S =>
  scenes.find((s) => t >= s.from && t < s.to) ?? scenes[scenes.length - 1];

export function captions(e: Engine, c: ComposeCtx, t: number) {
  if (!c.captions.enabled) return;
  const i = c.cues.findIndex((q) => t >= q.start - c.captions.pre && t <= q.end + c.captions.post);
  if (i < 0) return;
  const lines = e.wrap(c.cues[i].text, c.captions.wrapW);
  const w = Math.max(...lines.map((l) => e.measure(l))) + 10;
  const h = lines.length * 10 + 4;
  const y = e.H - 4 - h;
  e.rect(e.W / 2 - w / 2, y, w, h, "k", 0.82);
  lines.forEach((l, j) => {
    e.text(l, e.W / 2, y + 3 + j * 10, { align: "center", colour: "P" });
  });
}

/** true while t is inside the dissolve into a scene other than the first */
export function dissolving(c: ComposeCtx, t: number) {
  const sc = sceneAt(c.scenes, t);
  return sc !== c.scenes[0] && c.dissolveIn > 0 && t - sc.from < c.dissolveIn;
}

/** dissolve into every scene but the first, fade out at the end. `prev` is the outgoing scene's last frame: its
 * blocks give way to the new scene. Without it the blocks are black, and the cut frame itself is all black. */
export function transitions(e: Engine, c: ComposeCtx, t: number, prev?: Uint8Array) {
  const sc = sceneAt(c.scenes, t);
  const s = t - sc.from;
  if (sc !== c.scenes[0] && c.dissolveIn > 0 && s < c.dissolveIn) {
    for (let by = 0; by < e.H; by += 10)
      for (let bx = 0; bx < e.W; bx += 10) {
        if (rnd(bx * 31 + by * 7) <= s / c.dissolveIn) continue;
        if (!prev) {
          e.rect(bx, by, 10, 10, "k");
          continue;
        }
        for (let y = by; y < Math.min(by + 10, e.H); y++) {
          const i = (y * e.W + bx) * 3;
          e.buf.set(prev.subarray(i, i + Math.min(10, e.W - bx) * 3), i);
        }
      }
  }
  if (c.fadeOut > 0 && t > c.duration - c.fadeOut)
    e.rect(0, 0, e.W, e.H, "k", (t - (c.duration - c.fadeOut)) / c.fadeOut);
}
