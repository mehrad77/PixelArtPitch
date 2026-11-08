// The viewer: a 320×180 canvas scaled with nearest-neighbour. Scrubbing draws server frames (GET …/frame?t=);
// playback uses the rough cut with sound (the proxy mp4 the review writes) when one exists, unmuted once the person
// presses Play, or steps through frames at a lower rate when it doesn't ("Silent preview, frame by frame"). The first
// press always answers at once: the button turns to Pause and the frame says it is loading. A scene being redrawn
// (stale) or a frame that fails keeps the last good frame on screen, never an empty sky. `minimal` (the simple view)
// keeps only the picture and one play/scrub bar; the paused frame is a button that asks what should change there
// (onSteer).
import { Badge, Button, Icon } from "@shabboo/kit/react";
import { useEffect, useRef, useState } from "react";
import { client } from "../lib/client.ts";
import { FPS, timecode } from "../lib/format.ts";
import { mss, VERSION_WORD } from "../lib/human.ts";
import type { Playback } from "../lib/playback.ts";
import type { ProjectState } from "../lib/types.ts";
import "./Viewer.css";

const SLOW_FPS = 8;
/** the last good frames kept, so a scene being redrawn (or a frame that fails) shows what was there */
const KEEP_FRAMES = 360;

export type Overlays = { safe: boolean; captions: boolean; grid: boolean };

