// "Add connection": paste server JSON (the mcpServers shape, several at once), see each server as a row before
// anything runs, then one button that says exactly what it does ("Run npx foo-mcp and connect"). Values of env and
// headers are never shown: only their names. After a submit the field empties, so a pasted secret doesn't linger.
// Used by Pip's form card and by Settings › Connections.
import { Button, Field, Icon } from "@shabboo/kit/react";
import { type FormEvent, useEffect, useId, useState } from "react";
import { commandLine, hostsWords, type Parsed, parseMcpJson, submitEffect } from "../lib/mcp.ts";
import type { PipAdded } from "../lib/types.ts";

const EXAMPLE = `{
  "mcpServers": {
    "music": { "command": "npx", "args": ["-y", "music-search-mcp"], "env": { "API_KEY": "…" } }
  }
}`;

export function McpForm({
  onSubmit,
  busy = false,
  result,
  onCancel,
  cancelLabel = "Cancel",
}: {
  /** returns nothing on success; throws to keep the text and say why */
  onSubmit: (json: string) => Promise<void>;
  busy?: boolean;
  result?: PipAdded[] | null;
  onCancel?: () => void;
  cancelLabel?: string;
}) {
  const id = useId();
  const [text, setText] = useState("");
  const [parsed, setParsed] = useState<Parsed>({ servers: [] });
  const [err, setErr] = useState<string | null>(null);
  // the preview follows the paste after a short pause; it never blocks typing
  useEffect(() => {
    const t = setTimeout(() => setParsed(parseMcpJson(text)), 250);
    return () => clearTimeout(t);
  }, [text]);

  const eff = submitEffect(parsed.servers);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const now = parseMcpJson(text);
    setParsed(now);
    if (!text.trim()) return setErr("Paste the server JSON first.");
    if (now.error) return setErr(now.error);
    const bad = now.servers.find((s) => s.problem);
    if (bad) return setErr(`${bad.name}: ${bad.problem}`);
    setErr(null);
    try {
      await onSubmit(text);
      setText("");
      setParsed({ servers: [] });
    } catch (ex) {
      setErr(`${(ex as Error).message}. Your JSON is still here.`);
    }
  };

  if (result?.length) return <McpResult added={result} />;

  return (
    <form className="mcp-form" onSubmit={submit} aria-busy={busy ? "true" : undefined}>
      <Field
        id={`${id}-json`}
        label="Server JSON"
        control="textarea"
        code
        hint="Paste from Claude Desktop, Claude Code or a server's README. Several servers at once are fine."
        placeholder={EXAMPLE}
        value={text}
        rows={6}
        error={parsed.error && text.trim() ? parsed.error : undefined}
        onChange={(e) => {
          setText(e.currentTarget.value);
          if (err) setErr(null);
        }}
      />
      {parsed.servers.length > 0 && (
        <ul className="mcp-preview" aria-label="What will be added">
          {parsed.servers.map((s) => (
            <li key={s.name} className="mcp-row" data-problem={s.problem ? "" : undefined}>
              <span className="mcp-row-name mono" translate="no">
                {s.name}
              </span>
              <span className="mcp-row-how small">
                {s.transport === "stdio" ? (
                  <>
                    <span className="muted">Runs on this computer: </span>
                    <code className="ltr" translate="no">
                      {commandLine(s) || "(no command)"}
                    </code>
                  </>
                ) : (
                  <>
                    <span className="muted">Connects to </span>
                    <code className="ltr" translate="no">
                      {s.url}
                    </code>
                  </>
                )}
              </span>
              {(s.envKeys.length > 0 || s.headerKeys.length > 0) && (
                <span className="mcp-row-keys small muted">
                  {s.envKeys.length > 0 && (
                    <>
                      Env:{" "}
                      {s.envKeys.map((k) => (
                        <code key={k} className="ltr" translate="no">
                          {k}=••••
                        </code>
                      ))}
                    </>
                  )}
                  {s.headerKeys.length > 0 && (
                    <>
                      {" "}
                      Headers:{" "}
                      {s.headerKeys.map((k) => (
                        <code key={k} className="ltr" translate="no">
                          {k}: ••••
                        </code>
                      ))}
                    </>
                  )}
                  <span className="visually-hidden"> (values hidden)</span>
                </span>
              )}
              {s.problem && (
                <span className="mcp-row-problem small">
                  <Icon name="warning" size="sm" label="Problem" /> {s.problem}
                </span>
              )}
            </li>
          ))}
        </ul>
      )}
      <div className="mcp-actions">
        <Button type="submit" variant="primary" size="sm" aria-disabled={busy ? "true" : undefined}>
          {busy ? (
            "Connecting…"
          ) : eff.run.length ? (
            <>
              Run{" "}
              {eff.run.map((c, i) => (
                <span key={c}>
                  {i > 0 && (i === eff.run.length - 1 ? " and " : ", ")}
                  <code className="ltr" translate="no">
                    {c}
                  </code>
                </span>
              ))}{" "}
              and connect
              {eff.hosts.length ? ` to ${hostsWords(eff.hosts)} too` : ""}
            </>
          ) : eff.hosts.length ? (
            `Connect to ${hostsWords(eff.hosts)}`
          ) : (
            "Connect"
          )}
        </Button>
        {onCancel && (
          <Button type="button" variant="quiet" size="sm" onClick={onCancel}>
            {cancelLabel}
          </Button>
        )}
      </div>
      {eff.run.length > 0 && (
        <p className="small muted">
          Nothing runs until you press the button. Secrets go to your keychain, not to settings.
        </p>
      )}
      <p className="small mcp-error" role="status">
        {err ?? ""}
      </p>
    </form>
  );
}

export function McpResult({ added }: { added: PipAdded[] }) {
  return (
    <ul className="mcp-result">
      {added.map((a) => (
        <li key={a.name} data-status={a.status}>
          <span className="mcp-mark" aria-hidden="true">
            {a.status === "connected" ? "✓" : "✕"}
          </span>
          <div>
            <p>
              <span className="mono" translate="no">
                {a.name}
              </span>
              {a.status === "connected"
                ? ` connected: ${a.tools.length} ${a.tools.length === 1 ? "tool" : "tools"}.`
                : " didn't connect."}
            </p>
            {a.status === "connected" && a.tools.length > 0 && (
              <p className="small muted ltr mono" translate="no">
                {a.tools.join(", ")}
              </p>
            )}
            {a.error && <p className="small">{a.error}</p>}
            {a.fix && <p className="small muted">{a.fix}</p>}
          </div>
        </li>
      ))}
    </ul>
  );
}
