// A take's waveform: decoded in the browser (Web Audio), drawn as whole-pixel bars in SVG.
import { useEffect, useState } from "react";
import "./Waveform.css";

const cache = new Map<string, number[]>();

async function peaksOf(src: string, n: number): Promise<number[]> {
  const key = `${src}|${n}`;
  const hit = cache.get(key);
  if (hit) return hit;
  const buf = await (await fetch(src)).arrayBuffer();
  const ctx = new OfflineAudioContext(1, 1, 44100);
  const audio = await ctx.decodeAudioData(buf);
  const data = audio.getChannelData(0);
  const step = Math.max(1, Math.floor(data.length / n));
  const out: number[] = [];
  for (let i = 0; i < n; i++) {
    let m = 0;
    for (let j = i * step; j < Math.min(data.length, (i + 1) * step); j++) m = Math.max(m, Math.abs(data[j]));
    out.push(m);
  }
  cache.set(key, out);
  return out;
}

export function Waveform({
  src,
  peaks: given,
  label,
  bars = 96,
}: {
  src?: string;
  peaks?: number[];
  label: string;
  bars?: number;
}) {
  const [peaks, setPeaks] = useState<number[] | null>(given ?? null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    if (given || !src) return;
    let live = true;
    peaksOf(src, bars).then(
      (p) => live && setPeaks(p),
      () => live && setFailed(true),
    );
    return () => {
      live = false;
    };
  }, [src, given, bars]);
  if (failed) return <span className="muted small">No waveform: the file didn't decode.</span>;
  if (!peaks) return <span className="waveform waveform-empty" aria-hidden="true" />;
  const max = Math.max(0.001, ...peaks);
  return (
    <svg
      className="waveform"
      viewBox={`0 0 ${peaks.length * 2} 24`}
      preserveAspectRatio="none"
      role="img"
      aria-label={label}
      shapeRendering="crispEdges"
    >
      {peaks.map((p, i) => {
        const h = Math.max(1, Math.round((p / max) * 22));
        // biome-ignore lint/suspicious/noArrayIndexKey: bars are positional
        return <rect key={i} x={i * 2} y={12 - Math.ceil(h / 2)} width={1} height={h} />;
      })}
    </svg>
  );
}
