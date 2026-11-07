// The record page: the proof-of-concept prompter (muted video, big now/next synced to WebVTT, 3-2-1 count-in,
// 0.75×/1×, Space / R / ←→ 5 s) plus a mic picker with a level meter, takes for the whole script or one cue
// (2 s pre-roll) uploaded to POST /vo, Audacity import, and Align, whose proposal is approved as a patch.
import { Badge, Button, Callout, Checkbox, Field, HudMeter, Kbd, Skeleton, Table } from "@shabboo/kit/react";
import { type RefObject, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { type PromptCue, parseVtt, Teleprompter } from "../components/Teleprompter.tsx";
import { Waveform } from "../components/Waveform.tsx";
import { client } from "../lib/client.ts";
import { bytes, secs } from "../lib/format.ts";
import { isControlTarget, useProject } from "../lib/hooks.ts";
import { Link } from "../lib/router.tsx";
import type { PatchOpT, ProjectState } from "../lib/types.ts";
import "./Record.css";

const PREROLL = 2;

type Take = {
  name: string;
  scope: string;
  durationSec: number;
  size: number;
  url: string;
  status: "uploading" | "saved" | "failed";
  file?: string;
  error?: string;
};
type Proposal = { cue: string; start: number; end: number }[];

/** the prompter's clock: the video when there is one, else a virtual clock with the same controls */
function useClock(video: RefObject<HTMLVideoElement | null>, hasVideo: boolean, duration: number) {
  const [t, setT] = useState(0);
  const [playing, setPlaying] = useState(false);
  const v = useRef({ t: 0, at: 0, rate: 1, playing: false });
  useEffect(() => {
    const id = setInterval(() => {
      if (hasVideo && video.current) {
        setT(video.current.currentTime);
        setPlaying(!video.current.paused);
        return;
      }
      const s = v.current;
      if (s.playing) {
        const now = performance.now();
        s.t = Math.min(duration, s.t + ((now - s.at) / 1000) * s.rate);
        s.at = now;
        if (s.t >= duration) s.playing = false;
      }
      setT(s.t);
      setPlaying(s.playing);
    }, 80);
    return () => clearInterval(id);
  }, [hasVideo, video, duration]);
  return {
    t,
    playing,
    play: () => {
      if (hasVideo && video.current) return void video.current.play();
      v.current.playing = true;
      v.current.at = performance.now();
    },
    pause: () => {
      if (hasVideo && video.current) return video.current.pause();
      v.current.playing = false;
    },
    seek: (x: number) => {
      const c = Math.max(0, Math.min(duration, x));
      if (hasVideo && video.current) video.current.currentTime = c;
      v.current.t = c;
      v.current.at = performance.now();
      setT(c);
    },
    setRate: (r: number) => {
      if (video.current) video.current.playbackRate = r;
      // bank the time played at the old rate before switching
      const now = performance.now();
      if (v.current.playing) v.current.t += ((now - v.current.at) / 1000) * v.current.rate;
      v.current.at = now;
      v.current.rate = r;
    },
  };
}

export function RecordPage({ id }: { id: string }) {
  const view = useProject(id);
  if (view.error && !view.state)
    return (
      <main id="main" className="page-narrow">
        <Callout tone="error" title="This project didn't open">
          {view.error.message}. Go back to <Link href="/">Projects</Link> and open it again.
        </Callout>
      </main>
    );
  if (!view.state)
    return (
      <main id="main" className="page" aria-busy="true">
        <Skeleton lines={5} label="Opening the record page" />
      </main>
    );
  return <Recorder id={id} state={view.state} proxy={view.proxy} />;
}

function Recorder({ id, state, proxy }: { id: string; state: ProjectState; proxy: string | null }) {
  const videoFile = state.files.find((f) => f.kind === "video" && f.url);
  const vttFile = state.files.find((f) => f.kind === "subtitles" && f.name.endsWith(".vtt") && f.url);
  const videoSrc = videoFile?.url || proxy || (client.mock ? "" : client.proxyUrl(id));
  const [videoOk, setVideoOk] = useState(!!videoSrc);
  const video = useRef<HTMLVideoElement>(null);
  const [vttCues, setVttCues] = useState<PromptCue[] | null>(null);
  // a rendered video carries the still first frame (composition.hold); timeline cues are in scene time, so they
  // shift by the hold when a video drives the clock. VTT cues are already in video time.
  const usingVideo = videoOk && !!videoSrc;
  const hold = usingVideo ? state.timeline.hold : 0;
  const cues: PromptCue[] = useMemo(
    () => vttCues ?? state.timeline.cues.map((c) => ({ ...c, start: c.start + hold, end: c.end + hold })),
    [vttCues, state.timeline.cues, hold],
  );
  const duration = state.timeline.duration + hold;
  const clock = useClock(video, usingVideo, duration);
  const [countInOn, setCountInOn] = useState(true);
  const [countIn, setCountIn] = useState<number | null>(null);
  const [sound, setSound] = useState(false);
  const [rate, setRate] = useState(1);

  useEffect(() => {
    if (!vttFile) return;
    fetch(vttFile.url)
      .then((r) => (r.ok ? r.text() : Promise.reject(new Error(String(r.status)))))
      .then(
        (x) => setVttCues(parseVtt(x)),
        () => setVttCues(null),
      );
  }, [vttFile]);

  const countThenPlay = useCallback(async () => {
    if (countInOn) {
      for (const n of [3, 2, 1]) {
        setCountIn(n);
        await new Promise((r) => setTimeout(r, 800));
      }
      setCountIn(null);
    }
    clock.play();
  }, [countInOn, clock]);
  const toggle = useCallback(async () => {
    if (clock.playing) return clock.pause();
    if (clock.t < 0.2) await countThenPlay();
    else clock.play();
  }, [clock, countThenPlay]);

  // ---- mic, level meter, takes ----
  const [mics, setMics] = useState<MediaDeviceInfo[]>([]);
  const [mic, setMic] = useState("");
  const [stream, setStream] = useState<MediaStream | null>(null);
  const [micErr, setMicErr] = useState<string | null>(null);
  const [level, setLevel] = useState(0);
  const [recording, setRecording] = useState<{ scope: string; until: number | null } | null>(null);
  const rec = useRef<MediaRecorder | null>(null);
  const startedAt = useRef(0);
  const [takes, setTakes] = useState<Take[]>([]);
  const [cueChoice, setCueChoice] = useState(cues[0]?.id ?? "");
  const [proposal, setProposal] = useState<{ file: string; rows: Proposal } | null>(null);
  const [alignErr, setAlignErr] = useState<string | null>(null);
  const [aligning, setAligning] = useState(false);
  const [applied, setApplied] = useState<string | null>(null);

  const openMic = useCallback(async (deviceId?: string) => {
    setMicErr(null);
    try {
      const s = await navigator.mediaDevices.getUserMedia({
        audio: deviceId ? { deviceId: { exact: deviceId } } : true,
      });
      setStream((old) => {
        for (const tr of old?.getTracks() ?? []) tr.stop();
        return s;
      });
      const list = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === "audioinput");
      setMics(list);
      setMic(deviceId ?? s.getAudioTracks()[0]?.getSettings().deviceId ?? "");
    } catch (e) {
      setMicErr(
        `${(e as Error).message || "The microphone didn't open"}. Allow microphone access for this page in the browser's site settings, then try again.`,
      );
    }
  }, []);
  useEffect(
    () => () => {
      for (const t of stream?.getTracks() ?? []) t.stop();
    },
    [stream],
  );

  // input level, read from an analyser about 12 times a second
  useEffect(() => {
    if (!stream) return;
    const ctx = new AudioContext();
    const src = ctx.createMediaStreamSource(stream);
    const an = ctx.createAnalyser();
    an.fftSize = 1024;
    src.connect(an);
    const buf = new Float32Array(an.fftSize);
    const id = setInterval(() => {
      an.getFloatTimeDomainData(buf);
      let peak = 0;
      for (const x of buf) peak = Math.max(peak, Math.abs(x));
      const db = 20 * Math.log10(Math.max(1e-4, peak));
      setLevel(Math.round(Math.max(0, Math.min(100, ((db + 60) / 60) * 100))));
    }, 80);
    return () => {
      clearInterval(id);
      ctx.close();
    };
  }, [stream]);

  const upload = useCallback(
    async (blob: Blob, name: string, scope: string, durationSec: number) => {
      const url = URL.createObjectURL(blob);
      setTakes((t) => [...t, { name, scope, durationSec, size: blob.size, url, status: "uploading" }]);
      try {
        const { file } = await client.uploadVo(id, blob, name);
        setTakes((t) => t.map((x) => (x.name === name ? { ...x, status: "saved", file } : x)));
      } catch (e) {
        setTakes((t) =>
          t.map((x) =>
            x.name === name
              ? {
                  ...x,
                  status: "failed",
                  error: `${(e as Error).message}. The take is kept here; check the server and upload it again.`,
                }
              : x,
          ),
        );
      }
    },
    [id],
  );

  const stopTake = useCallback(() => {
    rec.current?.stop();
    clock.pause();
  }, [clock]);

  const startTake = useCallback(
    async (scope: "script" | "cue") => {
      if (!stream) {
        setMicErr("Turn on the microphone first.");
        return;
      }
      const cue = cues.find((c) => (c.id ?? "") === cueChoice) ?? cues[0];
      const from = scope === "cue" && cue ? Math.max(0, cue.start - PREROLL) : 0;
      const until = scope === "cue" && cue ? cue.end + 0.5 : null;
      const label = scope === "cue" && cue ? `cue ${cue.id ?? ""}` : "whole script";
      const n = takes.length + 1;
      const name = `take-${String(n).padStart(2, "0")}${scope === "cue" && cue?.id ? `-${cue.id}` : ""}`;
      const chunks: Blob[] = [];
      const mr = new MediaRecorder(stream);
      mr.ondataavailable = (e) => e.data.size && chunks.push(e.data);
      mr.onstop = () => {
        setRecording(null);
        // the contract takes audio/webm or audio/wav; drop the codecs parameter MediaRecorder adds
        const blob = new Blob(chunks, { type: (mr.mimeType || "audio/webm").split(";")[0] });
        upload(blob, name, label, (performance.now() - startedAt.current) / 1000);
      };
      rec.current = mr;
      clock.pause();
      clock.seek(from);
      if (countInOn && from === 0) {
        for (const k of [3, 2, 1]) {
          setCountIn(k);
          await new Promise((r) => setTimeout(r, 800));
        }
        setCountIn(null);
      }
      startedAt.current = performance.now();
      mr.start(250);
      setRecording({ scope: label, until });
      clock.play();
    },
    [stream, cues, cueChoice, takes.length, countInOn, clock, upload],
  );
  // a cue take stops itself after the cue (and half a second); a script take at the end
  useEffect(() => {
    if (!recording) return;
    const end = recording.until ?? duration;
    if (clock.t >= end - 0.05) stopTake();
  }, [clock.t, recording, duration, stopTake]);

  const align = async (file: string) => {
    setAligning(true);
    setAlignErr(null);
    setApplied(null);
    try {
      const res = await client.align(id, file);
      setProposal({ file, rows: res.proposal });
    } catch (e) {
      setAlignErr(`${(e as Error).message}. Check the take plays, then align again.`);
    } finally {
      setAligning(false);
    }
  };
  const applyAlign = async () => {
    if (!proposal) return;
    const aligned = Object.fromEntries(proposal.rows.map((r) => [r.cue, [r.start, r.end]]));
    const ops: PatchOpT[] = [
      { op: "replace", path: "/script/timing/mode", value: "aligned" },
      { op: "add", path: "/script/timing/aligned", value: aligned },
      { op: "add", path: "/audio/vo/-", value: { file: proposal.file, offset: 0 } },
    ];
    try {
      const r = await client.patch(id, { ops, reason: `Aligned the cues to ${proposal.file}`, baseRev: state.rev });
      setApplied(`Applied as change #${r.seq}. You can revert it in the workspace's Changes tab.`);
      setProposal(null);
    } catch (e) {
      const ex = e as Error & { fix?: string };
      setAlignErr(`${ex.message}.${ex.fix ? ` ${ex.fix}` : " The project changed meanwhile; align again."}`);
    }
  };

  // keys: Space play/pause, R restart, ←/→ 5 s
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey || isControlTarget(e)) return;
      if (e.key === " ") {
        e.preventDefault();
        if (recording) stopTake();
        else toggle();
      } else if (e.key === "r" || e.key === "R") {
        clock.pause();
        clock.seek(0);
      } else if (e.key === "ArrowLeft") clock.seek(clock.t - 5);
      else if (e.key === "ArrowRight") clock.seek(clock.t + 5);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [clock, toggle, recording, stopTake]);

  const current = new Map(state.timeline.cues.map((c) => [c.id, c]));

  return (
    <main id="main" className="page record">
      <div className="page-head">
        <h1>Record narration</h1>
        <Link href={`/p/${encodeURIComponent(id)}`}>Back to {state.doc.title}</Link>
      </div>
      <p className="muted">
        The video plays muted so its effects don't reach your mic. Press <Kbd>Space</Kbd> to start, <Kbd>R</Kbd> to
        restart, <Kbd>←</Kbd> <Kbd>→</Kbd> for 5 s.
      </p>
      <div className="record-grid">
        <div className="stack-3">
          {videoSrc && videoOk ? (
            <video
              ref={video}
              className="record-video pixelated"
              src={videoSrc}
              muted={!sound}
              playsInline
              preload="auto"
              onError={() => setVideoOk(false)}
            />
          ) : (
            <div className="record-video record-novideo">
              <p className="muted small">No video yet. The prompter runs on the script's timing.</p>
            </div>
          )}
          <div className="record-bar">
            <Button variant="primary" onClick={() => (recording ? stopTake() : toggle())}>
              {recording ? "Stop take" : clock.playing ? "Pause" : "Play"}
            </Button>
            <Button
              variant="ghost"
              onClick={() => {
                clock.pause();
                clock.seek(0);
              }}
            >
              Restart
            </Button>
            <Button variant="ghost" onClick={() => clock.seek(clock.t - 5)}>
              Back 5 s
            </Button>
            <Button variant="ghost" onClick={() => clock.seek(clock.t + 5)}>
              Forward 5 s
            </Button>
            <Checkbox
              id="r-sound"
              label="Video sound"
              checked={sound}
              onChange={(e) => setSound(e.currentTarget.checked)}
              size="sm"
            />
            <Checkbox
              id="r-count"
              label="3-2-1 count-in"
              checked={countInOn}
              onChange={(e) => setCountInOn(e.currentTarget.checked)}
              size="sm"
            />
            <Field
              id="r-rate"
              label="Speed"
              control="select"
              size="sm"
              value={String(rate)}
              onChange={(e) => {
                const r = Number(e.currentTarget.value);
                setRate(r);
                clock.setRate(r);
              }}
            >
              <option value="0.75">0.75×</option>
              <option value="1">1×</option>
            </Field>
            <output className="mono small">
              {secs(clock.t)} / {secs(duration)}
            </output>
          </div>
          <Teleprompter cues={cues} t={clock.t} countIn={countIn} />
          {recording && (
            <p className="record-live" role="status">
              <Badge tone="error" live>
                Recording
              </Badge>{" "}
              {recording.scope}. Press Space or Stop take to finish.
            </p>
          )}
        </div>
        <aside className="stack-4" aria-label="Microphone and takes">
          <section className="stack-2">
            <h2 className="h3">Microphone</h2>
            {!stream ? (
              <Button variant="ghost" onClick={() => openMic()}>
                Turn on microphone
              </Button>
            ) : (
              <>
                <Field
                  id="r-mic"
                  label="Input"
                  control="select"
                  value={mic}
                  onChange={(e) => openMic(e.currentTarget.value)}
                >
                  {mics.map((m, i) => (
                    <option key={m.deviceId || i} value={m.deviceId}>
                      {m.label || `Microphone ${i + 1}`}
                    </option>
                  ))}
                </Field>
                <HudMeter
                  label="Input level"
                  value={level}
                  segments={16}
                  zones
                  live={!!recording}
                  valueText={`${level}%`}
                />
              </>
            )}
            {micErr && (
              <p className="decision-error" role="status">
                {micErr}
              </p>
            )}
          </section>
          <section className="stack-2">
            <h2 className="h3">Takes</h2>
            <div className="record-bar">
              <Button
                variant="primary"
                onClick={() => startTake("script")}
                disabled={!!recording}
                aria-disabled={!stream ? "true" : undefined}
              >
                Record the whole script
              </Button>
            </div>
            <div className="record-bar">
              <Field
                id="r-cue"
                label="Cue"
                control="select"
                size="sm"
                value={cueChoice}
                onChange={(e) => setCueChoice(e.currentTarget.value)}
              >
                {cues.map((c, i) => (
                  <option key={c.id ?? i} value={c.id ?? ""}>
                    {c.id ?? i + 1}: {c.text.slice(0, 40)}
                  </option>
                ))}
              </Field>
              <Button variant="ghost" onClick={() => startTake("cue")} disabled={!!recording}>
                Record this cue
              </Button>
            </div>
            <p className="muted small">A cue take starts {PREROLL} s early and stops half a second after the cue.</p>
            <Field
              id="r-import"
              label="Import from Audacity"
              type="file"
              accept="audio/wav,audio/x-wav,audio/webm,.wav,.webm"
              hint="Export the take as WAV, then pick it here."
              onChange={(e) => {
                const f = (e.currentTarget as HTMLInputElement).files?.[0];
                if (f) upload(f, f.name.replace(/\.[^.]+$/, "").replace(/[^a-zA-Z0-9_-]+/g, "-"), "imported", 0);
                (e.currentTarget as HTMLInputElement).value = "";
              }}
            />
            {takes.length > 0 && (
              <Table caption="Takes" captionHidden size="sm">
                <thead>
                  <tr>
                    <th scope="col">Take</th>
                    <th scope="col">Sound</th>
                    <th scope="col">Status</th>
                    <th scope="col">
                      <span className="visually-hidden">Actions</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {takes.map((t) => (
                    <tr key={t.name}>
                      <td>
                        <span className="mono small">{t.name}</span>
                        <div className="muted small">
                          {t.scope}
                          {t.durationSec > 0 && `, ${secs(Math.round(t.durationSec * 10) / 10)}`}, {bytes(t.size)}
                        </div>
                      </td>
                      <td>
                        <Waveform src={t.url} label={`Waveform of ${t.name}`} />
                        {/* biome-ignore lint/a11y/useMediaCaption: a narration take is the words themselves */}
                        <audio controls src={t.url} preload="none" className="take-audio" />
                      </td>
                      <td>
                        {t.status === "saved" ? (
                          <Badge tone="success">Saved</Badge>
                        ) : t.status === "failed" ? (
                          <>
                            <Badge tone="error">Not saved</Badge>
                            <p className="small">{t.error}</p>
                          </>
                        ) : (
                          <Badge tone="muted">Uploading</Badge>
                        )}
                      </td>
                      <td>
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => t.file && align(t.file)}
                          aria-disabled={t.status !== "saved" ? "true" : undefined}
                        >
                          {aligning && proposal?.file === t.file ? "Aligning…" : "Align"}
                        </Button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </Table>
            )}
            {alignErr && (
              <p className="decision-error" role="status">
                {alignErr}
              </p>
            )}
            {applied && (
              <Callout tone="success" title="Cues aligned">
                {applied}
              </Callout>
            )}
          </section>
          {proposal && (
            <section className="stack-2 proposal" aria-labelledby="align-title">
              <h2 id="align-title" className="h3">
                Proposed alignment
              </h2>
              <p className="small muted">
                The Editor matched each cue to <span className="mono ltr">{proposal.file}</span>. Applying it is one
                change to the project, so you can revert it.
              </p>
              <Table caption="Cue times, now and proposed" captionHidden size="sm">
                <thead>
                  <tr>
                    <th scope="col">Cue</th>
                    <th scope="col" className="num">
                      Now
                    </th>
                    <th scope="col" className="num">
                      Proposed
                    </th>
                    <th scope="col" className="num">
                      Shift
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {proposal.rows.map((r) => {
                    const c = current.get(r.cue);
                    return (
                      <tr key={r.cue}>
                        <td className="mono small">{r.cue}</td>
                        <td className="num">{c ? `${c.start.toFixed(2)} to ${c.end.toFixed(2)}` : "new"}</td>
                        <td className="num">
                          {r.start.toFixed(2)} to {r.end.toFixed(2)}
                        </td>
                        <td className="num">
                          {c ? `${r.start - c.start >= 0 ? "+" : "−"}${Math.abs(r.start - c.start).toFixed(2)} s` : ""}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </Table>
              <div className="record-bar">
                <Button variant="primary" onClick={applyAlign}>
                  Apply alignment
                </Button>
                <Button variant="ghost" onClick={() => setProposal(null)}>
                  Discard
                </Button>
              </div>
            </section>
          )}
        </aside>
      </div>
    </main>
  );
}
