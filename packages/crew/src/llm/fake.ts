// A scripted provider for tests: canned responses, usage, cost and delay; records every request.
import { abortError, defaultSleep, ProviderError } from "./http.ts";
import type {
  AssistantPart,
  Caps,
  ChatRequest,
  ChatResult,
  ModelInfo,
  Provider,
  ProviderConfig,
  StreamEvent,
  Usage,
} from "./types.ts";

export type FakeStep = {
  text?: string;
  /** shorthand: text = JSON.stringify(json) */
  json?: unknown;
  toolCalls?: { id?: string; name: string; input: unknown }[];
  stop?: ChatResult["stop"];
  usage?: Partial<Usage>;
  usd?: number;
  delayMs?: number;
  ttftMs?: number;
  /** thrown instead of answering (after the delay) */
  error?: Error | { status: number; type?: string; message?: string };
};

export type FakeScript = FakeStep[] | ((req: ChatRequest, index: number) => FakeStep);

export const FAKE_CAPS: Caps = {
  vision: "passed",
  structured: "passed",
  tools: "passed",
  longOutput: "passed",
  thinking: "none",
  caching: false,
  ctx: 200_000,
  maxOut: 64_000,
  concurrency: 4,
  local: false,
};

export class FakeProvider implements Provider {
  config: ProviderConfig;
  calls: ChatRequest[] = [];
  private script: FakeScript;
  private models: ModelInfo[];
  constructor(script: FakeScript, opts: { id?: string; models?: Partial<ModelInfo>[]; caps?: Partial<Caps> } = {}) {
    const id = opts.id ?? "fake";
    this.config = { id, kind: "custom", label: "Fake", baseUrl: "http://fake.invalid", enabled: true };
    this.script = script;
    this.models = (opts.models ?? [{ model: "model" }]).map((m) => ({
      id: `${id}/${m.model ?? "model"}`,
      provider: id,
      model: m.model ?? "model",
      label: m.label ?? m.model ?? "model",
      caps: { ...FAKE_CAPS, ...opts.caps, ...m.caps },
      price: m.price ?? null,
    }));
  }

  async listModels(): Promise<ModelInfo[]> {
    return this.models;
  }

  async chat(
    req: ChatRequest,
    opts: { signal?: AbortSignal; onEvent?: (e: StreamEvent) => void } = {},
  ): Promise<ChatResult> {
    const i = this.calls.length;
    this.calls.push(structuredClone(req));
    const step = typeof this.script === "function" ? this.script(req, i) : this.script[i];
    if (!step) throw new Error(`FakeProvider: no scripted step ${i}`);
    if (opts.signal?.aborted) throw opts.signal.reason ?? abortError();
    if (step.delayMs) await defaultSleep(step.delayMs, opts.signal);
    if (step.error) {
      if (step.error instanceof Error) throw step.error;
      const e = step.error;
      throw new ProviderError(
        e.message ?? `fake ${e.status}`,
        e.status,
        e.type ?? `http_${e.status}`,
        e.status >= 500 || e.status === 429,
      );
    }
    const text = step.text ?? (step.json !== undefined ? JSON.stringify(step.json) : "");
    if (text) opts.onEvent?.({ type: "text", text });
    const toolCalls = (step.toolCalls ?? []).map((t, k) => ({
      id: t.id ?? `call_${i}_${k}`,
      name: t.name,
      input: t.input,
    }));
    for (const t of toolCalls) opts.onEvent?.({ type: "tool_call", name: t.name });
    const usage: Usage = { inputTokens: 100, outputTokens: Math.max(1, Math.ceil(text.length / 4)), ...step.usage };
    const assistant: AssistantPart[] = [
      ...(text ? [{ type: "text" as const, text }] : []),
      ...toolCalls.map((t) => ({ type: "tool_call" as const, ...t })),
    ];
    let json: unknown;
    if ((req.json || req.jsonMode) && text) {
      try {
        json = JSON.parse(text);
      } catch {}
    }
    return {
      text,
      json,
      toolCalls,
      assistant,
      stop: step.stop ?? (toolCalls.length ? "tool_use" : "end"),
      usage,
      usd: step.usd ?? 0,
      usdSource: step.usd ? "table" : "zero",
      ttftMs: step.ttftMs ?? 5,
      durationMs: (step.delayMs ?? 0) + 10,
    };
  }
}
