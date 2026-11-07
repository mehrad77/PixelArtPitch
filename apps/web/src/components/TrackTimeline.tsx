// The track timeline: Notes, Scenes, Picture, Text, Voice, SFX and Music against one time axis, with a playhead,
// zoom and an In/Out range. The axis runs left to right in every language (dir="ltr"). Each clip says its state in
// a word (and a pattern), never by colour alone. Nothing here scrolls or seeks unless the user does it.
// Labels follow the room a clip has: under 56 px a state glyph only (the name is in the tooltip and accessible name),
// 56–140 px the word, wider the word and the label. Words are never cut: a label that doesn't fit drops whole words.
// Planned clips are a dashed outline with no word. Tracks with nothing on them are hidden; zoom fits on mount.
import { Button, Popover } from "@shabboo/kit/react";
import { type KeyboardEvent, type PointerEvent, useLayoutEffect, useMemo, useRef } from "react";
import { CLIP_WORD, type Clip, initials, TRACKS, type TrackId } from "../lib/derive.ts";
import { clamp, FPS, timecode } from "../lib/format.ts";
import type { Playback } from "../lib/playback.ts";
import { Link } from "../lib/router.tsx";
import type { ClipState } from "../lib/types.ts";
import "./TrackTimeline.css";

const GLYPH: Record<ClipState, string> = {
  planned: "",
  drafting: "…",
  ready: "✓",
  stale: "!",
  approval: "?",
  locked: "■",
};
/** about one mono character at --step--2, in px */
const CH = 6.6;
/** the words of `text` that fit in `chars` characters, whole, with an ellipsis when some were dropped */
function fitWords(text: string, chars: number): string {
  if (text.length <= chars) return text;
  let out = "";
  for (const w of text.split(/\s+/)) {
    const next = out ? `${out} ${w}` : w;
    if (next.length + 1 > chars) break;
    out = next;
  }
  return out ? `${out}…` : "";
}

export function TrackTimeline({
  clips,
  pb,
  zoom,
  setZoom,
  inOut,
  selected,
  onSelect,
  projectId,
  narration = "none",
  folded = false,
  onFold,
}: {
  projectId: string;
  /** folded: only the bar shows, as a footer; the tracks come back with "Show" */
  folded?: boolean;
  onFold?: (folded: boolean) => void;
  /** how the narration is made; with nothing recorded yet, the Voice track is one quiet band (hidden for "none") */
  narration?: "user" | "tts" | "none";
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

  const voiceBand = narration !== "none" && !byTrack.get("voice")?.length;
  const tracks = TRACKS.filter((t) => byTrack.get(t.id)?.length || (t.id === "voice" && voiceBand));
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
  // fit once when the timeline first shows (a folded one has no width yet); after that the zoom is the person's
  const fitted = useRef(false);
  // biome-ignore lint/correctness/useExhaustiveDependencies: only when it first unfolds
  useLayoutEffect(() => {
    if (folded || fitted.current) return;
    fitted.current = true;
    fit();
  }, [folded]);

  const [i, o] = inOut;
  return (
    <section className="tracks" aria-label="Timeline" data-folded={folded ? "" : undefined}>
      <div className="tracks-bar">
        <h2 className="label">Timeline</h2>
        {onFold && (
          <Button
            size="sm"
            variant="ghost"
            className="tracks-fold"
            aria-expanded={!folded}
            aria-controls="tracks-body"
            onClick={() => onFold(!folded)}
          >
            {folded ? "Show ▴" : "Hide ▾"}
          </Button>
        )}
        {!folded && (
          <>
            <fieldset className="tracks-zoom">
              <legend className="visually-hidden">Zoom</legend>
              <Button
                size="sm"
                variant="ghost"
                aria-label="Zoom out"
                onClick={() => setZoom(clamp(zoom / 1.5, 4, 200))}
              >
                −
              </Button>
              <Button size="sm" variant="ghost" onClick={fit}>
                Fit
              </Button>
              <Button size="sm" variant="ghost" aria-label="Zoom in" onClick={() => setZoom(clamp(zoom * 1.5, 4, 200))}>
                +
              </Button>
            </fieldset>
            <Popover id="tracks-key" label="Key" variant="quiet" size="sm">
              <ul className="tracks-legend" aria-label="Clip states">
                {(Object.keys(CLIP_WORD) as ClipState[]).map((s) => (
                  <li key={s}>
                    <span className="clip legend-swatch" data-state={s} aria-hidden="true">
                      {GLYPH[s]}
                    </span>
                    {CLIP_WORD[s]}
                  </li>
                ))}
              </ul>
            </Popover>
          </>
        )}
      </div>
      <div className="tracks-body" id="tracks-body" dir="ltr" hidden={folded}>
        <div className="tracks-heads" aria-hidden="true">
          <div className="track-head ruler-head" />
          {tracks.map((t) => (
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
            {tracks.map((tr) =>
              tr.id === "voice" && voiceBand ? (
                <ul key={tr.id} className="track" aria-label="Voice track">
                  <li className="voice-band" style={{ inlineSize: `${Math.ceil(pb.duration * zoom)}px` }}>
                    <span>{narration === "user" ? "Narration not recorded" : "Narration not generated yet"}</span>
                    {narration === "user" && <Link href={`/p/${encodeURIComponent(projectId)}/record`}>Record</Link>}
                  </li>
                </ul>
              ) : (
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
                          {!c.point && <ClipText clip={c} w={w} word={word} />}
                        </button>
                      </li>
                    );
                  })}
                </ul>
              ),
            )}
            <div className="playhead" aria-hidden="true" style={{ insetInlineStart: `${pb.t * zoom}px` }} />
          </div>
        </div>
      </div>
    </section>
  );
}

function ClipText({ clip: c, w, word }: { clip: Clip; w: number; word: string }) {
  const planned = c.state === "planned";
  if (w < 56)
    return planned ? null : (
      <span className="clip-glyph" aria-hidden="true">
        {GLYPH[c.state]}
      </span>
    );
  const avatar = c.state === "drafting" && c.by && w > 140;
  const room = Math.floor((w - 12 - (avatar ? 24 : 0)) / CH);
  const shownWord = planned ? "" : word;
  const label = w > 140 || planned ? fitWords(c.label, room - (shownWord ? shownWord.length + 1 : 0)) : "";
  return (
    <>
      {avatar && c.by && (
        <span className="clip-avatar" aria-hidden="true">
          {initials(c.by)}
        </span>
      )}
      {shownWord && (
        <span className="clip-word" aria-hidden="true">
          {fitWords(shownWord, room) || GLYPH[c.state]}
        </span>
      )}
      {label && (
        <span className="clip-label" aria-hidden="true">
          {label}
        </span>
      )}
    </>
  );
}
