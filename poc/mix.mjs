// After the voiceover: node mix.mjs assets/vo.wav -> out/audio.wav
// The VO leads; the SFX sit about 12 dB under it and duck further while the voice speaks; loudness to -16 LUFS.
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { DURATION, HOLD } from "./timeline.mjs";

const vo = process.argv[2] ?? "assets/vo.wav";
const out = new URL("./out/audio.wav", import.meta.url).pathname;
const sfx = new URL("./out/sfx.wav", import.meta.url).pathname;
const music = new URL("./out/music.wav", import.meta.url).pathname;
const withMusic = existsSync(music) && !process.argv.includes("--no-music");
const TOTAL = (DURATION + HOLD).toFixed(2);
execFileSync(
  "ffmpeg",
  [
    "-y",
    "-loglevel",
    "error",
    "-i",
    vo,
    "-i",
    sfx,
    ...(withMusic ? ["-i", music] : []),
    "-filter_complex",
    [
      `[0:a]aresample=44100,aformat=channel_layouts=mono,adelay=${HOLD * 1000},highpass=f=80,acompressor=threshold=0.1:ratio=3:attack=5:release=120,apad=whole_dur=${TOTAL},asplit=3[vo][key][key2]`,
      "[1:a]aformat=channel_layouts=mono,volume=-15dB[fx]",
      "[fx][key]sidechaincompress=threshold=0.03:ratio=6:attack=10:release=300[duck]",
      ...(withMusic
        ? [
            "[2:a]aformat=channel_layouts=mono,volume=-14dB[mu]",
            "[mu][key2]sidechaincompress=threshold=0.02:ratio=4:attack=40:release=600[mduck]",
            "[vo][duck][mduck]amix=inputs=3:normalize=0:duration=longest[a]",
          ]
        : ["[key2]anullsink", "[vo][duck]amix=inputs=2:normalize=0:duration=longest[a]"]),
    ].join(";"),
    "-map",
    "[a]",
    "-ar",
    "44100",
    out,
  ],
  { stdio: "inherit" },
);
// static gain to -15 LUFS (loudnorm's dynamic mode pumps the quiet opening), then a peak limiter
const raw = `${out}.raw.wav`;
execFileSync("mv", [out, raw]);
const r = require_ebur(raw);
const gain = (-15 - r).toFixed(2);
execFileSync("ffmpeg", ["-y", "-loglevel", "error", "-i", raw, "-af", `volume=${gain}dB,alimiter=limit=0.84:level=false`, "-ar", "44100", out]);
execFileSync("rm", ["-f", raw]);
console.log(`${out} (gain ${gain} dB from ${r} LUFS)`);
function require_ebur(file) {
  const res = require_spawn(file);
  const m = [...res.matchAll(/I:\s+(-?[0-9.]+) LUFS/g)].pop();
  return Number(m[1]);
}
function require_spawn(file) {
  return spawnSync("ffmpeg", ["-hide_banner", "-nostats", "-i", file, "-af", "ebur128", "-f", "null", "-"], { encoding: "utf8" }).stderr;
}
