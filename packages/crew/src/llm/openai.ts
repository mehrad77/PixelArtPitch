// An OpenAI-compatible /chat/completions client over plain fetch + SSE, for OpenAI, OpenRouter, LM Studio, Ollama,
// llama.cpp and custom servers. `baseUrl` includes the version segment (".../v1"), as these servers document it.
//
// UNVERIFIED ("claimed"): no OpenAI SDK or server docs were available offline, so the request/stream shapes below are
// written from the public OpenAI chat-completions format as remembered: `stream_options.include_usage` (usage in a
// final chunk with empty `choices`), `data: [DONE]`, tool-call deltas assembled by `index`, `response_format`
// json_schema / json_object, `image_url` data URIs, OpenRouter `usage.cost` and its /models `pricing` ($ per token,
// as strings) and `supported_parameters`, LM Studio `/api/v0/models` (`type: llm|vlm`, `max_context_length`), Ollama
// `/api/show` (`capabilities`, `model_info["<arch>.context_length"]`), llama.cpp `/props`
// (`default_generation_settings.n_ctx`, `modalities.vision`). Capabilities read from them are only ever "claimed".
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
  CapStatus,
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
  ProviderKind,
  StreamEvent,
  Usage,
  WindowInfo,
} from "./types.ts";

export const DEFAULT_BASE_URLS: Record<ProviderKind, string> = {
  anthropic: "https://api.anthropic.com",
  openai: "https://api.openai.com/v1",
  openrouter: "https://openrouter.ai/api/v1",
  lmstudio: "http://127.0.0.1:1234/v1",
  ollama: "http://127.0.0.1:11434/v1",
  llamacpp: "http://127.0.0.1:8080/v1",
  custom: "http://127.0.0.1:8000/v1",
};

const LOCAL_KINDS = new Set<ProviderKind>(["lmstudio", "ollama", "llamacpp"]);

export function isLocalProvider(config: ProviderConfig): boolean {
  if (LOCAL_KINDS.has(config.kind)) return true;
  if (config.kind !== "custom") return false;
  try {
    const h = new URL(config.baseUrl).hostname;
    return h === "localhost" || h === "127.0.0.1" || h === "[::1]" || h === "::1" || h.endsWith(".local");
  } catch {
    return false;
  }
}

export type OpenAIOpts = HttpOpts & {
  getKey: () => string | undefined;
  streamRetries?: number;
};

export class OpenAICompatProvider implements Provider {
  config: ProviderConfig;
  readonly local: boolean;
  private opts: OpenAIOpts;
  private prices = new Map<string, Price>();
  constructor(config: ProviderConfig, opts: OpenAIOpts) {
    this.config = config;
    this.opts = opts;
    this.local = isLocalProvider(config);
  }

  private base(): string {
    return this.config.baseUrl.replace(/\/+$/, "");
  }
  /** the server root, for the native (non-/v1) metadata endpoints */
  private root(): string {
    return this.base().replace(/\/v1$/, "");
  }

  private headers(json = true): Record<string, string> {
    const h: Record<string, string> = {};
    if (json) h["content-type"] = "application/json";
    const key = this.opts.getKey();
    if (key) h.authorization = `Bearer ${key}`;
    else if (!this.local) throw new ProviderError(`${this.config.id}: no API key`, 401, "authentication_error", false);
    if (this.config.kind === "openrouter") h["x-title"] = "PixelArtPitch";
    return h;
  }

  private async getJson(url: string, signal?: AbortSignal, init?: RequestInit): Promise<any> {
    const f: FetchLike = this.opts.fetch ?? fetch;
    const res = await f(url, { method: "GET", headers: this.headers(false), signal, ...init });
    if (!res.ok) throw new ProviderError(`${res.status} ${url}`, res.status, `http_${res.status}`, false);
    return res.json();
  }

