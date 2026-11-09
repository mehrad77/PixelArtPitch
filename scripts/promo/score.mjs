#!/usr/bin/env node
// The promo's score: a ~92 s chiptune keynote track, synthesized (no samples, no dependencies), plus hits.json and
// a few UI sound effects. Every time comes from timing.json: the grid (bpm), the sections and their notes, the
// shots' hit, pullBack and pushIn. Same voices as packages/engine/src/audio.ts (pulse, triangle, noise), but band-
// limited pulses, 48 kHz stereo, a four-on-the-floor kit, sidechain ducking, delay and reverb.
//
//   node scripts/promo/score.mjs [--out <dir>]
//
// Writes <out>/score.wav, <out>/hits.json and <out>/sfx/*.wav (default out: ../pap-promo-work/audio next to the repo).
// Deterministic: the same timing.json gives the same bytes.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const argOut = process.argv.indexOf("--out");
const OUT = argOut >= 0 ? resolve(process.argv[argOut + 1]) : resolve(HERE, "../../../pap-promo-work/audio");

// ---------------------------------------------------------------- timing
const T = JSON.parse(readFileSync(join(HERE, "timing.json"), "utf8"));
const SR = 48000;
const BPM = T.bpm;
const BEAT = 60 / BPM;
const BAR = BEAT * 4;
const DUR = T.duration;
const N = Math.round(DUR * SR);
const FPS = T.fps;
const S = (t) => Math.round(t * SR);

const fail = (m) => {
  throw new Error(`score: ${m}`);
};
const shot = (id) => T.shots.find((s) => s.id === id) ?? fail(`no shot "${id}" in timing.json`);
const SECTIONS = T.music.sections;
const section = (energy) => SECTIONS.find((s) => s.energy === energy) ?? fail(`no "${energy}" section`);
const grab = (energy, re, what) => {
  const m = section(energy).note.match(re);
  if (!m) fail(`can't read ${what} from the "${energy}" note: "${section(energy).note}"`);
  return m;
};
const onBeat = (t, what) => {
  const k = t / BEAT;
  if (Math.abs(k - Math.round(k)) > 1e-9) fail(`${what} (${t} s) is not on a beat`);
  return t;
};
const onBar = (t, what) => {
  const k = t / BAR;
  if (Math.abs(k - Math.round(k)) > 1e-9) fail(`${what} (${t} s) is not on a bar line`);
  return t;
};

// sections: contiguous, on bar lines, cover the whole video
SECTIONS.forEach((s, i) => {
  onBar(s.from, `section ${i} start`);
  onBar(s.to, `section ${i} end`);
  if (i === 0 && s.from !== 0) fail("the first section must start at 0");
  if (i > 0 && SECTIONS[i - 1].to !== s.from) fail(`section ${i} doesn't start where ${i - 1} ends`);
});
if (SECTIONS.at(-1).to !== DUR) fail("the last section must end at duration");

// the structured fields first, the notes only for what has no field
const HIT = onBeat(shot("title").hit, "the title hit");
if (+grab("hit", /big hit at ([\d.]+)/, "the hit")[1] !== HIT) fail("the hit note and shots.title.hit disagree");
if (section("hit").from !== HIT) fail("the hit section must start on the hit");
const KIT = onBeat(+grab("hit", /full kit from ([\d.]+)/, "the full-kit time")[1], "full kit");
const GAP0 = onBeat(+grab("riser", /silence at ([\d.]+)/, "the silence")[1], "the silence");
const gapBeats = grab("riser", /(one|two|half a) beats? of silence/, "the silence length")[1];
const GAP1 = GAP0 + { one: 1, two: 2, "half a": 0.5 }[gapBeats] * BEAT;
if (GAP1 !== section("riser").to) fail("the silence must end where the riser section ends");
const PULLBACK = shot("break").pullBack ?? fail("no pullBack on the break shot");
const PUSHIN = shot("finale").pushIn ?? fail("no pushIn on the finale shot");
const RISER0 = onBeat(PULLBACK[0], "pull-back start");
const STABS = grab("stabs", /at ([\d.]+(?:\s*,\s*[\d.]+)*)/, "the stab times")[1]
  .split(",")
  .map((x, i) => onBeat(+x.trim(), `stab ${i + 1}`));
const CLAIMS = shot("claims").lines;
if (STABS.length !== CLAIMS.length) fail(`${STABS.length} stabs for ${CLAIMS.length} claims`);
const FANFARE = onBeat(+grab("outro", /fanfare[^\d]*at ([\d.]+)/, "the fanfare time")[1], "the fanfare");
for (const [t, what] of [
  [KIT, "full kit"],
  [GAP0, "silence"],
  ...STABS.map((t) => [t, "a stab"]),
  [FANFARE, "the fanfare"],
]) {
  const s = SECTIONS.find((x) => t >= x.from && t < x.to);
  if (!s) fail(`${what} at ${t} s is outside every section`);
}
const GS0 = S(GAP0);
const GS1 = S(GAP1);
// a breath before the first claim: when it opens the stabs section, the beat before it is cut to zero (an echo of
// the silence before the title)
const DROP = STABS[0] === section("stabs").from ? [STABS[0] - BEAT, STABS[0]] : null;

// ---------------------------------------------------------------- harmony (A major)
const midi = (n) => 440 * 2 ** ((n - 69) / 12);
const CH = {
  A: { root: 45, tones: [57, 61, 64] },
  E: { root: 40, tones: [56, 59, 64] },
  Fsm: { root: 42, tones: [57, 61, 66] },
  D: { root: 38, tones: [57, 62, 66] },
  Bm: { root: 47, tones: [59, 62, 66] },
};
const SCALE = [9, 11, 1, 2, 4, 6, 8]; // A B C# D E F# G#
const third = (m) => {
  // the diatonic third below m
  let x = m - 1;
  let steps = 0;
  while (steps < 2) {
    if (SCALE.includes(((x % 12) + 12) % 12)) steps++;
    if (steps < 2) x--;
  }
  return x;
};

// ---------------------------------------------------------------- buses
const DRY_L = new Float32Array(N);
const DRY_R = new Float32Array(N);
const DUCK_L = new Float32Array(N); // bass, arp, chords: pumped by the kick
const DUCK_R = new Float32Array(N);
const DLY = new Float32Array(N); // mono sends
const REV = new Float32Array(N);
const KICKS = []; // { t, depth } for the sidechain

const panLR = (p) => {
  const a = ((p + 1) * Math.PI) / 4;
  return [Math.cos(a) * Math.SQRT2, Math.sin(a) * Math.SQRT2];
};
const bus = (name) => (name === "duck" ? [DUCK_L, DUCK_R] : [DRY_L, DRY_R]);
// nothing that starts before the silence may sound inside it or after it
const limitOf = (i0) => (i0 < GS0 ? GS0 : N);

let seedState = 0x2f6e2b1;
const rand = () => {
  seedState = (seedState * 1103515245 + 12345) & 0x7fffffff;
  return (seedState / 0x7fffffff) * 2 - 1;
};
const blep = (t, dt) => {
  if (t < dt) {
    t /= dt;
    return t + t - t * t - 1;
  }
  if (t > 1 - dt) {
    t = (t - 1) / dt;
    return t * t + t + t + 1;
  }
  return 0;
};
const triW = (ph) => 4 * Math.abs(ph - 0.5) - 1;

