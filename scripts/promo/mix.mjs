// The promo's sound: the score with the UI effects placed on the picture's moments, as one WAV, plus the score's
// loudness per frame (envelope.json) for the bars in the sound shot.
//
//   node scripts/promo/mix.mjs --audio <work>/audio
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";

const { values: o } = parseArgs({ options: { audio: { type: "string" } } });
const A = o.audio;
const sfx = (f) => join(A, "sfx", `${f}.wav`);

// [file, start s, gain dB]
const events = [
  ["card", 10.2, -4],
  ["card", 10.55, -6],
  ["blip", 10.95, -4],
  ["whoosh-pullback", 14.0, -6],
  ["whoosh", 25.3, -8],
  ["card", 29.15, -6],
  ...Array.from({ length: 6 }, (_, i) => ["blip", 34.4 + i * 0.1, -10]),
  ...[38, 40, 42, 44, 46].map((t) => ["whoosh", t - 0.15, -10]),
  ["whoosh", 51.9, -9],
  ["whoosh", 54.3, -9],
  ["whoosh", 55.95, -9],
  ["whoosh", 58.2, -11],
  ["whoosh", 58.95, -11],
  ["card", 70.9, -5],
  ["blip", 80.85, -4],
  ["whoosh-pushin", 84.0, -6],
  ...Array.from({ length: 17 }, (_, i) => [`type-${(i % 3) + 1}`, 90.0 + i * 0.053, -6]),
];

const inputs = ["-i", join(A, "score.wav"), ...events.flatMap(([f]) => ["-i", sfx(f)])];
const chains = events.map(
  ([, t, g], i) => `[${i + 1}:a]adelay=${Math.round(t * 1000)}|${Math.round(t * 1000)},volume=${g}dB[e${i}]`,
);
const filter = `${chains.join(";")};[0:a]${events.map((_, i) => `[e${i}]`).join("")}amix=inputs=${events.length + 1}:normalize=0:duration=first,volume=-1dB,alimiter=limit=0.8:attack=1:release=60:level=disabled[out]`;
const out = join(A, "mix.wav");
const r = spawnSync(
  "ffmpeg",
  [
    "-loglevel",
    "error",
    "-y",
    ...inputs,
    "-filter_complex",
    filter,
    "-map",
    "[out]",
    "-ar",
    "48000",
    "-c:a",
    "pcm_s16le",
    out,
  ],
  { stdio: "inherit" },
);
if (r.status !== 0) throw new Error("ffmpeg mix failed");

// the score's RMS per frame (30 fps), 0..1, from the 16-bit WAV's data chunk
const buf = readFileSync(join(A, "score.wav"));
let p = 12;
let data = null;
let ch = 2;
while (p < buf.length) {
  const id = buf.toString("ascii", p, p + 4);
  const size = buf.readUInt32LE(p + 4);
  if (id === "fmt ") ch = buf.readUInt16LE(p + 10);
  if (id === "data") data = buf.subarray(p + 8, p + 8 + size);
  p += 8 + size + (size % 2);
}
const SR = 48000;
const per = SR / 30;
const frames = Math.floor(data.length / 2 / ch / per);
const rms = [];
for (let f = 0; f < frames; f++) {
  let s = 0;
  for (let i = 0; i < per; i++) {
    const k = (f * per + i) * ch;
    const v = (data.readInt16LE(k * 2) + data.readInt16LE((k + 1) * 2)) / 65536;
    s += v * v;
  }
  rms.push(Number(Math.sqrt(s / per).toFixed(4)));
}
writeFileSync(join(A, "envelope.json"), JSON.stringify({ fps: 30, rms }));
console.log(`${out}, ${events.length} effects; envelope ${rms.length} frames`);
