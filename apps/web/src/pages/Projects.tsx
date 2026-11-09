// The Projects overview: one card per project, grouped Needs you, Working, Stopped, Has a video, Not started. Each
// card shows its live thumbnail, its five parts, the plain status with an icon and a word (never colour alone), the faces
// of whoever is working, money as one quiet line and when it last moved. Motion is stepped and calm, and stills under
// reduced motion. The disk path sits in the card's "⋯" menu.
import { Button, Callout, Dialog, Menu, Skeleton } from "@shabboo/kit/react";
import { Fragment, useEffect, useState } from "react";
import { CrewFace, type Mood, useStep } from "../components/CrewStrip.tsx";
import { PipFace } from "../components/PipFace.tsx";
import { ApiError } from "../lib/api.ts";
import { client } from "../lib/client.ts";
import { STAGE_LABEL } from "../lib/derive.ts";
import { ago, duration } from "../lib/format.ts";
import { useLoad } from "../lib/hooks.ts";
import { type Member, memberOf, setView, usdPlain } from "../lib/human.ts";
import { MAKE_ANOTHER, makeAnother } from "../lib/pip.ts";
import { type Kind, kindOf } from "../lib/projects.ts";
import { Link, LinkButton, navigate } from "../lib/router.tsx";
import type { ProjectSummary, WorkspaceLine } from "../lib/types.ts";
import { PART_ICON, PART_WORD, partLabel, partsLabel } from "../lib/versions.ts";
import "./Projects.css";

const GROUPS: { id: string; title: string; kinds: Kind[] }[] = [
  { id: "needs", title: "Needs you", kinds: ["needs"] },
  { id: "working", title: "Working", kinds: ["working"] },
  { id: "stopped", title: "Stopped", kinds: ["problem", "stopped"] },
  { id: "finished", title: "Has a video", kinds: ["finished"] },
  { id: "fresh", title: "Not started", kinds: ["fresh"] },
  // an unstarted /new: only its conversation is saved (PIP-JOURNEY §3.6)
  { id: "drafts", title: "Drafts", kinds: ["draft"] },
];

