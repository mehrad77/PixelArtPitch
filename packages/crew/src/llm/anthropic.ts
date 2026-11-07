// The Anthropic Messages API over plain fetch + SSE (no SDK).
// Shapes: claude-api/curl/examples.md (headers, streaming events, tool use, caching, adaptive thinking), checked against
// the event and usage types of @anthropic-ai/sdk 1.6.0 (RawMessageStreamEvent, MessageDeltaUsage, StopReason).
import {
  backoffMs,
  defaultSleep,
  type FetchLike,
  type HttpOpts,
  isAbort,
  ProviderError,
  parseSSE,
  postWithRetry,
  splitModelId,
} from "./http.ts";
import { costUsd, priceFor } from "./prices.ts";
import { sanitizeSchema } from "./schema.ts";
import type {
  AssistantPart,
  Caps,
  ChatMessage,
  ChatRequest,
  ChatResult,
  ContentPart,
  CountInfo,
  ModelInfo,
  Price,
  Provider,
  ProviderConfig,
  StreamEvent,
  Usage,
  WindowInfo,
} from "./types.ts";

export const ANTHROPIC_VERSION = "2026-10-21";

type ThinkingOff = "never" | "disabled" | "between_tools";
type KnownModel = { label: string; thinkingOff: ThinkingOff; forcedTool: boolean };

/** Models this layer knows by name (claude-api/shared/models.md:79-87, tool-use-concepts.md:106). */
export const ANTHROPIC_MODELS: Record<string, KnownModel> = {
  // thinking can't be disabled; forced tool_choice returns 400
  "claude-opus-5-5": { label: "Claude Opus 5.5", thinkingOff: "never", forcedTool: false },
  // `disabled` returns 400; `between_tools` at effort <= high turns thinking off; forced tool_choice returns 400
  "claude-sonnet-5-5": { label: "Claude Sonnet 5.5", thinkingOff: "between_tools", forcedTool: false },
  // `disabled` accepted at effort <= high; not in the forced-tool_choice exclusion list
  "claude-haiku-5-5": { label: "Claude Haiku 5.5", thinkingOff: "disabled", forcedTool: true },
  // thinking always on; forced tool_choice returns 400
  "claude-fable-5-1": { label: "Claude Fable 5.1", thinkingOff: "never", forcedTool: false },
};

const knownCaps = (forcedTool: boolean): Caps => ({
  vision: "claimed",
  structured: "claimed",
  tools: "claimed",
  longOutput: "claimed",
  thinking: "adaptive",
  caching: true,
  ctx: 1_000_000,
  maxOut: 128_000,
  concurrency: 6,
  local: false,
  forcedTool,
});

export type AnthropicOpts = HttpOpts & {
  /** read at call time so a key set later is picked up; never logged */
  getKey: () => string | undefined;
  version?: string;
  /** extra stream-level retries when an `error` event arrives before any content (default 2) */
  streamRetries?: number;
};

export class AnthropicProvider implements Provider {
  config: ProviderConfig;
  private opts: AnthropicOpts;
  constructor(config: ProviderConfig, opts: AnthropicOpts) {
    this.config = config;
    this.opts = opts;
  }

  private headers(): Record<string, string> {
    const key = this.opts.getKey();
    if (!key) throw new ProviderError(`${this.config.id}: no API key`, 401, "authentication_error", false);
    return {
      "x-api-key": key,
      "anthropic-version": this.opts.version ?? ANTHROPIC_VERSION,
      "content-type": "application/json",
    };
  }

  private base(): string {
    return this.config.baseUrl.replace(/\/+$/, "").replace(/\/v1$/, "");
  }

  /** The static table, no network. */
  knownModels(): ModelInfo[] {
    return Object.entries(ANTHROPIC_MODELS).map(([model, k]) => ({
      id: `${this.config.id}/${model}`,
      provider: this.config.id,
      model,
      label: k.label,
      caps: knownCaps(k.forcedTool),
      price: priceFor(model),
    }));
  }

