// /context: what Pip's model is holding right now, as one stacked bar and a row per part. A modal opened from the
// field; nothing goes into the conversation. Esc closes it and focus goes back to the field.
import { Button, Dialog, Skeleton } from "@shabboo/kit/react";
import type { CSSProperties } from "react";
import { client } from "../lib/client.ts";
import { useLoad } from "../lib/hooks.ts";
import { modelWords } from "../lib/human.ts";
import { askPip } from "../lib/pip.ts";
import type { PipContext, PipContextPart } from "../lib/types.ts";
import "./PipContext.css";

/** 1.2k, 161.3k; under a thousand as is */
export const tok = (n: number) => (n < 1000 ? String(Math.round(n)) : `${(n / 1000).toFixed(1)}k`);
const tokRound = (n: number) => (n < 1000 ? String(Math.round(n)) : `${Math.round(n / 1000)}k`);
const pct = (n: number, of: number) => (of > 0 ? Math.round((n / of) * 100) : 0);

const ORDER: PipContextPart["id"][] = ["system", "facts", "tools", "summary", "messages", "reserve"];
const LABEL: Record<PipContextPart["id"], string> = {
  system: "System prompt",
  facts: "Project facts",
  tools: "Tool definitions",
  summary: "Summary of earlier conversation",
  messages: "Conversation",
  reserve: "Room for the reply",
};

const WHO: Record<string, string> = {
  anthropic: "Anthropic",
  openai: "OpenAI",
  openrouter: "OpenRouter",
  lmstudio: "LM Studio",
  ollama: "Ollama",
  llamacpp: "llama.cpp",
  "llama.cpp": "llama.cpp",
};
const whoOf = (s?: string) => (s ? (WHO[s.toLowerCase()] ?? s) : "");
const LOCAL = new Set(["lmstudio", "ollama", "llamacpp", "llama.cpp"]);

/** "Counted by Anthropic · window from the provider", "Estimated (calibrated from 40 calls) · window as loaded in LM Studio" */
export function sourceLine(c: PipContext): string {
  const src = c.countSource ?? "";
  const calls = src.match(/from (\d+) calls?/i)?.[1];
  const counted =
    c.method === "count"
      ? `Counted by ${whoOf(src.split(/\s/)[0]) || whoOf(c.provider) || "the provider"}`
      : calls
        ? `Estimated (calibrated from ${calls} calls)`
        : "Estimated from the text";
  const provider = (c.provider ?? c.model.split("/")[0] ?? "").toLowerCase();
  const window =
    c.windowSource === "provider"
      ? LOCAL.has(provider)
        ? `window as loaded in ${whoOf(provider)}`
        : "window from the provider"
      : c.windowSource === "table"
        ? "window from the model table"
        : c.window == null || c.windowSource === "unknown"
          ? "window size unknown"
          : "";
  return window ? `${counted} · ${window}` : counted;
}

export function ContextDialog({
  project,
  open,
  onClose,
}: {
  project: string | null | undefined;
  open: boolean;
  onClose: () => void;
}) {
  const ctx = useLoad<PipContext | null>(
    () => (open ? client.pipContext(project || undefined) : Promise.resolve(null)),
    [open, project],
  );
  return (
    <Dialog
      id={`pip-context-${project ?? "ws"}`}
      title="What Pip is holding"
      size="sm"
      open={open}
      onClose={onClose}
      closeLabel="Close"
      className="pip-context"
    >
      {ctx.error ? (
        <p className="small" role="status">
          Couldn't read Pip's context: {ctx.error.message}. Close this and try /context again.
        </p>
      ) : !ctx.data ? (
        <Skeleton lines={4} label="Reading Pip's context" />
      ) : (
        <ContextBody c={ctx.data} project={project} onClose={onClose} />
      )}
    </Dialog>
  );
}

function ContextBody({
  c,
  project,
  onClose,
}: {
  c: PipContext;
  project: string | null | undefined;
  onClose: () => void;
}) {
  const about = c.method === "estimate" ? "about " : "";
  const parts = ORDER.flatMap((id) => {
    const p = c.parts.find((x) => x.id === id);
    return p ? [p] : [];
  });
  const used = c.total || parts.reduce((a, p) => a + p.tokens, 0);
  const whole = c.window ?? used;
  const free = c.window != null ? Math.max(0, c.window - used) : null;
  const low = free != null && c.window ? free / c.window < 0.2 : false;
  const model = modelWords(c.model).split(" · ")[0];
  return (
    <div className="pip-context-body">
      <p className="pip-context-head">
        <bdi className="mono">
          {about}
          {tokRound(used)}
          {c.window != null ? ` of ${tokRound(c.window)} · ${pct(used, c.window)}%` : ""}
        </bdi>
        <span aria-hidden="true"> · </span>
        <bdi>{model}</bdi>
        {c.mode ? (
          <span className="muted">
            <span aria-hidden="true"> · </span>
            <bdi>{c.mode === "agent" ? "agent mode" : "menu mode"}</bdi>
          </span>
        ) : null}
      </p>
      <div className="pip-context-bar" aria-hidden="true">
        {parts.map((p, i) => (
          <span
            key={p.id}
            className="pip-context-seg"
            data-tone={i}
            style={{ inlineSize: `${(p.tokens / whole) * 100}%` } as CSSProperties}
          />
        ))}
      </div>
      <ul className="pip-context-rows">
        {parts.map((p, i) => (
          <li key={p.id}>
            <span className="pip-context-swatch" data-tone={i} aria-hidden="true" />
            <span className="pip-context-label">
              {p.label || LABEL[p.id]}
              {p.detail && <span className="muted small"> · {p.detail}</span>}
            </span>
            <span className="pip-context-num mono">{tok(p.tokens)}</span>
            <span className="pip-context-pct mono muted">{pct(p.tokens, whole)}%</span>
          </li>
        ))}
        {free != null && (
          <li>
            <span className="pip-context-swatch" data-tone="free" aria-hidden="true" />
            <span className="pip-context-label">Free space</span>
            <span className="pip-context-num mono">{tok(free)}</span>
            <span className="pip-context-pct mono muted">{pct(free, whole)}%</span>
          </li>
        )}
      </ul>
      <p className="small muted pip-context-source">{sourceLine(c)}</p>
      {low && (
        <div className="pip-context-low">
          <p className="small">
            Running low? <span className="mono">/compact</span> folds older messages into the summary.
          </p>
          <Button
            size="sm"
            variant="ghost"
            onClick={() => {
              onClose();
              askPip(project, "/compact");
            }}
          >
            Compact now
          </Button>
        </div>
      )}
    </div>
  );
}
