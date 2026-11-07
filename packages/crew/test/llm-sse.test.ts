// Hand-written stream fixtures (shapes from claude-api/curl/examples.md and the chat-completions stream format), fed
// through the real clients with an injected fetch, chunked awkwardly.
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { AnthropicProvider, toAnthropicMessages } from "../src/llm/anthropic.ts";
import { type FetchLike, ProviderError, parseSSE } from "../src/llm/http.ts";
import { OpenAICompatProvider, toOpenAIMessages } from "../src/llm/openai.ts";
import type { ProviderConfig } from "../src/llm/types.ts";

process.env.PAP_HOME = mkdtempSync(join(tmpdir(), "pap-sse-"));

const enc = new TextEncoder();
const sse = (events: [string | null, unknown][], eol = "\n") =>
  events
    .map(
      ([ev, data]) =>
        `${ev ? `event: ${ev}${eol}` : ""}data: ${typeof data === "string" ? data : JSON.stringify(data)}${eol}${eol}`,
    )
    .join("");
/** split into uneven chunks, including 1-byte ones, so lines and CRLFs straddle chunk edges */
const chunked = (s: string) => {
  const sizes = [7, 1, 13, 2, 31, 1, 5];
  const out: string[] = [];
  for (let i = 0, k = 0; i < s.length; k++) {
    const n = sizes[k % sizes.length];
    out.push(s.slice(i, i + n));
    i += n;
  }
  return out;
};
const streamResponse = (body: string, status = 200, headers: Record<string, string> = {}) =>
  new Response(
    new ReadableStream({
      start(c) {
        for (const ch of chunked(body)) c.enqueue(enc.encode(ch));
        c.close();
      },
    }),
    { status, headers: { "content-type": "text/event-stream", ...headers } },
  );

const ANTHROPIC_EVENTS: [string, unknown][] = [
  [
    "message_start",
    {
      type: "message_start",
      message: {
        id: "msg_01",
        type: "message",
        role: "assistant",
        model: "claude-opus-5-5",
        content: [],
        stop_reason: null,
        usage: {
          input_tokens: 12,
          cache_creation_input_tokens: 100,
          cache_read_input_tokens: 50,
          cache_creation: { ephemeral_5m_input_tokens: 60, ephemeral_1h_input_tokens: 40 },
          output_tokens: 1,
        },
      },
    },
  ],
  ["ping", { type: "ping" }],
  [
    "content_block_start",
    { type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "", signature: "" } },
  ],
  ["content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "" } }],
  [
    "content_block_delta",
    { type: "content_block_delta", index: 0, delta: { type: "signature_delta", signature: "sig==" } },
  ],
  ["content_block_stop", { type: "content_block_stop", index: 0 }],
  ["content_block_start", { type: "content_block_start", index: 1, content_block: { type: "text", text: "" } }],
  [
    "content_block_delta",
    { type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "Let me draw " } },
  ],
  ["content_block_delta", { type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "it. ✨" } }],
  ["content_block_stop", { type: "content_block_stop", index: 1 }],
  [
    "content_block_start",
    {
      type: "content_block_start",
      index: 2,
      content_block: { type: "tool_use", id: "toolu_1", name: "paint", input: {} },
    },
  ],
  [
    "content_block_delta",
    { type: "content_block_delta", index: 2, delta: { type: "input_json_delta", partial_json: '{"rows": ["..' } },
  ],
  [
    "content_block_delta",
    { type: "content_block_delta", index: 2, delta: { type: "input_json_delta", partial_json: 'AB"], "w": 4}' } },
  ],
  ["content_block_stop", { type: "content_block_stop", index: 2 }],
  [
    "content_block_start",
    {
      type: "content_block_start",
      index: 3,
      content_block: { type: "tool_use", id: "toolu_2", name: "noop", input: {} },
    },
  ],
  [
    "content_block_delta",
    { type: "content_block_delta", index: 3, delta: { type: "input_json_delta", partial_json: "" } },
  ],
  ["content_block_stop", { type: "content_block_stop", index: 3 }],
  [
    "message_delta",
    {
      type: "message_delta",
      delta: { stop_reason: "tool_use", stop_sequence: null },
      usage: { output_tokens: 87, output_tokens_details: { thinking_tokens: 30 } },
    },
  ],
  ["message_stop", { type: "message_stop" }],
];

