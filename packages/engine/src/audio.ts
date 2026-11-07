// 8-bit sound effects and the chiptune bed, synthesized (no samples). Ported from the first video's audio.mjs and
// music.mjs with the same arithmetic (Float32Array mixes, one noise seed per render), so the WAVs match byte for byte.
import type { SfxTypeT } from "@pap/schema";

export const SR = 44100;

export type SfxEvent = { t: number; type: string };

/** the keep table that worked with a voiceover: only key beats keep a sound */
export const VOICE_KEEP: Record<string, number> = {
  confirm: 1,
  bump: 2,
  coin: 4,
  join: 2,
  powerup: 2,
  cheer: 1,
  achieve: 3,
  flag: 3,
  fanfare: 1,
  start: 1,
};

/** keep at most keep[type] of each type and never two within minGap s; events are taken in the order given */
export function thinSfx(events: SfxEvent[], keep: Record<string, number> | null, minGap = 0.6) {
  if (!keep) return { kept: events, used: {} as Record<string, number> };
  let lastT = -9;
  const used: Record<string, number> = {};
  const kept: SfxEvent[] = [];
  for (const e of events) {
    if (!keep[e.type] || (used[e.type] ?? 0) >= keep[e.type] || e.t - lastT < minGap) continue;
    used[e.type] = (used[e.type] ?? 0) + 1;
    lastT = e.t;
    kept.push(e);
  }
  return { kept, used };
}

