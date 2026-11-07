// The Projects overview: one card per project, grouped Needs you, Working, Stopped, Finished, Not started. Each card
// shows its live thumbnail, the five steps, the plain status with an icon and a word (never colour alone), the faces
// of whoever is working, money as one quiet line and when it last moved. Motion is stepped and calm, and stills under
// reduced motion. The disk path sits in the card's "⋯" menu.
import { Button, Callout, Menu, Skeleton } from "@shabboo/kit/react";
import { useState } from "react";
import { CrewFace, type Mood, useStep } from "../components/CrewStrip.tsx";
import { client } from "../lib/client.ts";
import { STAGE_LABEL } from "../lib/derive.ts";
import { ago, duration } from "../lib/format.ts";
import { useLoad } from "../lib/hooks.ts";
import { type Member, memberOf, PHASES, setView, usdPlain } from "../lib/human.ts";
import { Link, LinkButton, navigate } from "../lib/router.tsx";
import type { ProjectSummary } from "../lib/types.ts";
import { ComposerPage } from "./Composer.tsx";
import "./Projects.css";

type Kind = "needs" | "working" | "problem" | "stopped" | "finished" | "fresh";
const GROUPS: { id: string; title: string; kinds: Kind[] }[] = [
  { id: "needs", title: "Needs you", kinds: ["needs"] },
  { id: "working", title: "Working", kinds: ["working"] },
  { id: "stopped", title: "Stopped", kinds: ["problem", "stopped"] },
  { id: "finished", title: "Finished", kinds: ["finished"] },
  { id: "fresh", title: "Not started", kinds: ["fresh"] },
];

function kindOf(p: ProjectSummary): Kind {
  if (p.needsYou > 0) return "needs";
  if (p.status?.problem) return "problem";
  if (p.finished) return "finished";
  if (p.running) return "working";
  // an older server sends none of the overview fields: anything past the brief has started
  const started = (p.milestones ?? 0) > 0 || (p.phase ?? 0) > 0 || p.stage !== "brief" || p.spentUsd > 0;
  return started || p.paused ? "stopped" : "fresh";
}

export function ProjectsPage() {
  const { data, error, loading, reload } = useLoad(() => client.projects(), []);
  const anyWorking = !!data?.some((p) => (p.working?.length ?? 0) > 0);
  const step = useStep(anyWorking);
  if (!loading && !error && data && data.length === 0) return <ComposerPage first />;
  const byKind = (kinds: Kind[]) =>
    (data ?? [])
      .filter((p) => kinds.includes(kindOf(p)))
      .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
  return (
    <main id="main" className="page" aria-busy={loading ? "true" : undefined}>
      <div className="page-head">
        <h1>Projects</h1>
        <LinkButton href="/new" variant="primary">
          New project
        </LinkButton>
      </div>
      {error && (
        <Callout tone="error" title="Projects didn't load">
          <p>
            {error.message}. Check that the studio server is running (<code>pnpm pap</code>), then{" "}
            <Button variant="quiet" size="sm" onClick={reload}>
              try again
            </Button>
            .
          </p>
        </Callout>
      )}
      {loading && !data && <Skeleton lines={4} label="Loading projects" />}
      {data && data.length > 0 && (
        <div className="overview">
          {GROUPS.map((g) => {
            const list = byKind(g.kinds);
            if (!list.length) return null;
            return (
              <section key={g.id} className="overview-group" aria-labelledby={`pg-${g.id}`}>
                <h2 id={`pg-${g.id}`} className="label">
                  {g.title} <span className="muted">· {list.length}</span>
                </h2>
                <ul className="pcards">
                  {list.map((p) => (
                    <ProjectCard key={p.id} p={p} kind={kindOf(p)} step={step} />
                  ))}
                </ul>
              </section>
            );
          })}
        </div>
      )}
    </main>
  );
}

/** the status in an icon and a word */
function StatusMark({ p, kind }: { p: ProjectSummary; kind: Kind }) {
  const stage = STAGE_LABEL[p.stage];
  const [icon, word] =
    kind === "needs"
      ? [<span key="i" className="pm-dot" />, `Needs you${p.needsYou > 1 ? ` (${p.needsYou})` : ""}`]
      : kind === "working"
        ? [
            <span key="i" className="pm-spin">
              <span />
              <span />
              <span />
            </span>,
            "Working",
          ]
        : kind === "problem"
          ? [
              <span key="i" className="pm-x">
                x x
              </span>,
              "Stuck",
            ]
          : kind === "stopped"
            ? [
                <span key="i" className="pm-stop">
                  {p.paused ? "❚❚" : "■"}
                </span>,
                `${p.paused ? "Paused" : "Stopped"} during ${stage}`,
              ]
            : kind === "finished"
              ? [
                  <span key="i" className="pm-check">
                    ✓
                  </span>,
                  "Finished",
                ]
              : [<span key="i" className="pm-ring" />, "Not started"];
  return (
    <p className="pmark" data-kind={kind}>
      <span className="pmark-icon" aria-hidden="true">
        {icon}
      </span>
      <span className="pmark-word">{word}</span>
    </p>
  );
}