const anthropicConfig: ProviderConfig = {
  id: "anthropic",
  kind: "anthropic",
  label: "Anthropic",
  baseUrl: "https://api.anthropic.com",
  enabled: true,
};

function recorder(responses: (() => Response)[]) {
  const seen: { url: string; init: RequestInit }[] = [];
  const f: FetchLike = async (url, init) => {
    seen.push({ url, init });
    const next = responses.shift();
    if (!next) throw new Error("no more responses");
    return next();
  };
  return { f, seen };
}
const noSleep = async () => {};

for (const eol of ["\n", "\r\n"]) {
  test(`Anthropic stream: thinking, text, tool calls, usage, cost (${eol === "\n" ? "LF" : "CRLF"})`, async () => {
    const { f, seen } = recorder([() => streamResponse(sse(ANTHROPIC_EVENTS, eol))]);
    const p = new AnthropicProvider(anthropicConfig, { getKey: () => "sk-test", fetch: f, sleep: noSleep });
    const events: string[] = [];
    const r = await p.chat(
      {
        model: "anthropic/claude-opus-5-5",
        system: "You paint.",
        messages: [{ role: "user", content: "draw" }],
        tools: [{ name: "paint", description: "paint", inputSchema: { type: "object" } }],
        maxOut: 1000,
        cache: true,
        temperature: 0.7,
        effort: "high",
      },
      { onEvent: (e) => events.push(e.type) },
    );
    assert.equal(r.text, "Let me draw it. ✨");
    assert.equal(r.stop, "tool_use");
    assert.deepEqual(r.toolCalls, [
      { id: "toolu_1", name: "paint", input: { rows: ["..AB"], w: 4 } },
      { id: "toolu_2", name: "noop", input: {} },
    ]);
    assert.deepEqual(r.usage, {
      inputTokens: 12,
      outputTokens: 87,
      cacheWriteTokens: 100,
      cacheReadTokens: 50,
      cacheWrite1hTokens: 40,
      thinkingTokens: 30,
    });
    // 12*$4 + 60*$5 + 40*$8 + 50*$0.20 + 87*$20, per million
    assert.equal(Number(r.usd.toFixed(9)), 0.002418);
    assert.equal(r.usdSource, "table");
    assert.equal(r.assistant?.[0].type, "opaque");
    assert.ok(events.includes("thinking") && events.includes("text") && events.includes("tool_call"));
    // the request
    assert.equal(seen[0].url, "https://api.anthropic.com/v1/messages");
    const h = seen[0].init.headers as Record<string, string>;
    assert.equal(h["x-api-key"], "sk-test");
    assert.equal(h["anthropic-version"], "2026-10-21");
    const body = JSON.parse(seen[0].init.body as string);
    assert.equal(body.model, "claude-opus-5-5");
    assert.equal(body.stream, true);
    assert.equal(body.temperature, undefined);
    assert.deepEqual(body.thinking, { type: "adaptive" });
    assert.deepEqual(body.output_config, { effort: "high" });
    assert.deepEqual(body.system[0].cache_control, { type: "ephemeral" });
    assert.deepEqual(body.tools[0].cache_control, { type: "ephemeral" });
  });
}

