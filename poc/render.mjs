// node render.mjs                 -> out/video.mp4 (with out/audio.wav or out/sfx.wav if present)
// node render.mjs --preview 2,5.5 -> out/preview-<t>.png stills (x4)
// node render.mjs --contact       -> out/contact.png, one still per second
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { encodePng } from "../vendor/painter/png.mjs";
import { buf, H, W } from "./engine.mjs";
import { loadLogos } from "./logos.mjs";
import { draw, init } from "./scenes.mjs";
import { DURATION, HOLD } from "./timeline.mjs";

const FPS = 30;
const OUT = new URL("./out/", import.meta.url).pathname;
mkdirSync(OUT, { recursive: true });
init(await loadLogos());

const arg = (n) => {
  const i = process.argv.indexOf(`--${n}`);
  return i < 0 ? null : (process.argv[i + 1] ?? "");
};

function upscale(src, w, h, k) {
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

const preview = arg("preview");
if (preview) {
  for (const t of preview.split(",").map(Number)) {
    draw(t);
    writeFileSync(`${OUT}preview-${t}.png`, encodePng(W * 4, H * 4, upscale(buf, W, H, 4)));
    console.log(`${OUT}preview-${t}.png`);
  }
  process.exit(0);
}
if (process.argv.includes("--contact")) {
  const n = Math.ceil(DURATION);
  const cols = 6;
  const rows = Math.ceil(n / cols);
  const sheet = Buffer.alloc(W * cols * H * rows * 3);
  for (let i = 0; i < n; i++) {
    draw(i + 0.5);
    const ox = (i % cols) * W;
    const oy = Math.floor(i / cols) * H;
    for (let y = 0; y < H; y++) buf.copy(sheet, ((oy + y) * W * cols + ox) * 3, y * W * 3, (y + 1) * W * 3);
  }
  writeFileSync(`${OUT}contact.png`, encodePng(W * cols, H * rows, sheet));
  console.log(`${OUT}contact.png`);
  process.exit(0);
}

const audio = [`${OUT}audio.wav`, `${OUT}sfx.wav`].find(existsSync);
const out = `${OUT}${arg("out") ?? "video.mp4"}`;
const args = ["-y", "-loglevel", "error", "-f", "rawvideo", "-pix_fmt", "rgb24", "-s", `${W}x${H}`, "-r", String(FPS), "-i", "-"];
if (audio) args.push("-i", audio);
args.push(
  "-vf",
  process.argv.includes("--4k") ? "scale=3840:2160:flags=neighbor" : "scale=1920:1080:flags=neighbor",
  "-c:v",
  "libx264",
  "-preset",
  "slow",
  "-crf",
  process.env.CRF ?? "16",
  "-tune",
  "animation",
  "-pix_fmt",
  "yuv420p",
  "-r",
  String(FPS),
);
if (audio) args.push("-af", "apad", "-c:a", "aac", "-b:a", "192k", "-t", String(DURATION + HOLD));
args.push("-map_metadata", "-1", "-movflags", "+faststart", out);
const ff = spawn("ffmpeg", args, { stdio: ["pipe", "inherit", "inherit"] });
const frames = Math.round((DURATION + HOLD) * FPS);
for (let i = 0; i < frames; i++) {
  draw(Math.max(0, i / FPS - HOLD));
  if (!ff.stdin.write(Buffer.from(buf))) await new Promise((r) => ff.stdin.once("drain", r));
}
ff.stdin.end();
await new Promise((r) => ff.on("close", r));
console.log(`${out} (${frames} frames, ${(DURATION + HOLD).toFixed(1)} s${audio ? `, audio ${audio.split("/").pop()}` : ""})`);
