// The structured-output ladder: get a schema-valid object out of any model.
//   1. native json_schema output   2. a `submit` tool (forced where the model allows it)
//   3. JSON mode with the schema in the prompt   4. a fenced ```json block, extracted with light repair
// then zod validation; on failure one repair turn (at most 10 path-level errors, asking for the whole object), then a
// caller-supplied normalizer.
//
// Keep schemas generic: an array of `{ name, rows }` items, not an object with one property per item. Big
// one-property-per-item schemas break grammar compilers (native output and strict tools).
import type { z } from "zod";
import { ProviderError } from "./http.ts";
import { sanitizeSchema, toJsonSchema } from "./schema.ts";
import type { Caps, ChatMessage, ChatRequest, ChatResult, Provider, StreamEvent, ToolSpec, Usage } from "./types.ts";

export type Rung = "native" | "tool" | "json_mode" | "fenced";
export const RUNGS: Rung[] = ["native", "tool", "json_mode", "fenced"];
export const SUBMIT_TOOL = "submit";

export type ChatJsonOpts = {
  /** schema name sent with native output */
  name?: string;
  /** the model's caps: rungs whose capability "failed" are skipped */
  caps?: Partial<Caps>;
  /** force a rung order (tests, or a caller that knows better) */
  rungs?: Rung[];
  /** last resort after the repair turn: reshape the raw object (pad, trim, coerce), then it is validated again */
  normalize?: (raw: unknown) => unknown;
  signal?: AbortSignal;
  onEvent?: (e: StreamEvent) => void;
};

export class StructuredError extends Error {
  readonly code = "structured";
  readonly issues: string[];
  readonly raw: unknown;
  readonly result: ChatResult | null;
  constructor(message: string, issues: string[], raw: unknown, result: ChatResult | null) {
    super(message);
    this.issues = issues;
    this.raw = raw;
    this.result = result;
  }
}

/** Errors that mean "this rung isn't supported here", so the next rung is worth a try. */
const unsupported = (e: unknown) =>
  e instanceof ProviderError && (e.status === 400 || e.status === 404 || e.status === 422 || e.status === 501);

export function rungsFor(caps: Partial<Caps> | undefined, nativeOk: boolean): Rung[] {
  return RUNGS.filter((r) => {
    if (r === "native") return nativeOk && caps?.structured !== "failed";
    if (r === "tool") return caps?.tools !== "failed";
    return true;
  });
}

/** Path-level zod issues, at most `max`. */
export function issueLines(error: z.ZodError, max = 10): string[] {
  return error.issues.slice(0, max).map((i) => `${i.path.length ? i.path.join(".") : "(root)"}: ${i.message}`);
}

/** Pull a JSON value out of free text: a ```json fence, else the outermost {...} or [...], with light repair. */
export function extractJson(text: string): unknown {
  const t = text.replace(/^﻿/, "");
  const candidates: string[] = [];
  for (const m of t.matchAll(/```(?:json|JSON)?\s*\n?([\s\S]*?)```/g)) candidates.push(m[1]);
  const open = t.search(/[{[]/);
  if (open >= 0) {
    const close = Math.max(t.lastIndexOf("}"), t.lastIndexOf("]"));
    candidates.push(close > open ? t.slice(open, close + 1) : t.slice(open));
    // an unclosed fence (truncated answer)
    const fence = /```(?:json|JSON)?\s*\n?([\s\S]*)$/.exec(t);
    if (fence) candidates.push(fence[1]);
  }
  for (const c of candidates) {
    const v = tryParse(c) ?? tryParse(repairJson(c));
    if (v !== undefined) return v;
  }
  return undefined;
}

function tryParse(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return undefined;
  }
}

/** Light repair: smart quotes, comments, trailing commas, and closing brackets a truncated answer left open. */
export function repairJson(s: string): string {
  let out = s
    .trim()
    .replace(/[“”]/g, '"')
    .replace(/^\s*\/\/.*$/gm, "")
    .replace(/,\s*([}\]])/g, "$1");
  const stack: string[] = [];
  let inStr = false;
  let esc = false;
  for (const ch of out) {
    if (inStr) {
      if (esc) esc = false;
      else if (ch === "\\") esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === "{") stack.push("}");
    else if (ch === "[") stack.push("]");
    else if (ch === "}" || ch === "]") stack.pop();
  }
  if (inStr) out += '"';
  out = out.replace(/,\s*$/, "");
  while (stack.length) out += stack.pop();
  return out;
}

const sumUsage = (a: Usage, b: Usage): Usage => {
  const add = (x?: number, y?: number) => (x === undefined && y === undefined ? undefined : (x ?? 0) + (y ?? 0));
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    cacheWriteTokens: add(a.cacheWriteTokens, b.cacheWriteTokens),
    cacheReadTokens: add(a.cacheReadTokens, b.cacheReadTokens),
    cacheWrite1hTokens: add(a.cacheWrite1hTokens, b.cacheWrite1hTokens),
    thinkingTokens: add(a.thinkingTokens, b.thinkingTokens),
  };
};

function withNote(system: string | undefined, note: string): string {
  return system ? `${system}\n\n${note}` : note;
}

function rungRequest(
  base: Omit<ChatRequest, "json">,
  rung: Rung,
  name: string,
  jsonSchema: Record<string, unknown>,
): ChatRequest {
  const schemaText = JSON.stringify(jsonSchema);
  switch (rung) {
    case "native":
      return { ...base, json: { name, schema: jsonSchema } };
    case "tool": {
      const submit: ToolSpec = {
        name: SUBMIT_TOOL,
        description: "Submit the final answer: one complete object matching the input schema.",
        inputSchema: jsonSchema,
      };
      return {
        ...base,
        tools: [...(base.tools ?? []).filter((t) => t.name !== SUBMIT_TOOL), submit],
        toolChoice: { name: SUBMIT_TOOL },
        system: withNote(
          base.system,
          `When you have the answer, call the \`${SUBMIT_TOOL}\` tool exactly once with the complete object. Do not write the answer as text.`,
        ),
      };
    }
    case "json_mode":
      return {
        ...base,
        jsonMode: true,
        system: withNote(
          base.system,
          `Reply with one JSON object and nothing else. It must match this JSON schema:\n${schemaText}`,
        ),
      };
    case "fenced":
      return {
        ...base,
        system: withNote(
          base.system,
          `Reply with the answer as one JSON object in a single \`\`\`json fenced block. It must match this JSON schema:\n${schemaText}`,
        ),
      };
  }
}