/** Idea · Story · Pictures · Sound · Finished as five segments */
function MiniSteps({ phase }: { phase: number }) {
  const at = Math.max(0, Math.min(PHASES.length, phase));
  const label = at >= PHASES.length ? "All five steps done" : `Step ${at + 1} of ${PHASES.length}: ${PHASES[at].label}`;
  return (
    <ol className="psteps" aria-label={label}>
      {PHASES.map((ph, i) => (
        <li key={ph.label} data-state={i < at ? "done" : i === at ? "now" : "todo"} title={ph.label} />
      ))}
    </ol>
  );
}

/** who is on it: working faces blink, a stuck one says x x, one waiting on you looks up; nobody, one calm face */
function Faces({ p, kind, step }: { p: ProjectSummary; kind: Kind; step: number }) {
  const seen = new Map<string, { m: Member; mood: Mood }>();
  for (const r of p.waiting ?? []) seen.set(memberOf(r).id, { m: memberOf(r), mood: "needs" });
  for (const r of p.working ?? [])
    if (!seen.has(memberOf(r).id)) seen.set(memberOf(r).id, { m: memberOf(r), mood: "working" });
  let faces = [...seen.values()].slice(0, 4);
  if (!faces.length) {
    const producer = memberOf("producer");
    if (kind === "problem") faces = [{ m: producer, mood: "stuck" }];
    else if (kind === "needs") faces = [{ m: producer, mood: "needs" }];
    else if (kind === "finished") faces = [{ m: producer, mood: "done" }];
    else if (kind !== "fresh") faces = [{ m: producer, mood: "idle" }];
  }
  if (!faces.length) return null;
  return (
    <span className="pfaces" aria-hidden="true">
      {faces.map((f, i) => (
        <CrewFace key={f.m.id} member={f.m} mood={f.mood} step={step + i} />
      ))}
    </span>
  );
}

function ProjectCard({ p, kind, step }: { p: ProjectSummary; kind: Kind; step: number }) {
  const [playing, setPlaying] = useState(false);
  const [showPath, setShowPath] = useState(false);
  const href = `/p/${encodeURIComponent(p.id)}`;
  const video = kind === "finished" ? p.video || client.proxyUrl(p.id) : "";
  const phase = p.phase ?? (p.finished ? PHASES.length : (p.status?.phase ?? 0));
  const raw = kind === "problem" ? (p.status?.problem?.text ?? p.status?.line) : p.status?.line;
  // the mark already says these
  const line = raw && !/^(Stopped|Waiting to start|Your video is ready)\.?$/.test(raw) ? raw : "";
  const money = p.capUsd === 0 ? "Example" : `${usdPlain(Math.round(p.spentUsd * 100) / 100)} of ${usdPlain(p.capUsd)}`;
  const eta = p.running && p.etaSec ? `≈ ${duration(p.etaSec)} left` : null;
  return (
    <li className="pcard" data-kind={kind}>
      <div className="pcard-thumb">
        {playing && video ? (
          // biome-ignore lint/a11y/useMediaCaption: the project's own preview; its captions are burned in
          <video src={video} autoPlay controls playsInline onEnded={() => setPlaying(false)} />
        ) : p.thumb ? (
          <img key={p.rev} className="pixelated" src={p.thumb} alt="" width={320} height={180} loading="lazy" />
        ) : (
          <span className="pcard-nothumb" aria-hidden="true" />
        )}
      </div>
      <div className="pcard-body">
        <h3 className="pcard-title">
          <Link className="pcard-link" href={href}>
            {p.title}
          </Link>
        </h3>
        <MiniSteps phase={phase} />
        <StatusMark p={p} kind={kind} />
        {line && <p className="pcard-line">{line}</p>}
        <div className="pcard-foot">
          <Faces p={p} kind={kind} step={step} />
          <span className="pcard-meta">
            <span>{eta ? `${money} · ${eta}` : money}</span>
            <span>
              Updated <time dateTime={p.updatedAt}>{ago(p.updatedAt)}</time>
            </span>
          </span>
        </div>
        {showPath && <p className="pcard-path mono ltr">{p.dir}</p>}
      </div>
      <div className="pcard-tools">
        {video && !playing && (
          <Button size="sm" variant="quiet" onClick={() => setPlaying(true)} aria-label={`Play ${p.title}`}>
            Play
          </Button>
        )}
        <Menu
          id={`pmenu-${p.id}`}
          label={`More for ${p.title}`}
          trigger={<span aria-hidden="true">⋯</span>}
          variant="quiet"
          placement="block-end"
          items={[
            { label: "Open in Studio", value: "studio" },
            { label: showPath ? "Hide folder path" : "Show folder path", value: "path" },
          ]}
          onSelect={(v) => {
            if (v === "studio") {
              setView("studio");
              navigate(`${href}/${p.stage}`);
            } else setShowPath((x) => !x);
          }}
        />
      </div>
    </li>
  );
}
