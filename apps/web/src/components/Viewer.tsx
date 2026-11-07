// The viewer: a 320×180 canvas scaled with nearest-neighbour. Scrubbing draws server frames (GET …/frame?t=);
// playback uses the proxy mp4 when one exists, or steps through frames at a lower rate when it doesn't.
// `minimal` (the simple view) keeps only the picture and one play/scrub bar; the paused frame is a button that
// asks what should change there (onSteer).
import { Badge, Button, Icon } from "@shabboo/kit/react";
import { useEffect, useRef, useState } from "react";
import { client } from "../lib/client.ts";
import { FPS, timecode } from "../lib/format.ts";
import { mss, VERSION_WORD } from "../lib/human.ts";
import type { Playback } from "../lib/playback.ts";
import type { ProjectState } from "../lib/types.ts";
import "./Viewer.css";

const SLOW_FPS = 8;

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
  useEffect(() => setProxyOk(true), [proxy]);
  const useVideo = !!proxy && proxyOk && pb.playing && pb.rate > 0 && !compare;
  /** the proxy has the still first frame (composition.hold) baked in; the playhead is in scene time */
  const hold = tl.hold ?? 0;
  const inFlight = useRef(false);
  const latest = useRef<string | null>(null);

  // draw the frame at the playhead (latest request wins; throttled while stepping through frames); a new version
  // of the scene under the playhead redraws it
  // biome-ignore lint/correctness/useExhaustiveDependencies: status.version and status.stale trigger the redraw
  useEffect(() => {
    if (useVideo) return;
    const now = performance.now();
    if (pb.playing && now - lastDraw.current < 1000 / SLOW_FPS) return;
    lastDraw.current = now;
    const src = client.frameUrl(projectId, Math.round(pb.t * FPS) / FPS, 2, compare ? state.rev - 1 : undefined);
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
        if (want.current === url && canvas.current) {
          const c = canvas.current.getContext("2d");
          if (c) {
            c.imageSmoothingEnabled = false;
            c.clearRect(0, 0, 320, 180);
            c.drawImage(img, 0, 0, 320, 180);
            setFrameError(false);
          }
        }
        done();
      };
      img.onerror = () => {
        if (want.current === url) setFrameError(true);
        done();
      };
      img.src = url;
    };
    if (inFlight.current) latest.current = src;
    else load(src);
  }, [pb.t, pb.playing, projectId, compare, state.rev, useVideo, status?.version, status?.stale]);

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
    v.currentTime = pb.t + hold;
    v.playbackRate = pb.rate;
    v.play().catch(() => {
      pb.external(false);
      setProxyOk(false);
    });
    let raf = 0;
    const loop = () => {
      pb.report(v.currentTime - hold);
      const c = canvas.current?.getContext("2d");
      if (c && v.readyState >= 2) {
        c.imageSmoothingEnabled = false;
        c.drawImage(v, 0, 0, 320, 180);
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
  const mode = useVideo ? "Proxy" : pb.playing ? `Frames, ${SLOW_FPS} fps` : "Frame";

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
          {frameError && (
            <p className="viewer-error" role="status">
              This frame didn't render. The crew may still be drawing this scene; try another point or wait for the next
              still.
            </p>
          )}
        </div>
        {proxy && (
          <video ref={video} src={proxy} muted playsInline preload="auto" hidden onError={() => setProxyOk(false)} />
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
