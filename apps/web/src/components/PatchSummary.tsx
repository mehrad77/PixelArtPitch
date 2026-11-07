// One change to the project: who made it, why, and the diff (each op with the value it replaced, from the inverse).
// Compare shows before and after side by side; Revert appends the inverse; "Revert and tell the agent why" adds a reason.
import { Badge, Button, Field } from "@shabboo/kit/react";
import { useState } from "react";
import { client } from "../lib/client.ts";
import { ROLE_LABEL } from "../lib/derive.ts";
import { ago } from "../lib/format.ts";
import type { PatchEntryT, PatchOpT, Role } from "../lib/types.ts";
import "./PatchSummary.css";

export function authorName(a: PatchEntryT["author"]): string {
  if (a.kind === "user") return "You";
  if (a.kind === "agent") return ROLE_LABEL[a.role as Role] ?? a.role ?? "An agent";
  if (a.kind === "mcp") return `MCP${a.client ? ` (${a.client})` : ""}`;
  return "System";
}

const show = (v: unknown) => {
  if (v === undefined) return "nothing";
  const s = typeof v === "string" ? v : JSON.stringify(v, null, 1);
  return s.length > 400 ? `${s.slice(0, 400)}…` : s;
};

/** the value at `path` before the patch: the inverse op that touches the same path */
function before(entry: PatchEntryT, op: PatchOpT): unknown {
  const inv = entry.inverse.find((x) => x.path === op.path);
  if (!inv) return undefined;
  return "value" in inv ? inv.value : undefined;
}

export function PatchSummary({ projectId, entry, undone }: { projectId: string; entry: PatchEntryT; undone: boolean }) {
  const [compare, setCompare] = useState(false);
  const [explain, setExplain] = useState(false);
  const [why, setWhy] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const id = `patch-${entry.seq}`;
  const revert = async (reason: string) => {
    setBusy(true);
    setErr(null);
    try {
      await client.undo(projectId, entry.seq, reason);
      setExplain(false);
    } catch (e) {
      const ex = e as Error & { fix?: string };
      setErr(
        `${ex.message}.${ex.fix ? ` ${ex.fix}` : " A later change may touch the same part; revert that one first."}`,
      );
    } finally {
      setBusy(false);
    }
  };
  return (
    <article className="patch" aria-labelledby={`${id}-t`} aria-busy={busy ? "true" : undefined}>
      <header className="patch-head">
        <span className="mono small muted">#{entry.seq}</span>
        <strong id={`${id}-t`} className="patch-author">
          {authorName(entry.author)}
        </strong>
        {entry.author.model && <span className="mono small muted">{entry.author.model.split("/").pop()}</span>}
        {entry.undoes != null && <Badge tone="muted">Undoes #{entry.undoes}</Badge>}
        {undone && <Badge tone="muted">Reverted</Badge>}
        <time className="muted small" dateTime={entry.ts}>
          {ago(entry.ts)}
        </time>
      </header>
      <p className="patch-reason">{entry.reason}</p>
      <ul className="patch-ops">
        {entry.ops.map((op, i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: ops are positional; two may share a path
          <li key={`${op.path}-${i}`}>
            <span className="mono small">{op.op}</span> <code className="ltr">{op.path}</code>
            {compare && (
              <div className="patch-compare">
                <div>
                  <span className="label">Before</span>
                  <pre className="diff-del">{show(before(entry, op))}</pre>
                </div>
                <div>
                  <span className="label">After</span>
                  <pre className="diff-add">
                    {show("value" in op ? op.value : op.op === "remove" ? undefined : (op as { from?: string }).from)}
                  </pre>
                </div>
              </div>
            )}
          </li>
        ))}
      </ul>
      {err && (
        <p className="decision-error" role="status">
          Not reverted: {err}
        </p>
      )}
      <div className="patch-actions">
        <Button size="sm" variant="ghost" aria-pressed={compare} onClick={() => setCompare(!compare)}>
          Compare
        </Button>
        {!undone && entry.undoes == null && (
          <>
            <Button size="sm" variant="ghost" onClick={() => revert(`Reverted #${entry.seq}`)}>
              Revert
            </Button>
            <Button
              size="sm"
              variant="ghost"
              aria-expanded={explain}
              aria-controls={`${id}-why`}
              onClick={() => setExplain(!explain)}
            >
              Revert and tell the agent why
            </Button>
          </>
        )}
      </div>
      {explain && (
        <form
          id={`${id}-why`}
          className="patch-why"
          onSubmit={(e) => {
            e.preventDefault();
            if (!why.trim()) {
              setErr("Say why, so the agent doesn't do it again.");
              document.getElementById(`${id}-why-f`)?.focus();
              return;
            }
            revert(why.trim());
          }}
        >
          <Field
            id={`${id}-why-f`}
            label={`Why revert this, ${authorName(entry.author)}?`}
            control="textarea"
            rows={2}
            size="sm"
            value={why}
            onChange={(e) => setWhy(e.currentTarget.value)}
          />
          <Button type="submit" size="sm" variant="primary">
            Revert and send
          </Button>
        </form>
      )}
    </article>
  );
}