/** one tonal note: band-limited pulse, triangle or sine, ADSR + exponential decay, vibrato, one-pole low-pass */
function voice(o) {
  const {
    t,
    dur,
    freq,
    wave = "pulse",
    duty = 0.5,
    vol = 0.1,
    a = 0.004,
    d = 0.08,
    s = 0.7,
    r = 0.05,
    decay = 0,
    pan = 0,
    to = "dry",
    dly = 0,
    rev = 0,
    vib = 0,
    vibDelay = 0.15,
    vibRate = 5.5,
    lp = 0,
    cents = 0,
  } = o;
  const i0 = S(t);
  const nOn = Math.round(dur * SR);
  const n = nOn + Math.round(r * SR);
  const lim = limitOf(i0);
  const [gl, gr] = panLR(pan);
  const [BL, BR] = bus(to);
  const lpk = lp ? 1 - Math.exp((-2 * Math.PI * lp) / SR) : 0;
  const mean = wave === "pulse" ? 2 * duty - 1 : 0;
  const detune = 2 ** (cents / 1200);
  let ph = wave === "tri" ? 0.25 : 0;
  let lps = 0;
  for (let i = 0; i < n; i++) {
    const j = i0 + i;
    if (j >= lim) break;
    if (j < 0) continue;
    const lt = i / SR;
    let env = lt < a ? lt / a : lt < a + d ? 1 - ((1 - s) * (lt - a)) / d : s;
    if (decay) env *= Math.exp(-lt * decay);
    if (i >= nOn) env *= 1 - (i - nOn) / (n - nOn);
    env *= Math.min(1, (lim - j) / 96);
    let f = (typeof freq === "function" ? freq(lt) : freq) * detune;
    if (vib && lt > vibDelay)
      f *=
        2 ** ((vib / 1200) * Math.sin(2 * Math.PI * vibRate * (lt - vibDelay)) * Math.min(1, (lt - vibDelay) / 0.25));
    const dt = f / SR;
    ph += dt;
    ph -= Math.floor(ph);
    let x;
    if (wave === "pulse") x = (ph < duty ? 1 : -1) + blep(ph, dt) - blep((ph + 1 - duty) % 1, dt) - mean;
    else if (wave === "tri") x = triW(ph);
    else x = Math.sin(2 * Math.PI * ph);
    if (lpk) {
      lps += (x - lps) * lpk;
      x = lps;
    }
    const y = x * env * vol;
    BL[j] += y * gl;
    BR[j] += y * gr;
    if (dly) DLY[j] += y * dly;
    if (rev) REV[j] += y * rev;
  }
}

/** a noise burst: white (LCG) or the NES short-mode LFSR (metallic), clocked at `rate`, through high/low one-poles */
function noise(o) {
  const {
    t,
    dur,
    env,
    vol = 0.1,
    rate = SR,
    short = false,
    hp = 0,
    lp = 0,
    pan = 0,
    to = "dry",
    rev = 0,
    dly = 0,
    seed = 1,
  } = o;
  const i0 = S(t);
  const n = Math.round(dur * SR);
  const lim = limitOf(i0);
  const [gl, gr] = panLR(pan);
  const [BL, BR] = bus(to);
  let reg = seed & 0x7fff || 1;
  let lcg = seed * 7919 + 1;
  let acc = 1;
  let held = 0;
  let h1 = 0;
  let h2 = 0;
  let l1 = 0;
  for (let i = 0; i < n; i++) {
    const j = i0 + i;
    if (j >= lim) break;
    if (j < 0) continue;
    const lt = i / SR;
    acc += (typeof rate === "function" ? rate(lt) : rate) / SR;
    while (acc >= 1) {
      acc -= 1;
      if (short) {
        const bit = (reg ^ (reg >> 6)) & 1;
        reg = (reg >> 1) | (bit << 14);
        held = reg & 1 ? -1 : 1;
      } else {
        lcg = (lcg * 1103515245 + 12345) & 0x7fffffff;
        held = (lcg / 0x7fffffff) * 2 - 1;
      }
    }
    let x = held;
    const hpf = typeof hp === "function" ? hp(lt) : hp;
    if (hpf) {
      const k = 1 - Math.exp((-2 * Math.PI * hpf) / SR);
      h1 += (x - h1) * k;
      x -= h1;
      h2 += (x - h2) * k;
      x -= h2;
    }
    const lpf = typeof lp === "function" ? lp(lt) : lp;
    if (lpf) {
      l1 += (x - l1) * (1 - Math.exp((-2 * Math.PI * lpf) / SR));
      x = l1;
    }
    const y = x * env(lt) * vol * Math.min(1, (lim - j) / 96);
    BL[j] += y * gl;
    BR[j] += y * gr;
    if (rev) REV[j] += y * rev;
    if (dly) DLY[j] += y * dly;
  }
}

// ---------------------------------------------------------------- drums
let drumSeed = 11;
const nextSeed = () => (drumSeed = (drumSeed * 48271) % 0x7fffffff);

function kick(t, v = 1, duck = 0.55) {
  const i0 = S(t);
  const lim = limitOf(i0);
  const n = Math.round(0.5 * SR);
  let ph = 0;
  for (let i = 0; i < n; i++) {
    const j = i0 + i;
    if (j >= lim) break;
    const lt = i / SR;
    const f = 46 + 135 * Math.exp(-lt / 0.028);
    ph += f / SR;
    ph -= Math.floor(ph);
    const amp = Math.min(1, lt / 0.0015) * Math.exp(-lt / 0.21) * v * Math.min(1, (lim - j) / 96);
    const click = lt < 0.005 ? rand() * (1 - lt / 0.005) * 0.3 : 0;
    const y = (Math.sin(2 * Math.PI * ph) * 0.85 + triW(ph) * 0.22 + click) * amp * 0.95;
    DRY_L[j] += y;
    DRY_R[j] += y;
  }
  if (duck) KICKS.push({ t, depth: duck });
}
function snare(t, v = 1, pan = 0.05) {
  voice({
    t,
    dur: 0.12,
    freq: (lt) => 150 + 60 * Math.exp(-lt / 0.02),
    wave: "tri",
    vol: 0.32 * v,
    a: 0.001,
    s: 1,
    d: 0,
    decay: 22,
    r: 0.02,
    pan,
  });
  noise({
    t,
    dur: 0.3,
    env: (lt) => Math.exp(-lt / 0.075),
    vol: 0.42 * v,
    hp: 1400,
    lp: 9000,
    pan,
    rev: 0.22,
    seed: nextSeed(),
  });
  noise({ t, dur: 0.1, env: (lt) => Math.exp(-lt / 0.03), vol: 0.1 * v, rate: 9000, short: true, pan, seed: 77 });
}
function hat(t, v = 1, open = false, pan = 0.3) {
  const tau = open ? 0.1 : 0.016;
  noise({
    t,
    dur: open ? 0.4 : 0.08,
    env: (lt) => Math.exp(-lt / tau),
    vol: 0.2 * v,
    hp: 7000,
    pan,
    seed: nextSeed(),
    rev: open ? 0.05 : 0,
  });
  noise({
    t,
    dur: open ? 0.3 : 0.05,
    env: (lt) => Math.exp(-lt / tau),
    vol: 0.035 * v,
    rate: 40000,
    short: true,
    hp: 5000,
    pan,
    seed: 3,
  });
}
function crash(t, v = 1, len = 2.6) {
  for (const [pan, seed] of [
    [-0.6, nextSeed()],
    [0.6, nextSeed()],
  ])
    noise({
      t,
      dur: len,
      env: (lt) => Math.min(1, lt / 0.002) * (0.35 * Math.exp(-lt / 0.05) + 0.65 * Math.exp(-lt / (len / 4))),
      vol: 0.2 * v,
      hp: 3500,
      pan,
      rev: 0.25,
      seed,
    });
  noise({
    t,
    dur: len * 0.6,
    env: (lt) => Math.exp(-lt / (len / 6)),
    vol: 0.03 * v,
    rate: 30000,
    short: true,
    hp: 4000,
    seed: 5,
  });
}
function tom(t, f0, v = 1, pan = 0) {
  voice({
    t,
    dur: 0.2,
    freq: (lt) => f0 * (0.62 + 0.38 * Math.exp(-lt / 0.05)),
    wave: "tri",
    vol: 0.42 * v,
    a: 0.001,
    d: 0,
    s: 1,
    decay: 11,
    r: 0.03,
    pan,
    rev: 0.12,
  });
  noise({ t, dur: 0.05, env: (lt) => Math.exp(-lt / 0.012), vol: 0.12 * v, hp: 900, pan, seed: nextSeed() });
}
function boom(t, rootMidi, v = 1, len = 1.8) {
  // a sub drop under the big hits
  const f0 = midi(rootMidi + 12);
  const f1 = midi(rootMidi - 12);
  voice({
    t,
    dur: len,
    freq: (lt) => f1 + (f0 - f1) * Math.exp(-lt / 0.09),
    wave: "sine",
    vol: 0.36 * v,
    a: 0.002,
    d: 0,
    s: 1,
    decay: 1.6,
    r: 0.1,
  });
  voice({
    t,
    dur: len * 0.6,
    freq: (lt) => f1 + (f0 - f1) * Math.exp(-lt / 0.09),
    wave: "tri",
    vol: 0.12 * v,
    a: 0.002,
    d: 0,
    s: 1,
    decay: 2.5,
    r: 0.1,
  });
}
/** a roll ending at `end`, in segments [beats, hits per beat], with a crescendo from v0 to v1 */
function roll(end, segs, v0, v1) {
  const total = segs.reduce((n, [b]) => n + b, 0);
  let t = end - total * BEAT;
  const t0 = t;
  for (const [beats, per] of segs) {
    const step = BEAT / per;
    for (let k = 0; k < beats * per; k++, t += step) {
      const x = (t - t0) / (total * BEAT);
      snare(t, v0 + (v1 - v0) * x * x, k % 2 ? 0.15 : -0.15);
    }
  }
}