  private caps(over: Partial<Caps>): Caps {
    return {
      vision: "unknown",
      structured: "unknown",
      tools: "unknown",
      longOutput: "unknown",
      thinking: "none",
      caching: false,
      ctx: 0,
      maxOut: 0,
      concurrency: this.local ? 1 : 6,
      local: this.local,
      ...over,
    };
  }

  private info(model: string, label: string, caps: Caps, price: Price | null): ModelInfo {
    if (price) this.prices.set(model, price);
    return { id: `${this.config.id}/${model}`, provider: this.config.id, model, label, caps, price };
  }

  async listModels(signal?: AbortSignal): Promise<ModelInfo[]> {
    const kind = this.config.kind;
    if (kind === "openrouter") return this.listOpenRouter(signal);
    if (kind === "lmstudio") {
      try {
        return await this.listLmStudio(signal);
      } catch (e) {
        if (isAbort(e)) throw e;
      }
    }
    const body = await this.getJson(`${this.base()}/models`, signal);
    const ids: string[] = (body.data ?? body.models ?? []).map((m: any) => m.id ?? m.name).filter(Boolean);
    const out: ModelInfo[] = [];
    for (const id of ids) {
      let caps = this.caps({});
      if (kind === "ollama") caps = await this.ollamaCaps(id, signal).catch(() => caps);
      if (kind === "llamacpp") caps = await this.llamacppCaps(signal).catch(() => caps);
      const price = this.local ? null : priceFor(`${this.config.id}/${id}`);
      out.push(this.info(id, id, caps, price));
    }
    return out;
  }

  private async listOpenRouter(signal?: AbortSignal): Promise<ModelInfo[]> {
    const body = await this.getJson(`${this.base()}/models`, signal);
    const perM = (s: unknown) => {
      const n = typeof s === "string" ? Number.parseFloat(s) : typeof s === "number" ? s : Number.NaN;
      return Number.isFinite(n) && n >= 0 ? n * 1e6 : undefined;
    };
    return (body.data ?? []).map((m: any) => {
      const params: string[] = m.supported_parameters ?? [];
      const inputs: string[] = m.architecture?.input_modalities ?? [];
      const has = (p: string): CapStatus => (params.includes(p) ? "claimed" : params.length ? "failed" : "unknown");
      const maxOut = m.top_provider?.max_completion_tokens ?? 0;
      const caps = this.caps({
        vision: inputs.length ? (inputs.includes("image") ? "claimed" : "failed") : "unknown",
        structured: has("structured_outputs"),
        tools: has("tools"),
        longOutput: maxOut >= 32_000 ? "claimed" : maxOut ? "failed" : "unknown",
        thinking: params.includes("reasoning") ? "effort" : "none",
        caching: perM(m.pricing?.input_cache_read) !== undefined,
        ctx: m.context_length ?? m.top_provider?.context_length ?? 0,
        maxOut,
      });
      const inP = perM(m.pricing?.prompt);
      const outP = perM(m.pricing?.completion);
      const price: Price | null =
        inP !== undefined && outP !== undefined
          ? {
              inPerMTok: inP,
              outPerMTok: outP,
              cacheReadPerMTok: perM(m.pricing?.input_cache_read),
              cacheWritePerMTok: perM(m.pricing?.input_cache_write),
              source: "provider",
            }
          : null;
      return this.info(m.id, m.name ?? m.id, caps, price);
    });
  }

  private async listLmStudio(signal?: AbortSignal): Promise<ModelInfo[]> {
    const body = await this.getJson(`${this.root()}/api/v0/models`, signal);
    return (body.data ?? [])
      .filter((m: any) => m.type !== "embeddings")
      .map((m: any) =>
        this.info(
          m.id,
          m.id,
          this.caps({
            vision: m.type === "vlm" ? "claimed" : m.type === "llm" ? "failed" : "unknown",
            ctx: m.max_context_length ?? 0,
          }),
          null,
        ),
      );
  }

