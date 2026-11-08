// The live canvas (Settings › Experimental): the grid a Pixel Artist is drawing, painted a whole row at a time as its
// answer streams, at 6× in whole cells (nearest neighbour). The colours are the drawing's own palette, as the
// `progress` event sends it (letters → colours); "." stays clear over the sunken well. The canvas is an image named
// for what it shows so far; the step's words say the rest in text.
import { useEffect, useRef } from "react";
import { liveFrame } from "../lib/draft.ts";
import { n } from "../lib/format.ts";

export function LiveCanvas({
  draft,
  palette,
  scale = 6,
  label,
}: {
  draft: string;
  palette?: Record<string, string>;
  scale?: number;
  /** what it shows, for the figure's caption ("variant 2, frame idle0 · 7 rows") */
  label?: string;
}) {
  const ref = useRef<HTMLCanvasElement>(null);
  const frame = liveFrame(draft);
  const w = frame ? Math.max(...frame.rows.map((r) => r.length)) : 0;
  const h = frame?.rows.length ?? 0;
  const key = frame ? `${frame.name}|${frame.rows.length}|${frame.rows.at(-1)}` : "";
  // biome-ignore lint/correctness/useExhaustiveDependencies: repaints when a row lands
  useEffect(() => {
    const c = ref.current;
    const g = c?.getContext("2d");
    if (!c || !g || !frame) return;
    g.clearRect(0, 0, c.width, c.height);
    frame.rows.forEach((row, y) => {
      for (let x = 0; x < row.length; x++) {
        const ink = palette?.[row[x]];
        if (!ink || row[x] === ".") continue;
        g.fillStyle = ink;
        g.fillRect(x * scale, y * scale, scale, scale);
      }
    });
  }, [key, scale, palette]);
  if (!frame || !w) return null;
  return (
    <figure className="live-canvas">
      <canvas
        ref={ref}
        width={w * scale}
        height={h * scale}
        role="img"
        aria-label={`The grid so far: ${frame.name}, ${n(h)} ${h === 1 ? "row" : "rows"}`}
      />
      <figcaption className="small muted">
        <bdi>{label ? `${label} · ` : ""}</bdi>
        <bdi className="ltr" translate="no">
          {frame.name}
        </bdi>
        {" · "}
        <bdi>
          {n(h)} {h === 1 ? "row" : "rows"} so far
        </bdi>
      </figcaption>
    </figure>
  );
}
