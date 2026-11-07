// Narration alignment without speech-to-text: find the speech runs between pauses (ffmpeg silencedetect) and fit
// them to the script cues, merging or splitting runs so their lengths follow each cue's word count.
import { spawnSync } from "node:child_process";

export type Span = [number, number];

export function speechRuns(
  file: string,
  { noiseDb = -40, minSilence = 0.25 } = {},
): { runs: Span[]; duration: number } {
  const err = spawnSync(
    "ffmpeg",
    [
      "-hide_banner",
      "-nostats",
      "-i",
      file,
      "-af",
      `silencedetect=noise=${noiseDb}dB:d=${minSilence}`,
      "-f",
      "null",
      "-",
    ],
    { encoding: "utf8" },
  ).stderr;
  const dm = /Duration: (\d+):(\d+):([\d.]+)/.exec(err);
  const duration = dm ? Number(dm[1]) * 3600 + Number(dm[2]) * 60 + Number(dm[3]) : 0;
  const silences: Span[] = [];
  let start: number | null = null;
  for (const line of err.split("\n")) {
    const s = /silence_start: (-?[\d.]+)/.exec(line);
    if (s) start = Math.max(0, Number(s[1]));
    const e = /silence_end: ([\d.]+)/.exec(line);
    if (e && start !== null) {
      silences.push([start, Number(e[1])]);
      start = null;
    }
  }
  if (start !== null) silences.push([start, duration]);
  const runs: Span[] = [];
  let t = 0;
  for (const [a, b] of silences) {
    if (a - t > 0.05) runs.push([t, a]);
    t = b;
  }
  if (duration - t > 0.05) runs.push([t, duration]);
  return { runs, duration };
}

/**
 * Fit speech runs to cues: each cue takes one or more consecutive runs. Dynamic programming picks the grouping whose
 * lengths best follow the cues' word counts (log-ratio error), penalising long pauses inside a cue. When there are
 * fewer runs than cues, the longest runs are split by words first.
 */
export function fitRuns(runs: Span[], words: number[]): Span[] {
  const n = words.length;
  if (!n || !runs.length) return [];
  const rs = runs.map((r) => [...r] as Span);
  while (rs.length < n) {
    let longest = 0;
    for (let i = 1; i < rs.length; i++) if (rs[i][1] - rs[i][0] > rs[longest][1] - rs[longest][0]) longest = i;
    const [a, b] = rs[longest];
    const mid = a + (b - a) / 2;
    rs.splice(longest, 1, [a, mid - 0.05], [mid + 0.05, b]);
  }
  const m = rs.length;
  const speech = rs.reduce((s, [a, b]) => s + (b - a), 0);
  const totalWords = words.reduce((s, w) => s + w, 0);
  const expected = words.map((w) => (w / totalWords) * speech);
  const cost = (c: number, i: number, j: number) => {
    // cue c covers runs i..j inclusive
    let inner = 0;
    for (let k = i; k < j; k++) inner += rs[k + 1][0] - rs[k][1];
    const dur = rs[j][1] - rs[i][0] - inner * 0.5;
    const r = Math.log(Math.max(0.05, dur) / Math.max(0.05, expected[c]));
    return r * r + inner * 1.5;
  };
  // best[c][j]: cues 0..c placed, cue c ends at run j
  const best = Array.from({ length: n }, () => new Array<number>(m).fill(Number.POSITIVE_INFINITY));
  const from = Array.from({ length: n }, () => new Array<number>(m).fill(-1));
  for (let j = 0; j < m; j++) best[0][j] = cost(0, 0, j);
  for (let c = 1; c < n; c++)
    for (let j = c; j < m; j++)
      for (let i = c; i <= j; i++) {
        const v = best[c - 1][i - 1] + cost(c, i, j);
        if (v < best[c][j]) {
          best[c][j] = v;
          from[c][j] = i;
        }
      }
  const out: Span[] = new Array(n);
  let j = m - 1;
  for (let c = n - 1; c >= 0; c--) {
    const i = c === 0 ? 0 : from[c][j];
    out[c] = [rs[i][0], rs[j][1]];
    j = i - 1;
  }
  return out.map(([a, b]) => [Math.round(a * 100) / 100, Math.round(b * 100) / 100]);
}
