// Capability probe: declared metadata first, then four cheap empirical tests (schema echo, a forced tool call, a vision
// quiz on a generated 16x16 two-colour PNG, a measured TTFT and output speed). Results are cached on disk per model id.
// Probing spends money, so it only ever runs from an explicit probeModel() call; readProbe() never touches the network.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { crc32, deflateSync } from "node:zlib";
import { ProviderError } from "./http.ts";
import { tokPerSec } from "./ledger.ts";
import { appDataDir } from "./paths.ts";
import type { CapStatus, Caps, ChatRequest, ChatResult, ModelInfo, Provider } from "./types.ts";

export type ProbeTest = { status: CapStatus; detail: string; usd: number };
export type ProbeResult = {
  model: string;
  at: string;
  caps: Caps;
  speed: { ttftMs: number; tokPerSec: number } | null;
  usd: number;
  tests: { schema: ProbeTest; tool: ProbeTest; vision: ProbeTest; speed: ProbeTest };
};

const probeDir = (dir?: string) => {
  const d = dir ?? join(appDataDir(), "probes");
  mkdirSync(d, { recursive: true });
  return d;
};
const probeFile = (id: string, dir?: string) => join(probeDir(dir), `${encodeURIComponent(id)}.json`);

/** The cached probe for a model, or null. No network. */
export function readProbe(modelId: string, dir?: string): ProbeResult | null {
  const p = probeFile(modelId, dir);
  if (!existsSync(p)) return null;
  try {
    return JSON.parse(readFileSync(p, "utf8")) as ProbeResult;
  } catch {
    return null;
  }
}

/** Caps with a cached probe applied (passed/failed win over claimed). */
export function withProbe(model: ModelInfo, dir?: string): ModelInfo {
  const p = readProbe(model.id, dir);
  return p ? { ...model, caps: { ...model.caps, ...pickTested(p.caps) } } : model;
}
const pickTested = (c: Caps): Partial<Caps> => {
  const out: Partial<Caps> = {};
  for (const k of ["vision", "structured", "tools"] as const) if (c[k] === "passed" || c[k] === "failed") out[k] = c[k];
  return out;
};

// ---- a tiny PNG, built in code ----
export const PROBE_COLOURS: Record<string, [number, number, number]> = {
  red: [220, 30, 30],
  green: [30, 170, 60],
  blue: [30, 60, 220],
  yellow: [240, 220, 30],
};