// ---------------------------------------------------------------- instruments
const N8 = BAR / 8;
const N16 = BAR / 16;

function lead(t, m, len, v = 1, o = {}) {
  for (const [cents, pan] of [
    [-5, -0.22],
    [5, 0.22],
  ])
    voice({
      t,
      dur: len,
      freq: midi(m),
      duty: 0.25,
      vol: 0.075 * v,
      a: 0.004,
      d: 0.12,
      s: 0.72,
      r: 0.07,
      pan,
      cents,
      lp: 5200,
      vib: 14,
      vibDelay: 0.14,
      dly: 0.2,
      rev: 0.12,
      ...o,
    });
}
function harmony(t, m, len, v = 1) {
  voice({
    t,
    dur: len,
    freq: midi(third(m)),
    duty: 0.125,
    vol: 0.038 * v,
    a: 0.004,
    d: 0.1,
    s: 0.7,
    r: 0.06,
    pan: 0.45,
    lp: 4500,
    vib: 10,
    dly: 0.12,
    rev: 0.1,
  });
}
function triLead(t, m, len, v = 1) {
  voice({
    t,
    dur: len,
    freq: midi(m),
    wave: "tri",
    vol: 0.2 * v,
    a: 0.008,
    d: 0.1,
    s: 0.85,
    r: 0.08,
    pan: -0.3,
    vib: 9,
    vibDelay: 0.2,
    rev: 0.08,
  });
}
function playLine(b, bars, fn) {
  // bars: [[step8, midi, len8], ...] per bar, cycled; fn(t, midi, lenSeconds)
  if (!bars) return;
  for (const [st, m, len] of bars) fn(b * BAR + st * N8, m, len * N8 - 0.02);
}
function arp(t0, t1, chord, { duty = 0.125, v = 1, up = 12, to = "duck", pattern = [0, 1, 2, 3, 2, 1, 2, 3] } = {}) {
  const tones = [...chord.tones.map((x) => x + up), chord.tones[0] + up + 12];
  let k = Math.round(t0 / N16);
  for (let t = t0; t < t1 - 1e-9; t += N16, k++) {
    const m = tones[pattern[k % pattern.length]];
    const vv = typeof v === "function" ? v(t) : v;
    voice({
      t,
      dur: N16 * 0.7,
      freq: midi(m),
      duty,
      vol: 0.05 * vv,
      a: 0.002,
      d: 0.05,
      s: 0.45,
      decay: 6,
      r: 0.02,
      pan: k % 2 ? 0.4 : -0.4,
      to,
      dly: 0.25,
      lp: 7000,
    });
  }
}
function bassBar(b, chord, mode, v = 1) {
  const t0 = b * BAR;
  if (mode === "drive") {
    for (let k = 0; k < 8; k++) {
      const m = chord.root + (k % 2 ? 12 : 0);
      voice({
        t: t0 + k * N8,
        dur: N8 * 0.8,
        freq: midi(m),
        duty: 0.5,
        vol: 0.13 * v,
        a: 0.002,
        d: 0.06,
        s: 0.6,
        decay: 3,
        r: 0.02,
        lp: 1400,
        to: "duck",
      });
    }
    for (let k = 0; k < 4; k++)
      voice({
        t: t0 + k * BEAT,
        dur: BEAT * 0.9,
        freq: midi(chord.root - 12),
        wave: "tri",
        vol: 0.3 * v,
        a: 0.004,
        d: 0.1,
        s: 0.8,
        r: 0.03,
        to: "duck",
      });
  } else if (mode === "eighths") {
    for (let k = 0; k < 8; k++)
      voice({
        t: t0 + k * N8,
        dur: N8 * 0.75,
        freq: midi(chord.root),
        duty: 0.5,
        vol: 0.11 * (typeof v === "function" ? v(t0 + k * N8) : v),
        a: 0.002,
        d: 0.06,
        s: 0.6,
        decay: 3,
        r: 0.02,
        lp: 1100,
        to: "duck",
      });
  } else if (mode === "quarters") {
    for (let k = 0; k < 4; k++) {
      voice({
        t: t0 + k * BEAT,
        dur: BEAT * 0.85,
        freq: midi(chord.root),
        duty: 0.5,
        vol: 0.09 * v,
        a: 0.003,
        d: 0.1,
        s: 0.6,
        decay: 2,
        r: 0.03,
        lp: 900,
        to: "duck",
      });
      voice({
        t: t0 + k * BEAT,
        dur: BEAT * 0.85,
        freq: midi(chord.root - 12),
        wave: "tri",
        vol: 0.2 * v,
        a: 0.004,
        d: 0.1,
        s: 0.8,
        r: 0.03,
        to: "duck",
      });
    }
  }
}
function offbeatChords(b, chord, v = 1) {
  for (let k = 0; k < 4; k++)
    chord.tones.forEach((m, i) =>
      voice({
        t: b * BAR + k * BEAT + N8,
        dur: 0.11,
        freq: midi(m + 12),
        duty: 0.5,
        vol: 0.03 * v,
        a: 0.002,
        d: 0.03,
        s: 0.6,
        decay: 9,
        r: 0.03,
        pan: [-0.55, 0, 0.55][i],
        lp: 2600,
        to: "duck",
        rev: 0.05,
      }),
    );
}
function chordStab(t, chord, { v = 1, len = 0.8, decay = 2.5, rev = 0.3 } = {}) {
  const voicing = [chord.tones[0], ...chord.tones.map((x) => x + 12), chord.tones[0] + 24];
  voicing.forEach((m, i) =>
    voice({
      t,
      dur: len,
      freq: midi(m),
      duty: i % 2 ? 0.25 : 0.5,
      vol: 0.055 * v,
      a: 0.002,
      d: 0.05,
      s: 0.8,
      decay,
      r: 0.12,
      pan: -0.6 + (1.2 * i) / (voicing.length - 1),
      lp: 5000,
      rev,
      dly: 0.05,
    }),
  );
}
/** a soft sustained chord: detuned, low-passed pulses with a triangle root under them */
function pad(t0, t1, chord, v = 1, to = "duck") {
  const len = t1 - t0 - 0.05;
  chord.tones.forEach((m, i) => {
    for (const c of [-7, 7])
      voice({
        t: t0,
        dur: len,
        freq: midi(m),
        duty: 0.5,
        vol: 0.035 * v,
        a: 0.12,
        d: 0,
        s: 1,
        r: 0.15,
        pan: (c < 0 ? -1 : 1) * (0.25 + 0.2 * i),
        cents: c,
        lp: 1600,
        to,
        rev: 0.15,
      });
  });
  voice({ t: t0, dur: len, freq: midi(chord.root - 12), wave: "tri", vol: 0.22 * v, a: 0.05, d: 0, s: 1, r: 0.1, to });
}
/** the full groove for one bar: four on the floor, snare on 2 and 4, hats; a fill on the last beat if asked */
function drums(b, { fill = false, crashIn = false, v = 1 } = {}) {
  const t0 = b * BAR;
  if (crashIn) crash(t0, 0.85 * v);
  for (let k = 0; k < 4; k++) kick(t0 + k * BEAT, 1 * v);
  const lastBeat = fill ? 3 : 4;
  for (let k = 0; k < lastBeat; k++) if (k % 2 === 1) snare(t0 + k * BEAT, 0.8 * v);
  for (let k = 0; k < lastBeat * 4; k++) {
    const t = t0 + k * N16;
    if (k % 4 === 2) hat(t, 0.75 * v, true, 0.3);
    else hat(t, (k % 4 === 0 ? 0.35 : 0.5) * v, false, -0.25);
  }
  if (fill) {
    const f = t0 + 3 * BEAT;
    snare(f, 0.55 * v);
    snare(f + N16, 0.65 * v);
    tom(f + 2 * N16, midi(57), 0.9 * v, -0.3);
    tom(f + 3 * N16, midi(50), 1 * v, 0.3);
  }
}