  private async ollamaCaps(model: string, signal?: AbortSignal): Promise<Caps> {
    const f: FetchLike = this.opts.fetch ?? fetch;
    const res = await f(`${this.root()}/api/show`, {
      method: "POST",
      headers: this.headers(true),
      body: JSON.stringify({ model }),
      signal,
    });
    if (!res.ok) throw new ProviderError(`${res.status} /api/show`, res.status, `http_${res.status}`, false);
    const b = await res.json();
    const capList: string[] = b.capabilities ?? [];
    const ctxKey = Object.keys(b.model_info ?? {}).find((k) => k.endsWith(".context_length"));
    return this.caps({
      vision: capList.length ? (capList.includes("vision") ? "claimed" : "failed") : "unknown",
      tools: capList.length ? (capList.includes("tools") ? "claimed" : "failed") : "unknown",
      thinking: capList.includes("thinking") ? "effort" : "none",
      ctx: ctxKey ? Number(b.model_info[ctxKey]) || 0 : 0,
    });
  }

  /**
   * The model's real window, as its server reports it: LM Studio's loaded context length (not the model's maximum),
   * llama.cpp's n_ctx, Ollama's num_ctx (or the model maximum, noted), OpenRouter's context_length.
   */
  async contextWindow(model: string, signal?: AbortSignal): Promise<WindowInfo | null> {
    const s = splitModelId(model);
    const id = s.provider === this.config.id ? s.model : model;
    const kind = this.config.kind;
    try {
      if (kind === "lmstudio") {
        const body = await this.getJson(`${this.root()}/api/v0/models`, signal);
        const m = (body.data ?? []).find((x: any) => x.id === id);
        if (!m) return null;
        if (typeof m.loaded_context_length === "number")
          return { window: m.loaded_context_length, source: "LM Studio loaded_context_length" };
        if (typeof m.max_context_length === "number")
          return {
            window: m.max_context_length,
            source: "LM Studio max_context_length",
            note: "the model isn't loaded; LM Studio loads it with a smaller context unless set",
          };
        return null;
      }
      if (kind === "llamacpp") {
        const b = await this.getJson(`${this.root()}/props`, signal);
        const n = b.default_generation_settings?.n_ctx ?? b.n_ctx;
        return typeof n === "number" ? { window: n, source: "llama.cpp /props n_ctx" } : null;
      }
      if (kind === "ollama") {
        const f: FetchLike = this.opts.fetch ?? fetch;
        const res = await f(`${this.root()}/api/show`, {
          method: "POST",
          headers: this.headers(true),
          body: JSON.stringify({ model: id }),
          signal,
        });
        if (!res.ok) return null;
        const b = await res.json();
        const numCtx = /(?:^|\n)\s*num_ctx\s+(\d+)/.exec(String(b.parameters ?? ""))?.[1];
        if (numCtx) return { window: Number(numCtx), source: "Ollama num_ctx" };
        const k = Object.keys(b.model_info ?? {}).find((x) => x.endsWith(".context_length"));
        return k
          ? {
              window: Number(b.model_info[k]),
              source: `Ollama ${k}`,
              note: "the model's maximum; Ollama runs it with num_ctx, which is smaller unless set",
            }
          : null;
      }
      if (kind === "openrouter") {
        const body = await this.getJson(`${this.base()}/models`, signal);
        const m = (body.data ?? []).find((x: any) => x.id === id);
        const n = m?.context_length ?? m?.top_provider?.context_length;
        return typeof n === "number" ? { window: n, source: "OpenRouter context_length" } : null;
      }
    } catch (e) {
      if (isAbort(e)) throw e;
    }
    return null;
  }