test("Anthropic: retries 529 with retry-after, then a stream error event before any content", async () => {
  const waits: number[] = [];
  const overloaded = () =>
    new Response(JSON.stringify({ type: "error", error: { type: "overloaded_error", message: "Overloaded" } }), {
      status: 529,
      headers: { "retry-after": "2" },
    });
  const midError = () =>
    streamResponse(
      sse([
        ["message_start", ANTHROPIC_EVENTS[0][1]],
        ["error", { type: "error", error: { type: "overloaded_error", message: "Overloaded" } }],
      ]),
    );
  const { f, seen } = recorder([overloaded, midError, () => streamResponse(sse(ANTHROPIC_EVENTS))]);
  const p = new AnthropicProvider(anthropicConfig, {
    getKey: () => "k",
    fetch: f,
    sleep: async (ms) => {
      waits.push(ms);
    },
  });
  const r = await p.chat({ model: "claude-opus-5-5", messages: [{ role: "user", content: "x" }], maxOut: 10 });
  assert.equal(r.stop, "tool_use");
  assert.equal(seen.length, 3);
  assert.equal(waits[0], 2000);
});

test("Anthropic: 400 is not retried; refusal and max_tokens map", async () => {
  const bad = () =>
    new Response(JSON.stringify({ type: "error", error: { type: "invalid_request_error", message: "nope" } }), {
      status: 400,
    });
  const { f } = recorder([bad]);
  const p = new AnthropicProvider(anthropicConfig, { getKey: () => "k", fetch: f, sleep: noSleep });
  await assert.rejects(
    p.chat({ model: "claude-opus-5-5", messages: [{ role: "user", content: "x" }], maxOut: 10 }),
    (e) => e instanceof ProviderError && e.status === 400 && e.type === "invalid_request_error",
  );
  for (const [reason, stop] of [
    ["refusal", "refusal"],
    ["max_tokens", "max_tokens"],
  ]) {
    const { f: f2 } = recorder([
      () =>
        streamResponse(
          sse([
            ["message_start", ANTHROPIC_EVENTS[0][1]],
            ["message_delta", { type: "message_delta", delta: { stop_reason: reason }, usage: { output_tokens: 5 } }],
            ["message_stop", { type: "message_stop" }],
          ]),
        ),
    ]);
    const p2 = new AnthropicProvider(anthropicConfig, { getKey: () => "k", fetch: f2, sleep: noSleep });
    const r = await p2.chat({ model: "claude-haiku-5-5", messages: [{ role: "user", content: "x" }], maxOut: 10 });
    assert.equal(r.stop, stop);
  }
});

test("Anthropic request mapping: forced tool, thinking off, json schema, tool round-trip", () => {
  const p = new AnthropicProvider(anthropicConfig, { getKey: () => "k" });
  const tools = [{ name: "submit", description: "d", inputSchema: { type: "object" } }];
  const opus = p.buildBody({
    model: "claude-opus-5-5",
    messages: [],
    tools,
    toolChoice: { name: "submit" },
    maxOut: 5,
    thinking: false,
  });
  assert.deepEqual(opus.tool_choice, { type: "auto" });
  assert.deepEqual(opus.thinking, { type: "adaptive" });
  const haiku = p.buildBody({
    model: "claude-haiku-5-5",
    messages: [],
    tools,
    toolChoice: { name: "submit" },
    maxOut: 5,
    thinking: false,
  });
  assert.deepEqual(haiku.tool_choice, { type: "tool", name: "submit" });
  assert.deepEqual(haiku.thinking, { type: "disabled" });
  const sonnet = p.buildBody({ model: "claude-sonnet-5-5", messages: [], maxOut: 5, thinking: false, effort: "xhigh" });
  assert.deepEqual(sonnet.thinking, { type: "adaptive" });
  const sonnetLow = p.buildBody({
    model: "claude-sonnet-5-5",
    messages: [],
    maxOut: 5,
    thinking: false,
    effort: "low",
  });
  assert.deepEqual(sonnetLow.thinking, { type: "between_tools" });
  const j = p.buildBody({
    model: "claude-opus-5-5",
    messages: [],
    maxOut: 5,
    json: {
      name: "x",
      schema: { type: "object", properties: { s: { type: "string", minLength: 3 } }, required: ["s"] },
    },
  });
  assert.deepEqual(j.output_config, {
    format: {
      type: "json_schema",
      schema: { type: "object", properties: { s: { type: "string" } }, required: ["s"], additionalProperties: false },
    },
  });
  const thinking = { type: "thinking", thinking: "", signature: "sig" };
  const msgs = toAnthropicMessages([
    {
      role: "user",
      content: [
        { type: "text", text: "look" },
        { type: "image", mediaType: "image/png", data: "AAAA" },
      ],
    },
    {
      role: "assistant",
      content: [
        { type: "opaque", provider: "anthropic", block: thinking },
        { type: "opaque", provider: "openai", block: { junk: true } },
        { type: "tool_call", id: "t1", name: "paint", input: { a: 1 } },
        { type: "tool_call", id: "t2", name: "paint", input: { a: 2 } },
      ],
    },
    { role: "tool", toolCallId: "t1", name: "paint", content: "ok" },
    {
      role: "tool",
      toolCallId: "t2",
      name: "paint",
      content: [{ type: "image", mediaType: "image/png", data: "BB" }],
      isError: true,
    },
    { role: "user", content: "next" },
  ]);
  assert.equal(msgs.length, 3);
  assert.deepEqual(msgs[0].content[1], {
    type: "image",
    source: { type: "base64", media_type: "image/png", data: "AAAA" },
  });
  assert.deepEqual(msgs[1].content[0], thinking);
  assert.equal(msgs[1].content.length, 3);
  assert.equal(msgs[2].role, "user");
  assert.deepEqual(msgs[2].content[0], { type: "tool_result", tool_use_id: "t1", content: "ok" });
  assert.equal((msgs[2].content[1] as any).is_error, true);
  assert.deepEqual(msgs[2].content[2], { type: "text", text: "next" });
});

