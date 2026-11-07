// The workspace's left panel, the only part that swaps by stage.
import { Badge, Button, Callout, Checkbox, DescriptionList, EmptyState, Table, Tag } from "@shabboo/kit/react";
import { client } from "../lib/client.ts";
import { DEPARTMENTS, GATE_STAGE, ROLE_LABEL, STAGE_LABEL, TASK_STATUS } from "../lib/derive.ts";
import { bytes, n, secs, usd, words } from "../lib/format.ts";
import { LinkButton } from "../lib/router.tsx";
import type { ProjectState, Stage } from "../lib/types.ts";
import { DecisionCard, GateCard } from "./DecisionCard.tsx";
import { MixerStrip } from "./MixerStrip.tsx";
import "./StagePanel.css";

type Props = {
  projectId: string;
  state: ProjectState;
  stage: Stage;
  onSeek: (t: number) => void;
  lastStill: string | null;
};

export function StagePanel(props: Props) {
  const { stage } = props;
  return (
    <section className="stage-panel" aria-labelledby="stage-title">
      <h2 id="stage-title" className="stage-title">
        {STAGE_LABEL[stage]}
      </h2>
      {stage === "brief" && <BriefPanel {...props} />}
      {stage === "script" && <ScriptPanel {...props} />}
      {stage === "storyboard" && <StoryboardPanel {...props} />}
      {stage === "art" && <ArtPanel {...props} />}
      {stage === "animate" && <WorkPanel {...props} />}
      {stage === "narrate" && <NarratePanel {...props} />}
      {stage === "sound" && <SoundPanel {...props} />}
      {stage === "review" && <ReviewPanel {...props} />}
      {stage === "deliver" && <DeliverPanel {...props} />}
    </section>
  );
}

function Gates({ projectId, state, stage }: Props) {
  const gates = state.gates.filter((g) => GATE_STAGE[g.id] === stage);
  return (
    <>
      {gates.map((g) => (
        <GateCard key={g.id} projectId={projectId} gate={g} where="stage" />
      ))}
    </>
  );
}

function BriefPanel(p: Props) {
  const b = p.state.doc.brief;
  const est = p.state.budget.estTotalUsd;
  const split = DEPARTMENTS.map((d) => {
    const ts = p.state.tasks.filter((t) => d.roles.includes(t.role));
    return { d, est: ts.reduce((a, t) => a + (t.estUsd ?? t.usd), 0), spent: ts.reduce((a, t) => a + t.usd, 0) };
  }).filter((x) => x.est > 0 || x.spent > 0);
  return (
    <div className="stack-4">
      <section>
        <h3 className="label">The brief, as the crew sees it</h3>
        <DescriptionList size="sm" layout="stacked">
          <dt>Idea</dt>
          <dd>{b.idea}</dd>
          <dt>Purpose and length</dt>
          <dd>
            {b.purpose}, {b.lengthSec} s
          </dd>
          {b.audience && (
            <>
              <dt>Audience</dt>
              <dd>{b.audience}</dd>
            </>
          )}
          {b.ask && (
            <>
              <dt>The ask</dt>
              <dd>{b.ask}</dd>
            </>
          )}
          <dt>Narration</dt>
          <dd>{b.narration === "user" ? "You record it" : b.narration === "tts" ? "AI voice" : "None"}</dd>
          <dt>Style</dt>
          <dd>{b.tone.length ? b.tone.join(", ") : "Defaults"}</dd>
          <dt>References</dt>
          <dd>
            {b.references.length ? (
              <ul className="plain-list">
                {b.references.map((r) => (
                  <li key={r.file}>
                    <span className="mono ltr">{r.file}</span> · {r.type} · rights:{" "}
                    {r.rights === "unsure" ? "not sure" : r.rights}
                    {(r.type === "likeness" || r.type === "logo") && (
                      <>
                        {" "}
                        <Badge tone="info" caps={false}>
                          Private to this project
                        </Badge>
                      </>
                    )}
                  </li>
                ))}
              </ul>
            ) : (
              "None"
            )}
          </dd>
        </DescriptionList>
        {p.state.doc.notes.length > 0 && (
          <Callout tone="aside" title="Assumptions the Producer made">
            <ul className="plain-list">
              {p.state.doc.notes.map((x) => (
                <li key={x.text}>{x.text}</li>
              ))}
            </ul>
          </Callout>
        )}
      </section>
      <section>
        <h3 className="label">Plan and budget split</h3>
        <p className="small muted">
          Cap {usd(p.state.budget.capUsd)}
          {est && `; the Producer expects ${usd(est[0])} to ${usd(est[1])}`}.
        </p>
        {split.length ? (
          <Table caption="Budget by department" captionHidden size="sm">
            <thead>
              <tr>
                <th scope="col">Department</th>
                <th scope="col" className="num">
                  Planned
                </th>
                <th scope="col" className="num">
                  Spent
                </th>
              </tr>
            </thead>
            <tbody>
              {split.map((x) => (
                <tr key={x.d.id}>
                  <td>{x.d.label}</td>
                  <td className="num">{usd(x.est)}</td>
                  <td className="num">{usd(x.spent)}</td>
                </tr>
              ))}
            </tbody>
          </Table>
        ) : (
          <p className="muted small">The Producer is still planning.</p>
        )}
      </section>
      <Gates {...p} />
    </div>
  );
}

