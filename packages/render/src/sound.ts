// Project sound: SFX and music WAVs from the document, the ffmpeg mix with the narration, loudness analysis, and
// subtitles. The mix filter graph is the one that worked on the first video.
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { renderMusic, renderSfx, type SfxEvent, thinSfx, wav16 } from "@pap/engine/audio";
import { plainText } from "@pap/engine/core";
import type { LoadedProject } from "./project.ts";
import type { Renderer } from "./renderer.ts";

export async function sfxEventsOf(p: LoadedProject, r: Renderer): Promise<SfxEvent[]> {
  const { audio } = p.doc;
  const fromDoc = audio.sfx.events.map((e) => ({ t: p.timeline.at(e.t), type: e.type }));
  const fromSandbox = await r.sfxEvents();
  return audio.sfx.source === "doc" ? [...fromDoc, ...fromSandbox] : [...fromSandbox, ...fromDoc];
}

export async function writeSfx(p: LoadedProject, r: Renderer, file: string) {
  const events = await sfxEventsOf(p, r);
  const { kept, used } = thinSfx(events, p.doc.audio.sfx.keep, p.doc.audio.sfx.minGap);
  const mix = renderSfx(kept, { duration: p.timeline.duration, hold: p.timeline.hold });
  writeFileSync(file, wav16(mix, 1.2, 0.85));
  return { events: events.length, kept: kept.length, used };
}

export function writeMusic(p: LoadedProject, file: string) {
  const m = p.doc.audio.music;
  if (!m) return false;
  const sc = (id?: string) => p.timeline.scenes.find((s) => s.id === id)?.from;
  const L = renderMusic({
    duration: p.timeline.duration,
    hold: p.timeline.hold,
    liftFrom: sc(m.lift),
    settleFrom: sc(m.settle),
  });
  writeFileSync(file, wav16(L, 1.5, 0.8));
  return true;
}

export function loudness(file: string) {
  const err = spawnSync(
    "ffmpeg",
    ["-hide_banner", "-nostats", "-i", file, "-af", "ebur128=peak=true", "-f", "null", "-"],
    {
      encoding: "utf8",
    },
  ).stderr;
  const I = [...err.matchAll(/I:\s+(-?[0-9.]+) LUFS/g)].pop();
  const peak = [...err.matchAll(/Peak:\s+(-?[0-9.]+|-inf) dBFS/g)].pop();
  return { lufs: I ? Number(I[1]) : Number.NaN, truePeakDb: peak ? Number(peak[1]) : Number.NaN };
}

/** voice (delayed by the hold) + ducked SFX + ducked music, static gain to the target loudness, then a limiter */
export function mix(p: LoadedProject, { sfx, music, out }: { sfx: string; music?: string; out: string }) {
  const { hold, duration } = p.timeline;
  const m = p.doc.mix;
  const vo = p.doc.audio.vo[0];
  const voFile = vo ? join(p.dir, vo.file) : null;
  const total = (duration + hold).toFixed(2);
  const withMusic = !!music && existsSync(music);
  const inputs = [...(voFile ? ["-i", voFile] : []), "-i", sfx, ...(withMusic ? ["-i", music!] : [])];
  let graph: string[];
  if (voFile) {
    graph = [
      `[0:a]aresample=44100,aformat=channel_layouts=mono,adelay=${(hold + (vo?.offset ?? 0)) * 1000},highpass=f=${m.voHighpass},acompressor=threshold=0.1:ratio=3:attack=5:release=120,apad=whole_dur=${total},asplit=3[vo][key][key2]`,
      `[1:a]aformat=channel_layouts=mono,volume=${m.sfxDb}dB[fx]`,
      "[fx][key]sidechaincompress=threshold=0.03:ratio=6:attack=10:release=300[duck]",
      ...(withMusic
        ? [
            `[2:a]aformat=channel_layouts=mono,volume=${m.musicDb}dB[mu]`,
            "[mu][key2]sidechaincompress=threshold=0.02:ratio=4:attack=40:release=600[mduck]",
            "[vo][duck][mduck]amix=inputs=3:normalize=0:duration=longest[a]",
          ]
        : ["[key2]anullsink", "[vo][duck]amix=inputs=2:normalize=0:duration=longest[a]"]),
    ];
  } else {
    graph = [
      `[0:a]aformat=channel_layouts=mono,volume=${m.sfxDb + 9}dB[fx]`,
      ...(withMusic
        ? [
            `[1:a]aformat=channel_layouts=mono,volume=${m.musicDb + 6}dB[mu]`,
            "[fx][mu]amix=inputs=2:normalize=0:duration=longest[a]",
          ]
        : ["[fx]anull[a]"]),
    ];
  }
  execFileSync("ffmpeg", [
    "-y",
    "-loglevel",
    "error",
    ...inputs,
    "-filter_complex",
    graph.join(";"),
    "-map",
    "[a]",
    "-ar",
    "44100",
    out,
  ]);
  const raw = `${out}.raw.wav`;
  renameSync(out, raw);
  const before = loudness(raw).lufs;
  const gain = (m.lufs - before).toFixed(2);
  execFileSync("ffmpeg", [
    "-y",
    "-loglevel",
    "error",
    "-i",
    raw,
    "-af",
    `volume=${gain}dB,alimiter=limit=${m.limiter}:level=false`,
    "-ar",
    "44100",
    out,
  ]);
  rmSync(raw, { force: true });
  return { gainDb: Number(gain), from: before, ...loudness(out) };
}

const ts = (s: number, sep: "," | ".") => {
  const ms = Math.round(s * 1000);
  const p = (n: number, w: number) => String(n).padStart(w, "0");
  return `${p(Math.floor(ms / 3600000), 2)}:${p(Math.floor(ms / 60000) % 60, 2)}:${p(Math.floor(ms / 1000) % 60, 2)}${sep}${p(ms % 1000, 3)}`;
};
/**
 * SRT and WebVTT from the same cues that drive the burned-in captions, shifted by the hold.
 * `texts` replaces cue texts by id (a translation): those are written as given, without the pixel font's
 * `plainText` swaps, since a subtitle file never passes through the font.
 */
export function subtitles(p: LoadedProject, opts: { texts?: Record<string, string> } = {}) {
  const { hold, cues } = p.timeline;
  const post = p.doc.composition.captions.post;
  const text = (c: { id: string; text: string }) => opts.texts?.[c.id] ?? plainText(c.text);
  const srt = cues
    .map((c, i) => `${i + 1}\n${ts(c.start + hold, ",")} --> ${ts(c.end + hold + post, ",")}\n${text(c)}\n`)
    .join("\n");
  const vtt = `WEBVTT\n\n${cues.map((c) => `${ts(c.start + hold, ".")} --> ${ts(c.end + hold + post, ".")}\n${text(c)}\n`).join("\n")}`;
  return { srt, vtt };
}