/** Render SFX events (seconds on the scene clock) into a mono mix; hold shifts everything by the opening still. */
export function renderSfx(events: SfxEvent[], { duration, hold }: { duration: number; hold: number }) {
  const N = Math.ceil((duration + hold) * SR) + SR;
  const mix = new Float32Array(N);
  const square = (ph: number, duty = 0.5) => (ph % 1 < duty ? 1 : -1);
  const tri = (ph: number) => 4 * Math.abs((ph % 1) - 0.5) - 1;
  let seed = 1;
  const noise = () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return (seed / 0x7fffffff) * 2 - 1;
  };
  const midi = (n: number) => 440 * 2 ** ((n - 69) / 12);
  type V = {
    wave?: "square" | "tri" | "noise";
    duty?: number;
    notes?: [number | null, number][];
    sweep?: (x: number, d: number) => number;
    dur?: number;
    vol?: number;
    decay?: number;
  };
  function tone(
    i0: number,
    d: number,
    freqAt: (t: number, d: number) => number,
    { wave, duty, vol, decay }: { wave: string; duty: number; vol: number; decay: number },
  ) {
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
      let s: number;
      if (wave === "noise") {
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
  function voice(at: number, { wave = "square", duty = 0.5, notes, sweep, dur, vol = 0.25, decay = 6 }: V) {
    let i0 = Math.round(at * SR);
    if (notes) {
      for (const [n, d] of notes) {
        tone(i0, d, () => (n == null ? 0 : midi(n)), { wave, duty, vol, decay });
        i0 += Math.round(d * SR);
      }
    } else tone(i0, dur!, sweep!, { wave, duty, vol, decay });
  }
  const FX: Record<SfxTypeT, (t: number) => void> = {
    select: (t) =>
      voice(t, {
        notes: [
          [84, 0.05],
          [91, 0.06],
        ],
        duty: 0.25,
        vol: 0.18,
        decay: 8,
      }),
    confirm: (t) =>
      voice(t, {
        notes: [
          [72, 0.06],
          [79, 0.06],
          [84, 0.06],
          [91, 0.14],
        ],
        duty: 0.25,
        vol: 0.2,
        decay: 5,
      }),
    whoosh: (t) => voice(t, { wave: "noise", dur: 0.25, sweep: (x, d) => 3000 + 9000 * (x / d), vol: 0.07, decay: 10 }),
    coin: (t) =>
      voice(t, {
        notes: [
          [83, 0.06],
          [88, 0.22],
        ],
        duty: 0.5,
        vol: 0.17,
        decay: 9,
      }),
    jump: (t) => voice(t, { dur: 0.22, sweep: (x, d) => 220 + 600 * (x / d), duty: 0.25, vol: 0.15, decay: 7 }),
    bump: (t) => {
      voice(t, { wave: "tri", dur: 0.12, sweep: (x) => 130 - x * 300, vol: 0.4, decay: 14 });
      voice(t, { wave: "noise", dur: 0.08, sweep: () => 1500, vol: 0.1, decay: 30 });
    },
    sign: (t) =>
      voice(t, {
        notes: [
          [76, 0.08],
          [81, 0.08],
          [88, 0.16],
        ],
        duty: 0.125,
        vol: 0.14,
        decay: 6,
      }),
    pipe: (t) =>
      voice(t, {
        dur: 0.45,
        sweep: (x, d) => 160 + 300 * Math.abs(Math.sin((x / d) * 12)),
        duty: 0.5,
        vol: 0.13,
        decay: 3,
      }),
    land: (t) => voice(t, { wave: "noise", dur: 0.09, sweep: () => 900, vol: 0.14, decay: 30 }),
    fall: (t) => voice(t, { dur: 0.45, sweep: (x, d) => 1200 - 900 * (x / d), duty: 0.25, vol: 0.09, decay: 2 }),
    join: (t) =>
      voice(t + 0.05, {
        notes: [
          [79, 0.07],
          [83, 0.07],
          [86, 0.07],
          [91, 0.18],
        ],
        duty: 0.5,
        vol: 0.14,
        decay: 4,
      }),
    powerup: (t) => {
      const notes: [number, number][] = [];
      for (let k = 0; k < 10; k++) notes.push([67 + k * 2 + (k % 2) * 5, 0.045]);
      voice(t, { notes, duty: 0.25, vol: 0.16, decay: 1.5 });
    },
    cheer: (t) => {
      voice(t, { wave: "noise", dur: 0.9, sweep: (x) => 4000 + 1500 * Math.sin(x * 40), vol: 0.06, decay: 2.5 });
      voice(t + 0.1, {
        notes: [
          [76, 0.08],
          [79, 0.08],
          [84, 0.2],
        ],
        duty: 0.5,
        vol: 0.1,
        decay: 5,
      });
    },
    block: (t) =>
      voice(t, {
        notes: [
          [69, 0.05],
          [74, 0.08],
        ],
        duty: 0.25,
        vol: 0.12,
        decay: 10,
      }),
    "fanfare-short": (t) => {
      voice(t, {
        notes: [
          [72, 0.1],
          [76, 0.1],
          [79, 0.1],
          [84, 0.3],
        ],
        duty: 0.5,
        vol: 0.14,
        decay: 2,
      });
      voice(t, {
        wave: "tri",
        notes: [
          [48, 0.3],
          [55, 0.3],
        ],
        vol: 0.25,
        decay: 2,
      });
    },
    achieve: (t) => {
      voice(t, {
        notes: [
          [88, 0.07],
          [91, 0.07],
          [96, 0.25],
        ],
        duty: 0.125,
        vol: 0.14,
        decay: 4,
      });
      voice(t + 0.02, { wave: "tri", notes: [[64, 0.39]], vol: 0.18, decay: 4 });
    },
    quest: (t) =>
      voice(t, {
        notes: [
          [69, 0.1],
          [null, 0.04],
          [69, 0.1],
          [76, 0.25],
        ],
        duty: 0.25,
        vol: 0.13,
        decay: 3,
      }),
    flag: (t) =>
      voice(t, {
        notes: [
          [79, 0.06],
          [84, 0.06],
          [88, 0.06],
          [91, 0.06],
          [96, 0.16],
        ],
        duty: 0.5,
        vol: 0.12,
        decay: 4,
      }),
    alarm: (t) => {
      for (let k = 0; k < 3; k++)
        voice(t + k * 0.32, {
          notes: [
            [81, 0.12],
            [76, 0.12],
          ],
          duty: 0.5,
          vol: 0.09,
          decay: 2,
        });
    },
    brick: (t) => {
      voice(t, { wave: "noise", dur: 0.07, sweep: () => 2200, vol: 0.12, decay: 35 });
      voice(t, { wave: "tri", dur: 0.08, sweep: () => 196, vol: 0.25, decay: 25 });
    },
    flagpole: (t) => voice(t, { dur: 1.0, sweep: (x, d) => 300 + 900 * (x / d), duty: 0.25, vol: 0.08, decay: 1 }),
    fanfare: (t) => {
      voice(t, {
        notes: [
          [67, 0.12],
          [72, 0.12],
          [76, 0.12],
          [79, 0.24],
          [76, 0.12],
          [79, 0.5],
        ],
        duty: 0.5,
        vol: 0.14,
        decay: 1.2,
      });
      voice(t, {
        notes: [
          [64, 0.12],
          [67, 0.12],
          [72, 0.12],
          [76, 0.24],
          [72, 0.12],
          [76, 0.5],
        ],
        duty: 0.25,
        vol: 0.08,
        decay: 1.2,
      });
      voice(t, {
        wave: "tri",
        notes: [
          [48, 0.36],
          [53, 0.36],
          [55, 0.5],
        ],
        vol: 0.25,
        decay: 1.2,
      });
    },
    start: (t) =>
      voice(t, {
        notes: [
          [84, 0.08],
          [null, 0.04],
          [84, 0.08],
          [96, 0.3],
        ],
        duty: 0.5,
        vol: 0.15,
        decay: 3,
      }),
  };
  for (const { t, type } of events) FX[type as SfxTypeT]?.(t + hold);
  return mix;
}
export const SFX_TYPES = Object.freeze([
  "select",
  "confirm",
  "whoosh",
  "coin",
  "jump",
  "bump",
  "sign",
  "pipe",
  "land",
  "fall",
  "join",
  "powerup",
  "cheer",
  "block",
  "fanfare-short",
  "achieve",
  "quest",
  "flag",
  "alarm",
  "brick",
  "flagpole",
  "fanfare",
  "start",
]);

/**
 * A calm night chiptune bed (Am - F - C - G at 84 BPM): a soft detuned triangle pad, a quiet 12.5% square arpeggio and
 * a triangle bass. Fades in over the opening hold, lifts for [liftFrom, settleFrom), settles after, fades at the end.
 * Times are on the scene clock (without the hold).
 */
export function renderMusic({
  duration,
  hold,
  liftFrom,
  settleFrom,
}: {
  duration: number;
  hold: number;
  liftFrom?: number;
  settleFrom?: number;
}) {
  const TOTAL = duration + hold;
  const N = Math.ceil(TOTAL * SR);
  const L = new Float32Array(N);
  const BPM = 84;
  const beat = 60 / BPM;
  const bar = beat * 4;
  const midi = (n: number) => 440 * 2 ** ((n - 69) / 12);
  const CHORDS = [
    [57, 60, 64, 69],
    [53, 57, 60, 65],
    [48, 52, 55, 60],
    [55, 59, 62, 67],
  ];
  const tri = (ph: number) => 4 * Math.abs((ph % 1) - 0.5) - 1;
  const sq = (ph: number, d: number) => (ph % 1 < d ? 1 : -1);
  const f0 = (liftFrom ?? Number.POSITIVE_INFINITY) + hold;
  const e0 = (settleFrom ?? Number.POSITIVE_INFINITY) + hold;
  const lift = (t: number) => {
    if (t < f0) return 1;
    if (t < e0) return 1 + 0.35 * Math.min(1, (t - f0) / 2);
    return 1.35 - 0.35 * Math.min(1, (t - e0) / 4);
  };
  const master = (t: number) => Math.min(1, t / hold) * Math.min(1, (TOTAL - t) / 4) * lift(t);
  let lp = 0;
  for (let i = 0; i < N; i++) {
    const t = i / SR;
    const b = Math.floor(t / bar);
    const chord = CHORDS[b % 4];
    const inBar = t - b * bar;
    const swell = Math.min(1, inBar / 0.8) * (0.75 + 0.25 * Math.cos((inBar / bar) * Math.PI * 2));
    let pad = 0;
    for (const n of chord.slice(0, 3)) {
      const f = midi(n);
      pad += tri(t * f) + tri(t * f * 1.004);
    }
    pad *= 0.045 * swell;
    const step = Math.floor(inBar / (beat / 2));
    const note = chord[[0, 1, 2, 3, 2, 1, 2, 3][step % 8]] + 12;
    const ts = inBar - step * (beat / 2);
    const arpRaw = sq(t * midi(note), 0.125) * Math.exp(-ts * 5) * 0.06;
    lp += (arpRaw - lp) * 0.12;
    const bt = inBar % (beat * 2);
    const bass = tri(t * midi(chord[0] - 24)) * Math.exp(-bt * 1.6) * 0.16;
    L[i] = (pad + lp + bass) * master(t);
  }
  const d = Math.round(beat * 0.75 * SR);
  for (let i = d; i < N; i++) L[i] += L[i - d] * 0.28;
  return L;
}

/** 16-bit mono WAV; samples pass through tanh(x * drive) * gain like the originals (sfx 1.2/0.85, music 1.5/0.8) */
export function wav16(samples: Float32Array, drive: number, gain: number): Uint8Array {
  const N = samples.length;
  const out = new Uint8Array(44 + N * 2);
  const dv = new DataView(out.buffer);
  const str = (o: number, s: string) => {
    for (let i = 0; i < s.length; i++) out[o + i] = s.charCodeAt(i);
  };
  str(0, "RIFF");
  dv.setUint32(4, 36 + N * 2, true);
  str(8, "WAVEfmt ");
  dv.setUint32(16, 16, true);
  dv.setUint16(20, 1, true);
  dv.setUint16(22, 1, true);
  dv.setUint32(24, SR, true);
  dv.setUint32(28, SR * 2, true);
  dv.setUint16(32, 2, true);
  dv.setUint16(34, 16, true);
  str(36, "data");
  dv.setUint32(40, N * 2, true);
  for (let i = 0; i < N; i++) dv.setInt16(44 + i * 2, Math.round(Math.tanh(samples[i] * drive) * gain * 32767), true);
  return out;
}
