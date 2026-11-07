// A calm night chiptune bed, synthesized (no samples, no copyright): node music.mjs -> out/music.wav
// Am - F - C - G at 84 BPM: a soft detuned triangle pad, a quiet 12.5% square arpeggio, a triangle bass.
// Fades in over the opening hold, lifts a little for the finale, loops gently through the end card, fades out at the end.
import { writeFileSync } from "node:fs";
import { DURATION, HOLD, SCENES } from "./timeline.mjs";

const SR = 44100;
const TOTAL = DURATION + HOLD;
const N = Math.ceil(TOTAL * SR);
const L = new Float32Array(N);
const BPM = 84;
const beat = 60 / BPM;
const bar = beat * 4;
const midi = (n) => 440 * 2 ** ((n - 69) / 12);
// chords as midi notes (root, third, fifth, octave), one per bar
const CHORDS = [
  [57, 60, 64, 69], // Am
  [53, 57, 60, 65], // F
  [48, 52, 55, 60], // C
  [55, 59, 62, 67], // G
];
const tri = (ph) => 4 * Math.abs((ph % 1) - 0.5) - 1;
const sq = (ph, d) => ((ph % 1) < d ? 1 : -1);

const finale = SCENES.find((s) => s.id === "finale");
const end = SCENES.find((s) => s.id === "end");
const lift = (t) => {
  const f0 = finale.from + HOLD;
  const e0 = end.from + HOLD;
  if (t < f0) return 1;
  if (t < e0) return 1 + 0.35 * Math.min(1, (t - f0) / 2);
  return 1.35 - 0.35 * Math.min(1, (t - e0) / 4);
};
const master = (t) => Math.min(1, t / HOLD) * Math.min(1, (TOTAL - t) / 4) * lift(t);

// one-pole low-pass state for the arpeggio, so the square stays soft
let lp = 0;
for (let i = 0; i < N; i++) {
  const t = i / SR;
  const b = Math.floor(t / bar);
  const chord = CHORDS[b % 4];
  const inBar = t - b * bar;
  // pad: chord tones, two slightly detuned triangles each, slow swell per bar
  const swell = Math.min(1, inBar / 0.8) * (0.75 + 0.25 * Math.cos((inBar / bar) * Math.PI * 2));
  let pad = 0;
  for (const n of chord.slice(0, 3)) {
    const f = midi(n);
    pad += tri(t * f) + tri(t * f * 1.004);
  }
  pad *= 0.045 * swell;
  // arpeggio: eighth notes up the chord, octave up, short decay
  const step = Math.floor(inBar / (beat / 2));
  const note = chord[[0, 1, 2, 3, 2, 1, 2, 3][step % 8]] + 12;
  const ts = inBar - step * (beat / 2);
  const arpRaw = sq(t * midi(note), 0.125) * Math.exp(-ts * 5) * 0.06;
  lp += (arpRaw - lp) * 0.12;
  // bass: root on beats 1 and 3, triangle
  const bt = inBar % (beat * 2);
  const bass = tri(t * midi(chord[0] - 24)) * Math.exp(-bt * 1.6) * 0.16;
  L[i] = (pad + lp + bass) * master(t);
}
// gentle echo for space
const d = Math.round(beat * 0.75 * SR);
for (let i = d; i < N; i++) L[i] += L[i - d] * 0.28;

const pcm = Buffer.alloc(44 + N * 2);
pcm.write("RIFF", 0);
pcm.writeUInt32LE(36 + N * 2, 4);
pcm.write("WAVEfmt ", 8);
pcm.writeUInt32LE(16, 16);
pcm.writeUInt16LE(1, 20);
pcm.writeUInt16LE(1, 22);
pcm.writeUInt32LE(SR, 24);
pcm.writeUInt32LE(SR * 2, 28);
pcm.writeUInt16LE(2, 32);
pcm.writeUInt16LE(16, 34);
pcm.write("data", 36);
pcm.writeUInt32LE(N * 2, 40);
for (let i = 0; i < N; i++) pcm.writeInt16LE(Math.round(Math.tanh(L[i] * 1.5) * 0.8 * 32767), 44 + i * 2);
writeFileSync(new URL("./out/music.wav", import.meta.url).pathname, pcm);
console.log(`out/music.wav ${TOTAL.toFixed(1)} s`);
