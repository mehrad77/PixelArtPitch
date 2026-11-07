// Settings › Connections: the person's own MCP servers. One calm row each: name, what it runs or where it connects,
// its status in words, its tools, the trust choice, on/off and Remove (asked again in place). "Add connection"
// opens the same form Pip shows. Secret values never come back from the server, so none are shown here.
import { Badge, Button, Disclosure, EmptyState, Radio, Skeleton, Switch } from "@shabboo/kit/react";
import { useEffect, useRef, useState } from "react";
import { McpForm, McpResult } from "../components/McpForm.tsx";
import { client } from "../lib/client.ts";
import { useLoad } from "../lib/hooks.ts";
import { commandLine } from "../lib/mcp.ts";
import type { Connection, ConnectionTrust, PipAdded } from "../lib/types.ts";
import "../components/Pip.css";
import "./Connections.css";

const STATUS: Record<Connection["status"], { word: string; tone: "success" | "error" | "muted" }> = {
  connected: { word: "Connected", tone: "success" },
  failed: { word: "Didn't connect", tone: "error" },
  off: { word: "Off", tone: "muted" },
};

export function Connections() {
  const list = useLoad(() => client.connections(), []);
  const [adding, setAdding] = useState(false);
  const [busy, setBusy] = useState(false);
  const [added, setAdded] = useState<PipAdded[] | null>(null);
  const addBtn = useRef<HTMLSpanElement>(null);

  const submit = async (json: string) => {
    setBusy(true);
    try {
      const r = await client.addConnections(json);
      setAdded(r.added);
      list.reload();
    } finally {
      setBusy(false);
    }
  };
  const closeForm = () => {
    setAdding(false);
    setAdded(null);
    requestAnimationFrame(() => addBtn.current?.querySelector("button")?.focus());
  };

  return (
    <div className="stack-4 conn">
      <p className="muted">
        Connections give the crew new tools from your own MCP servers: music search, a brand kit, a translation service.
        Pip lends a tool to the crew only for the task that needs it.
      </p>
      {list.error && (
        <p className="small" role="status">
          Couldn't load connections: {list.error.message}. Reload to try again.
        </p>
      )}
      {!list.data && !list.error && <Skeleton lines={3} label="Loading connections" />}
      {list.data && list.data.length === 0 && !adding && (
        <EmptyState size="sm" title="No connections yet">
          Add one by pasting its JSON, or ask Pip to add an MCP server.
        </EmptyState>
      )}
      {list.data && list.data.length > 0 && (
        <ul className="conn-list">
          {list.data.map((c) => (
            <ConnectionRow key={c.name} c={c} onChanged={list.reload} />
          ))}
        </ul>
      )}
      {adding ? (
        <section className="conn-add" aria-labelledby="conn-add-h">
          <h3 id="conn-add-h" className="h4">
            Add connection
          </h3>
          {added ? (
            <>
              <McpResult added={added} />
              <div>
                <Button size="sm" variant="ghost" onClick={closeForm}>
                  Done
                </Button>
              </div>
            </>
          ) : (
            <McpForm busy={busy} onSubmit={submit} onCancel={closeForm} />
          )}
        </section>
      ) : (
        <span ref={addBtn} className="conn-add-btn">
          <Button
            variant="primary"
            size="sm"
            onClick={() => {
              setAdding(true);
              requestAnimationFrame(() => document.querySelector<HTMLElement>(".conn-add textarea")?.focus());
            }}
          >
            Add connection
          </Button>
        </span>
      )}
    </div>
  );
}