/** 16x16 RGB PNG: the top half one colour, the bottom half another. Returns base64. */
export function twoColourPng(top: [number, number, number], bottom: [number, number, number], size = 16): string {
  const chunk = (type: string, data: Buffer) => {
    const t = Buffer.from(type, "ascii");
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(Buffer.concat([t, data])));
    return Buffer.concat([len, t, data, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // RGB
  const raw = Buffer.alloc(size * (1 + size * 3));
  for (let y = 0; y < size; y++) {
    const row = y * (1 + size * 3);
    raw[row] = 0; // filter: none
    const c = y < size / 2 ? top : bottom;
    for (let x = 0; x < size; x++) raw.set(c, row + 1 + x * 3);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]).toString("base64");
}

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

export type ProbeOpts = {
  dir?: string;
  /** re-run even when a cached result exists */
  force?: boolean;
  signal?: AbortSignal;
  /** pick the quiz colours (tests); default random */
  pick?: () => [string, string];
};

/** Run the probe for one model (spends a few cents on paid models). Cached unless `force`. */
export async function probeModel(provider: Provider, model: ModelInfo, opts: ProbeOpts = {}): Promise<ProbeResult> {
  if (!opts.force) {
    const cached = readProbe(model.id, opts.dir);
    if (cached) return cached;
  }
  const base = { model: model.id, maxOut: 2048, effort: "low" as const, thinking: false };
  const run = async (req: Omit<ChatRequest, "model" | "maxOut"> & { maxOut?: number }): Promise<ChatResult> =>
    provider.chat({ ...base, ...req }, { signal: opts.signal });
  const test = async (fn: () => Promise<{ status: CapStatus; detail: string; usd: number }>): Promise<ProbeTest> => {
    try {
      return await fn();
    } catch (e) {
      if (opts.signal?.aborted) throw e;
      const rejected = e instanceof ProviderError && (e.status === 400 || e.status === 422);
      return { status: rejected ? "failed" : "unknown", detail: (e as Error).message.slice(0, 200), usd: 0 };
    }
  };

  const schemaT = await test(async () => {
    const want = { word: "lantern", n: 7 };
    const r = await run({
      messages: [{ role: "user", content: 'Return the word "lantern" as `word` and the number 7 as `n`.' }],
      json: {
        name: "echo",
        schema: {
          type: "object",
          properties: { word: { type: "string" }, n: { type: "integer" } },
          required: ["word", "n"],
          additionalProperties: false,
        },
      },
    });
    let got = r.json;
    if (got === undefined) {
      try {
        got = JSON.parse(r.text);
      } catch {}
    }
    return { status: same(got, want) ? "passed" : "failed", detail: r.text.slice(0, 120), usd: r.usd };
  });

  const toolT = await test(async () => {
    const want = { colour: "teal", count: 3 };
    const r = await run({
      system: "Use the record tool to answer. Do not reply in text.",
      messages: [{ role: "user", content: 'Record the colour "teal" with count 3.' }],
      tools: [
        {
          name: "record",
          description: "Record a colour and a count.",
          inputSchema: {
            type: "object",
            properties: { colour: { type: "string" }, count: { type: "integer" } },
            required: ["colour", "count"],
          },
        },
      ],
      toolChoice: { name: "record" },
    });
    const call = r.toolCalls.find((t) => t.name === "record");
    return {
      status: call && same(call.input, want) ? "passed" : "failed",
      detail: call ? JSON.stringify(call.input) : `no tool call (${r.stop})`,
      usd: r.usd,
    };
  });

  const visionT = await test(async () => {
    const names = Object.keys(PROBE_COLOURS);
    const [top, bottom] =
      opts.pick?.() ??
      (() => {
        const a = names[Math.floor(Math.random() * names.length)];
        const rest = names.filter((n) => n !== a);
        return [a, rest[Math.floor(Math.random() * rest.length)]] as [string, string];
      })();
    const r = await run({
      messages: [
        {
          role: "user",
          content: [
            { type: "image", mediaType: "image/png", data: twoColourPng(PROBE_COLOURS[top], PROBE_COLOURS[bottom]) },
            {
              type: "text",
              text: `The image has a top half and a bottom half. What colour is the top half? Answer with one word: ${names.join(", ")}.`,
            },
          ],
        },
      ],
    });
    const said = r.text.toLowerCase();
    const okAns = said.includes(top) && !said.includes(bottom);
    return { status: okAns ? "passed" : "failed", detail: `top=${top} said=${r.text.slice(0, 40)}`, usd: r.usd };
  });

  let speed: ProbeResult["speed"] = null;
  const speedT = await test(async () => {
    const r = await run({
      messages: [{ role: "user", content: "Count from 1 to 60, one number per line, nothing else." }],
      maxOut: 1024,
    });
    if (!r.usage.outputTokens) return { status: "failed", detail: "no output", usd: r.usd };
    speed = { ttftMs: r.ttftMs, tokPerSec: tokPerSec(r.usage.outputTokens, r.durationMs, r.ttftMs) };
    return {
      status: "passed",
      detail: `${Math.round(speed.ttftMs)} ms, ${speed.tokPerSec.toFixed(1)} tok/s`,
      usd: r.usd,
    };
  });

  const decide = (t: ProbeTest, declared: CapStatus): CapStatus => (t.status === "unknown" ? declared : t.status);
  const caps: Caps = {
    ...model.caps,
    structured: decide(schemaT, model.caps.structured),
    tools: decide(toolT, model.caps.tools),
    vision: decide(visionT, model.caps.vision),
  };
  const result: ProbeResult = {
    model: model.id,
    at: new Date().toISOString(),
    caps,
    speed,
    usd: schemaT.usd + toolT.usd + visionT.usd + speedT.usd,
    tests: { schema: schemaT, tool: toolT, vision: visionT, speed: speedT },
  };
  writeFileSync(probeFile(model.id, opts.dir), `${JSON.stringify(result, null, 2)}\n`);
  return result;
}
