// 8-bit sound effects, synthesized (square / triangle / noise with envelopes), placed at the scenes' SFX events.
// node audio.mjs -> out/sfx.wav (44.1 kHz mono 16-bit)
import { writeFileSync } from "node:fs";
import { loadLogos } from "./logos.mjs";
import { init, sfxEvents } from "./scenes.mjs";
import { DURATION, HOLD } from "./timeline.mjs";

const SR = 44100;
const N = Math.ceil((DURATION + HOLD) * SR) + SR;
const mix = new Float32Array(N);

const square = (ph, duty = 0.5) => (ph % 1 < duty ? 1 : -1);
const tri = (ph) => 4 * Math.abs((ph % 1) - 0.5) - 1;
let seed = 1;
const noise = () => {
  seed = (seed * 1103515245 + 12345) & 0x7fffffff;
  return (seed / 0x7fffffff) * 2 - 1;
};
const midi = (n) => 440 * 2 ** ((n - 69) / 12);

/** one voice: notes [[midi, dur], ...] or a frequency sweep */
function voice(at, { wave = "square", duty = 0.5, notes, sweep, dur, vol = 0.25, decay = 6, crush = false }) {
  let i0 = Math.round(at * SR);
  if (notes) {
    for (const [n, d] of notes) {
      tone(i0, d, (t) => (n == null ? 0 : midi(n)), { wave, duty, vol, decay });
      i0 += Math.round(d * SR);
    }
  } else tone(i0, dur, sweep, { wave, duty, vol, decay, crush });
}
function tone(i0, d, freqAt, { wave, duty, vol, decay }) {
  const n = Math.round(d * SR);
  let ph = 0;
  let hold = 0;
  let held = 0;
  for (let i = 0; i < n; i++) {
    const t = i / SR;
    const f = freqAt(t, d);
    if (!f) continue;
    ph += f / SR;
    const env = Math.min(1, i / 60) * Math.exp(-t * decay) * Math.min(1, (n - i) / 200);
    let s;
    if (wave === "noise") {
      // sample-and-hold noise, pitched by f
      hold += f / SR;
      if (hold >= 1) {
        hold %= 1;
        held = noise();
      }
      s = held;
    } else s = wave === "tri" ? tri(ph) : square(ph, duty);
    if (i0 + i < N) mix[i0 + i] += s * vol * env;
  }
}

