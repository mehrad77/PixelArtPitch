// The note form the M key opens at the playhead (or the In/Out range): category chips, optional text, and who it
// goes to, prefilled from the track and changeable.
import { Button, Dialog, Field, Fieldset, Radio } from "@shabboo/kit/react";
import { type FormEvent, useState } from "react";
import { client } from "../lib/client.ts";
import { NOTE_CATEGORY, ROLE_LABEL, ROLES, TRACKS, type TrackId } from "../lib/derive.ts";
import { timecode } from "../lib/format.ts";
import type { NoteCategory, NoteTarget, Role } from "../lib/types.ts";

export function NoteForm({
  projectId,
  target,
  track,
  onClose,
}: {
  projectId: string;
  target: NoteTarget;
  track: TrackId;
  onClose: () => void;
}) {
  const [cat, setCat] = useState<NoteCategory>("unclear");
  const [text, setText] = useState("");
  const [to, setTo] = useState<Role | "producer">(TRACKS.find((t) => t.id === track)?.assignee ?? "producer");
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const where = target.range
    ? target.range[1] - target.range[0] > 0.05
      ? `${timecode(target.range[0])} to ${timecode(target.range[1])}`
      : `at ${timecode(target.range[0])}`
    : "here";
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setErr(null);
    try {
      await client.addNote(projectId, {
        target: { ...target, track },
        category: cat,
        text: text.trim() || undefined,
        assignee: to,
      });
      onClose();
    } catch (ex) {
      setErr(`${(ex as Error).message}. Your note is still here; try again.`);
      setBusy(false);
    }
  };
  return (
    <Dialog
      id="note-dialog"
      title={`Note ${where}${target.scene ? `, ${target.scene}` : ""}`}
      open
      onClose={onClose}
      closedby="closerequest"
      size="sm"
      closeLabel="Cancel"
    >
      <form className="stack-3" onSubmit={submit} aria-busy={busy ? "true" : undefined}>
        <Fieldset id="note-cat" legend="What's wrong" layout="row" size="sm">
          {(Object.keys(NOTE_CATEGORY) as NoteCategory[]).map((c) => (
            <Radio
              key={c}
              id={`note-cat-${c}`}
              name="note-cat"
              variant="chip"
              size="sm"
              indicator={false}
              label={NOTE_CATEGORY[c]}
              checked={cat === c}
              onChange={() => setCat(c)}
            />
          ))}
        </Fieldset>
        <Field
          id="note-text"
          label="Note"
          control="textarea"
          rows={3}
          value={text}
          onChange={(e) => setText(e.currentTarget.value)}
          hint="Optional."
        />
        <Field
          id="note-to"
          label="Goes to"
          control="select"
          value={to}
          onChange={(e) => setTo(e.currentTarget.value as Role | "producer")}
        >
          {ROLES.map((r) => (
            <option key={r} value={r}>
              {ROLE_LABEL[r]}
            </option>
          ))}
        </Field>
        {err && (
          <p className="decision-error" role="status">
            {err}
          </p>
        )}
        <div className="decision-actions">
          <Button type="submit" variant="primary">
            Add note
          </Button>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