const OPENAI_CHUNKS: unknown[] = [
  { id: "gen-1", choices: [{ index: 0, delta: { role: "assistant", content: "" } }] },
  { id: "gen-1", choices: [{ index: 0, delta: { reasoning: "hmm" } }] },
  { id: "gen-1", choices: [{ index: 0, delta: { content: "Paint" } }] },
  { id: "gen-1", choices: [{ index: 0, delta: { content: "ing." } }] },
  {
    id: "gen-1",
    choices: [
      {
        index: 0,
        delta: {
          tool_calls: [{ index: 0, id: "call_a", type: "function", function: { name: "paint", arguments: "" } }],
        },
      },
    ],
  },
  { id: "gen-1", choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: '{"w":' } }] } }] },
  { id: "gen-1", choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: " 8}" } }] } }] },
  { id: "gen-1", choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] },
  {
    id: "gen-1",
    choices: [],
    usage: {
      prompt_tokens: 50,
      completion_tokens: 20,
      total_tokens: 70,
      prompt_tokens_details: { cached_tokens: 10 },
      completion_tokens_details: { reasoning_tokens: 5 },
      cost: 0.0012,
    },
  },
];

test("OpenAI-compatible stream: text, tool-call deltas by index, final usage chunk, provider cost", async () => {
  const body = `${OPENAI_CHUNKS.map((c) => `data: ${JSON.stringify(c)}\r\n\r\n`).join("")}data: [DONE]\r\n\r\n`;
  const { f, seen } = recorder([() => streamResponse(`: OPENROUTER PROCESSING\n\n${body}`)]);
  const p = new OpenAICompatProvider(
    { id: "openrouter", kind: "openrouter", label: "OR", baseUrl: "https://openrouter.ai/api/v1", enabled: true },
    { getKey: () => "or-key", fetch: f, sleep: noSleep },
  );
  const events: string[] = [];
  const r = await p.chat(
    {
      model: "openrouter/anthropic/claude-sonnet-5-5",
      system: "sys",
      messages: [{ role: "user", content: [{ type: "image", mediaType: "image/png", data: "QQ" }] }],
      tools: [{ name: "paint", description: "p", inputSchema: { type: "object" } }],
      json: { name: "out", schema: { type: "object", properties: { a: { type: "string" } }, required: ["a"] } },
      maxOut: 64,
    },
    { onEvent: (e) => events.push(e.type) },
  );
  assert.equal(r.text, "Painting.");
  assert.equal(r.stop, "tool_use");
  assert.deepEqual(r.toolCalls, [{ id: "call_a", name: "paint", input: { w: 8 } }]);
  assert.deepEqual(r.usage, { inputTokens: 40, cacheReadTokens: 10, outputTokens: 20, thinkingTokens: 5 });
  assert.equal(r.usd, 0.0012);
  assert.equal(r.usdSource, "provider");
  assert.deepEqual(events.slice(0, 2), ["thinking", "text"]);
  assert.equal(seen[0].url, "https://openrouter.ai/api/v1/chat/completions");
  assert.equal((seen[0].init.headers as Record<string, string>).authorization, "Bearer or-key");
  const sent = JSON.parse(seen[0].init.body as string);
  assert.equal(sent.model, "anthropic/claude-sonnet-5-5");
  assert.deepEqual(sent.stream_options, { include_usage: true });
  assert.equal(sent.max_tokens, 64);
  assert.equal(sent.messages[0].role, "system");
  assert.equal(sent.messages[1].content[0].image_url.url, "data:image/png;base64,QQ");
  assert.equal(sent.response_format.type, "json_schema");
  assert.equal(sent.response_format.json_schema.strict, true);
  assert.equal(sent.response_format.json_schema.schema.additionalProperties, false);
});

