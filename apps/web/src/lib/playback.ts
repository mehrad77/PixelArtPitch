// The playhead: one clock the viewer, the timeline and the shortcuts share. It moves only while the user plays,
// shuttles or seeks; nothing the crew does moves it.
import { useCallback, useEffect, useRef, useState } from "react";
import { clamp, FPS } from "./format.ts";

export type Playback = {
  t: number;
  playing: boolean;
  /** 1, 2, 4 forward; -1, -2, -4 backward (J/K/L) */
  rate: number;
  seek: (t: number) => void;
  step: (frames: number) => void;
  play: (rate?: number) => void;
  pause: () => void;
  toggle: () => void;
  /** J and L: each press doubles the speed in that direction, up to 4× */
  shuttle: (dir: 1 | -1) => void;
  /** a media element drives the clock while it plays (the proxy video); it reports time here */
  external: (on: boolean) => void;
  report: (t: number) => void;
  duration: number;
};

export function usePlayback(duration: number): Playback {
  const [t, setT] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [rate, setRate] = useState(1);
  const ext = useRef(false);
  const tRef = useRef(0);
  tRef.current = t;
  const dur = Math.max(0.1, duration);

  useEffect(() => {
    if (!playing) return;
    let raf = 0;
    let last = performance.now();
    const loop = (now: number) => {
      const dt = (now - last) / 1000;
      last = now;
      if (!ext.current) {
        const next = tRef.current + dt * rate;
        if (next >= dur || next <= 0) {
          setT(clamp(next, 0, dur));
          setPlaying(false);
          return;
        }
        setT(next);
      }
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [playing, rate, dur]);

  const seek = useCallback((x: number) => setT(clamp(x, 0, dur)), [dur]);
  const step = useCallback(
    (frames: number) => {
      setPlaying(false);
      setT((cur) => clamp(Math.round(cur * FPS + frames) / FPS, 0, dur));
    },
    [dur],
  );
  const play = useCallback(
    (r = 1) => {
      setRate(r);
      if (r > 0 && tRef.current >= dur - 0.01) setT(0);
      setPlaying(true);
    },
    [dur],
  );
  const pause = useCallback(() => setPlaying(false), []);
  const toggle = useCallback(() => (playing ? setPlaying(false) : play(1)), [playing, play]);
  const shuttle = useCallback(
    (dir: 1 | -1) => {
      const same = playing && Math.sign(rate) === dir;
      const next = same ? Math.min(4, Math.abs(rate) * 2) * dir : dir;
      play(next);
    },
    [playing, rate, play],
  );
  return {
    t,
    playing,
    rate,
    seek,
    step,
    play,
    pause,
    toggle,
    shuttle,
    external: (on) => {
      ext.current = on;
    },
    report: (x) => setT(clamp(x, 0, dur)),
    duration: dur,
  };
}
