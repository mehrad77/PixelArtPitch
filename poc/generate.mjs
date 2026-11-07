// Draws the video's pixel assets with Claude Opus 5.5: draw -> validate -> render -> critique/revise -> judge.
// Run: node --env-file=.env gen/generate.mjs [--only a,b] [--variants 3] [--rounds 2] [--cap 140] [--conc 6]
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import Anthropic from "@anthropic-ai/sdk";
import { renderSheet } from "../vendor/painter/png.mjs";
import { COLOURS, PALETTE, SKY } from "../palette.mjs";
import { FONT_SPEC, SPECS } from "./specs.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = join(ROOT, "gen/out");
const COST_LOG = join(ROOT, "gen/cost.jsonl");
const MODEL = "claude-opus-5-5";
const PRICE_IN = 4 / 1e6;
const PRICE_OUT = 20 / 1e6;

const arg = (name, dflt) => {
  const i = process.argv.indexOf(`--${name}`);
  return i < 0 ? dflt : process.argv[i + 1];
};
const ONLY = arg("only", "")?.split(",").filter(Boolean);
const VARIANTS = Number(arg("variants", 3));
const ROUNDS = Number(arg("rounds", 2));
const CAP = Number(arg("cap", 140));
const CONC = Number(arg("conc", 6));
const TAG = arg("tag", ""); // prefix for variant ids in a later pass (e.g. "b" -> vb1, vb2)
const RESERVE = 2.5; // dollars kept free for any call in flight

const client = new Anthropic({ maxRetries: 5, timeout: 20 * 60 * 1000 });

// ---- cost ----
let spent = existsSync(COST_LOG)
  ? readFileSync(COST_LOG, "utf8")
      .split("\n")
      .filter(Boolean)
      .reduce((s, l) => s + JSON.parse(l).usd, 0)
  : 0;
const costOf = (u) =>
  ((u.input_tokens ?? 0) + 1.25 * (u.cache_creation_input_tokens ?? 0) + 0.1 * (u.cache_read_input_tokens ?? 0)) *
    PRICE_IN +
  (u.output_tokens ?? 0) * PRICE_OUT;
class BudgetError extends Error {}
function guard() {
  if (spent + RESERVE > CAP) throw new BudgetError(`budget: $${spent.toFixed(2)} spent, cap $${CAP}`);
}

// ---- prompt ----
const paletteTable = (letters) =>
  Object.entries(PALETTE)
    .filter(([k]) => !letters || letters.includes(k))
    .map(([k, [hex, what]]) => `${k}  ${hex}  ${what}`)
    .join("\n");

const SYSTEM = `You are a senior pixel artist making sprites for a short 2D-platformer-style video (a hackathon intro for a
small startup). The look: a night-time retro platformer in the dark-green "shab.boo" palette,
16-bit era quality, clean readable silhouettes.

You draw sprites as text grids. Each frame is a list of rows; each row is a string of single-letter cells. "." is
transparent. Every other character must be a palette letter. Rows must be exactly the requested width, frames exactly the
requested height. Never use "#".

Craft rules:
- Light comes from the upper left: the right and bottom edges of a shape take its darker tone.
- A 1-cell dark outline (k, or a dark tone of the shape) around figures and objects so they read against a near-black sky
  (#0f1411). Avoid edge cells darker than the sky without an outline making sense.
- Use clusters, not noise: no lone stray pixels, no checkerboard dithering unless asked. Deliberate anti-aliasing only.
- Keep animation frames consistent: same palette, same proportions, same anchor (feet on the same baseline).
- Characters face RIGHT unless told otherwise.

Full palette (letter, colour, use):
${paletteTable()}

Return only JSON matching the schema: "notes" (one or two sentences on your approach or what you changed) and "frames"
(each requested frame name -> array of row strings).`;

const schemaFor = (spec) => ({
  type: "object",
  additionalProperties: false,
  required: ["notes", "frames"],
  properties: {
    notes: { type: "string" },
    frames: {
      type: "object",
      additionalProperties: false,
      required: spec.frames,
      properties: Object.fromEntries(spec.frames.map((f) => [f, { type: "array", items: { type: "string" } }])),
    },
  },
});

const imageBlock = (buf, media = "image/png") => ({
  type: "image",
  source: { type: "base64", media_type: media, data: buf.toString("base64") },
});
const refBlocks = (spec) =>
  (spec.ref ?? []).map((f) => {
    const p = join(ROOT, "assets/ref", f);
    return imageBlock(readFileSync(p), f.endsWith(".jpg") ? "image/jpeg" : "image/png");
  });

