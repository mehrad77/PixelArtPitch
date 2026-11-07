// The app header's end: the Simple | Studio switch (project pages only) and the Crew button (every page). The Crew
// button opens the activity drawer for the project on screen, else the one opened last, else the one with the
// newest activity; C opens it from anywhere outside a text field. Its faces are still: nothing here moves alone.
import { Badge, Button, Field, Radio } from "@shabboo/kit/react";
import { type CSSProperties, useEffect, useRef, useState } from "react";
import { client } from "../lib/client.ts";
import { useShownProject } from "../lib/current.ts";
import { needsYouCount } from "../lib/derive.ts";
import { isControlTarget, useLoad, useProject } from "../lib/hooks.ts";
import { getLastProject, setView, type View } from "../lib/human.ts";
import { hasNews, pipMood, usePip } from "../lib/pip.ts";
import { navigate } from "../lib/router.tsx";
import type { ProjectState } from "../lib/types.ts";
import { AgentActivity } from "./AgentActivity.tsx";
import { CrewFace, crewRows, type Mood } from "./CrewStrip.tsx";
import { PipFace } from "./PipFace.tsx";
import "./AppHeader.css";

/** Simple | Studio, as a row of chip radios; `mode` is null where neither applies */
export function ModeSwitch({ projectId, mode }: { projectId: string; mode: View | null }) {
  const shown = useShownProject();
  const go = (v: View) => {
    setView(v);
    const base = `/p/${encodeURIComponent(projectId)}`;
    const stage = shown?.id === projectId ? shown.state.stage : null;
    navigate(v === "studio" && stage ? `${base}/${stage}` : base);
  };
  return (
    <fieldset className="mode-switch">
      <legend className="visually-hidden">View</legend>
      {(["simple", "studio"] as const).map((v) => (
        <Radio
          key={v}
          id={`mode-${v}`}
          name="pap-mode"
          value={v}
          variant="chip"
          size="sm"
          indicator={false}
          label={v === "simple" ? "Simple" : "Studio"}
          checked={mode === v}
          onChange={() => go(v)}
        />
      ))}
    </fieldset>
  );
}

const PRIORITY: Mood[] = ["needs", "stuck", "working", "idle", "done", "later"];

/** the member to open the drawer on: who waits on you, else who works, else the Producer */
function firstMember(state: ProjectState): string {
  const rows = crewRows(state);
  return rows.find((r) => r.mood === "needs")?.m.id ?? rows.find((r) => r.mood === "working")?.m.id ?? rows[0].m.id;
}

export function CrewButton({ routeId }: { routeId: string | null }) {
  const shown = useShownProject();
  const projects = useLoad(() => client.projects(), []);
  const [open, setOpen] = useState(false);
  const [picked, setPicked] = useState<string | null>(null);
  const btn = useRef<HTMLSpanElement>(null);

  const list = projects.data ?? [];
  const last = getLastProject();
  const newest = [...list].sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt))[0]?.id ?? null;
  const fallback = last && (!projects.data || list.some((p) => p.id === last)) ? last : newest;
  const target = picked ?? routeId ?? fallback;
  // the page on screen shares its state; anywhere else the button follows the target project itself
  const own = useProject(target && target !== routeId && target !== shown?.id ? target : null);
  const state = target && shown?.id === target ? shown.state : own.state;
  // Pip in the drawer talks about the page's project, or about the workspace off a project page
  const pip = usePip(routeId);

  const reload = useRef(projects.reload);
  reload.current = projects.reload;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey || isControlTarget(e)) return;
      if (e.key !== "c" && e.key !== "C") return;
      e.preventDefault();
      setOpen(true);
      reload.current();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  if (!target && projects.data) return null;

  const needs = state ? needsYouCount(state) : 0;
  const rows = state ? crewRows(state) : [];
  const working = rows.some((r) => r.mood === "working");
  const faces = rows.length
    ? [...rows].sort((a, b) => PRIORITY.indexOf(a.mood) - PRIORITY.indexOf(b.mood)).slice(0, 3)
    : [];
  const status = needs > 0 ? `needs you (${needs})` : working ? "working" : "";
  const pipNews = hasNews(pip);
  const name = `${status ? `Crew, ${status}` : "Crew"}${pipNews ? ". Pip has something for you" : ""}. Ask Pip`;

  const close = () => {
    setOpen(false);
    setPicked(null);
    requestAnimationFrame(() => btn.current?.querySelector("button")?.focus());
  };

  return (
    <>
      <span ref={btn} className="crew-btn-wrap">
        <Button
          size="sm"
          variant="ghost"
          className="crew-btn"
          aria-label={name}
          title={`${name} · press C`}
          data-tone={needs > 0 ? "needs" : working ? "working" : undefined}
          onClick={() => {
            setOpen(true);
            projects.reload();
          }}
        >
          <span className="crew-btn-faces" aria-hidden="true">
            <span className="crew-btn-pip">
              <PipFace mood={pipMood(pip, routeId ? (state ?? null) : null)} size="sm" dot={pipNews} />
            </span>
            {faces.map((r, i) => (
              <span key={r.m.id} style={{ "--face-i": i } as CSSProperties}>
                <CrewFace member={r.m} mood={r.mood} step={0} />
              </span>
            ))}
          </span>
          <span className="crew-btn-word" aria-hidden="true">
            Crew
          </span>
          {needs > 0 ? (
            <Badge tone="signal" size="sm" aria-hidden="true" className="crew-btn-count">
              {needs}
            </Badge>
          ) : working ? (
            <span className="crew-btn-dot" aria-hidden="true" />
          ) : null}
        </Button>
      </span>
      {open && target && state && (
        <AgentActivity
          key={target}
          projectId={target}
          state={state}
          memberId={!routeId || pipNews ? "pip" : firstMember(state)}
          pipProject={routeId}
          onClose={close}
          picker={
            list.length > 1 ? (
              <Field
                id="crew-project"
                label="Project"
                control="select"
                size="sm"
                value={target}
                onChange={(e) => setPicked(e.currentTarget.value)}
              >
                {list.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.title}
                    {p.needsYou > 0 ? ` · needs you (${p.needsYou})` : ""}
                  </option>
                ))}
              </Field>
            ) : undefined
          }
        />
      )}
    </>
  );
}