  /** an exact count where the server tokenizes for free: llama.cpp /tokenize (the chat template isn't included) */
  async countTokens(req: ChatRequest, signal?: AbortSignal): Promise<CountInfo | null> {
    if (this.config.kind !== "llamacpp") return null;
    const text = [
      req.system ?? "",
      ...req.messages.map((m) => (typeof m.content === "string" ? m.content : JSON.stringify(m.content))),
      ...(req.tools ?? []).map((t) => JSON.stringify(t)),
    ].join("\n");
    try {
      const f: FetchLike = this.opts.fetch ?? fetch;
      const res = await f(`${this.root()}/tokenize`, {
        method: "POST",
        headers: this.headers(true),
        body: JSON.stringify({ content: text }),
        signal,
      });
      if (!res.ok) return null;
      const b = (await res.json()) as { tokens?: unknown[] };
      return Array.isArray(b.tokens)
        ? { tokens: b.tokens.length, source: "llama.cpp /tokenize (no chat template)" }
        : null;
    } catch (e) {
      if (isAbort(e)) throw e;
      return null;
    }
  }

  private async llamacppCaps(signal?: AbortSignal): Promise<Caps> {
    const b = await this.getJson(`${this.root()}/props`, signal);
    const vision = b.modalities?.vision;
    return this.caps({
      vision: typeof vision === "boolean" ? (vision ? "claimed" : "failed") : "unknown",
      ctx: b.default_generation_settings?.n_ctx ?? 0,
    });
  }

  buildBody(req: ChatRequest): Record<string, unknown> {
    const s = splitModelId(req.model);
    const model = s.provider === this.config.id ? s.model : req.model;
    const body: Record<string, unknown> = {
      model,
      messages: toOpenAIMessages(req.system, req.messages),
      stream: true,
      stream_options: { include_usage: true },
    };
    if (this.config.kind === "openai") body.max_completion_tokens = req.maxOut;
    else body.max_tokens = req.maxOut;
    if (req.temperature !== undefined) body.temperature = req.temperature;
    if (req.tools?.length) {
      body.tools = req.tools.map((t) => ({
        type: "function",
        function: { name: t.name, description: t.description, parameters: t.inputSchema },
      }));
      const tc = req.toolChoice;
      if (tc === "none" || tc === "auto") body.tool_choice = tc;
      else if (tc) body.tool_choice = { type: "function", function: { name: tc.name } };
    }
    if (req.json) {
      const s = sanitizeSchema(req.json.schema);
      body.response_format = {
        type: "json_schema",
        json_schema: { name: req.json.name, schema: s.schema, strict: s.strictOk },
      };
    } else if (req.jsonMode) body.response_format = { type: "json_object" };
    // local servers (LM Studio, Ollama, llama.cpp) take reasoning_effort for reasoning models; others ignore it
    if (
      req.effort &&
      (this.config.kind === "lmstudio" || this.config.kind === "ollama" || this.config.kind === "llamacpp")
    )
      body.reasoning_effort = req.effort === "xhigh" || req.effort === "high" ? "medium" : req.effort;
    if (req.effort && this.config.kind === "openai")
      body.reasoning_effort = req.effort === "xhigh" ? "high" : req.effort;
    if (req.effort && this.config.kind === "openrouter")
      body.reasoning = { effort: req.effort === "xhigh" ? "high" : req.effort };
    if (this.config.kind === "openrouter") body.usage = { include: true };
    return body;
  }