const FX = {
  select: (t) => voice(t, { notes: [[84, 0.05], [91, 0.06]], duty: 0.25, vol: 0.18, decay: 8 }),
  confirm: (t) => voice(t, { notes: [[72, 0.06], [79, 0.06], [84, 0.06], [91, 0.14]], duty: 0.25, vol: 0.2, decay: 5 }),
  whoosh: (t) => voice(t, { wave: "noise", dur: 0.25, sweep: (x, d) => 3000 + 9000 * (x / d), vol: 0.07, decay: 10 }),
  coin: (t) => voice(t, { notes: [[83, 0.06], [88, 0.22]], duty: 0.5, vol: 0.17, decay: 9 }),
  jump: (t) => voice(t, { dur: 0.22, sweep: (x, d) => 220 + 600 * (x / d), duty: 0.25, vol: 0.15, decay: 7 }),
  bump: (t) => {
    voice(t, { wave: "tri", dur: 0.12, sweep: (x) => 130 - x * 300, vol: 0.4, decay: 14 });
    voice(t, { wave: "noise", dur: 0.08, sweep: () => 1500, vol: 0.1, decay: 30 });
  },
  sign: (t) => voice(t, { notes: [[76, 0.08], [81, 0.08], [88, 0.16]], duty: 0.125, vol: 0.14, decay: 6 }),
  pipe: (t) => voice(t, { dur: 0.45, sweep: (x, d) => 160 + 300 * Math.abs(Math.sin((x / d) * 12)), duty: 0.5, vol: 0.13, decay: 3 }),
  land: (t) => voice(t, { wave: "noise", dur: 0.09, sweep: () => 900, vol: 0.14, decay: 30 }),
  fall: (t) => voice(t, { dur: 0.45, sweep: (x, d) => 1200 - 900 * (x / d), duty: 0.25, vol: 0.09, decay: 2 }),
  join: (t) => voice(t + 0.05, { notes: [[79, 0.07], [83, 0.07], [86, 0.07], [91, 0.18]], duty: 0.5, vol: 0.14, decay: 4 }),
  powerup: (t) => {
    const notes = [];
    for (let k = 0; k < 10; k++) notes.push([67 + k * 2 + (k % 2) * 5, 0.045]);
    voice(t, { notes, duty: 0.25, vol: 0.16, decay: 1.5 });
  },
  cheer: (t) => {
    voice(t, { wave: "noise", dur: 0.9, sweep: (x) => 4000 + 1500 * Math.sin(x * 40), vol: 0.06, decay: 2.5 });
    voice(t + 0.1, { notes: [[76, 0.08], [79, 0.08], [84, 0.2]], duty: 0.5, vol: 0.1, decay: 5 });
  },
  block: (t) => voice(t, { notes: [[69, 0.05], [74, 0.08]], duty: 0.25, vol: 0.12, decay: 10 }),
  "fanfare-short": (t) => {
    voice(t, { notes: [[72, 0.1], [76, 0.1], [79, 0.1], [84, 0.3]], duty: 0.5, vol: 0.14, decay: 2 });
    voice(t, { wave: "tri", notes: [[48, 0.3], [55, 0.3]], vol: 0.25, decay: 2 });
  },
  achieve: (t) => {
    voice(t, { notes: [[88, 0.07], [91, 0.07], [96, 0.25]], duty: 0.125, vol: 0.14, decay: 4 });
    voice(t + 0.02, { wave: "tri", notes: [[64, 0.39]], vol: 0.18, decay: 4 });
  },
  quest: (t) => voice(t, { notes: [[69, 0.1], [null, 0.04], [69, 0.1], [76, 0.25]], duty: 0.25, vol: 0.13, decay: 3 }),
  flag: (t) => voice(t, { notes: [[79, 0.06], [84, 0.06], [88, 0.06], [91, 0.06], [96, 0.16]], duty: 0.5, vol: 0.12, decay: 4 }),
  alarm: (t) => {
    for (let k = 0; k < 3; k++) voice(t + k * 0.32, { notes: [[81, 0.12], [76, 0.12]], duty: 0.5, vol: 0.09, decay: 2 });
  },
  brick: (t) => {
    voice(t, { wave: "noise", dur: 0.07, sweep: () => 2200, vol: 0.12, decay: 35 });
    voice(t, { wave: "tri", dur: 0.08, sweep: () => 196, vol: 0.25, decay: 25 });
  },
  flagpole: (t) => voice(t, { dur: 1.0, sweep: (x, d) => 300 + 900 * (x / d), duty: 0.25, vol: 0.08, decay: 1 }),
  fanfare: (t) => {
    voice(t, { notes: [[67, 0.12], [72, 0.12], [76, 0.12], [79, 0.24], [76, 0.12], [79, 0.5]], duty: 0.5, vol: 0.14, decay: 1.2 });
    voice(t, { notes: [[64, 0.12], [67, 0.12], [72, 0.12], [76, 0.24], [72, 0.12], [76, 0.5]], duty: 0.25, vol: 0.08, decay: 1.2 });
    voice(t, { wave: "tri", notes: [[48, 0.36], [53, 0.36], [55, 0.5]], vol: 0.25, decay: 1.2 });
  },
  start: (t) => voice(t, { notes: [[84, 0.08], [null, 0.04], [84, 0.08], [96, 0.3]], duty: 0.5, vol: 0.15, decay: 3 }),
};

init(await loadLogos());
// with a voiceover, only the key beats keep a sound: at most N of each type, and never two within 0.6 s
const KEEP = process.env.SFX_ALL
  ? null
  : { confirm: 1, bump: 2, coin: 4, join: 2, powerup: 2, cheer: 1, achieve: 3, flag: 3, fanfare: 1, start: 1 };
let lastT = -9;
const used = {};
for (const { t, type } of sfxEvents()) {
  if (KEEP) {
    if (!KEEP[type] || (used[type] ?? 0) >= KEEP[type] || t - lastT < 0.6) continue;
    used[type] = (used[type] ?? 0) + 1;
    lastT = t;
  }
  FX[type]?.(t + HOLD);
}
console.error(`sfx kept: ${JSON.stringify(used)}`);

// soft limiter + 16-bit WAV
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
for (let i = 0; i < N; i++) pcm.writeInt16LE(Math.round(Math.tanh(mix[i] * 1.2) * 0.85 * 32767), 44 + i * 2);
const out = new URL("./out/sfx.wav", import.meta.url).pathname;
writeFileSync(out, pcm);
console.log(out);