// ---------------------------------------------------------------- the score
const CHORDS = []; // [t, chord] for NOTES.md
const setChord = (t, name) => CHORDS.push([t, name]);
const FILLS = [];
const barOf = (t) => Math.round(t / BAR);

const INTRO_MEL = [
  [
    [0, 73, 3],
    [3, 76, 1],
    [4, 78, 4],
  ],
  [
    [0, 78, 2],
    [2, 76, 2],
    [4, 74, 4],
  ],
  [
    [0, 73, 3],
    [3, 76, 1],
    [4, 81, 4],
  ],
  [
    [0, 80, 4],
    [4, 76, 2],
    [6, 71, 2],
  ],
  [
    [0, 73, 3],
    [3, 76, 1],
    [4, 78, 4],
  ],
];
const BUILD_MEL = [
  [
    [0, 78, 2],
    [2, 81, 2],
    [4, 86, 4],
  ],
  [
    [0, 85, 3],
    [3, 83, 1],
    [4, 81, 2],
    [6, 80, 2],
  ],
];
const TITLE_MEL = [
  [
    [0, 78, 2],
    [2, 81, 2],
    [4, 83, 3],
    [7, 81, 1],
  ],
  [
    [0, 80, 3],
    [3, 76, 1],
    [4, 80, 2],
    [6, 83, 2],
  ],
];
const HOOK = [
  [
    [0, 76, 2],
    [2, 76, 1],
    [3, 81, 2],
    [5, 80, 1],
    [6, 76, 2],
  ],
  [
    [0, 80, 2],
    [2, 76, 1],
    [3, 78, 2],
    [5, 76, 1],
    [6, 73, 2],
  ],
  [
    [0, 78, 2],
    [2, 78, 1],
    [3, 81, 2],
    [5, 80, 1],
    [6, 78, 2],
  ],
  [
    [0, 81, 3],
    [3, 78, 1],
    [4, 76, 2],
    [6, 73, 1],
    [7, 71, 1],
  ],
];
const HOOK_B = [
  [
    [0, 81, 1],
    [1, 80, 1],
    [2, 81, 1],
    [3, 83, 1],
    [4, 85, 2],
    [6, 83, 1],
    [7, 81, 1],
  ],
  [
    [0, 80, 2],
    [2, 76, 2],
    [4, 80, 1],
    [5, 81, 1],
    [6, 83, 2],
  ],
  [
    [0, 85, 2],
    [2, 81, 2],
    [4, 78, 2],
    [6, 81, 2],
  ],
  [
    [0, 78, 4],
    [4, 76, 2],
    [6, 73, 2],
  ],
];
const COUNTER = [
  [
    [0, 69, 4],
    [4, 73, 4],
  ],
  [
    [0, 71, 4],
    [4, 68, 4],
  ],
  [
    [0, 69, 4],
    [4, 73, 4],
  ],
  [
    [0, 74, 4],
    [4, 73, 2],
    [6, 71, 2],
  ],
];
const LEADIN = [
  [0, 80, 2],
  [2, 76, 1],
  [3, 78, 1],
  [4, 80, 1],
  [5, 83, 1],
];
const OUTRO_MEL = [
  [
    [0, 78, 2],
    [2, 74, 2],
    [4, 78, 2],
    [6, 81, 2],
  ],
  [
    [0, 80, 4],
    [4, 83, 2],
    [6, 85, 2],
  ],
];
const NIGHT_LOOP = ["Fsm", "D", "A", "E"];
const DRIVE_LOOP = ["A", "E", "Fsm", "D"];