  /** GET /v1/models (id, display_name, max_input_tokens, max_tokens, capabilities; models.md "Raw HTTP"). */
  async listModels(signal?: AbortSignal): Promise<ModelInfo[]> {
    const f: FetchLike = this.opts.fetch ?? fetch;
    const out: ModelInfo[] = [];
    let after: string | null = null;
    for (let page = 0; page < 20; page++) {
      const url = `${this.base()}/v1/models?limit=1000${after ? `&after_id=${encodeURIComponent(after)}` : ""}`;
      const { "content-type": _ct, ...h } = this.headers();
      const res = await f(url, { method: "GET", headers: h, signal });
      if (!res.ok) throw new ProviderError(`${res.status} listing models`, res.status, `http_${res.status}`, false);
      const body = (await res.json()) as { data?: any[]; has_more?: boolean; last_id?: string | null };
      for (const m of body.data ?? []) out.push(this.fromApi(m));
      if (!body.has_more || !body.last_id) break;
      after = body.last_id;
    }
    return out;
  }

  private fromApi(m: any): ModelInfo {
    const known = ANTHROPIC_MODELS[m.id];
    const c = m.capabilities ?? {};
    const sup = (x: any): boolean | undefined => (x && typeof x.supported === "boolean" ? x.supported : undefined);
    const flag = (x: boolean | undefined) => (x === undefined ? "unknown" : x ? "claimed" : "failed");
    const maxOut = typeof m.max_tokens === "number" ? m.max_tokens : known ? 128_000 : 0;
    const adaptive = sup(c.thinking?.types?.adaptive);
    const caps: Caps = {
      vision: flag(sup(c.image_input) ?? (known ? true : undefined)),
      structured: flag(sup(c.structured_outputs) ?? (known ? true : undefined)),
      tools: "claimed",
      longOutput: maxOut >= 32_000 ? "claimed" : maxOut ? "failed" : "unknown",
      thinking: adaptive || known ? "adaptive" : sup(c.effort) ? "effort" : "none",
      caching: true,
      ctx: typeof m.max_input_tokens === "number" ? m.max_input_tokens : known ? 1_000_000 : 0,
      maxOut,
      concurrency: 6,
      local: false,
      forcedTool: known ? known.forcedTool : undefined,
    };
    return {
      id: `${this.config.id}/${m.id}`,
      provider: this.config.id,
      model: m.id,
      label: m.display_name ?? known?.label ?? m.id,
      caps,
      price: priceFor(m.id),
    };
  }

  buildBody(req: ChatRequest): Record<string, unknown> {
    const { model } = splitModelIdFor(this.config.id, req.model);
    const known = ANTHROPIC_MODELS[model];
    const body: Record<string, unknown> = { model, max_tokens: req.maxOut, stream: true };
    if (req.system) {
      body.system = req.cache ? [{ type: "text", text: req.system, cache_control: { type: "ephemeral" } }] : req.system;
    }
    body.messages = toAnthropicMessages(req.messages);
    if (req.tools?.length) {
      body.tools = req.tools.map((t, i) => ({
        name: t.name,
        description: t.description,
        input_schema: t.inputSchema,
        ...(req.cache && i === req.tools!.length - 1 ? { cache_control: { type: "ephemeral" } } : {}),
      }));
      const tc = req.toolChoice;
      if (tc === "none") body.tool_choice = { type: "none" };
      else if (tc && typeof tc === "object") {
        // Opus 5.5 / Sonnet 5.5 / Fable 5.1 400 on a forced choice: send auto, the caller's prompt names the tool
        body.tool_choice = known && !known.forcedTool ? { type: "auto" } : { type: "tool", name: tc.name };
      } else if (tc === "auto") body.tool_choice = { type: "auto" };
    }
    const lowEffort = !req.effort || req.effort === "low" || req.effort === "medium" || req.effort === "high";
    // unknown models keep their own default; known 5.x models run adaptive unless asked off where allowed
    if (known) {
      const off = req.thinking === false && lowEffort && known.thinkingOff !== "never";
      body.thinking = { type: off ? known.thinkingOff : "adaptive" };
    }
    const oc: Record<string, unknown> = {};
    if (req.effort) oc.effort = req.effort;
    if (req.json) oc.format = { type: "json_schema", schema: sanitizeSchema(req.json.schema).schema };
    if (Object.keys(oc).length) body.output_config = oc;
    // no temperature/top_p/top_k: API version 2026-10-21 rejects sampling parameters on every model
    return body;
  }