test("local OpenAI-compatible: no auth header without a key, zero cost", async () => {
  const body = `${OPENAI_CHUNKS.slice(2, 4)
    .concat([
      { choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
      { choices: [], usage: { prompt_tokens: 9, completion_tokens: 3 } },
    ])
    .map((c) => `data: ${JSON.stringify(c)}\n\n`)
    .join("")}data: [DONE]\n\n`;
  const { f, seen } = recorder([() => streamResponse(body)]);
  const p = new OpenAICompatProvider(
    { id: "lmstudio", kind: "lmstudio", label: "LM Studio", baseUrl: "http://127.0.0.1:1234/v1", enabled: true },
    { getKey: () => undefined, fetch: f, sleep: noSleep },
  );
  const r = await p.chat({ model: "lmstudio/qwen", messages: [{ role: "user", content: "x" }], maxOut: 8 });
  assert.equal(r.text, "Painting.");
  assert.equal(r.stop, "end");
  assert.equal(r.usd, 0);
  assert.equal(r.usdSource, "zero");
  assert.equal((seen[0].init.headers as Record<string, string>).authorization, undefined);
});

test("OpenAI message mapping: tool results with images move to a user turn", () => {
  const m = toOpenAIMessages(undefined, [
    { role: "assistant", content: [{ type: "tool_call", id: "c1", name: "render", input: { t: 1 } }] },
    {
      role: "tool",
      toolCallId: "c1",
      name: "render",
      content: [
        { type: "text", text: "rendered" },
        { type: "image", mediaType: "image/png", data: "ZZ" },
      ],
    },
    { role: "user", content: "ok?" },
  ]) as any[];
  assert.equal(m[0].content, null);
  assert.equal(m[0].tool_calls[0].function.arguments, '{"t":1}');
  assert.deepEqual(m[1], { role: "tool", tool_call_id: "c1", content: "rendered" });
  assert.equal(m[2].role, "user");
  assert.equal(m[2].content[1].image_url.url, "data:image/png;base64,ZZ");
  assert.equal(m[3].content, "ok?");
});

test("parseSSE: CR-only line ends, multi-line data, comments, no trailing blank line", async () => {
  const text = ": hi\revent: a\rdata: one\rdata: two\r\rdata: tail";
  const body = new ReadableStream<Uint8Array>({
    start(c) {
      for (const ch of chunked(text)) c.enqueue(enc.encode(ch));
      c.close();
    },
  });
  const got = [];
  for await (const m of parseSSE(body)) got.push(m);
  assert.deepEqual(got, [
    { event: "a", data: "one\ntwo" },
    { event: null, data: "tail" },
  ]);
});