function intro(sec) {
  for (let b = barOf(sec.from); b < barOf(sec.to); b++) {
    const name = NIGHT_LOOP[b % 4];
    setChord(b * BAR, name);
    const k = b - barOf(sec.from);
    arp(b * BAR, (b + 1) * BAR, CH[name], {
      duty: 0.25,
      v: (t) => 0.55 * Math.min(1, 0.25 + t / (2 * BAR)),
      to: "dry",
      pattern: [0, 1, 2, 3, 2, 1, 0, 1],
    });
    playLine(b, INTRO_MEL[k % INTRO_MEL.length], (t, m, len) =>
      lead(t, m, len, 0.6, { lp: 2600, dly: 0.32, rev: 0.22 }),
    );
    // stars: two quiet high blips a bar
    for (const st of [(b * 5 + 3) % 16, (b * 7 + 11) % 16])
      voice({
        t: b * BAR + st * N16,
        dur: 0.06,
        freq: midi(CH[name].tones[(b + st) % 3] + 24),
        duty: 0.125,
        vol: 0.022,
        decay: 18,
        a: 0.001,
        r: 0.02,
        pan: st % 2 ? 0.7 : -0.7,
        dly: 0.6,
        rev: 0.4,
      });
  }
}
function build(sec) {
  const b0 = barOf(sec.from);
  const b1 = barOf(sec.to);
  for (let b = b0; b < b1; b++) {
    const name = NIGHT_LOOP[b % 4];
    setChord(b * BAR, name);
    const lift = (t) => (t - sec.from) / (sec.to - sec.from);
    arp(b * BAR, (b + 1) * BAR, CH[name], { duty: 0.125, v: (t) => 0.6 + 0.3 * lift(t), to: "dry" });
    bassBar(b, CH[name], "quarters", 0.8);
    playLine(b, BUILD_MEL[(b - b0) % BUILD_MEL.length], (t, m, len) => lead(t, m, len, 0.75, { lp: 3800, dly: 0.28 }));
    for (let k = 0; k < 16; k++) {
      const t = b * BAR + k * N16;
      const v = (0.45 + 0.45 * lift(t)) * (k % 2 ? 0.55 : 1);
      if (k % 4 === 2 && k === 14) hat(t, v, true, 0.3);
      else hat(t, v, false, k % 2 ? 0.35 : -0.2);
    }
  }
}
function riser(sec) {
  const b0 = barOf(sec.from);
  const b1 = barOf(sec.to);
  const names = ["Bm", "E"];
  const span = GAP0 - RISER0;
  const x = (t) => Math.max(0, Math.min(1, (t - RISER0) / span));
  for (let b = b0; b < b1; b++) {
    const name = names[Math.min(names.length - 1, b - b0)];
    setChord(b * BAR, name);
    const end = Math.min((b + 1) * BAR, GAP0);
    arp(b * BAR, end, CH[name], { duty: 0.125, v: (t) => 0.85 + 0.5 * x(t), to: "dry", up: b === b1 - 1 ? 24 : 12 });
    bassBar(b, CH[name], "eighths", (t) => 0.8 + 0.4 * x(t));
    for (let t = b * BAR; t < end - 1e-9; t += N16)
      hat(t, (0.5 + 0.4 * x(t)) * (Math.round(t / N16) % 2 ? 0.55 : 1), false, -0.2);
  }
  playLine(b0, [[0, 83, 8]], (t, m, len) => lead(t, m, len, 0.8, { vib: 22 }));
  playLine(b0 + 1, [[0, 80, Math.round((GAP0 - (b0 + 1) * BAR) / N8)]], (t, m, len) =>
    lead(t, m, len + 0.02, 0.9, { vib: 26 }),
  );
  // the riser itself, under the pull-back: noise and a pulse sweep, both stopping dead at the silence
  for (const [pan, seed] of [
    [-0.5, 101],
    [0.5, 202],
  ])
    noise({
      t: RISER0,
      dur: span,
      env: (lt) => (lt / span) ** 2.2,
      vol: 0.22,
      hp: (lt) => 300 * 20 ** (lt / span),
      pan,
      seed,
      rev: 0.15,
    });
  voice({
    t: RISER0,
    dur: span,
    freq: (lt) => midi(57 + 36 * (lt / span) ** 1.4),
    duty: 0.25,
    vol: 0.055,
    a: 0.2,
    d: 0,
    s: 1,
    r: 0,
    lp: 6000,
    dly: 0.25,
  });
  // kicks on the last bar's beats, a roll to the silence: 8ths, 16ths, 32nds
  for (let t = (b1 - 1) * BAR; t < GAP0 - 1e-9; t += BEAT) kick(t, 0.6, 0.4);
  roll(
    GAP0,
    [
      [1, 2],
      [1, 4],
      [1, 8],
    ],
    0.3,
    0.7,
  );
}
function hit(sec) {
  const b0 = barOf(sec.from);
  const b1 = barOf(sec.to);
  // the big hit
  setChord(HIT, "A");
  kick(HIT, 1.1, 0.85);
  snare(HIT, 1);
  crash(HIT, 1.3, 3.5);
  boom(HIT, CH.A.root, 1.1, 2.2);
  chordStab(HIT, CH.A, { v: 1.7, len: KIT - HIT - 0.1, decay: 0.7, rev: 0.45 });
  pad(HIT + BEAT, KIT, CH.A, 0.8);
  lead(HIT, 81, KIT - HIT - 0.15, 1.2, { vib: 18, rev: 0.3 });
  harmony(HIT, 81, KIT - HIT - 0.15, 1.2);
  arp(HIT + 2 * BEAT, KIT, CH.A, { v: (t) => 0.3 + 0.5 * ((t - HIT) / (KIT - HIT)), to: "duck" });
  // full kit from KIT
  const after = ["D", "E"];
  for (let b = barOf(KIT); b < b1; b++) {
    const name = after[(b - barOf(KIT)) % after.length];
    setChord(b * BAR, name);
    drums(b, { crashIn: b === barOf(KIT), fill: b === b1 - 1 });
    bassBar(b, CH[name], "drive");
    arp(b * BAR, (b + 1) * BAR, CH[name]);
    offbeatChords(b, CH[name]);
    playLine(b, TITLE_MEL[(b - barOf(KIT)) % TITLE_MEL.length], (t, m, len) => {
      lead(t, m, len);
      harmony(t, m, len, 0.8);
    });
    if (b === b1 - 1) FILLS.push(b * BAR + 3 * BEAT);
  }
  if (barOf(KIT) <= b0) fail("the full kit must come after the hit");
}
let driveCount = 0;
function drive(sec, next) {
  const b0 = barOf(sec.from);
  const b1 = barOf(sec.to);
  const plan = driveCount++ === 0 ? ["hook", "hook+tri", "b", "hook+harm", "hook+tri+harm"] : ["hook+tri+harm"];
  for (let b = b0; b < b1; b++) {
    const k = b - b0;
    const last = b === b1 - 1;
    let name = DRIVE_LOOP[k % 4];
    const leadIn = last && next?.energy === "stabs";
    if (leadIn) name = "E";
    setChord(b * BAR, name);
    const fill = k % 4 === 3 || last;
    if (fill) FILLS.push(b * BAR + (leadIn ? 2 : 3) * BEAT);
    // the lead-in to the claims thins out: one kick, then only the roll, the bass and the lead
    if (leadIn) kick(b * BAR, 1);
    else drums(b, { crashIn: k % 4 === 0, fill });
    if (leadIn)
      roll(
        (b + 1) * BAR - BEAT,
        [
          [1, 4],
          [1, 8],
        ],
        0.3,
        0.9,
      );
    bassBar(b, CH[name], "drive");
    arp(b * BAR, (b + 1) * BAR, CH[name]);
    offbeatChords(b, CH[name]);
    const part = plan[Math.floor(k / 4) % plan.length];
    if (leadIn) {
      playLine(b, LEADIN, (t, m, len) => {
        lead(t, m, len);
        harmony(t, m, len);
      });
      continue;
    }
    const mel = (part === "b" ? HOOK_B : HOOK)[k % 4];
    playLine(b, mel, (t, m, len) => {
      lead(t, m, len);
      if (part.includes("harm") || part === "b") harmony(t, m, len);
    });
    if (part.includes("tri")) playLine(b, COUNTER[k % 4], triLead);
  }
}
function stabs(sec) {
  const build0 = sec.to - BAR; // the last bar builds back into the groove
  const names = ["A", "Fsm", "D"];
  STABS.forEach((t, i) => {
    const name = names[i % names.length];
    const end = STABS[i + 1] ?? build0;
    setChord(t, name);
    const c = CH[name];
    kick(t, 1.05, 0.8);
    snare(t, 0.9);
    crash(t, 1.3, 2.2);
    boom(t, c.root, 0.9, 1.4);
    chordStab(t, c, { v: 1.7, len: 1.5, decay: 1.4, rev: 0.4 });
    pad(t + BEAT / 2, end, c, 0.9);
    lead(t, c.tones[2] + 12, 0.7, 1.5, { decay: 2, rev: 0.25 });
    // the bed between stabs: hats, a bass pulse and the arp, no kick or snare
    arp(t + BEAT, end, c, { v: 0.85 });
    for (let u = t + N8; u < end - 1e-9; u += N8) {
      hat(u, Math.round(u / N8) % 2 ? 0.8 : 0.45, false, -0.2);
      voice({
        t: u,
        dur: N8 * 0.7,
        freq: midi(c.root),
        duty: 0.5,
        vol: 0.09,
        a: 0.002,
        d: 0.06,
        s: 0.6,
        decay: 3,
        r: 0.02,
        lp: 1000,
        to: "duck",
      });
    }
  });
  setChord(build0, "E");
  const c = CH.E;
  for (let k = 0; k < 4; k++) kick(build0 + k * BEAT, 0.95, 0.5);
  roll(
    sec.to,
    [
      [2, 2],
      [1, 4],
      [1, 8],
    ],
    0.25,
    0.95,
  );
  bassBar(barOf(build0), c, "eighths", (t) => 0.9 + 0.4 * ((t - build0) / BAR));
  arp(build0, sec.to, c, { v: 0.8 });
  for (let u = build0; u < sec.to - 1e-9; u += N16) hat(u, 0.45, false, -0.2);
  noise({
    t: build0,
    dur: BAR,
    env: (lt) => (lt / BAR) ** 2,
    vol: 0.16,
    hp: (lt) => 500 * 12 ** (lt / BAR),
    seed: 303,
    rev: 0.1,
  });
  playLine(
    barOf(build0),
    [
      [4, 76, 1],
      [5, 78, 1],
      [6, 80, 1],
      [7, 83, 1],
    ],
    (t, m, len) => lead(t, m, len, 0.9),
  );
  FILLS.push(build0);
}
function outro(sec) {
  const b0 = barOf(sec.from);
  const fb = barOf(FANFARE);
  const names = ["Bm", "E"];
  for (let b = b0; b < fb; b++) {
    const name = names[Math.min(names.length - 1, b - b0)];
    setChord(b * BAR, name);
    const lastBefore = b === fb - 1;
    drums(b, { crashIn: b === b0, fill: false });
    if (lastBefore)
      roll(
        FANFARE,
        [
          [1, 4],
          [1, 8],
        ],
        0.3,
        1.0,
      );
    bassBar(b, CH[name], "drive");
    arp(b * BAR, (b + 1) * BAR, CH[name]);
    offbeatChords(b, CH[name]);
    playLine(b, OUTRO_MEL[(b - b0) % OUTRO_MEL.length], (t, m, len) => {
      lead(t, m, len);
      harmony(t, m, len);
    });
  }
  // the fanfare: the flag goes up
  const F = FANFARE;
  setChord(F, "A");
  kick(F, 1.1, 0.7);
  snare(F, 1);
  crash(F, 1.3, 3);
  boom(F, CH.A.root, 1.1, 2);
  chordStab(F, CH.A, { v: 1.5, len: 1.2, decay: 1.8, rev: 0.4 });
  const tail = DUR - F;
  const trip = BEAT / 3;
  const MEL = [
    [0, 69, trip],
    [trip, 73, trip],
    [2 * trip, 76, trip],
    [BEAT, 81, BEAT],
    [2 * BEAT, 80, BEAT / 2],
    [2.5 * BEAT, 83, BEAT / 2],
    [3 * BEAT, 81, tail - 3 * BEAT - 0.1],
  ];
  for (const [dt, m, len] of MEL) {
    const ring = dt >= 3 * BEAT;
    lead(F + dt, m, len - 0.01, 1.25, ring ? { decay: 0.55, s: 1, d: 0, vib: 16, rev: 0.35 } : { rev: 0.2 });
    harmony(F + dt, m, len - 0.01, ring ? 1 : 1.1);
  }
  voice({ t: F, dur: 2 * BEAT, freq: midi(45), wave: "tri", vol: 0.32, s: 0.9, r: 0.05 });
  voice({ t: F + 2 * BEAT, dur: BEAT, freq: midi(40), wave: "tri", vol: 0.32, s: 0.9, r: 0.05 });
  // the landing on the tonic, ringing out
  const land = F + 3 * BEAT;
  kick(land, 1.0, 0);
  crash(land, 1.1, tail - 3 * BEAT);
  boom(land, CH.A.root, 0.9, tail - 3 * BEAT);
  chordStab(land, CH.A, { v: 1, len: tail - 3 * BEAT - 0.2, decay: 0.75, rev: 0.5 });
  voice({ t: land, dur: tail - 3 * BEAT - 0.2, freq: midi(33), wave: "tri", vol: 0.3, s: 1, d: 0, decay: 0.7, r: 0.1 });
  // a last falling sparkle over the tail
  [93, 88, 85, 81, 76, 73, 69].forEach((m, i) =>
    voice({
      t: land + BEAT + i * N16,
      dur: 0.08,
      freq: midi(m),
      duty: 0.125,
      vol: 0.03,
      decay: 12,
      a: 0.001,
      r: 0.03,
      pan: i % 2 ? 0.6 : -0.6,
      dly: 0.5,
      rev: 0.4,
    }),
  );
}