  /** the free count_tokens endpoint: the exact system + tools + messages this request would send (never billed) */
  async countTokens(req: ChatRequest, signal?: AbortSignal): Promise<CountInfo | null> {
    const { stream: _s, max_tokens: _m, output_config: _o, ...body } = this.buildBody(req) as Record<string, unknown>;
    const res = await postWithRetry(`${this.base()}/v1/messages/count_tokens`, this.headers(), body, {
      ...this.opts,
      maxRetries: 1,
      signal,
    });
    const j = (await res.json()) as { input_tokens?: number };
    return typeof j.input_tokens === "number" ? { tokens: j.input_tokens, source: "anthropic count_tokens" } : null;
  }

  /** GET /v1/models/{id}: max_input_tokens when the API reports it */
  async contextWindow(model: string, signal?: AbortSignal): Promise<WindowInfo | null> {
    const f: FetchLike = this.opts.fetch ?? fetch;
    const { "content-type": _ct, ...h } = this.headers();
    const id = splitModelIdFor(this.config.id, model).model;
    const res = await f(`${this.base()}/v1/models/${encodeURIComponent(id)}`, { method: "GET", headers: h, signal });
    if (!res.ok) return null;
    const m = (await res.json()) as { max_input_tokens?: number };
    return typeof m.max_input_tokens === "number"
      ? { window: m.max_input_tokens, source: "anthropic /v1/models max_input_tokens" }
      : null;
  }

  async chat(
    req: ChatRequest,
    opts: { signal?: AbortSignal; onEvent?: (e: StreamEvent) => void; price?: Price | null } = {},
  ): Promise<ChatResult> {
    const body = this.buildBody(req);
    const model = body.model as string;
    const url = `${this.base()}/v1/messages`;
    const streamRetries = this.opts.streamRetries ?? 2;
    const sleep = this.opts.sleep ?? defaultSleep;
    for (let attempt = 0; ; attempt++) {
      const t0 = performance.now();
      const res = await postWithRetry(url, this.headers(), body, { ...this.opts, signal: opts.signal });
      try {
        const r = await readAnthropicStream(res, t0, opts.onEvent);
        const price = opts.price !== undefined ? opts.price : priceFor(model);
        const usd = costUsd(price, r.usage);
        let json: unknown;
        if (req.json && r.text) {
          try {
            json = JSON.parse(r.text);
          } catch {}
        }
        return {
          text: r.text,
          json,
          toolCalls: r.toolCalls,
          assistant: r.assistant,
          stop: r.stop,
          usage: r.usage,
          usd,
          usdSource: price ? "table" : "zero",
          ttftMs: r.ttftMs,
          durationMs: performance.now() - t0,
          raw: { id: r.id, model: r.model, stopReason: r.stopReason, stopDetails: r.stopDetails },
        };
      } catch (e) {
        if (isAbort(e) || opts.signal?.aborted) throw e;
        if (e instanceof StreamError && e.err.retryable && !e.emitted && attempt < streamRetries) {
          await sleep(backoffMs(attempt, null), opts.signal);
          continue;
        }
        throw e instanceof StreamError ? e.err : e;
      }
    }
  }
}

function splitModelIdFor(providerId: string, id: string) {
  const s = splitModelId(id);
  return s.provider === providerId ? s : { provider: providerId, model: id };
}

class StreamError extends Error {
  err: ProviderError;
  emitted: boolean;
  constructor(err: ProviderError, emitted: boolean) {
    super(err.message);
    this.err = err;
    this.emitted = emitted;
  }
}