function ScriptPanel(p: Props) {
  const tl = p.state.timeline;
  const qs = p.state.questions.filter((q) => q.status === "open" && q.blocks.includes("script"));
  const text = new Map(p.state.doc.script.cues.map((c) => [c.id, c.text]));
  const total = tl.cues.reduce((a, c) => a + words(c.text), 0);
  return (
    <div className="stack-4">
      {qs.map((q) => (
        <DecisionCard key={q.id} projectId={p.projectId} q={q} where="stage" />
      ))}
      <Table
        caption={`Cues: ${n(total)} words, ${secs(tl.cues.at(-1)?.end ?? 0)} (${p.state.doc.script.timing.mode === "aligned" ? "aligned to your take" : "estimated"})`}
        size="sm"
        hover
      >
        <thead>
          <tr>
            <th scope="col">Cue</th>
            <th scope="col">Text</th>
            <th scope="col" className="num">
              Words
            </th>
            <th scope="col" className="num">
              Seconds
            </th>
          </tr>
        </thead>
        <tbody>
          {tl.cues.map((c) => (
            <tr key={c.id}>
              <td className="mono small">
                <button
                  type="button"
                  className="row-link linkish"
                  onClick={() => p.onSeek(c.start)}
                  aria-label={`Go to ${c.id} at ${secs(c.start)}`}
                >
                  {c.id}
                </button>
              </td>
              <td>{text.get(c.id) ?? c.text}</td>
              <td className="num">{words(c.text)}</td>
              <td className="num">{(c.end - c.start).toFixed(1)}</td>
            </tr>
          ))}
        </tbody>
      </Table>
      <Gates {...p} />
    </div>
  );
}

function StoryboardPanel(p: Props) {
  const tl = p.state.timeline;
  return (
    <div className="stack-4">
      <ol className="board">
        {tl.scenes.map((s) => {
          const st = p.state.sceneStatus?.[s.id];
          const title = p.state.doc.scenes.find((x) => x.id === s.id)?.title || s.id;
          const src = client.frameUrl(p.projectId, (s.from + s.to) / 2, 1);
          return (
            <li key={s.id} className="board-card">
              <button
                type="button"
                className="board-thumb"
                onClick={() => p.onSeek(s.from)}
                aria-label={`Go to ${title}`}
              >
                {src ? (
                  <img className="pixelated" src={src} alt="" width={160} height={90} loading="lazy" />
                ) : (
                  <span className="muted small">No frame</span>
                )}
              </button>
              <div className="board-meta">
                <span>{title}</span>
                <span className="mono small muted">
                  {secs(s.from)} to {secs(s.to)}
                </span>
                <span>
                  <Badge tone={st?.version === "render" ? "accent" : "muted"} variant="text">
                    {st?.version ?? "slate"}
                  </Badge>
                  {st?.stale && <Badge tone="warning">Stale</Badge>}
                </span>
              </div>
            </li>
          );
        })}
      </ol>
      <Gates {...p} />
    </div>
  );
}