// ---- validation and rendering ----
const legendOf = (spec) => spec.palette ?? Object.keys(PALETTE).join("");
function validate(spec, frames) {
  const errs = [];
  const legal = new Set([...legendOf(spec), "."]);
  for (const name of spec.frames) {
    const rows = frames?.[name];
    if (!Array.isArray(rows)) {
      errs.push(`${name}: missing`);
      continue;
    }
    if (rows.length !== spec.h) errs.push(`${name}: ${rows.length} rows, expected ${spec.h}`);
    rows.forEach((r, y) => {
      if (r.length !== spec.w) errs.push(`${name} row ${y}: ${r.length} cells, expected ${spec.w}`);
      const bad = [...r].filter((c) => !legal.has(c));
      if (bad.length) errs.push(`${name} row ${y}: illegal cells ${[...new Set(bad)].join("")}`);
    });
  }
  return errs;
}
/** Last resort: pad/trim to size and clear illegal cells. */
function normalize(spec, frames) {
  const legal = new Set([...legendOf(spec), "."]);
  return Object.fromEntries(
    spec.frames.map((name) => {
      const rows = (frames?.[name] ?? []).slice(0, spec.h).map((r) =>
        [...r.padEnd(spec.w, ".").slice(0, spec.w)].map((c) => (legal.has(c) ? c : ".")).join(""),
      );
      while (rows.length < spec.h) rows.push(".".repeat(spec.w));
      return [name, rows];
    }),
  );
}
function sheet(spec, frames) {
  const cols = Math.min(spec.frames.length, spec.w <= 8 ? 16 : spec.w >= 48 ? 2 : 4);
  const scale = Math.max(2, Math.min(10, Math.floor(1100 / (cols * (spec.w + 2)))));
  const colours = { ...COLOURS };
  return renderSheet(
    spec.frames.map((f) => frames[f]),
    { colours, scale, columns: cols, bg: SKY },
  );
}

// ---- API ----
async function call(label, messages, schema) {
  guard();
  const stream = client.messages.stream({
    model: MODEL,
    max_tokens: 48000,
    thinking: { type: "adaptive" },
    output_config: { effort: "high", format: { type: "json_schema", schema } },
    cache_control: { type: "ephemeral" },
    system: SYSTEM,
    messages,
  });
  const msg = await stream.finalMessage();
  const usd = costOf(msg.usage);
  spent += usd;
  appendFileSync(
    COST_LOG,
    `${JSON.stringify({ t: new Date().toISOString(), label, usd: +usd.toFixed(4), total: +spent.toFixed(2), usage: msg.usage })}\n`,
  );
  console.log(`  [$${spent.toFixed(2)}] ${label} +$${usd.toFixed(3)} (${msg.stop_reason})`);
  if (msg.stop_reason === "refusal") throw new Error(`${label}: refused (${msg.stop_details?.category ?? "?"})`);
  if (msg.stop_reason === "max_tokens") throw new Error(`${label}: hit max_tokens`);
  const text = msg.content.find((b) => b.type === "text")?.text;
  return { msg, json: JSON.parse(text) };
}

const firstPrompt = (spec, variant) => `Draw the asset "${spec.name}".
Size: each frame is exactly ${spec.w} cells wide and ${spec.h} rows tall.
Frames, in order: ${spec.frames.join(", ")}.
${spec.palette ? `Use only these letters: ${spec.palette} (and "." for transparent).` : "Use letters from the palette."}
${spec.ref?.length ? "The attached image(s) are likeness references only: capture the person's recognisable traits as a tiny sprite, do not trace." : ""}

${spec.describe}

This is variant ${variant} of ${spec.variants ?? VARIANTS}; make your own confident interpretation.`;

const critiquePrompt = (spec, round) => `Here is your "${spec.name}" sprite rendered on the night sky (frames left to right,
top to bottom: ${spec.frames.join(", ")}). Round ${round} of ${spec.rounds ?? ROUNDS}.
Look at it critically as a senior pixel artist${spec.ref?.length ? " and compare it with the reference" : ""}: silhouette and
readability at small size, ${spec.ref?.length ? "likeness, " : ""}anatomy and proportions, frame-to-frame consistency and
animation, outline and shading (light from the upper left), stray pixels. Then return the complete revised JSON with
every frame (fix what is weak; keep what works).`;