const imageBlock = (p: Extract<ContentPart, { type: "image" }>) => ({
  type: "image",
  source: { type: "base64", media_type: p.mediaType, data: p.data },
});
const partBlocks = (c: string | ContentPart[]) =>
  typeof c === "string"
    ? [{ type: "text", text: c }]
    : c.map((p) => (p.type === "text" ? { type: "text", text: p.text } : imageBlock(p)));

/** ChatMessage[] -> Anthropic messages: tool results become user tool_result blocks; same-role neighbours merge. */
export function toAnthropicMessages(messages: ChatMessage[]): { role: "user" | "assistant"; content: unknown[] }[] {
  const out: { role: "user" | "assistant"; content: unknown[] }[] = [];
  const push = (role: "user" | "assistant", blocks: unknown[]) => {
    if (!blocks.length) return;
    const last = out.at(-1);
    if (last && last.role === role) last.content.push(...blocks);
    else out.push({ role, content: blocks });
  };
  for (const m of messages) {
    if (m.role === "user") push("user", partBlocks(m.content));
    else if (m.role === "tool") {
      push("user", [
        {
          type: "tool_result",
          tool_use_id: m.toolCallId,
          content: typeof m.content === "string" ? m.content : partBlocks(m.content),
          ...(m.isError ? { is_error: true } : {}),
        },
      ]);
    } else {
      const parts: AssistantPart[] = typeof m.content === "string" ? [{ type: "text", text: m.content }] : m.content;
      const blocks: unknown[] = [];
      for (const p of parts) {
        if (p.type === "opaque") {
          if (p.provider === "anthropic") blocks.push(p.block);
        } else if (p.type === "text") {
          if (p.text) blocks.push({ type: "text", text: p.text });
        } else blocks.push({ type: "tool_use", id: p.id, name: p.name, input: p.input ?? {} });
      }
      push("assistant", blocks);
    }
  }
  return out;
}

const STOP: Record<string, ChatResult["stop"]> = {
  end_turn: "end",
  stop_sequence: "end",
  pause_turn: "end",
  tool_use: "tool_use",
  max_tokens: "max_tokens",
  model_context_window_exceeded: "max_tokens",
  refusal: "refusal",
};

type StreamOut = {
  id?: string;
  model?: string;
  text: string;
  toolCalls: ChatResult["toolCalls"];
  assistant: AssistantPart[];
  stop: ChatResult["stop"];
  stopReason: string | null;
  stopDetails: unknown;
  usage: Usage;
  ttftMs: number;
};