function candidateOf(rung: Rung, r: ChatResult): unknown {
  if (rung === "tool") {
    const call = r.toolCalls.find((t) => t.name === SUBMIT_TOOL);
    if (call && !(call.input && typeof call.input === "object" && "_unparsed" in call.input)) return call.input;
    return r.text ? extractJson(r.text) : undefined;
  }
  if (rung === "native" || rung === "json_mode") {
    if (r.json !== undefined) return r.json;
    return r.text ? (tryParse(r.text.trim()) ?? extractJson(r.text)) : undefined;
  }
  return r.text ? extractJson(r.text) : undefined;
}

/** Run the ladder and return a validated object in `json`, with `jsonVia`, summed usage/usd and `calls`. */
export async function chatJson<S extends z.ZodType>(
  provider: Provider,
  req: Omit<ChatRequest, "json">,
  schema: S,
  opts: ChatJsonOpts = {},
): Promise<ChatResult & { json: z.output<S> }> {
  const jsonSchema = toJsonSchema(schema);
  delete jsonSchema.$schema;
  const { nativeOk } = sanitizeSchema(jsonSchema);
  const order = opts.rungs ?? rungsFor(opts.caps, nativeOk);
  const name = opts.name ?? "answer";
  let total: ChatResult | null = null;
  const call = async (r: ChatRequest): Promise<ChatResult> => {
    const res = await provider.chat(r, { signal: opts.signal, onEvent: opts.onEvent });
    total = total
      ? {
          ...res,
          usage: sumUsage(total.usage, res.usage),
          usd: total.usd + res.usd,
          usdSource: total.usdSource === "provider" || res.usdSource === "provider" ? "provider" : res.usdSource,
          ttftMs: total.ttftMs,
          durationMs: total.durationMs + res.durationMs,
          calls: (total.calls ?? 1) + 1,
        }
      : { ...res, calls: 1 };
    return res;
  };
  const done = (json: unknown, via: ChatResult["jsonVia"]) =>
    ({ ...(total as unknown as ChatResult), json, jsonVia: via }) as ChatResult & { json: z.output<S> };

  let lastIssues: string[] = [];
  let lastRaw: unknown;
  let lastError: unknown;
  for (const rung of order) {
    const r1 = rungRequest(req, rung, name, jsonSchema);
    let res: ChatResult;
    try {
      res = await call(r1);
    } catch (e) {
      if (unsupported(e)) {
        lastError = e;
        continue;
      }
      throw e;
    }
    if (res.stop === "refusal") throw new StructuredError("the model refused", [], undefined, total);
    const raw = candidateOf(rung, res);
    if (raw === undefined) {
      if (res.stop === "max_tokens") throw new StructuredError("hit max_tokens before any JSON", [], res.text, total);
      continue;
    }
    const first = schema.safeParse(raw);
    if (first.success) return done(first.data, rung);
    lastRaw = raw;
    lastIssues = issueLines(first.error);

    // one repair turn: a fresh user message quoting the bad object (no assistant replay, so thinking stays valid)
    const quoted = JSON.stringify(raw, null, 1);
    const repairMsg: ChatMessage = {
      role: "user",
      content:
        `Your previous answer did not match the schema (${first.error.issues.length} problem${first.error.issues.length === 1 ? "" : "s"}` +
        `${first.error.issues.length > 10 ? ", first 10 shown" : ""}):\n${lastIssues.map((l) => `- ${l}`).join("\n")}\n\n` +
        `Your previous answer:\n\`\`\`json\n${quoted.length > 60_000 ? `${quoted.slice(0, 60_000)}\n...(truncated)` : quoted}\n\`\`\`\n\n` +
        "Reply with the complete corrected object (every field, not a diff).",
    };
    let repaired: unknown;
    try {
      const res2 = await call(rungRequest({ ...req, messages: [...req.messages, repairMsg] }, rung, name, jsonSchema));
      repaired = candidateOf(rung, res2);
    } catch (e) {
      if (!unsupported(e)) throw e;
    }
    if (repaired !== undefined) {
      const second = schema.safeParse(repaired);
      if (second.success) return done(second.data, "repaired");
      lastRaw = repaired;
      lastIssues = issueLines(second.error);
    }
    if (opts.normalize) {
      for (const candidate of repaired !== undefined ? [repaired, raw] : [raw]) {
        let n: unknown;
        try {
          n = opts.normalize(candidate);
        } catch {
          continue;
        }
        const third = schema.safeParse(n);
        if (third.success) return done(third.data, "normalized");
        lastIssues = issueLines(third.error);
      }
    }
    throw new StructuredError(`no schema-valid answer (${rung} rung)`, lastIssues, lastRaw, total);
  }
  // every rung was rejected outright (bad model id, bad image...): surface the provider's own error
  if (lastError && total === null) throw lastError;
  const err = new StructuredError("no rung produced JSON", lastIssues, lastRaw, total);
  if (lastError) err.cause = lastError;
  throw err;
}