const HANDLERS = { intro, build, riser, hit, drive, stabs, outro };
SECTIONS.forEach((s, i) => (HANDLERS[s.energy] ?? fail(`no music for energy "${s.energy}"`))(s, SECTIONS[i + 1]));

// ---------------------------------------------------------------- mix
// sidechain: the kick pumps the bass, arp and chords
const duckEnv = new Float32Array(N).fill(1);
for (const { t, depth } of KICKS) {
  const i0 = S(t);
  for (let i = 0; i < Math.round(0.4 * SR) && i0 + i < N; i++) {
    const lt = i / SR;
    const g = 1 - depth * (lt < 0.004 ? lt / 0.004 : Math.exp(-(lt - 0.004) / 0.1));
    if (g < duckEnv[i0 + i]) duckEnv[i0 + i] = g;
  }
}
const L = new Float32Array(N);
const R = new Float32Array(N);
for (let j = 0; j < N; j++) {
  L[j] = DRY_L[j] + DUCK_L[j] * duckEnv[j];
  R[j] = DRY_R[j] + DUCK_R[j] * duckEnv[j];
}
// ping-pong delay, a dotted eighth; cleared at the silence
{
  const D = S(BEAT * 0.75);
  const bl = new Float32Array(D);
  const br = new Float32Array(D);
  let k = 0;
  let fl = 0;
  let fr = 0;
  const fb = 0.38;
  const damp = 0.3;
  for (let j = 0; j < N; j++) {
    if (j === GS0) {
      bl.fill(0);
      br.fill(0);
      fl = fr = 0;
    }
    const yl = bl[k];
    const yr = br[k];
    fl += (yr - fl) * damp;
    fr += (yl - fr) * damp;
    bl[k] = DLY[j] + fl * fb;
    br[k] = fr * fb;
    L[j] += yl * 0.45;
    R[j] += yr * 0.45;
    k = (k + 1) % D;
  }
}
// Freeverb-style reverb; cleared at the silence
{
  const sc = SR / 44100;
  const combLens = [1116, 1188, 1277, 1356, 1422, 1491, 1557, 1617];
  const apLens = [556, 441, 341, 225];
  const mk = (spread) => ({
    combs: combLens.map((n) => ({ buf: new Float32Array(Math.round((n + spread) * sc)), i: 0, store: 0 })),
    aps: apLens.map((n) => ({ buf: new Float32Array(Math.round((n + spread) * sc)), i: 0 })),
  });
  const chans = [mk(0), mk(23)];
  const room = 0.86;
  const damp = 0.25;
  for (let j = 0; j < N; j++) {
    if (j === GS0)
      for (const ch of chans) {
        for (const c of ch.combs) {
          c.buf.fill(0);
          c.store = 0;
        }
        for (const a of ch.aps) a.buf.fill(0);
      }
    const x = REV[j] * 0.015;
    for (let c = 0; c < 2; c++) {
      const ch = chans[c];
      let out = 0;
      for (const cb of ch.combs) {
        const y = cb.buf[cb.i];
        cb.store = y * (1 - damp) + cb.store * damp;
        cb.buf[cb.i] = x + cb.store * room;
        cb.i = (cb.i + 1) % cb.buf.length;
        out += y;
      }
      for (const ap of ch.aps) {
        const bo = ap.buf[ap.i];
        ap.buf[ap.i] = out + bo * 0.5;
        ap.i = (ap.i + 1) % ap.buf.length;
        out = bo - out;
      }
      (c ? R : L)[j] += out * 1.1;
    }
  }
}
// DC / sub-rumble high-pass at 22 Hz
for (const ch of [L, R]) {
  const k = 1 - Math.exp((-2 * Math.PI * 22) / SR);
  let lp = 0;
  for (let j = 0; j < N; j++) {
    lp += (ch[j] - lp) * k;
    ch[j] -= lp;
  }
}

