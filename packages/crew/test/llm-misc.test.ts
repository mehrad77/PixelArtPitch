import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { inflateSync } from "node:zlib";
import { estimatePlan, estimateTask } from "../src/llm/estimator.ts";
import { FakeProvider } from "../src/llm/fake.ts";
import { Ledger, loadPriors } from "../src/llm/ledger.ts";
import { ANTHROPIC_PRICES, costUsd, priceFor, setPriceOverride, worstCaseUsd } from "../src/llm/prices.ts";
import { PROBE_COLOURS, probeModel, readProbe, twoColourPng } from "../src/llm/probe.ts";

process.env.PAP_HOME = mkdtempSync(join(tmpdir(), "pap-misc-"));
const freshLedger = () => new Ledger(join(mkdtempSync(join(tmpdir(), "pap-l-")), "ledger.sqlite"));

test("prices: table, cache multipliers, Haiku's long-context card, overrides", () => {
  const opus = ANTHROPIC_PRICES["claude-opus-5-5"];
  assert.equal(opus.cacheWritePerMTok, 5);
  assert.equal(opus.cacheWrite1hPerMTok, 8);
  assert.equal(opus.cacheReadPerMTok, 0.2);
  const haiku = priceFor("anthropic/claude-haiku-5-5")!;
  assert.equal(costUsd(haiku, { inputTokens: 100_000, outputTokens: 1_000_000 }), 0.01 + 0.5);
  assert.equal(costUsd(haiku, { inputTokens: 100_001, outputTokens: 0 }), (100_001 * 0.5) / 1e6);
  assert.equal(worstCaseUsd(opus, 1_000_000, 0, true), 5);
  assert.equal(priceFor("lmstudio/qwen"), null);
  setPriceOverride("openai/gpt-x", { inPerMTok: 1, outPerMTok: 2 });
  assert.equal(priceFor("openai/gpt-x")?.source, "manual");
  setPriceOverride("openai/gpt-x", null);
  assert.equal(priceFor("openai/gpt-x"), null);
});

test("priors are checked in and cover the task kinds", () => {
  const p = loadPriors();
  for (const k of [
    "asset.draw",
    "asset.repair",
    "asset.critique",
    "asset.judge",
    "direct.plan",
    "scene.code",
    "scene.patch",
    "review.final",
  ]) {
    assert.ok(p.kinds[k], k);
    assert.ok(p.kinds[k].usd.p90 >= p.kinds[k].usd.p50);
  }
  assert.equal(p.source.calls, 411);
});

test("estimator: price ratio, sprite size, local is free, measured speed wins", () => {
  const opus = { id: "anthropic/claude-opus-5-5", price: priceFor("claude-opus-5-5") };
  const sonnet = { id: "anthropic/claude-sonnet-5-5", price: priceFor("claude-sonnet-5-5") };
  const a = estimateTask({ kind: "asset.draw", model: opus });
  const b = estimateTask({ kind: "asset.draw", model: sonnet });
  assert.equal(a.source, "prior");
  assert.ok(Math.abs(b.usd[0] / a.usd[0] - 0.5) < 0.01);
  const big = estimateTask({ kind: "asset.draw", model: opus, params: { w: 32, h: 32, frames: 8 } });
  assert.ok(big.usd[0] > a.usd[0]);
  const local = estimateTask({ kind: "asset.draw", model: { id: "ollama/qwen", price: null, caps: { local: true } } });
  assert.deepEqual(local.usd, [0, 0]);
  assert.equal(local.speed.source, "default");

  const ledger = freshLedger();
  for (let i = 0; i < 4; i++) {
    ledger.insert({
      project: "p",
      task: "t",
      taskKind: "asset.draw",
      role: "pixel-artist",
      attempt: 0,
      provider: "anthropic",
      model: opus.id,
      promptVersion: "1",
      usage: { inputTokens: 10, outputTokens: 1000 },
      usd: 0.02,
      usdSource: "table",
      ttftMs: 1000,
      durationMs: 11_000,
      stop: "end",
      estUsd: null,
    });
  }
  const sp = ledger.speed(opus.id);
  assert.deepEqual(sp, { ttftMs: 1000, tokPerSec: 100, samples: 4 });
  const m = estimateTask({ kind: "asset.draw", model: opus }, { ledger });
  assert.equal(m.speed.source, "measured");
  assert.ok(Math.abs(m.sec[0] - (1 + m.outTokens[0] / 100)) < 1e-9);
  assert.equal(ledger.query({ project: "p", role: "pixel-artist", model: opus.id }).length, 4);
  assert.equal(ledger.query({ since: "2999-01-01" }).length, 0);
});

test("estimatePlan: list scheduling per endpoint, deps, summed $", () => {
  const model = { id: "fake/m", price: priceFor("claude-opus-5-5") };
  const t = estimateTask({ kind: "scene.code", model });
  const tasks = [
    { id: "a", kind: "scene.code", model },
    { id: "b", kind: "scene.code", model },
    { id: "c", kind: "scene.code", model, deps: ["a"] },
  ];
  const two = estimatePlan(tasks, 2);
  assert.ok(Math.abs(two.sec[0] - 2 * t.sec[0]) < 1e-9);
  const one = estimatePlan(tasks, 1);
  assert.ok(Math.abs(one.sec[0] - 3 * t.sec[0]) < 1e-9);
  assert.ok(Math.abs(two.usd[0] - 3 * t.usd[0]) < 1e-9);
  assert.ok(two.usd[1] > two.usd[0] && two.usd[1] < 3 * t.usd[1]);
  assert.ok(two.sec[1] >= two.sec[0]);
});

test("probe PNG is a valid 16x16 RGB image with two colours", () => {
  const buf = Buffer.from(twoColourPng(PROBE_COLOURS.red, PROBE_COLOURS.blue), "base64");
  assert.deepEqual([...buf.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  assert.equal(buf.readUInt32BE(16), 16);
  assert.equal(buf.readUInt32BE(20), 16);
  const idatAt = buf.indexOf("IDAT");
  const len = buf.readUInt32BE(idatAt - 4);
  const raw = inflateSync(buf.subarray(idatAt + 4, idatAt + 4 + len));
  assert.equal(raw.length, 16 * (1 + 48));
  assert.deepEqual([...raw.subarray(1, 4)], PROBE_COLOURS.red);
  assert.deepEqual([...raw.subarray(15 * 49 + 1, 15 * 49 + 4)], PROBE_COLOURS.blue);
});

test("probe: empirical tests decide caps, results are cached and reused", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pap-probe-"));
  const fake = new FakeProvider((req) => {
    if (req.json) return { json: { word: "lantern", n: 7 } };
    if (req.tools) return { toolCalls: [{ name: "record", input: { colour: "teal", count: 3 } }] };
    if (Array.isArray(req.messages[0].content)) return { text: "Green." };
    return { text: "1\n2\n3", usage: { outputTokens: 120 }, ttftMs: 50 };
  });
  const [info] = await fake.listModels();
  const r = await probeModel(
    fake,
    { ...info, caps: { ...info.caps, vision: "claimed", tools: "unknown" } },
    {
      dir,
      pick: () => ["red", "blue"],
    },
  );
  assert.equal(r.caps.structured, "passed");
  assert.equal(r.caps.tools, "passed");
  assert.equal(r.caps.vision, "failed");
  assert.ok(r.speed && r.speed.tokPerSec > 0);
  assert.equal(fake.calls.length, 4);
  assert.deepEqual(readProbe(info.id, dir)?.caps, r.caps);
  await probeModel(fake, info, { dir });
  assert.equal(fake.calls.length, 4);
});