function ArtPanel(p: Props) {
  const art = p.state.art ?? [];
  const drawing = p.state.tasks.filter((t) => t.role === "pixel-artist" || t.role === "art-director");
  return (
    <div className="stack-4">
      {art.length === 0 && (
        <EmptyState size="sm" title="No art yet">
          Variants show here as the Pixel artist draws them, with the Art director's reason for each pick.
        </EmptyState>
      )}
      {art.map((a) => (
        <section key={a.id} className="art-asset">
          <h3 className="h4">
            {a.label} {a.chosen ? <Badge tone="success">Chose {a.chosen}</Badge> : <Badge tone="muted">Judging</Badge>}
          </h3>
          <ul className="variants">
            {a.variants.map((v) => (
              <li key={v.id} className="variant" data-chosen={a.chosen === v.id ? "" : undefined}>
                <img className="pixelated" src={v.img} alt={`${a.label} ${v.id}`} />
                <div>
                  <span className="mono small">
                    {v.id}
                    {v.score != null && ` · ${v.score}/10`}
                    {a.chosen === v.id && " · chosen"}
                  </span>
                  {v.reason && <p className="small">{v.reason}</p>}
                </div>
              </li>
            ))}
          </ul>
        </section>
      ))}
      {p.state.doc.assets.length > 0 && (
        <section>
          <h3 className="label">Assets in this project</h3>
          <ul className="plain-list">
            {p.state.doc.assets.map((a) => (
              <li key={a.id}>
                <span className="mono">{a.id}</span> <span className="muted small ltr">{a.src}</span>{" "}
                {a.flags.private && (
                  <Badge tone="info" caps={false}>
                    Private to this project
                  </Badge>
                )}
              </li>
            ))}
          </ul>
        </section>
      )}
      <TaskList state={p.state} roles={drawing.map((t) => t.role)} />
    </div>
  );
}

function TaskList({ state, roles }: { state: ProjectState; roles: string[] }) {
  const tasks = state.tasks.filter((t) => roles.includes(t.role));
  if (!tasks.length) return null;
  return (
    <ul className="plain-list task-list">
      {tasks.map((t) => (
        <li key={t.id}>
          <Badge tone={TASK_STATUS[t.status].tone} variant="text">
            {TASK_STATUS[t.status].word}
          </Badge>{" "}
          {ROLE_LABEL[t.role]}: {t.title}
        </li>
      ))}
    </ul>
  );
}

function WorkPanel(p: Props) {
  return (
    <div className="stack-4">
      <p className="small muted">
        Scenes move from board to animatic to render. Stale ones need another pass after a change.
      </p>
      <ul className="plain-list">
        {p.state.timeline.scenes.map((s) => {
          const st = p.state.sceneStatus?.[s.id];
          return (
            <li key={s.id}>
              <button type="button" className="linkish" onClick={() => p.onSeek(s.from)}>
                {p.state.doc.scenes.find((x) => x.id === s.id)?.title || s.id}
              </button>{" "}
              <Badge tone="muted" variant="text">
                {st?.version ?? "slate"}
              </Badge>
              {st?.stale && <Badge tone="warning">Stale</Badge>}
            </li>
          );
        })}
      </ul>
      <TaskList state={p.state} roles={["animator", "scene-coder"]} />
      <Gates {...p} />
    </div>
  );
}

function NarratePanel(p: Props) {
  const vo = p.state.doc.audio.vo;
  return (
    <div className="stack-4">
      {p.state.doc.brief.narration === "user" ? (
        <>
          <p>
            Record the narration with the teleprompter, or import a take from Audacity. The Editor aligns the cues to
            it.
          </p>
          <LinkButton variant="primary" href={`/p/${encodeURIComponent(p.projectId)}/record`}>
            Open the record page
          </LinkButton>
        </>
      ) : (
        <p>
          {p.state.doc.brief.narration === "tts" ? "An AI voice reads the script." : "This video has no narration."}
        </p>
      )}
      <section>
        <h3 className="label">Takes in the mix</h3>
        {vo.length ? (
          <ul className="plain-list">
            {vo.map((v) => (
              <li key={v.file} className="mono small ltr">
                {v.file} (offset {v.offset} s)
              </li>
            ))}
          </ul>
        ) : (
          <p className="muted small">None yet.</p>
        )}
      </section>
      <TaskList state={p.state} roles={["editor"]} />
    </div>
  );
}