function ConnectionRow({ c, onChanged }: { c: Connection; onChanged: () => void }) {
  const [asking, setAsking] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [testing, setTesting] = useState(false);
  const row = useRef<HTMLLIElement>(null);
  const moved = useRef(false);
  const st = STATUS[c.status];
  const id = `conn-${c.name.replace(/[^\w-]/g, "_")}`;
  // the pressed button is replaced by Yes / Cancel and back: focus follows it
  useEffect(() => {
    if (!moved.current) return;
    moved.current = false;
    row.current?.querySelector<HTMLButtonElement>(asking ? ".conn-yes" : ".conn-remove")?.focus();
  }, [asking]);

  const run = async (fn: () => Promise<unknown>, done?: string) => {
    setMsg(null);
    try {
      await fn();
      if (done) setMsg(done);
      onChanged();
    } catch (e) {
      setMsg(`${(e as Error).message}. Try again.`);
    }
  };

  return (
    <li className="conn-row" ref={row} aria-labelledby={`${id}-name`}>
      <div className="conn-head">
        <h3 id={`${id}-name`} className="conn-name mono" translate="no">
          {c.name}
        </h3>
        <Badge tone={st.tone} size="sm" variant="text">
          {st.word}
        </Badge>
        {c.status === "connected" && (
          <span className="small muted">
            {c.tools.length} {c.tools.length === 1 ? "tool" : "tools"}
          </span>
        )}
      </div>
      <p className="small conn-how">
        {c.transport === "stdio" ? (
          <>
            <span className="muted">Runs </span>
            <code className="ltr" translate="no">
              {commandLine(c)}
            </code>
          </>
        ) : (
          <>
            <span className="muted">Connects to </span>
            <code className="ltr" translate="no">
              {c.url}
            </code>
          </>
        )}
        {!!(c.envKeys?.length || c.headerKeys?.length) && (
          <span className="muted">
            {" · secrets kept in your keychain: "}
            <span className="ltr mono" translate="no">
              {[...(c.envKeys ?? []), ...(c.headerKeys ?? [])].join(", ")}
            </span>
          </span>
        )}
      </p>
      {c.status === "failed" && (c.error || c.fix) && (
        <div className="small conn-problem">
          {c.error && <p>{c.error}</p>}
          {c.fix && <p className="muted">{c.fix}</p>}
        </div>
      )}
      {c.tools.length > 0 && (
        <Disclosure size="sm" summary="Show tools">
          <p className="small mono ltr" translate="no">
            {c.tools.join(", ")}
          </p>
        </Disclosure>
      )}
      <div className="conn-controls">
        <fieldset className="conn-trust">
          <legend className="label">Trust</legend>
          {(
            [
              ["ask", "Ask every time"],
              ["read_only", "Allow read-only tools"],
            ] as [ConnectionTrust, string][]
          ).map(([v, label]) => (
            <Radio
              key={v}
              id={`${id}-trust-${v}`}
              name={`${id}-trust`}
              value={v}
              variant="chip"
              size="sm"
              label={label}
              checked={c.trust === v}
              onChange={() => run(() => client.updateConnection(c.name, { trust: v }))}
            />
          ))}
        </fieldset>
        <Switch
          id={`${id}-on`}
          size="sm"
          label="On"
          checked={c.enabled}
          onChange={(e) => {
            const on = e.currentTarget.checked;
            run(() => client.updateConnection(c.name, { enabled: on }));
          }}
        />
        <span className="conn-end">
          <Button
            size="sm"
            variant="quiet"
            aria-disabled={testing ? "true" : undefined}
            onClick={async () => {
              setTesting(true);
              await run(() => client.testConnection(c.name), "Tested.");
              setTesting(false);
            }}
          >
            {testing ? "Testing…" : "Test"}
          </Button>
          {asking ? (
            <>
              <Button
                size="sm"
                variant="danger"
                className="conn-yes"
                onClick={() =>
                  run(async () => {
                    await client.removeConnection(c.name);
                    // the row goes away: focus lands on Add connection instead of the page
                    requestAnimationFrame(() => document.querySelector<HTMLElement>(".conn-add-btn button")?.focus());
                  })
                }
              >
                Yes, remove {c.name}
              </Button>
              <Button
                size="sm"
                variant="quiet"
                onClick={() => {
                  moved.current = true;
                  setAsking(false);
                }}
              >
                Cancel
              </Button>
            </>
          ) : (
            <Button
              size="sm"
              variant="quiet"
              className="conn-remove"
              onClick={() => {
                moved.current = true;
                setAsking(true);
              }}
            >
              Remove
            </Button>
          )}
        </span>
      </div>
      {c.trust === "read_only" && (
        <p className="small muted">
          Tools this connection says only read run without asking. Everything else is still a card you confirm.
        </p>
      )}
      <p className="small conn-msg" role="status">
        {msg ?? ""}
      </p>
    </li>
  );
}
