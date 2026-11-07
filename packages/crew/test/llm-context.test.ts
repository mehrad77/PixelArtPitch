// Context windows and free token counts per provider, from recorded responses (no network).
import assert from "node:assert/strict";
import { test } from "node:test";
import { AnthropicProvider } from "../src/llm/anthropic.ts";
import { OpenAICompatProvider } from "../src/llm/openai.ts";
import type { ProviderConfig, ProviderKind } from "../src/llm/types.ts";

type Rec = { method: string; url: string; body?: unknown };
/** a fetch that answers from recorded fixtures by method + path */
function recorded(fixtures: Record<string, unknown>, seen: Rec[] = []) {
  return async (url: string | URL | Request, init?: RequestInit) => {
    const u = new URL(String(url));
    const key = `${init?.method ?? "GET"} ${u.pathname}`;
    seen.push({
      method: init?.method ?? "GET",
      url: u.pathname,
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
    });
    if (!(key in fixtures)) return new Response("not found", { status: 404 });
    return new Response(JSON.stringify(fixtures[key]), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
}
const cfg = (kind: ProviderKind, baseUrl: string): ProviderConfig => ({
  id: kind,
  kind,
  label: kind,
  baseUrl,
  enabled: true,
});
const req = {
  model: "x",
  system: "You are Pip.",
  messages: [{ role: "user" as const, content: "hello" }],
  tools: [{ name: "files_list", description: "files", inputSchema: { type: "object" } }],
  maxOut: 100,
};

test("Anthropic: count_tokens gets the exact system, tools and messages; the window is max_input_tokens", async () => {
  const seen: Rec[] = [];
  const p = new AnthropicProvider(cfg("anthropic", "https://api.anthropic.com"), {
    getKey: () => "sk-test",
    fetch: recorded(
      {
        "POST /v1/messages/count_tokens": { input_tokens: 412 },
        // recorded from GET /v1/models/claude-sonnet-5-5 (2026-11-07), trimmed
        "GET /v1/models/claude-sonnet-5-5": {
          type: "model",
          id: "claude-sonnet-5-5",
          display_name: "Claude Sonnet 5.5",
          max_input_tokens: 1000000,
          max_tokens: 128000,
        },
      },
      seen,
    ) as any,
  });
  const c = await p.countTokens({ ...req, model: "anthropic/claude-sonnet-5-5" });
  assert.deepEqual(c, { tokens: 412, source: "anthropic count_tokens" });
  const body = seen[0].body as any;
  assert.equal(body.system, "You are Pip.");
  assert.equal(body.tools[0].name, "files_list");
  assert.equal(body.messages[0].content[0].text, "hello");
  assert.equal(body.max_tokens, undefined, "count_tokens takes no max_tokens");
  assert.equal(body.stream, undefined);
  assert.deepEqual(await p.contextWindow("anthropic/claude-sonnet-5-5"), {
    window: 1000000,
    source: "anthropic /v1/models max_input_tokens",
  });
});

test("LM Studio: the window is the loaded context length, not the model's maximum", async () => {
  const p = new OpenAICompatProvider(cfg("lmstudio", "http://127.0.0.1:1234/v1"), {
    getKey: () => undefined,
    // recorded from GET /api/v0/models (2026-11-07), trimmed
    fetch: recorded({
      "GET /api/v0/models": {
        data: [
          {
            id: "openai/gpt-oss-20b",
            type: "llm",
            state: "loaded",
            max_context_length: 131072,
            loaded_context_length: 8192,
          },
          { id: "google/gemma-4-12b", type: "vlm", state: "not-loaded", max_context_length: 262144 },
        ],
      },
    }) as any,
  });
  assert.deepEqual(await p.contextWindow("lmstudio/openai/gpt-oss-20b"), {
    window: 8192,
    source: "LM Studio loaded_context_length",
  });
  const notLoaded = await p.contextWindow("lmstudio/google/gemma-4-12b");
  assert.equal(notLoaded?.window, 262144);
  assert.match(notLoaded?.note ?? "", /isn't loaded/);
  assert.equal(await p.countTokens({ ...req, model: "lmstudio/openai/gpt-oss-20b" }), null, "no tokenize route");
});

test("llama.cpp: n_ctx from /props, an exact count from /tokenize", async () => {
  const p = new OpenAICompatProvider(cfg("llamacpp", "http://127.0.0.1:8080/v1"), {
    getKey: () => undefined,
    fetch: recorded({
      "GET /props": { default_generation_settings: { n_ctx: 16384 }, modalities: { vision: false } },
      "POST /tokenize": { tokens: [1, 2, 3, 4, 5, 6, 7] },
    }) as any,
  });
  assert.deepEqual(await p.contextWindow("llamacpp/model"), { window: 16384, source: "llama.cpp /props n_ctx" });
  assert.deepEqual(await p.countTokens({ ...req, model: "llamacpp/model" }), {
    tokens: 7,
    source: "llama.cpp /tokenize (no chat template)",
  });
});

test("Ollama: num_ctx when set, else the model maximum with a note", async () => {
  const show = (parameters: string) =>
    new OpenAICompatProvider(cfg("ollama", "http://127.0.0.1:11434/v1"), {
      getKey: () => undefined,
      fetch: recorded({
        "POST /api/show": { parameters, model_info: { "llama.context_length": 131072 }, capabilities: ["completion"] },
      }) as any,
    });
  assert.deepEqual(await show('num_ctx 8192\nstop "<|eot|>"').contextWindow("ollama/llama3"), {
    window: 8192,
    source: "Ollama num_ctx",
  });
  const max = await show('stop "<|eot|>"').contextWindow("ollama/llama3");
  assert.equal(max?.window, 131072);
  assert.match(max?.note ?? "", /num_ctx/);
});

test("OpenRouter: context_length from /models; no count endpoint", async () => {
  const p = new OpenAICompatProvider(cfg("openrouter", "https://openrouter.ai/api/v1"), {
    getKey: () => "sk-or",
    fetch: recorded({ "GET /api/v1/models": { data: [{ id: "meta/llama-4", context_length: 327680 }] } }) as any,
  });
  assert.deepEqual(await p.contextWindow("openrouter/meta/llama-4"), {
    window: 327680,
    source: "OpenRouter context_length",
  });
  assert.equal(await p.countTokens({ ...req, model: "openrouter/meta/llama-4" }), null);
});