/** Consume a Messages API SSE response. TTFT is the first content block of any kind (thinking included). */
export async function readAnthropicStream(
  res: Response,
  t0: number,
  onEvent?: (e: StreamEvent) => void,
): Promise<StreamOut> {
  if (!res.body) throw new ProviderError("empty response body", res.status, "empty_body", true);
  const blocks: any[] = [];
  const toolJson: string[] = [];
  const usage: Usage = { inputTokens: 0, outputTokens: 0 };
  let id: string | undefined;
  let model: string | undefined;
  let stopReason: string | null = null;
  let stopDetails: unknown = null;
  let ttft = -1;
  let ended = false;
  const applyUsage = (u: any) => {
    if (!u) return;
    if (typeof u.input_tokens === "number") usage.inputTokens = u.input_tokens;
    if (typeof u.output_tokens === "number") usage.outputTokens = u.output_tokens;
    if (typeof u.cache_creation_input_tokens === "number") usage.cacheWriteTokens = u.cache_creation_input_tokens;
    if (typeof u.cache_read_input_tokens === "number") usage.cacheReadTokens = u.cache_read_input_tokens;
    const h1 = u.cache_creation?.ephemeral_1h_input_tokens;
    if (typeof h1 === "number") usage.cacheWrite1hTokens = h1;
    const th = u.output_tokens_details?.thinking_tokens;
    if (typeof th === "number") usage.thinkingTokens = th;
  };
  for await (const msg of parseSSE(res.body)) {
    if (msg.event === "ping") continue;
    let ev: any;
    try {
      ev = msg.data ? JSON.parse(msg.data) : null;
    } catch {
      throw new StreamError(
        new ProviderError(`bad SSE data: ${msg.data.slice(0, 120)}`, 200, "bad_stream", true),
        ttft >= 0,
      );
    }
    if (!ev) continue;
    if (msg.event === "error" || ev.type === "error") {
      const type = ev.error?.type ?? "api_error";
      const retryable = type === "overloaded_error" || type === "api_error" || type === "rate_limit_error";
      throw new StreamError(
        new ProviderError(`stream ${type}: ${ev.error?.message ?? ""}`, 200, type, retryable),
        ttft >= 0,
      );
    }
    switch (ev.type) {
      case "message_start":
        id = ev.message?.id;
        model = ev.message?.model;
        applyUsage(ev.message?.usage);
        break;
      case "content_block_start": {
        if (ttft < 0) ttft = performance.now() - t0;
        const b = { ...ev.content_block };
        blocks[ev.index] = b;
        if (b.type === "tool_use") {
          toolJson[ev.index] = "";
          onEvent?.({ type: "tool_call", name: b.name });
        } else if (b.type === "thinking" || b.type === "redacted_thinking") onEvent?.({ type: "thinking" });
        else if (b.type === "text" && b.text) onEvent?.({ type: "text", text: b.text });
        break;
      }
      case "content_block_delta": {
        const b = blocks[ev.index];
        const d = ev.delta ?? {};
        if (!b) break;
        if (d.type === "text_delta") {
          b.text = (b.text ?? "") + d.text;
          onEvent?.({ type: "text", text: d.text });
        } else if (d.type === "thinking_delta") {
          b.thinking = (b.thinking ?? "") + d.thinking;
          if (d.thinking) onEvent?.({ type: "thinking", text: d.thinking });
        } else if (d.type === "signature_delta") b.signature = d.signature;
        else if (d.type === "input_json_delta")
          toolJson[ev.index] = (toolJson[ev.index] ?? "") + (d.partial_json ?? "");
        break;
      }
      case "content_block_stop": {
        const b = blocks[ev.index];
        if (b?.type === "tool_use") {
          const raw = toolJson[ev.index] ?? "";
          try {
            b.input = raw.trim() ? JSON.parse(raw) : (b.input ?? {});
          } catch {
            b.input = { _unparsed: raw };
          }
        }
        break;
      }
      case "message_delta":
        if (ev.delta && "stop_reason" in ev.delta) stopReason = ev.delta.stop_reason;
        if (ev.delta?.stop_details) stopDetails = ev.delta.stop_details;
        applyUsage(ev.usage);
        break;
      case "message_stop":
        ended = true;
        break;
    }
  }
  if (!ended && stopReason === null) {
    throw new StreamError(new ProviderError("stream ended early", 200, "incomplete_stream", true), ttft >= 0);
  }
  // a tool_use block cut off by max_tokens may never get its stop event
  for (let i = 0; i < blocks.length; i++) {
    const b = blocks[i];
    if (b?.type === "tool_use" && b.input === undefined) {
      try {
        b.input = JSON.parse(toolJson[i] || "{}");
      } catch {
        b.input = { _unparsed: toolJson[i] };
      }
    }
  }
  const assistant: AssistantPart[] = [];
  const toolCalls: ChatResult["toolCalls"] = [];
  let text = "";
  for (const b of blocks) {
    if (!b) continue;
    if (b.type === "text") {
      text += b.text ?? "";
      assistant.push({ type: "text", text: b.text ?? "" });
    } else if (b.type === "tool_use") {
      toolCalls.push({ id: b.id, name: b.name, input: b.input });
      assistant.push({ type: "tool_call", id: b.id, name: b.name, input: b.input });
    } else if (b.type === "thinking" || b.type === "redacted_thinking") {
      assistant.push({ type: "opaque", provider: "anthropic", block: b });
    }
  }
  return {
    id,
    model,
    text,
    toolCalls,
    assistant,
    stop: stopReason ? (STOP[stopReason] ?? "error") : "error",
    stopReason,
    stopDetails,
    usage,
    ttftMs: ttft < 0 ? 0 : ttft,
  };
}