export function ProjectsPage() {
  const { data, error, loading, reload } = useLoad(() => client.projects(), []);
  // Pip's line, built from state on the server (no model call); it refreshes with the list, and hides where the
  // server has none yet
  const line = useLoad(() => client.workspaceLine().catch(() => null), [data]);
  const anyWorking = !!data?.some((p) => (p.working?.length ?? 0) > 0);
  const step = useStep(anyWorking);
  const empty = !loading && !error && !!data && data.length === 0;
  // no projects yet: the empty stage is the first screen
  useEffect(() => {
    if (empty) navigate("/new", { replace: true });
  }, [empty]);
  if (empty) return null;
  const byKind = (kinds: Kind[]) =>
    (data ?? [])
      .filter((p) => kinds.includes(kindOf(p)))
      .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
  return (
    <main id="main" className="page" aria-busy={loading ? "true" : undefined}>
      <div className="page-head projects-head">
        {/* the app header's Projects item names the page; the h1 stays for screen readers */}
        <h1 className="visually-hidden">Projects</h1>
        {line.data && <PipSays line={line.data} projects={data ?? []} />}
        <LinkButton href="/new" variant="primary">
          New video
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
                  {list.map((p) =>
                    p.draft ? (
                      <DraftCard key={p.id} p={p} onRemoved={reload} />
                    ) : (
                      <ProjectCard key={p.id} p={p} kind={kindOf(p)} step={step} onRemoved={reload} />
                    ),
                  )}
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
            // a rerun: the last version keeps playing
            p.version ? `Working · v${p.version.v} plays` : "Working",
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
                  p.version ? `Has a video · v${p.version.v}` : "Has a video",
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

/** Idea · Story · Pictures · Sound · Video as five marks: a shape and a bar each (never colour alone), one label */
function PartMarks({ parts }: { parts: NonNullable<ProjectSummary["parts"]> }) {
  return (
    <ol className="psteps" aria-label={partsLabel(parts)}>
      {parts.map((x) => (
        <li key={x.id} data-state={x.state} title={partLabel(x)}>
          <span className="psteps-word" aria-hidden="true">
            {PART_ICON[x.state]} {PART_WORD[x.id]}
          </span>
        </li>
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

function ProjectCard({
  p,
  kind,
  step,
  onRemoved,
}: {
  p: ProjectSummary;
  kind: Kind;
  step: number;
  onRemoved: () => void;
}) {
  const [playing, setPlaying] = useState(false);
  const [showPath, setShowPath] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [asking, setAsking] = useState(false);
  const [removeErr, setRemoveErr] = useState<string | null>(null);
  const remove = async (trash: boolean) => {
    setRemoveErr(null);
    try {
      await client.removeProject(p.id, { trash });
      setAsking(false);
      onRemoved();
    } catch (e) {
      setRemoveErr(`${(e as Error).message}.${e instanceof ApiError && e.fix ? ` ${e.fix}.` : " Try again."}`);
    }
  };
  const href = `/p/${encodeURIComponent(p.id)}`;
  const video = kind === "finished" ? p.video || client.proxyUrl(p.id) : "";
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
        {p.parts && <PartMarks parts={p.parts} />}
        <StatusMark p={p} kind={kind} />
        {line && (
          <p className="pcard-line" dir="auto">
            {line}
          </p>
        )}
        <div className="pcard-foot">
          <Faces p={p} kind={kind} step={step} />
          <span className="pcard-meta">
            <span dir="auto">{eta ? `${money} · ${eta}` : money}</span>
            <span>
              Updated <time dateTime={p.updatedAt}>{ago(p.updatedAt)}</time>
            </span>
          </span>
        </div>
        {showPath && <p className="pcard-path mono ltr">{p.dir}</p>}
        {err && (
          <p className="pcard-err small" role="status">
            {err}
          </p>
        )}
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
            // a finished one can be the start of the next (PIP-JOURNEY §3.6)
            ...(kind === "finished" ? [{ label: MAKE_ANOTHER, value: "another" }] : []),
            { label: "Open in Studio", value: "studio" },
            // the run so far as one page (docs/REPORT.md): who worked when, what it cost, what failed
            { label: "Run report", value: "report" },
            { label: showPath ? "Hide folder path" : "Show folder path", value: "path" },
            // not while a crew works on it: pause first
            ...(p.running ? [] : [{ label: "Remove…", value: "remove" }]),
          ]}
          onSelect={(v) => {
            if (v === "another") {
              setErr(null);
              makeAnother(p.id).catch((e: Error) =>
                setErr(`Didn't start another one: ${e.message}.${e instanceof ApiError && e.fix ? ` ${e.fix}` : ""}`),
              );
            } else if (v === "report") {
              window.open(client.reportUrl(p.id), "_blank", "noopener");
            } else if (v === "studio") {
              setView("studio");
              navigate(`${href}/${p.stage}`);
            } else if (v === "remove") {
              setRemoveErr(null);
              setAsking(true);
            } else setShowPath((x) => !x);
          }}
        />
      </div>
      <Dialog
        id={`remove-${p.id}`}
        title={`Remove ${p.title}?`}
        size="sm"
        open={asking}
        onClose={() => setAsking(false)}
        closeLabel="Keep it"
      >
        <p>It leaves this list. Its folder stays where it is, untouched:</p>
        <p className="pcard-path mono ltr">{p.dir}</p>
        {p.canTrash && (
          <p className="muted small">
            It lives in PixelArtPitch's own projects folder, so it can also move to PixelArtPitch's trash folder.
            Nothing is deleted.
          </p>
        )}
        {removeErr && (
          <p className="decision-error" role="status">
            {removeErr}
          </p>
        )}
        <div className="decision-actions">
          <Button variant="danger" onClick={() => remove(false)}>
            Remove from the list
          </Button>
          {p.canTrash && (
            <Button variant="ghost" onClick={() => remove(true)}>
              Move to the trash
            </Button>
          )}
          <Button variant="quiet" onClick={() => setAsking(false)}>
            Keep it
          </Button>
        </div>
      </Dialog>
    </li>
  );
}

/** Pip's line on Projects: at most 3 clauses, each project's title a link to it; said once per change */
function PipSays({ line, projects }: { line: WorkspaceLine; projects: ProjectSummary[] }) {
  const titled = (part: WorkspaceLine["parts"][number]) => {
    const title = projects.find((p) => p.id === part.projectId)?.title ?? "";
    const at = title ? part.text.indexOf(title) : -1;
    if (at < 0) return <span dir="auto">{part.text}</span>;
    return (
      <>
        {part.text.slice(0, at)}
        <Link href={`/p/${encodeURIComponent(part.projectId)}`}>
          <bdi>{title}</bdi>
        </Link>
        {part.text.slice(at + title.length)}
      </>
    );
  };
  return (
    <div className="projects-pip">
      <PipFace mood="idle" size="sm" />
      <p className="projects-pip-line" dir="auto">
        {line.parts.length
          ? line.parts.map((part, i) => (
              <Fragment key={`${part.projectId}-${part.kind}`}>
                {i > 0 ? " " : null}
                {titled(part)}
              </Fragment>
            ))
          : line.text}
      </p>
      <p className="visually-hidden" role="status" aria-live="polite">
        {line.text}
      </p>
    </div>
  );
}

/** a draft from /new: no thumbnail, the mark "✎ Draft", Pip's last question, when it started; removable */
function DraftCard({ p, onRemoved }: { p: ProjectSummary; onRemoved: () => void }) {
  const [asking, setAsking] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const href = `/new/${encodeURIComponent(p.id)}`;
  const started = p.createdAt ?? p.updatedAt;
  const remove = async () => {
    setErr(null);
    try {
      await client.deleteDraft(p.id);
      setAsking(false);
      onRemoved();
    } catch (e) {
      setErr(`${(e as Error).message}. Try again.`);
    }
  };
  return (
    <li className="pcard" data-kind="draft">
      <div className="pcard-thumb">
        <span className="pcard-nothumb pcard-emptystage" aria-hidden="true" />
      </div>
      <div className="pcard-body">
        <h3 className="pcard-title">
          <Link className="pcard-link" href={href}>
            <bdi>{p.title}</bdi>
          </Link>
        </h3>
        <p className="pmark" data-kind="draft">
          <span className="pmark-icon" aria-hidden="true">
            ✎
          </span>
          <span className="pmark-word">Draft</span>
        </p>
        {p.status?.line && (
          <p className="pcard-line" dir="auto">
            {p.status.line}
          </p>
        )}
        <div className="pcard-foot">
          <span className="pcard-meta">
            <span>
              Started <time dateTime={started}>{ago(started)}</time>
            </span>
          </span>
        </div>
      </div>
      <div className="pcard-tools">
        <Menu
          id={`pmenu-${p.id}`}
          label={`More for ${p.title}`}
          trigger={<span aria-hidden="true">⋯</span>}
          variant="quiet"
          placement="block-end"
          items={[{ label: "Remove draft", value: "remove" }]}
          onSelect={(v) => {
            if (v === "remove") setAsking(true);
          }}
        />
      </div>
      <Dialog
        id={`remove-${p.id}`}
        title="Remove this draft?"
        size="sm"
        open={asking}
        onClose={() => setAsking(false)}
        closeLabel="Keep it"
      >
        <p>Only the conversation is saved, and it goes too.</p>
        {err && (
          <p className="decision-error" role="status">
            {err}
          </p>
        )}
        <div className="decision-actions">
          <Button variant="danger" onClick={remove}>
            Remove draft
          </Button>
          <Button variant="ghost" onClick={() => setAsking(false)}>
            Keep it
          </Button>
        </div>
      </Dialog>
    </li>
  );
}
