// The track timeline: Notes, Scenes, Picture, Text, Voice, SFX and Music against one time axis, with a playhead,
// zoom and an In/Out range. The axis runs left to right in every language (dir="ltr"). Each clip says its state in
// a word (and a pattern), never by colour alone. Nothing here scrolls or seeks unless the user does it.
import { Button } from "@shabboo/kit/react";
import { type KeyboardEvent, type PointerEvent, useMemo, useRef } from "react";
import { CLIP_WORD, type Clip, initials, TRACKS, type TrackId } from "../lib/derive.ts";
import { clamp, FPS, timecode } from "../lib/format.ts";
import type { Playback } from "../lib/playback.ts";
import "./TrackTimeline.css";

export function TrackTimeline({
  clips,
  pb,
  zoom,
  setZoom,
  inOut,
  selected,
  onSelect,
}: {
  clips: Clip[];
  pb: Playback;
  zoom: number;
  setZoom: (z: number) => void;
  inOut: [number | null, number | null];
  selected: string | null;
  onSelect: (c: Clip) => void;
}) {
  const ruler = useRef<HTMLDivElement>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const width = Math.ceil(pb.duration * zoom) + 40;
  const byTrack = useMemo(() => {
    const m = new Map<TrackId, Clip[]>();
    for (const c of clips) m.set(c.track, [...(m.get(c.track) ?? []), c]);
    return m;
  }, [clips]);

  const tick = zoom >= 80 ? 1 : zoom >= 30 ? 2 : zoom >= 12 ? 5 : 10;
  const ticks: number[] = [];
  for (let s = 0; s <= pb.duration; s += tick) ticks.push(s);

  const timeAt = (clientX: number) => {
    const r = ruler.current?.getBoundingClientRect();
    if (!r) return 0;
    return clamp((clientX - r.left) / zoom, 0, pb.duration);
  };
  const onDown = (e: PointerEvent<HTMLDivElement>) => {
    e.currentTarget.setPointerCapture(e.pointerId);
    pb.pause();
    pb.seek(timeAt(e.clientX));
  };
  const onMove = (e: PointerEvent<HTMLDivElement>) => {
    if (e.buttons & 1) pb.seek(timeAt(e.clientX));
  };
  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    const by = e.shiftKey ? FPS : 1;
    if (e.key === "ArrowLeft") pb.step(-by);
    else if (e.key === "ArrowRight") pb.step(by);
    else if (e.key === "Home") pb.seek(0);
    else if (e.key === "End") pb.seek(pb.duration);
    else return;
    e.preventDefault();
  };
  const fit = () => {
    const w = scroller.current?.clientWidth ?? 800;
    setZoom(clamp(Math.floor((w - 48) / pb.duration), 4, 200));
  };

  const [i, o] = inOut;
  return (
    <section className="tracks" aria-label="Timeline">
      <div className="tracks-bar">
        <h2 className="label">Timeline</h2>
        <fieldset className="tracks-zoom">
          <legend className="visually-hidden">Zoom</legend>
          <Button size="sm" variant="ghost" onClick={() => setZoom(clamp(zoom / 1.5, 4, 200))}>
            Zoom out
          </Button>
          <Button size="sm" variant="ghost" onClick={fit}>
            Fit
          </Button>
          <Button size="sm" variant="ghost" onClick={() => setZoom(clamp(zoom * 1.5, 4, 200))}>
            Zoom in
          </Button>
          <span className="muted small mono">{Math.round(zoom)} px/s</span>
        </fieldset>
        <ul className="tracks-legend" aria-label="Clip states">
          {(Object.keys(CLIP_WORD) as (keyof typeof CLIP_WORD)[]).map((s) => (
            <li key={s}>
              <span className="clip legend-swatch" data-state={s} aria-hidden="true" />
              {CLIP_WORD[s]}
            </li>
          ))}
        </ul>
      </div>
      <div className="tracks-body" dir="ltr">
        <div className="tracks-heads" aria-hidden="true">
          <div className="track-head ruler-head" />
          {TRACKS.map((t) => (
            <div key={t.id} className="track-head">
              {t.label}
            </div>
          ))}
        </div>
        <div className="tracks-scroll" ref={scroller}>
          <div className="tracks-canvas" style={{ inlineSize: `${width}px` }}>
            <div
              ref={ruler}
              className="ruler"
              role="slider"
              tabIndex={0}
              aria-label="Playhead"
              aria-valuemin={0}
              aria-valuemax={Math.round(pb.duration * 100) / 100}
              aria-valuenow={Math.round(pb.t * 100) / 100}
              aria-valuetext={timecode(pb.t)}
              onPointerDown={onDown}
              onPointerMove={onMove}
              onKeyDown={onKey}
            >
              {ticks.map((s) => (
                <span key={s} className="ruler-tick" style={{ insetInlineStart: `${s * zoom}px` }}>
                  {s}s
                </span>
              ))}
            </div>
            {(i != null || o != null) && (
              <div
                className="io-range"
                aria-hidden="true"
                style={{
                  insetInlineStart: `${(i ?? 0) * zoom}px`,
                  inlineSize: `${Math.max(1, ((o ?? pb.duration) - (i ?? 0)) * zoom)}px`,
                }}
              />
            )}
            {TRACKS.map((tr) => (
              <ul key={tr.id} className="track" aria-label={`${tr.label} track`}>
                {(byTrack.get(tr.id) ?? []).map((c) => {
                  const left = c.from * zoom;
                  const w = Math.max(c.point ? 10 : 4, (c.to - c.from) * zoom);
                  const word = CLIP_WORD[c.state];
                  const name = `${c.label}, ${word}, ${timecode(c.from)}${c.point ? "" : ` to ${timecode(c.to)}`}`;
                  return (
                    <li
                      key={c.id}
                      className="clip-slot"
                      style={{ insetInlineStart: `${left - (c.point ? 5 : 0)}px`, inlineSize: `${w}px` }}
                    >
                      <button
                        type="button"
                        className={`clip${c.point ? " point" : ""}`}
                        data-state={c.state}
                        data-kind={c.kind}
                        aria-pressed={selected === c.id}
                        aria-label={name}
                        title={name}
                        onClick={() => {
                          pb.pause();
                          pb.seek(c.from);
                          onSelect(c);
                        }}
                      >
                        {!c.point && (
                          <>
                            {c.state === "drafting" && c.by && (
                              <span className="clip-avatar" aria-hidden="true">
                                {initials(c.by)}
                              </span>
                            )}
                            <span className="clip-word" aria-hidden="true">
                              {word}
                            </span>
                            <span className="clip-label" aria-hidden="true">
                              {c.label}
                            </span>
                          </>
                        )}
                      </button>
                    </li>
                  );
                })}
              </ul>
            ))}
            <div className="playhead" aria-hidden="true" style={{ insetInlineStart: `${pb.t * zoom}px` }} />
          </div>
        </div>
      </div>
    </section>
  );
}