// ---------------------------------------------------------------- loudness (BS.1770-4) and a true-peak limiter
function kWeighted(x) {
  const y = new Float64Array(x.length);
  const st = [
    [1.53512485958697, -2.69169618940638, 1.19839281085285, -1.69065929318241, 0.73248077421585],
    [1.0, -2.0, 1.0, -1.99004745483398, 0.99007225036621],
  ];
  y.set(x);
  for (const [b0, b1, b2, a1, a2] of st) {
    let x1 = 0;
    let x2 = 0;
    let y1 = 0;
    let y2 = 0;
    for (let i = 0; i < y.length; i++) {
      const xi = y[i];
      const yi = b0 * xi + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2;
      x2 = x1;
      x1 = xi;
      y2 = y1;
      y1 = yi;
      y[i] = yi;
    }
  }
  return y;
}
function lufs(Lc, Rc, from = 0, to = Lc.length, gated = true) {
  const kl = kWeighted(Lc.subarray(from, to));
  const kr = kWeighted(Rc.subarray(from, to));
  const blk = Math.round(0.4 * SR);
  const hop = Math.round(0.1 * SR);
  const z = [];
  for (let i = 0; i + blk <= kl.length; i += hop) {
    let s = 0;
    for (let k = i; k < i + blk; k++) s += kl[k] * kl[k] + kr[k] * kr[k];
    z.push(s / blk);
  }
  const ld = (v) => -0.691 + 10 * Math.log10(v);
  if (!gated) return ld(z.reduce((a, b) => a + b, 0) / Math.max(1, z.length));
  const abs = z.filter((v) => ld(v) > -70);
  if (!abs.length) return Number.NEGATIVE_INFINITY;
  const rel = ld(abs.reduce((a, b) => a + b, 0) / abs.length) - 10;
  const g = abs.filter((v) => ld(v) > rel);
  return ld(g.reduce((a, b) => a + b, 0) / g.length);
}
// 4x oversampled peak per sample (windowed sinc), for the limiter and the report
const OS_TAPS = 12;
const OS = [1, 2, 3].map((p) => {
  const fr = p / 4;
  const h = [];
  for (let k = -OS_TAPS + 1; k <= OS_TAPS; k++) {
    const x = fr - k;
    const w = 0.5 + 0.5 * Math.cos((Math.PI * x) / OS_TAPS);
    h.push(Math.abs(x) < 1e-12 ? 1 : (Math.sin(Math.PI * x) / (Math.PI * x)) * w);
  }
  return h;
});
function peakOS(x, i) {
  let p = Math.abs(x[i]);
  for (const h of OS) {
    let v = 0;
    for (let k = -OS_TAPS + 1, q = 0; k <= OS_TAPS; k++, q++) {
      const idx = i + k;
      if (idx >= 0 && idx < x.length) v += x[idx] * h[q];
    }
    if (Math.abs(v) > p) p = Math.abs(v);
  }
  return p;
}
function limit(Lc, Rc, gain, ceilDb) {
  const ceil = 10 ** (ceilDb / 20);
  const W = Math.round(0.003 * SR);
  const rel = 1 - Math.exp(-1 / (0.08 * SR));
  const yl = new Float32Array(Lc.length);
  const yr = new Float32Array(Lc.length);
  for (let i = 0; i < Lc.length; i++) {
    yl[i] = Lc[i] * gain;
    yr[i] = Rc[i] * gain;
  }
  const req = new Float32Array(Lc.length);
  for (let i = 0; i < Lc.length; i++) {
    const p = Math.max(peakOS(yl, i), peakOS(yr, i));
    req[i] = p > ceil ? ceil / p : 1;
  }
  // forward-looking minimum over W, release smoothing, then a W-long moving average: gain[i] <= req[i] always
  const m = new Float32Array(Lc.length);
  const dq = [];
  for (let i = Lc.length - 1; i >= 0; i--) {
    while (dq.length && req[dq.at(-1)] >= req[i]) dq.pop();
    dq.push(i);
    while (dq[0] >= i + W) dq.shift();
    m[i] = req[dq[0]];
  }
  let h = 1;
  for (let i = 0; i < m.length; i++) {
    h = m[i] < h ? m[i] : h + (m[i] - h) * rel;
    m[i] = h;
  }
  limit.minGain = 1;
  for (let i = 0; i < m.length; i++)
    if (m[i] < limit.minGain) {
      limit.minGain = m[i];
      limit.minAt = i / SR;
    }
  limit.gain = m;
  let acc = 0;
  for (let i = 0; i < m.length; i++) {
    acc += m[i];
    if (i >= W) acc -= m[i - W];
    const g = i >= W - 1 ? acc / W : Math.min(...m.subarray(0, i + 1));
    yl[i] *= g;
    yr[i] *= g;
  }
  return [yl, yr];
}

const TARGET = -14;
const CEIL = -1.6;
let gain = 10 ** ((TARGET - lufs(L, R)) / 20);
let OL;
let OR;
for (let pass = 0; pass < 3; pass++) {
  [OL, OR] = limit(L, R, gain, CEIL);
  const got = lufs(OL, OR);
  if (Math.abs(got - TARGET) < 0.1) break;
  gain *= 10 ** ((TARGET - got) / 20);
}
// the beat of silence: a 5 ms fade into 17.5, digital zero until 18; and the ring-out fades to zero at the end
{
  const f = Math.round(0.005 * SR);
  for (let j = GS0 - f; j < GS1; j++) {
    const g = j < GS0 ? (GS0 - j) / f : 0;
    OL[j] *= g;
    OR[j] *= g;
  }
  const endFade = S(2 * BEAT);
  for (let j = N - endFade; j < N; j++) {
    const g = 0.5 + 0.5 * Math.cos((Math.PI * (j - (N - endFade))) / endFade);
    OL[j] *= g;
    OR[j] *= g;
  }
  OL[N - 1] = OR[N - 1] = 0;
  if (DROP) {
    const [d0, d1] = DROP.map(S);
    for (let j = d0 - f; j < d1; j++) {
      const g = j < d0 ? (d0 - j) / f : 0;
      OL[j] *= g;
      OR[j] *= g;
    }
  }
}

// ---------------------------------------------------------------- write
function wav(chans) {
  const n = chans[0].length;
  const nc = chans.length;
  const out = Buffer.alloc(44 + n * 2 * nc);
  out.write("RIFF", 0);
  out.writeUInt32LE(36 + n * 2 * nc, 4);
  out.write("WAVEfmt ", 8);
  out.writeUInt32LE(16, 16);
  out.writeUInt16LE(1, 20);
  out.writeUInt16LE(nc, 22);
  out.writeUInt32LE(SR, 24);
  out.writeUInt32LE(SR * 2 * nc, 28);
  out.writeUInt16LE(2 * nc, 32);
  out.writeUInt16LE(16, 34);
  out.write("data", 36);
  out.writeUInt32LE(n * 2 * nc, 40);
  for (let i = 0; i < n; i++)
    for (let c = 0; c < nc; c++) {
      const v = Math.max(-1, Math.min(1, chans[c][i]));
      out.writeInt16LE(Math.round(v * 32767), 44 + (i * nc + c) * 2);
    }
  return out;
}
mkdirSync(join(OUT, "sfx"), { recursive: true });
writeFileSync(join(OUT, "score.wav"), wav([OL, OR]));

// self-checks
let gapMax = 0;
for (let j = GS0; j < GS1; j++)
  gapMax = Math.max(gapMax, Math.abs(Math.round(OL[j] * 32767)), Math.abs(Math.round(OR[j] * 32767)));
if (gapMax !== 0) fail(`the silence at ${GAP0}-${GAP1} s is not digital zero (max ${gapMax})`);
let tp = 0;
for (let j = 0; j < N; j += 1) {
  const p = Math.max(Math.abs(OL[j]), Math.abs(OR[j]));
  if (p > tp * 0.7) tp = Math.max(tp, peakOS(OL, j), peakOS(OR, j));
}

// ---------------------------------------------------------------- hits.json
const fr = (t) => {
  const f = t * FPS;
  if (Math.abs(f - Math.round(f)) > 1e-9) fail(`${t} s is not on a frame`);
  return Math.round(f);
};
const acc = new Map();
const add = (t, kind, extra = {}) => {
  const e = acc.get(t) ?? { t, beat: t / BEAT, bar: t / BAR, frame: fr(t), sample: S(t), kinds: [] };
  e.kinds.push(kind);
  Object.assign(e, extra);
  acc.set(t, e);
};
SECTIONS.forEach((s) => add(s.from, "section", { energy: s.energy }));
add(RISER0, "riser");
add(GAP0, "silence", { until: GAP1 });
if (DROP) add(DROP[0], "drop", { until: DROP[1] });
add(HIT, "hit");
add(KIT, "kit");
STABS.forEach((t, i) => add(t, "stab", { claim: CLAIMS[i] }));
add(FANFARE, "fanfare");
add(FANFARE + 3 * BEAT, "land");
const accents = [...acc.values()].sort((a, b) => a.t - b.t);
const hits = {
  bpm: BPM,
  fps: FPS,
  sampleRate: SR,
  duration: DUR,
  beat: BEAT,
  bar: BAR,
  accents,
  fills: FILLS.sort((a, b) => a - b).map((t) => ({ t, beat: t / BEAT, bar: t / BAR, frame: fr(t), sample: S(t) })),
  downbeats: Array.from({ length: Math.round(DUR / BAR) }, (_, b) => b * BAR),
  chords: CHORDS.sort((a, b) => a[0] - b[0]).map(([t, name]) => ({ t, chord: name.replace("Fsm", "F#m") })),
};
writeFileSync(join(OUT, "hits.json"), `${JSON.stringify(hits, null, 2)}\n`);