export function Viewer({
  projectId,
  state,
  pb,
  proxy,
  overlays,
  setOverlays,
  compare,
  setCompare,
  inOut,
  minimal = false,
  onSteer,
}: {
  projectId: string;
  state: ProjectState;
  pb: Playback;
  proxy: string | null;
  overlays: Overlays;
  setOverlays: (o: Overlays) => void;
  compare: boolean;
  setCompare: (on: boolean) => void;
  inOut: [number | null, number | null];
  /** the simple view: no overlays, timecode or frame steps; one play/scrub bar */
  minimal?: boolean;
  /** minimal only: the paused frame was pressed at (x, y) in the viewport */
  onSteer?: (t: number, x: number, y: number) => void;
}) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const video = useRef<HTMLVideoElement>(null);
  const [frameError, setFrameError] = useState(false);
  /** the first frame after Play hasn't landed yet: the frame says it is loading */
  const [starting, setStarting] = useState(false);
  /** the proxy has a picture track (a WAV or a video that won't decode has none: the frames draw the picture) */
  const [picture, setPicture] = useState(true);
  /** the browser kept the sound off (autoplay rules): it plays muted and says so */
  const [muted, setMuted] = useState(false);
  /** the last good frame per frame number, and the scene each belongs to */
  const good = useRef(new Map<number, { img: HTMLImageElement; scene?: string }>());
  const soundOnly = useRef(false);
  const painted = useRef(false);
  const lastDraw = useRef(0);
  const want = useRef<string>("");
  const tl = state.timeline;
  const scene = tl.scenes.find((s) => pb.t >= s.from && pb.t < s.to) ?? tl.scenes.at(-1);
  const status = scene ? state.sceneStatus?.[scene.id] : undefined;
  const cue = tl.cues.find((c) => pb.t >= c.start && pb.t <= c.end);
  // captions burned into the pixels already show the cue; the overlay is only a stand-in when they are off
  const burned = (state.doc as any).composition?.captions?.enabled !== false;
  const sceneTitle = scene ? state.doc.scenes.find((s) => s.id === scene.id)?.title || scene.id : "";
  const [proxyOk, setProxyOk] = useState(true);
  // a new proxy URL gets a fresh chance to play
  // biome-ignore lint/correctness/useExhaustiveDependencies: proxy is the trigger
  useEffect(() => {
    setProxyOk(true);
    setPicture(true);
    setMuted(false);
    soundOnly.current = false;
  }, [proxy]);
  const useVideo = !!proxy && proxyOk && pb.playing && pb.rate > 0 && !compare;
  /** the video paints the canvas; without a picture track the frames do, while the sound keeps the time */
  const videoPaints = useVideo && picture;
  // the first press answers at once: Pause shows, and the frame says it's loading until a frame lands
  useEffect(() => {
    if (pb.playing) setStarting(true);
    else setStarting(false);
  }, [pb.playing]);
  /** the proxy has the still first frame (composition.hold) baked in; the playhead is in scene time */
  const hold = tl.hold ?? 0;
  const inFlight = useRef(false);
  const latest = useRef<string | null>(null);

  // draw the frame at the playhead (latest request wins; throttled while stepping through frames); a new version
  // of the scene under the playhead redraws it
  // biome-ignore lint/correctness/useExhaustiveDependencies: status.version and status.stale trigger the redraw
  useEffect(() => {
    if (videoPaints) return;
    const now = performance.now();
    if (pb.playing && now - lastDraw.current < 1000 / SLOW_FPS) return;
    lastDraw.current = now;
    const n = Math.round(pb.t * FPS);
    const paint = (img: HTMLImageElement) => {
      const c = canvas.current?.getContext("2d");
      if (!c) return;
      c.imageSmoothingEnabled = false;
      c.clearRect(0, 0, 320, 180);
      c.drawImage(img, 0, 0, 320, 180);
    };
    // a scene being redrawn: the server's frame there is empty sky, so the last good one of that scene stays
    if (status?.stale && !compare) {
      const kept = nearestKept(good.current, n, scene?.id);
      if (kept) {
        want.current = "";
        paint(kept);
        setFrameError(false);
        setStarting(false);
        return;
      }
    }
    // nothing kept for a scene being redrawn (a fresh visit): the revision before the change, which still has it
    const older = compare || (status?.stale && state.rev > 0) ? state.rev - 1 : undefined;
    const src = client.frameUrl(projectId, n / FPS, 2, older);
    if (!src) return;
    want.current = src;
    // one request in flight; when it lands, fetch the newest frame asked for meanwhile
    const load = (url: string) => {
      inFlight.current = true;
      const img = new Image();
      img.decoding = "async";
      const done = () => {
        inFlight.current = false;
        const next = latest.current;
        latest.current = null;
        if (next && next !== url) load(next);
      };
      img.onload = () => {
        if (!compare && !status?.stale) {
          const keep = good.current;
          keep.set(n, { img, scene: scene?.id });
          if (keep.size > KEEP_FRAMES) keep.delete(keep.keys().next().value as number);
        }
        if (want.current === url) {
          paint(img);
          setFrameError(false);
          setStarting(false);
        }
        done();
      };
      img.onerror = () => {
        // the canvas keeps the last good frame; a quiet note says this one isn't there
        if (want.current === url) {
          setFrameError(true);
          setStarting(false);
        }
        done();
      };
      img.src = url;
    };
    if (inFlight.current) latest.current = src;
    else load(src);
  }, [pb.t, pb.playing, projectId, compare, state.rev, videoPaints, status?.version, status?.stale]);

  // the proxy video drives the clock while it plays, and paints into the canvas
  // biome-ignore lint/correctness/useExhaustiveDependencies: restart only when the playback mode or rate changes
  useEffect(() => {
    const v = video.current;
    if (!v || !useVideo) {
      pb.external(false);
      v?.pause();
      return;
    }
    pb.external(true);
    painted.current = false;
    v.currentTime = pb.t + hold;
    v.playbackRate = pb.rate;
    // the person pressed Play: the rough cut plays with its sound (React's `muted` can't be relied on to unmute)
    v.muted = false;
    v.volume = 1;
    v.play().then(
      () => setMuted(false),
      (e: DOMException) => {
        // a browser that blocks sound plays it muted, and the bar says so; anything else falls back to the frames
        if (e?.name === "NotAllowedError") {
          v.muted = true;
          setMuted(true);
          v.play().catch(() => {
            pb.external(false);
            setProxyOk(false);
          });
          return;
        }
        pb.external(false);
        setProxyOk(false);
      },
    );
    let raf = 0;
    const loop = () => {
      pb.report(v.currentTime - hold);
      const c = canvas.current?.getContext("2d");
      // no picture track (sound only): the frames effect paints, the sound keeps the time
      if (v.readyState >= 1 && !v.videoWidth && !soundOnly.current) {
        soundOnly.current = true;
        setPicture(false);
      }
      if (c && v.readyState >= 2 && v.videoWidth) {
        c.imageSmoothingEnabled = false;
        c.drawImage(v, 0, 0, 320, 180);
        if (!painted.current) {
          painted.current = true;
          setStarting(false);
        }
      }
      if (v.ended) pb.pause();
      else raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => {
      cancelAnimationFrame(raf);
      v.pause();
      pb.external(false);
    };
  }, [useVideo, pb.rate]);

  const toggle = (k: keyof Overlays) => setOverlays({ ...overlays, [k]: !overlays[k] });
  const mode = useVideo
    ? muted
      ? "Rough cut, sound off"
      : "Rough cut with sound"
    : pb.playing
      ? `Frames, ${SLOW_FPS} fps`
      : "Frame";
  /** what playing gives you, said under the picture: with sound, or the silent frame-by-frame preview */
  const how =
    proxy && proxyOk && !compare
      ? muted
        ? "Your browser kept the sound off. Press Pause, then Play, to hear it."
        : "Rough cut with sound"
      : "Silent preview, frame by frame";

  return (
    <section className="viewer" aria-label="Viewer">
      <div className="viewer-stage">
        <div className="viewer-frame" dir="ltr">
          <canvas
            ref={canvas}
            width={320}
            height={180}
            className="pixelated"
            role="img"
            aria-label={`Frame at ${timecode(pb.t)}${sceneTitle ? `, ${sceneTitle}` : ""}`}
          />
          {minimal && (
            <button
              type="button"
              className="viewer-hit"
              aria-label={
                pb.playing
                  ? "Pause"
                  : `Frame at ${mss(pb.t)}${sceneTitle ? `, ${sceneTitle}` : ""}. Say what should change here`
              }
              onClick={(e) => {
                if (pb.playing) return pb.pause();
                const r = e.currentTarget.getBoundingClientRect();
                // a keyboard press has no pointer position: open it in the middle of the frame
                const x = e.detail === 0 ? r.left + r.width / 2 : e.clientX;
                const y = e.detail === 0 ? r.top + r.height / 2 : e.clientY;
                onSteer?.(pb.t, x, y);
              }}
            />
          )}
          {overlays.grid && <div className="ov-grid" aria-hidden="true" />}
          {overlays.safe && (
            <div className="ov-safe" aria-hidden="true">
              <div className="ov-safe-title" />
            </div>
          )}
          {overlays.captions && !burned && cue && (
            <p className="ov-caption" aria-hidden="true">
              {cue.text}
            </p>
          )}
          {!minimal && (
            <div className="viewer-tags">
              {status ? (
                <Badge tone={status.version === "render" ? "accent" : "muted"} variant="pill">
                  {VERSION_WORD[status.version]}
                </Badge>
              ) : (
                <Badge tone="muted">Slate</Badge>
              )}
              {status?.stale && <Badge tone="warning">Needs update</Badge>}
              {compare && <Badge tone="signal">Before (rev {state.rev - 1})</Badge>}
            </div>
          )}
          {starting && (
            <p className="viewer-loading small" role="status">
              <span className="viewer-spinner" aria-hidden="true" />
              {useVideo ? "Starting the rough cut…" : "Loading frames…"}
            </p>
          )}
          {status?.stale && !compare && (
            <p className="viewer-note small" aria-hidden={minimal ? undefined : "true"}>
              Redrawing this scene · showing the last good frame
            </p>
          )}
          {frameError && !status?.stale && (
            <p className="viewer-note small" role="status">
              {"This frame isn't drawn yet"}
              {good.current.size ? " · showing the last good one" : ". Try another point, or wait for the next still"}
            </p>
          )}
        </div>
        {proxy && (
          // the sound and the picture of the rough cut; the canvas shows the picture, whose captions are burned in
          // biome-ignore lint/a11y/useMediaCaption: hidden; the captions are in the pixels the canvas shows
          <video
            ref={video}
            className="viewer-media"
            src={proxy}
            playsInline
            preload="auto"
            hidden
            onError={() => setProxyOk(false)}
            onLoadedMetadata={(e) => setPicture(e.currentTarget.videoWidth > 0)}
          />
        )}
      </div>
      {minimal ? (
        <div className="viewer-bar viewer-min">
          <Button size="sm" variant="primary" onClick={pb.toggle} aria-label={pb.playing ? "Pause" : "Play"}>
            <Icon name={pb.playing ? "pause" : "play"} />
          </Button>
          <input
            type="range"
            className="viewer-scrub"
            aria-label="Position"
            min={0}
            max={pb.duration}
            step={1 / FPS}
            value={pb.t}
            aria-valuetext={`${mss(pb.t)} of ${mss(pb.duration)}`}
            onChange={(e) => {
              pb.pause();
              pb.seek(Number(e.currentTarget.value));
            }}
          />
          <span className="muted small mono" aria-hidden="true">
            {mss(pb.t)} / {mss(pb.duration)}
          </span>
          <span className="viewer-how small" data-sound={proxy && proxyOk && !muted ? "" : undefined}>
            {proxy && proxyOk && !muted ? <Icon name="music" size="sm" /> : null}
            {how}
          </span>
        </div>
      ) : (
        <fieldset className="viewer-bar">
          <legend className="visually-hidden">Transport</legend>
          <output className="timecode mono" aria-label="Timecode">
            {timecode(pb.t)} <span className="muted">/ {timecode(pb.duration)}</span>
          </output>
          <span className="muted small viewer-scene">{sceneTitle}</span>
          <div className="transport">
            <Button size="sm" variant="ghost" onClick={() => pb.seek(0)}>
              Start
            </Button>
            <Button size="sm" variant="ghost" onClick={() => pb.step(-1)} aria-label="Previous frame">
              <Icon name="arrow-left" />
            </Button>
            <Button size="sm" variant="primary" onClick={pb.toggle} aria-label={pb.playing ? "Pause" : "Play"}>
              <Icon name={pb.playing ? "pause" : "play"} />
            </Button>
            <Button size="sm" variant="ghost" onClick={() => pb.step(1)} aria-label="Next frame">
              <Icon name="arrow-right" />
            </Button>
            {pb.playing && Math.abs(pb.rate) !== 1 && <span className="mono small">{pb.rate}×</span>}
          </div>
          <fieldset className="overlays">
            <legend className="visually-hidden">Overlays</legend>
            <Button size="sm" variant="ghost" aria-pressed={overlays.safe} onClick={() => toggle("safe")}>
              Safe area
            </Button>
            {!burned && (
              <Button size="sm" variant="ghost" aria-pressed={overlays.captions} onClick={() => toggle("captions")}>
                Captions
              </Button>
            )}
            <Button size="sm" variant="ghost" aria-pressed={overlays.grid} onClick={() => toggle("grid")}>
              Pixel grid
            </Button>
            <Button
              size="sm"
              variant="ghost"
              aria-pressed={compare}
              onClick={() => setCompare(!compare)}
              disabled={state.rev < 1}
            >
              Before / after
            </Button>
          </fieldset>
          <span className="muted small">
            {mode}
            {(inOut[0] != null || inOut[1] != null) &&
              ` · In ${inOut[0] != null ? timecode(inOut[0]) : "–"} Out ${inOut[1] != null ? timecode(inOut[1]) : "–"}`}
          </span>
        </fieldset>
      )}
    </section>
  );
}

/** the kept frame nearest to frame `n` in the same scene, or null */
function nearestKept(
  keep: Map<number, { img: HTMLImageElement; scene?: string }>,
  n: number,
  scene?: string,
): HTMLImageElement | null {
  let best: { d: number; img: HTMLImageElement } | null = null;
  for (const [k, v] of keep) {
    if (scene && v.scene !== scene) continue;
    const d = Math.abs(k - n);
    if (!best || d < best.d) best = { d, img: v.img };
  }
  return best?.img ?? null;
}
