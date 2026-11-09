// The shorter cuts: renders the chosen ranges of the promo (each on a bar line, so the music joins on the beat) and
// joins picture and sound.
//
//   node scripts/promo/cut.mjs --work <dir> --mix <wav> --out <mp4> --ranges 0-24,66-76,84-92
//                              [--w 1920 --h 1080 --format wide|tall]
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";

const { values: o } = parseArgs({
  options: {
    work: { type: "string" },
    mix: { type: "string" },
    out: { type: "string" },
    ranges: { type: "string" },
    w: { type: "string", default: "1920" },
    h: { type: "string", default: "1080" },
    format: { type: "string", default: "wide" },
    crf: { type: "string", default: "16" },
  },
});
const ranges = o.ranges.split(",").map((r) => r.split("-").map(Number));
const tmp = resolve(o.work, "cuts", String(Date.now()));
mkdirSync(tmp, { recursive: true });
const here = new URL(".", import.meta.url).pathname;
const run = (cmd, args) => {
  const r = spawnSync(cmd, args, { stdio: "inherit" });
  if (r.status !== 0) throw new Error(`${cmd} failed`);
};

// the picture: one silent piece per range, then joined without re-encoding
const parts = ranges.map(([a, b], i) => {
  const f = join(tmp, `v${i}.mp4`);
  run("node", [
    join(here, "compose.mjs"),
    "--work",
    o.work,
    "--out",
    f,
    "--from",
    String(a),
    "--to",
    String(b),
    "--w",
    o.w,
    "--h",
    o.h,
    "--format",
    o.format,
    "--crf",
    o.crf,
  ]);
  return f;
});
writeFileSync(join(tmp, "list.txt"), parts.map((f) => `file '${f}'`).join("\n"));
run("ffmpeg", [
  "-loglevel",
  "error",
  "-y",
  "-f",
  "concat",
  "-safe",
  "0",
  "-i",
  join(tmp, "list.txt"),
  "-c",
  "copy",
  join(tmp, "video.mp4"),
]);

// the sound: the same ranges of the mix, each with a 10 ms fade at its joins, then a 1 s fade at the very end
const filters = ranges
  .map(
    ([a, b], i) =>
      `[0:a]atrim=${a}:${b},asetpts=PTS-STARTPTS,afade=t=in:d=0.01,afade=t=out:st=${b - a - 0.01}:d=0.01[a${i}]`,
  )
  .join(";");
const total = ranges.reduce((s, [a, b]) => s + b - a, 0);
run("ffmpeg", [
  "-loglevel",
  "error",
  "-y",
  "-i",
  o.mix,
  "-filter_complex",
  `${filters};${ranges.map((_, i) => `[a${i}]`).join("")}concat=n=${ranges.length}:v=0:a=1,afade=t=out:st=${total - 1}:d=1[out]`,
  "-map",
  "[out]",
  join(tmp, "audio.wav"),
]);
run("ffmpeg", [
  "-loglevel",
  "error",
  "-y",
  "-i",
  join(tmp, "video.mp4"),
  "-i",
  join(tmp, "audio.wav"),
  "-c:v",
  "copy",
  "-c:a",
  "aac",
  "-b:a",
  "256k",
  "-shortest",
  "-movflags",
  "+faststart",
  o.out,
]);
console.log(`${o.out} (${total} s)`);