// ---------------------------------------------------------------- sfx
function sfx(name, len, render, peakDb) {
  DRY_L.fill(0, 0, S(len) + 10);
  DRY_R.fill(0, 0, S(len) + 10);
  REV.fill(0, 0, S(len) + 10);
  render();
  const n = S(len);
  const l = DRY_L.slice(0, n);
  const r = DRY_R.slice(0, n);
  let p = 0;
  for (let i = 0; i < n; i++) p = Math.max(p, peakOS(l, i), peakOS(r, i));
  const g = 10 ** (peakDb / 20) / p;
  const f = Math.min(n, S(0.004));
  for (let i = 0; i < n; i++) {
    const e = i >= n - f ? (n - i) / f : 1;
    l[i] *= g * e;
    r[i] *= g * e;
  }
  writeFileSync(join(OUT, "sfx", `${name}.wav`), wav([l, r]));
  return { name, len };
}
// a swell of band-passed noise (state-variable filter) whose centre sweeps; peaks at `peak` s, then falls
function whoosh(len, peak, f0, fPeak, f1, panFrom, panTo, cut = false) {
  const n = S(len);
  let lo = 0;
  let bp = 0;
  let lo2 = 0;
  let bp2 = 0;
  let a = 91;
  let b = 7;
  for (let i = 0; i < n; i++) {
    const t = i / SR;
    const x = t < peak ? t / peak : (t - peak) / (len - peak);
    const env = t < peak ? x ** 2.4 : cut ? Math.max(0, 1 - (t - peak) / 0.06) : (1 - x) ** 2;
    const fc = t < peak ? f0 * (fPeak / f0) ** x : fPeak * (f1 / fPeak) ** x;
    const f = 2 * Math.sin((Math.PI * Math.min(fc, 7000)) / SR);
    a = (a * 1103515245 + 12345) & 0x7fffffff;
    b = (b * 1103515245 + 12345) & 0x7fffffff;
    const nl = (a / 0x7fffffff) * 2 - 1;
    const nr = (b / 0x7fffffff) * 2 - 1;
    const q = 0.9;
    const hl = nl - lo - q * bp;
    bp += f * hl;
    lo += f * bp;
    const hr = nr - lo2 - q * bp2;
    bp2 += f * hr;
    lo2 += f * bp2;
    const pan = panFrom + (panTo - panFrom) * (t / len);
    const [gl, gr] = panLR(pan);
    DRY_L[i] += bp * env * gl * 0.5 + bp2 * env * gl * 0.15;
    DRY_R[i] += bp2 * env * gr * 0.5 + bp * env * gr * 0.15;
  }
}
const pb = PULLBACK[1] - PULLBACK[0];
const pbPeak = GAP0 - PULLBACK[0]; // the pull-back swell peaks as the music stops, and is gone before the gap
const pi = PUSHIN[1] - PUSHIN[0];
const SFX = [
  sfx("whoosh-pullback", pb, () => whoosh(pb, pbPeak, 250, 4500, 4500, -0.5, 0.5, true), -6),
  sfx("whoosh-pushin", pi + 0.35, () => whoosh(pi + 0.35, pi, 400, 3000, 600, 0.4, -0.2), -6),
  sfx("whoosh", 0.7, () => whoosh(0.7, 0.3, 600, 3500, 900, -0.3, 0.3), -8),
  sfx(
    "card",
    0.3,
    () => {
      voice({ t: 0, dur: 0.045, freq: midi(88), duty: 0.125, vol: 0.2, a: 0.001, decay: 10, r: 0.01, pan: -0.1 });
      voice({ t: 0.045, dur: 0.12, freq: midi(93), duty: 0.125, vol: 0.2, a: 0.001, decay: 14, r: 0.06, pan: 0.1 });
    },
    -9,
  ),
  sfx(
    "blip",
    0.15,
    () => voice({ t: 0, dur: 0.06, freq: midi(91), duty: 0.25, vol: 0.2, a: 0.001, decay: 25, r: 0.03 }),
    -12,
  ),
  ...[0, 1, 2].map((k) =>
    sfx(
      `type-${k + 1}`,
      0.05,
      () => {
        noise({
          t: 0,
          dur: 0.03,
          env: (lt) => Math.exp(-lt / 0.004),
          vol: 0.3,
          hp: 2500 + 700 * k,
          seed: 900 + k,
          pan: [-0.15, 0, 0.15][k],
        });
        voice({
          t: 0,
          dur: 0.012,
          freq: midi(100 - 2 * k),
          duty: 0.5,
          vol: 0.06,
          a: 0.0005,
          decay: 120,
          r: 0.005,
          pan: [-0.15, 0, 0.15][k],
        });
      },
      -15,
    ),
  ),
];

// ---------------------------------------------------------------- report
const db = (v) => (20 * Math.log10(v)).toFixed(2);
console.log(`score.wav  ${DUR} s, ${SR} Hz stereo 16-bit -> ${join(OUT, "score.wav")}`);
console.log(
  `  integrated ${lufs(OL, OR).toFixed(2)} LUFS (target ${TARGET}), est. true peak ${db(tp)} dBTP, gain ${db(gain)} dB, deepest limiting ${db(limit.minGain)} dB`,
);
console.log(`  silence ${GAP0}-${GAP1} s: digital zero`);
const spans = [
  ["intro", 0, 10],
  ["build", 10, 14],
  ["riser 1st bar", RISER0, RISER0 + BAR],
  ["riser 2nd bar", RISER0 + BAR, GAP0],
  ["hit ring", HIT, KIT],
  ["title kit", KIT, section("hit").to],
  ["drive", section("drive").from, section("drive").to],
  ...STABS.map((t, i) => [`stab ${i + 1}`, t, t + BEAT]),
  ["stab bed", STABS[0] + BEAT, STABS[1]],
  ["drive 2", SECTIONS.findLast((s) => s.energy === "drive").from, section("outro").from],
  ["fanfare", FANFARE, FANFARE + 2],
  ["tail", DUR - 2, DUR],
];
for (const [name, a, b] of spans) {
  let pk = 0;
  for (let j = S(a); j < S(b); j++) pk = Math.max(pk, Math.abs(OL[j]), Math.abs(OR[j]));
  console.log(
    `  ${name.padEnd(14)} ${String(a).padStart(5)}-${String(b).padEnd(5)} ${lufs(OL, OR, S(a), S(b), false).toFixed(1).padStart(6)} LUFS (ungated)  peak ${db(pk)} dBFS`,
  );
}
const lu = (a, b) => lufs(OL, OR, S(a), S(b), false);
const lift = (name, t, before) =>
  console.log(
    `  ${name.padEnd(14)} ${(lu(t, t + 0.4) - lu(before - 0.4, before)).toFixed(1)} LU louder over 0.4 s than the 0.4 s up to ${before}`,
  );
lift("hit", HIT, GAP0);
STABS.forEach((t, i) => lift(`stab ${i + 1}`, t, i === 0 && DROP ? DROP[0] : t));
lift("fanfare", FANFARE, FANFARE);
{
  const g = limit.gain;
  let n2 = 0;
  const [a, b] = [S(section("drive").from), S(section("drive").to)];
  for (let j = a; j < b; j++) if (g[j] < 10 ** (-2 / 20)) n2++;
  console.log(
    `  limiter: deepest at ${limit.minAt.toFixed(2)} s; ${((100 * n2) / (b - a)).toFixed(1)}% of the drive under more than 2 dB of gain reduction`,
  );
  for (const [name, t] of [
    ["hit", HIT],
    ...STABS.map((t, i) => [`stab ${i + 1}`, t]),
    ["fanfare", FANFARE],
    ["land", FANFARE + 3 * BEAT],
  ]) {
    let mn = 1;
    for (let j = S(t); j < S(t + 0.3); j++) mn = Math.min(mn, g[j]);
    console.log(`  limiting at ${name.padEnd(8)} ${db(mn)} dB`);
  }
}
console.log(`hits.json  ${accents.length} accents, ${FILLS.length} fills`);
console.log(`sfx/       ${SFX.map((s) => `${s.name} (${s.len.toFixed(2)} s)`).join(", ")}`);
