// The model layer's contract. Providers are plain HTTP (fetch) clients: the Anthropic Messages API, and the
// OpenAI-compatible chat completions API used by OpenAI, OpenRouter, LM Studio, Ollama and llama.cpp.
import type { RoleT } from "@pap/schema";

export type ProviderKind = "anthropic" | "openai" | "openrouter" | "lmstudio" | "ollama" | "llamacpp" | "custom";

export type ProviderConfig = {
  id: string;
  kind: ProviderKind;
  label: string;
  baseUrl: string;
  enabled: boolean;
};

export type CapStatus = "passed" | "claimed" | "failed" | "unknown";
export type Caps = {
  vision: CapStatus;
  /** native JSON-schema structured output */
  structured: CapStatus;
  tools: CapStatus;
  /** can produce >= 32K output tokens */
  longOutput: CapStatus;
  thinking: "adaptive" | "effort" | "none";
  caching: boolean;
  ctx: number;
  maxOut: number;
  /** concurrent requests the endpoint handles well (local servers: usually 1) */
  concurrency: number;
  local: boolean;
  /** false when the model rejects a forced tool_choice (Opus 5.5, Sonnet 5.5, Fable 5.1); the provider then sends auto */
  forcedTool?: boolean;
};

export type Price = {
  inPerMTok: number;
  outPerMTok: number;
  cacheWritePerMTok?: number;
  cacheReadPerMTok?: number;
  /** 1-hour cache writes (2x input on Anthropic) */
  cacheWrite1hPerMTok?: number;
  /** a second rate card for long prompts (Claude Haiku 5.5 above 100K prompt tokens) */
  longContext?: {
    overPromptTokens: number;
    inPerMTok: number;
    outPerMTok: number;
    cacheWritePerMTok?: number;
    cacheReadPerMTok?: number;
    cacheWrite1hPerMTok?: number;
  };
  source: "table" | "provider" | "manual";
};

export type ModelInfo = {
  id: string /* "<providerId>/<model>" */;
  provider: string;
  model: string;
  label: string;
  caps: Caps;
  price: Price | null;
};

// ---- requests ----
export type ContentPart =
  | { type: "text"; text: string }
  | { type: "image"; mediaType: "image/png" | "image/jpeg"; data: string /* base64 */ };
export type ChatMessage =
  | { role: "user"; content: string | ContentPart[] }
  | { role: "assistant"; content: string | AssistantPart[] }
  | { role: "tool"; toolCallId: string; name: string; content: string | ContentPart[]; isError?: boolean };
export type AssistantPart =
  | { type: "text"; text: string }
  | { type: "tool_call"; id: string; name: string; input: unknown }
  /** a provider-specific block (Anthropic thinking / redacted_thinking) replayed verbatim to the same provider */
  | { type: "opaque"; provider: ProviderKind; block: unknown };

export type ToolSpec = { name: string; description: string; inputSchema: Record<string, unknown> };

export type ChatRequest = {
  model: string; // "<providerId>/<model>"
  system?: string;
  messages: ChatMessage[];
  tools?: ToolSpec[];
  /** force a JSON object matching this schema as the final answer (structured-output ladder applies) */
  json?: { name: string; schema: Record<string, unknown> };
  maxOut: number;
  effort?: "low" | "medium" | "high" | "xhigh";
  /** cache the system prompt and tools (Anthropic) */
  cache?: boolean;
  /** ignored by Anthropic (API version 2026-10-21 rejects sampling parameters) */
  temperature?: number;
  /** "auto" (default when tools are given), "none", or force one tool (downgraded to auto where the model rejects it) */
  toolChoice?: "auto" | "none" | { name: string };
  /** ask for a JSON object without a schema (OpenAI-compatible `response_format: json_object`; ignored by Anthropic) */
  jsonMode?: boolean;
  /** false: turn thinking off where the model allows it (Sonnet 5.5 `between_tools`, Haiku 5.5 `disabled`, effort <= high) */
  thinking?: boolean;
};

export type Usage = {
  inputTokens: number;
  outputTokens: number;
  cacheWriteTokens?: number;
  cacheReadTokens?: number;
  /** the part of cacheWriteTokens written with a 1-hour TTL */
  cacheWrite1hTokens?: number;
  /** included in outputTokens */
  thinkingTokens?: number;
};

export type ChatResult = {
  text: string;
  /** parsed and schema-checked when `json` was requested */
  json?: unknown;
  toolCalls: { id: string; name: string; input: unknown }[];
  /** the assistant turn as returned, thinking blocks included, for replaying tool round-trips */
  assistant?: AssistantPart[];
  stop: "end" | "tool_use" | "max_tokens" | "refusal" | "error";
  usage: Usage;
  usd: number;
  usdSource: "table" | "provider" | "zero";
  ttftMs: number;
  durationMs: number;
  /** which rung of the structured-output ladder produced `json` */
  jsonVia?: "native" | "tool" | "json_mode" | "fenced" | "repaired" | "normalized";
  /** model calls behind this result (the structured-output ladder may make several; usage and usd are their sum) */
  calls?: number;
  raw?: unknown;
};

export type StreamEvent =
  | { type: "text"; text: string }
  | { type: "thinking"; text?: string }
  | { type: "tool_call"; name: string };

/** a model's real context window as its provider reports it */
export type WindowInfo = { window: number; source: string; note?: string };
/** an exact input-token count from the provider (free endpoints only) */
export type CountInfo = { tokens: number; source: string };

export interface Provider {
  config: ProviderConfig;
  listModels(signal?: AbortSignal): Promise<ModelInfo[]>;
  chat(req: ChatRequest, opts: { signal?: AbortSignal; onEvent?: (e: StreamEvent) => void }): Promise<ChatResult>;
  /** the window the provider reports for this model (never a billed call) */
  contextWindow?(model: string, signal?: AbortSignal): Promise<WindowInfo | null>;
  /** the input tokens this request would take, from a free count endpoint */
  countTokens?(req: ChatRequest, signal?: AbortSignal): Promise<CountInfo | null>;
}

// ---- ledger and budget ----
export type LedgerRow = {
  id: number;
  ts: string;
  project: string;
  task: string;
  taskKind: string;
  role: RoleT | "system";
  attempt: number;
  provider: string;
  model: string;
  promptVersion: string;
  usage: Usage;
  usd: number;
  usdSource: string;
  ttftMs: number;
  durationMs: number;
  tokPerSec: number;
  stop: string;
  estUsd: number | null;
  /** the BudgetGuard ticket this call settled, so restarts can reconcile reservations */
  ticket?: string | null;
};

export class BudgetError extends Error {
  readonly code = "budget";
  readonly spentUsd: number;
  readonly capUsd: number;
  readonly needUsd: number;
  constructor(spentUsd: number, capUsd: number, needUsd: number) {
    super(`budget: $${spentUsd.toFixed(2)} spent of $${capUsd.toFixed(2)}, this call may need $${needUsd.toFixed(2)}`);
    this.spentUsd = spentUsd;
    this.capUsd = capUsd;
    this.needUsd = needUsd;
  }
}