  async chat(
    req: ChatRequest,
    opts: { signal?: AbortSignal; onEvent?: (e: StreamEvent) => void; price?: Price | null } = {},
  ): Promise<ChatResult> {
    const body = this.buildBody(req);
    const model = body.model as string;
    const url = `${this.base()}/chat/completions`;
    const sleep = this.opts.sleep ?? defaultSleep;
    for (let attempt = 0; ; attempt++) {
      const t0 = performance.now();
      const res = await postWithRetry(url, this.headers(), body, { ...this.opts, signal: opts.signal });
      try {
        const r = await readOpenAIStream(res, t0, opts.onEvent);
        let usd = 0;
        let usdSource: ChatResult["usdSource"] = "zero";
        if (typeof r.providerCost === "number") {
          usd = r.providerCost;
          usdSource = "provider";
        } else if (!this.local) {
          const price =
            opts.price !== undefined
              ? opts.price
              : (priceFor(`${this.config.id}/${model}`) ?? this.prices.get(model) ?? null);
          if (price) {
            usd = costUsd(price, r.usage);
            usdSource = "table";
          }
        }
        let json: unknown;
        if ((req.json || req.jsonMode) && r.text) {
          try {
            json = JSON.parse(r.text);
          } catch {}
        }
        return {
          text: r.text,
          json,
          toolCalls: r.toolCalls,
          assistant: [
            ...(r.text ? [{ type: "text" as const, text: r.text }] : []),
            ...r.toolCalls.map((t) => ({ type: "tool_call" as const, ...t })),
          ],
          stop: r.stop,
          usage: r.usage,
          usd,
          usdSource,
          ttftMs: r.ttftMs,
          durationMs: performance.now() - t0,
          raw: { id: r.id, finishReason: r.finishReason },
        };
      } catch (e) {
        if (isAbort(e) || opts.signal?.aborted) throw e;
        if (
          e instanceof ProviderError &&
          e.retryable &&
          !(e as any).emitted &&
          attempt < (this.opts.streamRetries ?? 2)
        ) {
          await sleep(backoffMs(attempt, null), opts.signal);
          continue;
        }
        throw e;
      }
    }
  }
}

const dataUri = (p: Extract<ContentPart, { type: "image" }>) => `data:${p.mediaType};base64,${p.data}`;
const oaParts = (c: string | ContentPart[]) =>
  typeof c === "string"
    ? c
    : c.map((p) =>
        p.type === "text" ? { type: "text", text: p.text } : { type: "image_url", image_url: { url: dataUri(p) } },
      );

/** ChatMessage[] -> chat-completions messages. Tool results are text only, so their images follow in a user turn. */
export function toOpenAIMessages(system: string | undefined, messages: ChatMessage[]): unknown[] {
  const out: unknown[] = [];
  if (system) out.push({ role: "system", content: system });
  let pendingImages: ContentPart[] = [];
  const flush = () => {
    if (!pendingImages.length) return;
    out.push({
      role: "user",
      content: oaParts([{ type: "text", text: "Images from the tool results above:" }, ...pendingImages]),
    });
    pendingImages = [];
  };
  for (const m of messages) {
    if (m.role !== "tool") flush();
    if (m.role === "user") out.push({ role: "user", content: oaParts(m.content) });
    else if (m.role === "tool") {
      const parts = typeof m.content === "string" ? [{ type: "text" as const, text: m.content }] : m.content;
      const text = parts
        .filter((p) => p.type === "text")
        .map((p) => (p as { text: string }).text)
        .join("\n");
      pendingImages.push(...parts.filter((p) => p.type === "image"));
      out.push({ role: "tool", tool_call_id: m.toolCallId, content: (m.isError ? "ERROR: " : "") + text });
    } else {
      const parts = typeof m.content === "string" ? [{ type: "text" as const, text: m.content }] : m.content;
      const text = parts
        .filter((p) => p.type === "text")
        .map((p) => (p as { text: string }).text)
        .join("");
      const calls = parts.filter((p) => p.type === "tool_call") as { id: string; name: string; input: unknown }[];
      out.push({
        role: "assistant",
        content: text || (calls.length ? null : ""),
        ...(calls.length
          ? {
              tool_calls: calls.map((c) => ({
                id: c.id,
                type: "function",
                function: { name: c.name, arguments: JSON.stringify(c.input ?? {}) },
              })),
            }
          : {}),
      });
    }
  }
  flush();
  return out;
}

