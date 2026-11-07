// Encode a project to MP4 (nearest-neighbour upscale keeps every pixel crisp), still PNGs, contact sheets, and the
// golden-frame check that proves a refactor changed nothing.
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import type { LoadedProject } from "./project.ts";
import { FPS, frameCount, H, type Renderer, W } from "./renderer.ts";
import { encodePng } from "./vendor/png.mjs";

export function upscale(src: Uint8Array, k: number, w = W, h = H): Buffer {
  const out = Buffer.alloc(w * k * h * k * 3);
  for (let y = 0; y < h * k; y++)
    for (let x = 0; x < w * k; x++) {
      const si = (Math.floor(y / k) * w + Math.floor(x / k)) * 3;
      const di = (y * w * k + x) * 3;
      out[di] = src[si];
      out[di + 1] = src[si + 1];
      out[di + 2] = src[si + 2];
    }
  return out;
}

export const png = (rgb: Uint8Array, scale = 4): Buffer => encodePng(W * scale, H * scale, upscale(rgb, scale));

export async function still(r: Renderer, t: number, scale = 4) {
  return png(await r.frame(t), scale);
}

/** one still every `every` seconds, laid out in `cols` columns at 1x */
export async function contactSheet(r: Renderer, { every = 1, cols = 6 } = {}) {
  const n = Math.ceil(r.project.timeline.duration / every);
  const rows = Math.ceil(n / cols);
  const sheet = Buffer.alloc(W * cols * H * rows * 3);
  for (let i = 0; i < n; i++) {
    const f = await r.frame(i * every + every / 2);
    const ox = (i % cols) * W;
    const oy = Math.floor(i / cols) * H;
    for (let y = 0; y < H; y++) f.copy(sheet, ((oy + y) * W * cols + ox) * 3, y * W * 3, (y + 1) * W * 3);
  }
  return encodePng(W * cols, H * rows, sheet) as Buffer;
}

export async function encode(
  r: Renderer,
  {
    out,
    scale = 6,
    crf = 16,
    audio,
    onProgress,
  }: { out: string; scale?: number; crf?: number; audio?: string; onProgress?: (f: number) => void },
) {
  const { duration, hold } = r.project.timeline;
  const args = [
    "-y",
    "-loglevel",
    "error",
    "-f",
    "rawvideo",
    "-pix_fmt",
    "rgb24",
    "-s",
    `${W}x${H}`,
    "-r",
    String(FPS),
    "-i",
    "-",
  ];
  const withAudio = audio && existsSync(audio);
  if (withAudio) args.push("-i", audio);
  args.push(
    "-vf",
    `scale=${W * scale}:${H * scale}:flags=neighbor`,
    "-c:v",
    "libx264",
    "-preset",
    "slow",
    "-crf",
    String(crf),
    "-tune",
    "animation",
    "-pix_fmt",
    "yuv420p",
    "-r",
    String(FPS),
  );
  if (withAudio) args.push("-af", "apad", "-c:a", "aac", "-b:a", "192k", "-t", String(duration + hold));
  args.push("-map_metadata", "-1", "-movflags", "+faststart", out);
  const ff = spawn("ffmpeg", args, { stdio: ["pipe", "inherit", "inherit"] });
  const n = frameCount(duration, hold);
  await r.frames(0, n, async (f, i) => {
    if (!ff.stdin.write(f)) await new Promise((res) => ff.stdin.once("drain", res));
    if (i % 30 === 0) onProgress?.(i / n);
  });
  ff.stdin.end();
  const code: number = await new Promise((res) => ff.on("close", res));
  if (code !== 0) throw new Error(`ffmpeg exited ${code}`);
  return { out, frames: n, seconds: duration + hold };
}

export type Golden = { frames: number; combined: string; hashes: string[]; audio?: Record<string, string> };

/** render every frame and compare its sha256 with the golden file; returns the first mismatches */
export async function checkGolden(r: Renderer, golden: Golden) {
  const { duration, hold } = r.project.timeline;
  const n = frameCount(duration, hold);
  const bad: number[] = [];
  const all = createHash("sha256");
  await r.frames(0, n, (f, i) => {
    const h = createHash("sha256").update(f).digest("hex");
    all.update(h);
    if (h !== golden.hashes[i]) bad.push(i);
  });
  return {
    frames: n,
    expected: golden.frames,
    combined: all.digest("hex"),
    ok: n === golden.frames && !bad.length,
    bad: bad.slice(0, 20),
    mismatches: bad.length,
  };
}

export const sha256File = (f: string) => createHash("sha256").update(readFileSync(f)).digest("hex");
export type { LoadedProject };
