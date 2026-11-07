import assert from "node:assert/strict";
import { test } from "node:test";
import { z } from "zod";
import { FakeProvider } from "../src/llm/fake.ts";
import { sanitizeSchema } from "../src/llm/schema.ts";
import { chatJson, extractJson, repairJson, StructuredError, SUBMIT_TOOL } from "../src/llm/structured.ts";

const Sprite = z.object({
  name: z.string().min(1),
  frames: z.array(z.object({ id: z.string(), rows: z.array(z.string()).min(1) })),
  fps: z.number().int().max(24).optional(),
});
const good = { name: "hero", frames: [{ id: "idle0", rows: ["..AA.."] }], fps: 8 };
const base = { model: "fake/model", messages: [{ role: "user" as const, content: "draw" }], maxOut: 100 };

test("rung 1: native json_schema", async () => {
  const fake = new FakeProvider([{ json: good, usd: 0.01 }]);
  const r = await chatJson(fake, base, Sprite);
  assert.deepEqual(r.json, good);
  assert.equal(r.jsonVia, "native");
  assert.equal(r.calls, 1);
  assert.equal(fake.calls[0].json?.name, "answer");
  assert.equal(fake.calls[0].json?.schema.$schema, undefined);
});

test("rung 2: a 400 on native falls through to the submit tool", async () => {
  const fake = new FakeProvider([
    { error: { status: 400, type: "invalid_request_error", message: "output_config not supported" } },
    { toolCalls: [{ name: SUBMIT_TOOL, input: good }], usd: 0.02 },
  ]);
  const r = await chatJson(fake, base, Sprite);
  assert.equal(r.jsonVia, "tool");
  assert.deepEqual(r.json, good);
  const req = fake.calls[1];
  assert.deepEqual(req.toolChoice, { name: SUBMIT_TOOL });
  assert.equal(req.tools?.at(-1)?.name, SUBMIT_TOOL);
  assert.match(req.system ?? "", /submit/);
});

test("rung 3: JSON mode when native and tools are known to fail", async () => {
  const fake = new FakeProvider([{ text: JSON.stringify(good) }]);
  const r = await chatJson(fake, base, Sprite, { caps: { structured: "failed", tools: "failed" } });
  assert.equal(r.jsonVia, "json_mode");
  assert.equal(fake.calls[0].jsonMode, true);
  assert.match(fake.calls[0].system ?? "", /JSON schema/);
});

test("rung 4: fenced JSON with light repair", async () => {
  const text = `Here you go:\n\`\`\`json\n{"name": "hero", "frames": [{"id": "idle0", "rows": ["..AA..",],},],}\n\`\`\`\nEnjoy.`;
  const fake = new FakeProvider([{ text }]);
  const r = await chatJson(fake, base, Sprite, { rungs: ["fenced"] });
  assert.equal(r.jsonVia, "fenced");
  assert.deepEqual(r.json, { name: "hero", frames: [{ id: "idle0", rows: ["..AA.."] }] });
});

test("a rung that yields no JSON moves on to the next", async () => {
  const fake = new FakeProvider([
    { text: "I would rather chat." },
    { text: `\`\`\`json\n${JSON.stringify(good)}\n\`\`\`` },
  ]);
  const r = await chatJson(fake, base, Sprite, { rungs: ["json_mode", "fenced"] });
  assert.equal(r.jsonVia, "fenced");
  assert.equal(r.calls, 2);
});

test("repair turn: at most 10 path-level errors, a fresh user message, the full object back", async () => {
  const bad = { name: "", frames: Array.from({ length: 12 }, (_, i) => ({ id: i, rows: [] })), fps: 60 };
  const fake = new FakeProvider([
    { json: bad, usd: 0.03 },
    { json: good, usd: 0.04 },
  ]);
  const r = await chatJson(fake, base, Sprite);
  assert.equal(r.jsonVia, "repaired");
  assert.equal(r.calls, 2);
  assert.equal(Number(r.usd.toFixed(6)), 0.07);
  const msgs = fake.calls[1].messages;
  assert.equal(msgs.length, 2);
  const last = msgs[1];
  assert.equal(last.role, "user");
  const text = last.content as string;
  const bullets = text.split("\n").filter((l) => l.startsWith("- "));
  assert.equal(bullets.length, 10);
  assert.match(text, /first 10 shown/);
  assert.match(text, /frames\.0\.id/);
  assert.match(text, /complete corrected object/);
});

test("normalizer after a failed repair", async () => {
  const bad = { name: "hero", frames: [{ id: "idle0", rows: "..AA.." }] };
  const fake = new FakeProvider([{ json: bad }, { json: bad }]);
  const r = await chatJson(fake, base, Sprite, {
    normalize: (raw: any) => ({ ...raw, frames: raw.frames.map((f: any) => ({ ...f, rows: [].concat(f.rows) })) }),
  });
  assert.equal(r.jsonVia, "normalized");
  assert.deepEqual(r.json.frames[0].rows, ["..AA.."]);
});

test("still invalid: StructuredError carrying the issues and the summed result", async () => {
  const fake = new FakeProvider([
    { json: { name: 3 }, usd: 0.01 },
    { json: { name: 4 }, usd: 0.01 },
  ]);
  await assert.rejects(chatJson(fake, base, Sprite), (e) => {
    assert.ok(e instanceof StructuredError);
    assert.ok(e.issues.length > 0);
    assert.equal(e.result?.calls, 2);
    return true;
  });
});

test("a refusal stops the ladder", async () => {
  const fake = new FakeProvider([{ text: "", stop: "refusal" }]);
  await assert.rejects(chatJson(fake, base, Sprite), /refused/);
  assert.equal(fake.calls.length, 1);
});

test("records skip the native rung", async () => {
  const Lookup = z.object({ colours: z.record(z.string(), z.string()) });
  const fake = new FakeProvider([{ toolCalls: [{ name: SUBMIT_TOOL, input: { colours: { A: "#fff" } } }] }]);
  const r = await chatJson(fake, base, Lookup);
  assert.equal(r.jsonVia, "tool");
});

test("extractJson and repairJson", () => {
  assert.deepEqual(extractJson('noise {"a": [1, 2,]} noise'), { a: [1, 2] });
  assert.deepEqual(extractJson('```json\n{"a": {"b": [1, 2'), { a: { b: [1, 2] } });
  assert.equal(repairJson('{"a": "x'), '{"a": "x"}');
  assert.equal(extractJson("no json here"), undefined);
});

test("sanitizeSchema drops unsupported constraints and flags optional props for strict", () => {
  const s = sanitizeSchema(z.toJSONSchema(Sprite) as Record<string, unknown>);
  const txt = JSON.stringify(s.schema);
  assert.doesNotMatch(txt, /minLength|maximum|\$schema/);
  assert.equal(s.nativeOk, true);
  assert.equal(s.strictOk, false);
  assert.ok(s.properties >= 5);
});

test("every rung rejected: the provider's own error comes through", async () => {
  const fake = new FakeProvider(() => ({ error: { status: 404, type: "not_found_error", message: "model: nope" } }));
  await assert.rejects(chatJson(fake, base, Sprite), /not_found_error|model: nope/);
  assert.equal(fake.calls.length, 4);
});
