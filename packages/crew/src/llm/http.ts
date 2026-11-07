// Shared plumbing for the fetch-based providers: SSE parsing, errors, retries with backoff.

export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;
export type SleepLike = (ms: number, signal?: AbortSignal) => Promise<void>;

export type HttpOpts = {
  fetch?: FetchLike;
  sleep?: SleepLike;
  /** retries after the first attempt (default 4) */
  maxRetries?: number;
};

export class ProviderError extends Error {
  readonly code = "provider";
  readonly status: number;
  /** the API's error type, e.g. "overloaded_error", "rate_limit_error", "invalid_request_error" */
  readonly type: string;
  readonly retryable: boolean;
  readonly retryAfterMs: number | null;
  constructor(message: string, status: number, type: string, retryable: boolean, retryAfterMs: number | null = null) {
    super(message);
    this.status = status;
    this.type = type;
    this.retryable = retryable;
    this.retryAfterMs = retryAfterMs;
  }
}

export const isAbort = (e: unknown): boolean =>
  e instanceof Error && (e.name === "AbortError" || (e as { code?: string }).code === "ABORT_ERR");

export const defaultSleep: SleepLike = (ms, signal) =>
  new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason ?? abortError());
    const t = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(t);
      reject(signal?.reason ?? abortError());
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });

export function abortError(): Error {
  const e = new Error("aborted");
  e.name = "AbortError";
  return e;
}

/** retry-after-ms, then retry-after (seconds or an HTTP date). */
export function retryAfterMs(headers: Headers): number | null {
  const ms = Number.parseFloat(headers.get("retry-after-ms") ?? "");
  if (Number.isFinite(ms) && ms > 0) return ms;
  const ra = headers.get("retry-after");
  if (!ra) return null;
  const s = Number.parseFloat(ra);
  if (Number.isFinite(s)) return s > 0 ? s * 1000 : null;
  const at = Date.parse(ra) - Date.now();
  return at > 0 ? at : null;
}

export const retryableStatus = (status: number): boolean =>
  status === 408 || status === 409 || status === 429 || status >= 500;

/** Exponential backoff with jitter: 0.5s, 1s, 2s ... capped at 16s; a server's retry-after wins (capped at 60s). */
export function backoffMs(attempt: number, hinted: number | null): number {
  if (hinted !== null && hinted > 0) return Math.min(hinted, 60_000);
  const base = Math.min(500 * 2 ** attempt, 16_000);
  return base * (1 - Math.random() * 0.25);
}

/** Read an error response into a ProviderError (body shapes: Anthropic `{error:{type,message}}`, OpenAI `{error:{message,type|code}}`). */
export async function errorFromResponse(res: Response): Promise<ProviderError> {
  let text = "";
  try {
    text = await res.text();
  } catch {}
  let type = `http_${res.status}`;
  let message = text.slice(0, 500) || res.statusText;
  try {
    const body = JSON.parse(text);
    const err = body?.error ?? body;
    if (typeof err?.type === "string") type = err.type;
    else if (typeof err?.code === "string") type = err.code;
    if (typeof err?.message === "string") message = err.message;
  } catch {}
  return new ProviderError(
    `${res.status} ${type}: ${message}`,
    res.status,
    type,
    retryableStatus(res.status),
    retryAfterMs(res.headers),
  );
}

export type SseMessage = { event: string | null; data: string };

/** Parse a Server-Sent Events body. Handles LF, CRLF and CR line ends, split chunks, multi-line data and comments. */
export async function* parseSSE(body: ReadableStream<Uint8Array>): AsyncGenerator<SseMessage> {
  const decoder = new TextDecoder();
  let buf = "";
  let event: string | null = null;
  let data: string[] = [];
  let pendingCR = false;
  function* line(l: string): Generator<SseMessage> {
    if (l === "") {
      if (data.length || event) yield { event, data: data.join("\n") };
      event = null;
      data = [];
      return;
    }
    if (l.startsWith(":")) return;
    const i = l.indexOf(":");
    const field = i < 0 ? l : l.slice(0, i);
    let value = i < 0 ? "" : l.slice(i + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    if (field === "event") event = value;
    else if (field === "data") data.push(value);
  }
  const reader = body.getReader();
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      if (pendingCR && buf.startsWith("\n")) buf = buf.slice(1);
      pendingCR = false;
      for (;;) {
        const m = /\r\n|\r|\n/.exec(buf);
        if (!m) break;
        // a CR at the very end may be the first half of a CRLF split across chunks
        if (m[0] === "\r" && m.index === buf.length - 1) {
          pendingCR = true;
          const l = buf.slice(0, m.index);
          buf = "";
          yield* line(l);
          break;
        }
        const l = buf.slice(0, m.index);
        buf = buf.slice(m.index + m[0].length);
        yield* line(l);
      }
    }
    buf += decoder.decode();
    if (buf) yield* line(buf);
    yield* line("");
  } finally {
    reader.releaseLock();
  }
}

/** POST JSON with retries on 408/409/429/5xx, honouring retry-after. Returns the OK response (body unread). */
export async function postWithRetry(
  url: string,
  headers: Record<string, string>,
  body: unknown,
  opts: HttpOpts & { signal?: AbortSignal; attemptOffset?: number },
): Promise<Response> {
  const f = opts.fetch ?? fetch;
  const sleep = opts.sleep ?? defaultSleep;
  const max = opts.maxRetries ?? 4;
  for (let attempt = opts.attemptOffset ?? 0; ; attempt++) {
    let res: Response;
    try {
      res = await f(url, { method: "POST", headers, body: JSON.stringify(body), signal: opts.signal });
    } catch (e) {
      if (isAbort(e) || opts.signal?.aborted) throw e;
      if (attempt >= max) throw new ProviderError(`network: ${(e as Error).message}`, 0, "network_error", true);
      await sleep(backoffMs(attempt, null), opts.signal);
      continue;
    }
    if (res.ok) return res;
    const err = await errorFromResponse(res);
    if (!err.retryable || attempt >= max) throw err;
    await sleep(backoffMs(attempt, err.retryAfterMs), opts.signal);
  }
}

/** Split "<providerId>/<model>" on the first slash (OpenRouter model names contain slashes). */
export function splitModelId(id: string): { provider: string; model: string } {
  const i = id.indexOf("/");
  return i < 0 ? { provider: "", model: id } : { provider: id.slice(0, i), model: id.slice(i + 1) };
}