function SoundPanel(p: Props) {
  const mix = p.state.doc.mix;
  const commit = (path: string, label: string) => (db: number) =>
    client
      .patch(p.projectId, {
        ops: [{ op: "replace", path, value: db }],
        reason: `Set ${label} to ${db} dB`,
        baseRev: p.state.rev,
      })
      .catch(() => {});
  return (
    <div className="stack-4">
      <div className="mixer">
        <MixerStrip id="mix-sfx" label="SFX" db={mix.sfxDb} onCommit={commit("/mix/sfxDb", "SFX")} />
        <MixerStrip id="mix-music" label="Music" db={mix.musicDb} onCommit={commit("/mix/musicDb", "music")} />
        <MixerStrip id="mix-lufs" label="Target" db={mix.lufs} min={-30} max={-9} note="LUFS" />
      </div>
      <p className="small muted">
        Voice high-pass at {mix.voHighpass} Hz, limiter at {mix.limiter}. Releasing a fader saves it as a change you can
        revert.
      </p>
      <section>
        <h3 className="label">Sound effects</h3>
        <ul className="plain-list">
          {p.state.doc.audio.sfx.events.map((e, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: events have no id
            <li key={i}>
              <Tag variant="chip" size="sm" as="span">
                {e.type}
              </Tag>{" "}
              <span className="mono small ltr">{String(e.t)}</span>
            </li>
          ))}
        </ul>
      </section>
      <TaskList state={p.state} roles={["sound-designer", "mixer"]} />
    </div>
  );
}

function ReviewPanel(p: Props) {
  const f = p.state.findings ?? [];
  return (
    <div className="stack-4">
      {f.length === 0 ? (
        <EmptyState size="sm" title="No findings yet">
          The Reviewer watches the rough cut and lists what to fix here. Select one to go to it.
        </EmptyState>
      ) : (
        <ol className="findings">
          {f.map((x) => (
            <li key={x.id}>
              <button type="button" className="finding" onClick={() => p.onSeek(x.t)}>
                <Badge tone={x.severity}>
                  {x.severity === "error" ? "Error" : x.severity === "warning" ? "Warning" : "Note"}
                </Badge>
                <span className="mono small">{secs(x.t)}</span>
                <span>{x.text}</span>
                {x.fix && <span className="muted small">Fix: {x.fix}</span>}
              </button>
            </li>
          ))}
        </ol>
      )}
      <Gates {...p} />
    </div>
  );
}

function DeliverPanel(p: Props) {
  const s = p.state;
  const g4 = s.gates.find((g) => g.id === "g4_final");
  const refsOk = s.doc.brief.references.every((r) => r.rights !== "unsure");
  const checks: [string, boolean][] = [
    ["Final approved (G4)", g4?.status === "passed"],
    ["Captions on", s.doc.composition.captions.enabled],
    ["Subtitles as SRT and VTT", s.doc.subtitles.srt && s.doc.subtitles.vtt],
    [`Loudness target ${s.doc.mix.lufs} LUFS`, true],
    ["Rights known for every reference", refsOk],
    ["Final video encoded", s.files.some((f) => f.kind === "video")],
  ];
  return (
    <div className="stack-4">
      <section>
        <h3 className="label">Files</h3>
        {s.files.length ? (
          <Table caption="Output files" captionHidden size="sm">
            <thead>
              <tr>
                <th scope="col">File</th>
                <th scope="col">Kind</th>
                <th scope="col" className="num">
                  Size
                </th>
              </tr>
            </thead>
            <tbody>
              {s.files.map((f) => (
                <tr key={f.name}>
                  <td className="ltr">
                    <a href={f.url || client.fileUrl(p.projectId, f.name)} download={f.name}>
                      {f.name}
                    </a>
                  </td>
                  <td>{f.kind}</td>
                  <td className="num">{f.bytes ? bytes(f.bytes) : "–"}</td>
                </tr>
              ))}
            </tbody>
          </Table>
        ) : (
          <p className="muted small">The Editor writes the final files here once G4 is approved.</p>
        )}
      </section>
      <section>
        <h3 className="label">Export checklist</h3>
        <ul className="plain-list checklist">
          {checks.map(([label, ok]) => (
            <li key={label}>
              <Badge tone={ok ? "success" : "warning"} variant="text">
                {ok ? "Done" : "To do"}
              </Badge>{" "}
              {label}
            </li>
          ))}
        </ul>
      </section>
      {!refsOk && <Checkbox id="rights-ack" label="I've checked the rights of every reference marked not sure" />}
      <Button variant="ghost" size="sm" onClick={() => client.crewRun(p.projectId, "deliver").catch(() => {})}>
        Encode again
      </Button>
    </div>
  );
}