const FINISH: Record<string, ChatResult["stop"]> = {
  stop: "end",
  length: "max_tokens",
  tool_calls: "tool_use",
  function_call: "tool_use",
  content_filter: "refusal",
};

/** Consume a chat-completions SSE response. */
export async function readOpenAIStream(res: Response, t0: number, onEvent?: (e: StreamEvent) => void) {
  if (!res.body) throw new ProviderError("empty response body", res.status, "empty_body", true);
  let text = "";
  let id: string | undefined;
  let finishReason: string | null = null;
  let ttft = -1;
  let thinkingSeen = false;
  let done = false;
  let providerCost: number | undefined;
  const usage: Usage = { inputTokens: 0, outputTokens: 0 };
  const calls: { id: string; name: string; args: string }[] = [];
  const mark = () => {
    if (ttft < 0) ttft = performance.now() - t0;
  };
  for await (const msg of parseSSE(res.body)) {
    const data = msg.data.trim();
    if (!data) continue;
    if (data === "[DONE]") {
      done = true;
      break;
    }
    let chunk: any;
    try {
      chunk = JSON.parse(data);
    } catch {
      continue;
    }
    if (chunk.error) {
      const code = String(chunk.error.code ?? chunk.error.type ?? "stream_error");
      const status = Number(chunk.error.code) || 200;
      const err = new ProviderError(
        `stream ${code}: ${chunk.error.message ?? ""}`,
        status,
        code,
        status === 429 || status >= 500,
      );
      (err as any).emitted = ttft >= 0;
      throw err;
    }
    id ??= chunk.id;
    for (const choice of chunk.choices ?? []) {
      const d = choice.delta ?? {};
      if (typeof d.content === "string" && d.content) {
        mark();
        text += d.content;
        onEvent?.({ type: "text", text: d.content });
      }
      const reasoning = d.reasoning ?? d.reasoning_content;
      if (reasoning) {
        mark();
        thinkingSeen = true;
        onEvent?.({ type: "thinking", text: typeof reasoning === "string" ? reasoning : undefined });
      }
      for (const tc of d.tool_calls ?? []) {
        mark();
        const i = typeof tc.index === "number" ? tc.index : calls.length;
        calls[i] ??= { id: "", name: "", args: "" };
        if (tc.id) calls[i].id = tc.id;
        if (tc.function?.name) {
          calls[i].name += tc.function.name;
          onEvent?.({ type: "tool_call", name: calls[i].name });
        }
        if (tc.function?.arguments) calls[i].args += tc.function.arguments;
      }
      if (choice.finish_reason) finishReason = choice.finish_reason;
    }
    const u = chunk.usage;
    if (u) {
      const cached = u.prompt_tokens_details?.cached_tokens ?? 0;
      usage.inputTokens = Math.max(0, (u.prompt_tokens ?? 0) - cached);
      if (cached) usage.cacheReadTokens = cached;
      usage.outputTokens = u.completion_tokens ?? 0;
      const r = u.completion_tokens_details?.reasoning_tokens;
      if (typeof r === "number") usage.thinkingTokens = r;
      if (typeof u.cost === "number") providerCost = u.cost;
    }
  }
  if (!done && finishReason === null) {
    const err = new ProviderError("stream ended early", 200, "incomplete_stream", true);
    (err as any).emitted = ttft >= 0;
    throw err;
  }
  const toolCalls = calls.filter(Boolean).map((c, i) => {
    let input: unknown;
    try {
      input = c.args.trim() ? JSON.parse(c.args) : {};
    } catch {
      input = { _unparsed: c.args };
    }
    return { id: c.id || `call_${i}`, name: c.name, input };
  });
  let stop: ChatResult["stop"] = finishReason ? (FINISH[finishReason] ?? "end") : "end";
  if (stop === "end" && toolCalls.length) stop = "tool_use";
  return { id, text, toolCalls, stop, finishReason, usage, providerCost, ttftMs: ttft < 0 ? 0 : ttft };
}