async function variant(spec, v) {
  const dir = join(OUT, spec.name);
  mkdirSync(dir, { recursive: true });
  const schema = schemaFor(spec);
  const messages = [{ role: "user", content: [...refBlocks(spec), { type: "text", text: firstPrompt(spec, v) }] }];
  let { msg, json } = await call(`${spec.name} v${v} draw`, messages, schema);
  messages.push({ role: "assistant", content: msg.content });
  let errs = validate(spec, json.frames);
  if (errs.length) {
    messages.push({
      role: "user",
      content: `The grid has errors; return the full corrected JSON:\n${errs.slice(0, 40).join("\n")}`,
    });
    ({ msg, json } = await call(`${spec.name} v${v} fix`, messages, schema));
    messages.push({ role: "assistant", content: msg.content });
    errs = validate(spec, json.frames);
  }
  let frames = errs.length ? normalize(spec, json.frames) : json.frames;
  writeFileSync(join(dir, `v${v}-r0.json`), JSON.stringify({ notes: json.notes, frames }, null, 1));
  writeFileSync(join(dir, `v${v}-r0.png`), sheet(spec, frames));
  for (let r = 1; r <= (spec.rounds ?? ROUNDS); r++) {
    messages.push({
      role: "user",
      content: [imageBlock(sheet(spec, frames)), { type: "text", text: critiquePrompt(spec, r) }],
    });
    try {
      ({ msg, json } = await call(`${spec.name} v${v} r${r}`, messages, schema));
    } catch (e) {
      if (e instanceof BudgetError) break;
      console.warn(`  ${spec.name} v${v} r${r}: ${e.message}`);
      break;
    }
    messages.push({ role: "assistant", content: msg.content });
    const e2 = validate(spec, json.frames);
    frames = e2.length ? normalize(spec, json.frames) : json.frames;
    writeFileSync(join(dir, `v${v}-r${r}.json`), JSON.stringify({ notes: json.notes, frames }, null, 1));
    writeFileSync(join(dir, `v${v}-r${r}.png`), sheet(spec, frames));
  }
  writeFileSync(join(dir, `v${v}.json`), JSON.stringify({ frames }, null, 1));
  writeFileSync(join(dir, `v${v}.png`), sheet(spec, frames));
  return frames;
}

const JUDGE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["best", "reason"],
  properties: { best: { type: "integer" }, reason: { type: "string" } },
};

async function judge(spec, results) {
  const dir = join(OUT, spec.name);
  const ok = results;
  if (ok.length === 1) return ok[0][0];
  const content = [...refBlocks(spec)];
  ok.forEach(([, f], i) => content.push({ type: "text", text: `Variant ${i + 1}:` }, imageBlock(sheet(spec, f))));
  content.push({
    type: "text",
    text: `These are variants of the "${spec.name}" asset (${spec.describe.split("\n")[0]}). Pick the single best one for a
polished night-time pixel platformer video: readability, ${spec.ref?.length ? "likeness, " : ""}craft and animation. Answer
with its variant number.`,
  });
  try {
    const { json } = await call(`${spec.name} judge`, [{ role: "user", content }], JUDGE_SCHEMA);
    writeFileSync(join(dir, "judge.json"), JSON.stringify(json, null, 1));
    const hit = ok[json.best - 1];
    return hit ? hit[0] : ok[0][0];
  } catch (e) {
    console.warn(`  ${spec.name} judge: ${e.message}`);
    return ok[0][0];
  }
}

async function asset(spec) {
  const n = spec.variants ?? VARIANTS;
  await Promise.all(
    Array.from({ length: n }, (_, i) =>
      limit(() => variant(spec, `${TAG}${i + 1}`)).catch((e) => {
        console.warn(`  ${spec.name} v${TAG}${i + 1} failed: ${e.message}`);
        return null;
      }),
    ),
  );
  // judge across every finished variant on disk, this pass and earlier ones
  const dir = join(OUT, spec.name);
  if (!existsSync(dir)) return console.warn(`${spec.name}: no variant survived`);
  const pool = readdirSync(dir)
    .filter((f) => /^v[a-z]*\d+\.json$/.test(f))
    .sort()
    .map((f) => [f.slice(1, -5), JSON.parse(readFileSync(join(dir, f), "utf8")).frames]);
  if (!pool.length) return console.warn(`${spec.name}: no variant survived`);
  const best = await limit(() => judge(spec, pool));
  const frames = pool.find(([id]) => id === best)[1];
  writeFileSync(join(dir, "chosen.json"), JSON.stringify({ variant: best, frames }, null, 1));
  writeFileSync(join(dir, "chosen.png"), sheet(spec, frames));
  console.log(`${spec.name}: chose v${best} of ${pool.length}`);
}

// ---- tiny concurrency pool ----
let active = 0;
const queue = [];
function limit(fn) {
  return new Promise((res, rej) => {
    const run = async () => {
      active++;
      try {
        res(await fn());
      } catch (e) {
        rej(e);
      } finally {
        active--;
        queue.shift()?.();
      }
    };
    active < CONC ? run() : queue.push(run);
  });
}

// the font in chunks of 18 glyphs: one schema per chunk keeps the structured-output grammar small
const fontParts = [];
for (let i = 0; i < FONT_SPEC.frames.length; i += 18)
  fontParts.push({ ...FONT_SPEC, name: `font${fontParts.length + 1}`, frames: FONT_SPEC.frames.slice(i, i + 18), variants: 2, rounds: 1,
    describe: FONT_SPEC.describe + `\nThis request covers only these glyphs: ${FONT_SPEC.glyphs.slice(i, i + 18).map((c) => JSON.stringify(c)).join(" ")}.` });
const all = [...SPECS, ...fontParts];
const todo = ONLY?.length ? all.filter((s) => ONLY.includes(s.name)) : all;
console.log(`spent so far $${spent.toFixed(2)}, cap $${CAP}; ${todo.length} assets × ${VARIANTS} variants, ${ROUNDS} rounds`);
await Promise.all(todo.map(asset));
console.log(`done: $${spent.toFixed(2)} spent`);
