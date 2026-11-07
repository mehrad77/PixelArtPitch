// Steering from the picture: pressing the paused film opens this at the press. "What should change at 0:04?", six
// plain chips and an optional line. The default is to ask Pip (a draft in Pip's field, to edit and send); sending a
// note straight to the crew is one disclosure away. A native popover: Esc and a click outside close it, and focus
// goes back to the frame.
import { Button, Field, Fieldset, Radio } from "@shabboo/kit/react";
import { type FormEvent, useLayoutEffect, useRef, useState } from "react";
import { client } from "../lib/client.ts";
import { mss } from "../lib/human.ts";
import { askPipAbout } from "../lib/pip.ts";
import type { NoteCategory } from "../lib/types.ts";
import { DirectControls } from "./DirectControls.tsx";

const CHIPS: { label: string; category: NoteCategory }[] = [
  { label: "Too fast", category: "too_fast" },
  { label: "Too slow", category: "too_slow" },
  { label: "Hard to read", category: "unclear" },
  { label: "The art", category: "art" },
  { label: "The sound", category: "sound" },
  { label: "Something else", category: "other" },
];
const W = 320;
const H = 340;

export function SteerPopover({
  projectId,
  t,
  scene,
  x,
  y,
  onClose,
}: {
  projectId: string;
  t: number;
  scene?: string;
  x: number;
  y: number;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const opener = useRef<Element | null>(null);
  const closed = useRef(onClose);
  closed.current = onClose;
  const [cat, setCat] = useState<NoteCategory | null>(null);
  const [text, setText] = useState("");
  const [state, setState] = useState<"idle" | "busy" | "sent">("idle");
  const [err, setErr] = useState<string | null>(null);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    opener.current = document.activeElement;
    const rtl = getComputedStyle(document.documentElement).direction === "rtl";
    const left = Math.min(Math.max(8, x), window.innerWidth - W - 8);
    const top = Math.min(Math.max(8, y), window.innerHeight - H - 8);
    el.style.insetBlockStart = `${top}px`;
    el.style.insetInlineStart = `${rtl ? window.innerWidth - left - W : left}px`;
    if (!el.matches(":popover-open")) el.showPopover?.();
    el.querySelector<HTMLElement>("input")?.focus();
    const onToggle = (e: Event) => {
      if ((e as ToggleEvent).newState === "closed") {
        (opener.current as HTMLElement | null)?.focus?.();
        closed.current();
      }
    };
    el.addEventListener("toggle", onToggle);
    return () => el.removeEventListener("toggle", onToggle);
  }, [x, y]);

  const close = () => ref.current?.hidePopover?.();
  /** the default: a draft for Pip, who plans the change with the crew */
  const ask = (e: FormEvent) => {
    e.preventDefault();
    if (!cat && !text.trim()) {
      setErr("Pick what's off, or write a line.");
      return;
    }
    const what = CHIPS.find((c) => c.category === cat)?.label.toLowerCase();
    const where = `At ${mss(t)}${scene ? ` (scene ${scene})` : ""}`;
    const draft = `${where}: ${[what, text.trim()].filter(Boolean).join(". ")}`;
    close();
    askPipAbout(projectId, draft);
  };
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!cat && !text.trim()) {
      setErr("Pick what's off, or write a line.");
      return;
    }
    setState("busy");
    setErr(null);
    try {
      await client.addNote(projectId, {
        target: { range: [t, t], scene },
        category: cat ?? "other",
        text: text.trim() || undefined,
        assignee: "producer",
      });
      setState("sent");
      setTimeout(close, 2500);
    } catch (ex) {
      setErr(`${(ex as Error).message}. Your note is still here; try again.`);
      setState("idle");
    }
  };

  return (
    <div ref={ref} popover="auto" className="steer" role="dialog" aria-labelledby="steer-title">
      {state === "sent" ? (
        <p role="status" className="steer-sent">
          Sent to the crew · they'll show you a fix
        </p>
      ) : (
        <form className="stack-3" onSubmit={ask} aria-busy={state === "busy" ? "true" : undefined}>
          <h2 id="steer-title" className="h4">
            What should change at {mss(t)}?
          </h2>
          <Fieldset id="steer-cat" legend="What's off" layout="row" size="sm">
            {CHIPS.map((c) => (
              <Radio
                key={c.category}
                id={`steer-${c.category}`}
                name="steer-cat"
                value={c.category}
                variant="chip"
                size="sm"
                indicator={false}
                label={c.label}
                checked={cat === c.category}
                onChange={() => setCat(c.category)}
              />
            ))}
          </Fieldset>
          <Field
            id="steer-text"
            label="Anything to add"
            size="sm"
            value={text}
            onChange={(e) => setText(e.currentTarget.value)}
            hint="Optional."
            autoComplete="off"
          />
          {err && (
            <p className="decision-error" role="status">
              {err}
            </p>
          )}
          <div className="needs-actions">
            <Button type="submit" size="sm" variant="primary">
              Ask Pip
            </Button>
            <Button size="sm" variant="quiet" onClick={close}>
              Cancel
            </Button>
          </div>
          <DirectControls who="the crew" summary="Send straight to the crew">
            <Button size="sm" variant="ghost" onClick={submit}>
              Send to the crew
            </Button>
          </DirectControls>
        </form>
      )}
    </div>
  );
}
