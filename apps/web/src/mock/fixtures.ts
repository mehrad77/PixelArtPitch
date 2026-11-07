// Fixture data for mock mode: one seeded project mid-run, the settings, a capability matrix and a library.
import type { LibraryIndex, ModelRow, ProjectT, Role, Settings, TimelineJSON } from "../lib/types.ts";

export const CUES_DRAFT = [
  { id: "c01", text: "Every night the market wakes up after the city sleeps." },
  { id: "c02", text: "But finding the good stalls means walking for an hour." },
  { id: "c03", text: "Lantern maps every stall, live, as it opens." },
  { id: "c04", text: "Tap a lantern, see what is cooking and how long the line is." },
  { id: "c05", text: "Vendors light their own lantern from their phone." },
  { id: "c06", text: "Three markets in the pilot, nine hundred walkers a week." },
  { id: "c07", text: "We are raising a small seed to light ten more." },
  { id: "c08", text: "Lantern. Find the night." },
];
export const CUES_ANGLE: Record<string, { id: string; text: string }[]> = {
  walker: CUES_DRAFT,
  vendor: [
    { id: "c01", text: "Mina sells dumplings from eleven until three." },
    { id: "c02", text: "Most nights, half her tray goes home with her." },
    { id: "c03", text: "With Lantern, she lights her stall from her phone." },
    { id: "c04", text: "Walkers nearby see it glow, and the line follows." },
    { id: "c05", text: "Three markets, nine hundred walkers a week." },
    { id: "c06", text: "We are raising a small seed to light ten more." },
    { id: "c07", text: "Lantern. Find the night." },
  ],
  data: [
    { id: "c01", text: "Night markets move eleven billion dollars a year." },
    { id: "c02", text: "Almost none of it is on a map." },
    { id: "c03", text: "Lantern puts every stall online the minute it opens." },
    { id: "c04", text: "Nine hundred walkers a week in the pilot." },
    { id: "c05", text: "Vendors sell out forty minutes sooner." },
    { id: "c06", text: "We are raising a small seed to light ten more." },
    { id: "c07", text: "Lantern. Find the night." },
  ],
};

/** cue times the way @pap/schema's cueTimes estimates them */
export function estimateCues(cues: { id: string; text: string }[], t0 = 0.6): TimelineJSON["cues"] {
  let t = t0;
  return cues.map((c) => {
    const d = Math.max(1.1, c.text.split(/\s+/).length / 2.5);
    const out = { ...c, start: +t.toFixed(2), end: +(t + d).toFixed(2) };
    t += d + 0.2;
    return out;
  });
}

export function scenesFor(cues: TimelineJSON["cues"]): TimelineJSON["scenes"] {
  const groups = [
    ["s1_open", 0, 2],
    ["s2_problem", 2, 3],
    ["s3_product", 3, 5],
    ["s4_traction", 5, 6],
    ["s5_end", 6, cues.length],
  ] as const;
  const out: TimelineJSON["scenes"] = [];
  for (const [id, a, b] of groups) {
    const first = cues[a];
    const last = cues[Math.min(b, cues.length) - 1];
    if (!first || !last) continue;
    out.push({
      id,
      from: out.length ? out[out.length - 1].to : 0,
      to: +(last.end + (id === "s5_end" ? 4 : 0.2)).toFixed(2),
    });
  }
  return out;
}
/** the journey's own film (PIP-JOURNEY §6): QuestDay, a fictional todo app, 30 s in the 4 scenes the plan expects */
export const CUES_QUESTDAY = [
  { id: "c01", text: "Your list keeps growing, and nothing feels done." },
  { id: "c02", text: "QuestDay turns every task into a quest." },
  { id: "c03", text: "Tap one, and the board rewards you." },
  { id: "c04", text: "Streaks, small wins, a reason to come back." },
  { id: "c05", text: "Teams finish a third more of their week." },
  { id: "c06", text: "QuestDay. Make the day a quest." },
];
export const QUESTDAY_SCENES: TimelineJSON["scenes"] = [
  { id: "s01", from: 0, to: 7 },
  { id: "s02", from: 7, to: 14 },
  { id: "s03", from: 14, to: 22 },
  { id: "s04", from: 22, to: 30 },
];
export const SCENE_TITLES: Record<string, string> = {
  s01: "The list grows",
  s02: "Every task a quest",
  s03: "The quest board",
  s04: "End card",
  s1_open: "Market wakes",
  s2_problem: "The long walk",
  s3_product: "Lanterns light up",
  s4_traction: "Pilot numbers",
  s5_end: "End card",
};

export function makeDoc(id: string, title: string, brief: Partial<ProjectT["brief"]> = {}): ProjectT {
  const cues = CUES_DRAFT;
  const tl = estimateCues(cues);
  const scenes = scenesFor(tl);
  return {
    pap: 1,
    rev: 3,
    id,
    title,
    canvas: { w: 320, h: 180, fps: 30, palette: "pap-night@1" },
    brief: {
      idea: "Lantern: a live map of night-market stalls. Walkers see what is open and cooking; vendors light their stall from a phone.",
      purpose: "pitch",
      audience: "Seed investors at a demo night",
      ask: "A small seed round to reach ten markets",
      lengthSec: 30,
      tone: ["calm", "warm"],
      mustSay: ["nine hundred walkers a week"],
      mustAvoid: [],
      narration: "user",
      involvement: "key",
      references: [
        { file: "lantern-logo.png", type: "logo", rights: "mine", note: "Our wordmark; keep the flame shape." },
        { file: "market-photo.jpg", type: "style", rights: "licensed", note: "The colour of the stalls at midnight." },
      ],
      ...brief,
    },
    script: { cues, timing: { mode: "estimate", wps: 2.5, pause: 0.2, lead: 0.6, minCue: 1.1 } },
    events: { lanterns_on: tl[2]?.start ?? 6 },
    composition: {
      hold: 3,
      endHold: 4,
      duration: "E(c08)+4",
      captions: { enabled: true, by: "host", wrapW: 296, pre: 0.05, post: 0.3, safeBottom: 26 },
      dissolveIn: 0.3,
      fadeOut: 0.4,
    },
    code: [],
    scenes: scenes.map((s) => ({
      kind: "decl" as const,
      id: s.id,
      title: SCENE_TITLES[s.id] ?? s.id,
      from: s.from,
      to: s.to,
      cues: [],
      notes: "",
      recipes: [],
      layers: [],
    })),
    audio: {
      sfx: {
        source: "doc",
        events: [
          { t: "@lanterns_on", type: "powerup" },
          { t: "E(c04)", type: "select" },
          { t: "E(c06)-0.5", type: "coin" },
          { t: "S(c08)", type: "fanfare-short" },
        ],
        keep: null,
        minGap: 0.6,
      },
      music: { generator: "chip-bed", lift: "s3_product", settle: "s5_end" },
      vo: [],
    },
    mix: { voHighpass: 80, sfxDb: -15, musicDb: -14, lufs: -15, limiter: 0.84 },
    delivery: [{ id: "main", scale: 6, crf: 16, out: "lantern-pitch.mp4" }],
    subtitles: { srt: true, vtt: true },
    assets: [
      {
        id: "lantern",
        src: "file:assets/lantern.json",
        flags: { private: true, brand: { owner: "Lantern", trademark: true } },
      },
      { id: "moon", src: "lib:moon@1", flags: { private: false } },
      { id: "props", src: "lib:props@1", flags: { private: false } },
    ],
    crew: { profile: "balanced", models: {} },
    budget: { capUsd: 6, askAtFraction: 0.8, reserveUsd: 0.5 },
    notes: [{ by: "producer", text: "Assumed a 30 s cut for the demo-night slot; the brief allows 60." }],
  };
}

export const ROLE_MODELS: Record<Role, string> = {
  producer: "anthropic/claude-sonnet-5",
  writer: "anthropic/claude-sonnet-5",
  director: "anthropic/claude-sonnet-5",
  "art-director": "openai/gpt-5.5",
  "pixel-artist": "anthropic/claude-opus-5",
  animator: "anthropic/claude-sonnet-5",
  "scene-coder": "anthropic/claude-sonnet-5",
  "sound-designer": "lmstudio/qwen3-30b",
  mixer: "lmstudio/qwen3-30b",
  editor: "anthropic/claude-haiku-5",
  reviewer: "openai/gpt-5.5",
  librarian: "ollama/llama4-scout",
  assistant: "anthropic/claude-sonnet-5",
};

export const SETTINGS: Settings = {
  providers: [
    {
      id: "anthropic",
      kind: "anthropic",
      label: "Anthropic",
      baseUrl: "https://api.anthropic.com",
      hasKey: true,
      enabled: true,
    },
    {
      id: "openai",
      kind: "openai",
      label: "OpenAI",
      baseUrl: "https://api.openai.com/v1",
      hasKey: true,
      enabled: true,
    },
    {
      id: "openrouter",
      kind: "openrouter",
      label: "OpenRouter",
      baseUrl: "https://openrouter.ai/api/v1",
      hasKey: false,
      enabled: false,
    },
    {
      id: "lmstudio",
      kind: "lmstudio",
      label: "LM Studio",
      baseUrl: "http://127.0.0.1:1234/v1",
      hasKey: false,
      enabled: true,
    },
    { id: "ollama", kind: "ollama", label: "Ollama", baseUrl: "http://127.0.0.1:11434", hasKey: false, enabled: true },
  ],
  profile: "balanced",
  roles: Object.fromEntries(
    Object.entries(ROLE_MODELS).map(([r, m]) => [r, { model: m, fallback: "anthropic/claude-haiku-5" }]),
  ) as Settings["roles"],
  defaults: {
    capUsd: 6,
    askAtFraction: 0.8,
    involvement: "key",
    concurrency: 3,
    pipPlan: "shadow",
    reviewRounds: 2,
    effortCeiling: "medium",
    variants: 2,
  },
  paths: {
    roots: ["~/Movies/PixelArtPitch"],
    library: "~/worksapce/PixelArtPitch/library",
    ffmpeg: "/opt/homebrew/bin/ffmpeg",
  },
};

export const MODELS: ModelRow[] = [
  {
    id: "anthropic/claude-opus-5",
    provider: "anthropic",
    label: "Claude Opus 5",
    local: false,
    caps: { vision: "passed", structured: "passed", tools: "passed", longOutput: "passed" },
    ctx: 400000,
    maxOut: 64000,
    price: { inPerMTok: 15, outPerMTok: 75, source: "table" },
    speed: { ttftMs: 1400, tokPerSec: 58, samples: 41 },
    spend30dUsd: 9.42,
  },
  {
    id: "anthropic/claude-sonnet-5",
    provider: "anthropic",
    label: "Claude Sonnet 5",
    local: false,
    caps: { vision: "passed", structured: "passed", tools: "passed", longOutput: "passed" },
    ctx: 400000,
    maxOut: 64000,
    price: { inPerMTok: 3, outPerMTok: 15, source: "table" },
    speed: { ttftMs: 700, tokPerSec: 92, samples: 212 },
    spend30dUsd: 6.1,
  },
  {
    id: "anthropic/claude-haiku-5",
    provider: "anthropic",
    label: "Claude Haiku 5",
    local: false,
    caps: { vision: "passed", structured: "passed", tools: "passed", longOutput: "claimed" },
    ctx: 200000,
    maxOut: 16000,
    price: { inPerMTok: 1, outPerMTok: 5, source: "table" },
    speed: { ttftMs: 380, tokPerSec: 160, samples: 88 },
    spend30dUsd: 0.74,
  },
  {
    id: "openai/gpt-5.5",
    provider: "openai",
    label: "GPT-5.5",
    local: false,
    caps: { vision: "passed", structured: "passed", tools: "passed", longOutput: "claimed" },
    ctx: 256000,
    maxOut: 32000,
    price: { inPerMTok: 5, outPerMTok: 20, source: "provider" },
    speed: { ttftMs: 900, tokPerSec: 75, samples: 30 },
    spend30dUsd: 2.3,
  },
  {
    id: "lmstudio/qwen3-30b",
    provider: "lmstudio",
    label: "Qwen3 30B (LM Studio)",
    local: true,
    caps: { vision: "failed", structured: "passed", tools: "claimed", longOutput: "unknown" },
    ctx: 32768,
    maxOut: 8192,
    price: null,
    speed: { ttftMs: 520, tokPerSec: 41, samples: 17 },
    spend30dUsd: 0,
  },
  {
    id: "ollama/llama4-scout",
    provider: "ollama",
    label: "Llama 4 Scout (Ollama)",
    local: true,
    caps: { vision: "claimed", structured: "claimed", tools: "unknown", longOutput: "unknown" },
    ctx: 128000,
    maxOut: 8192,
    price: null,
    speed: null,
    spend30dUsd: 0,
  },
];

export const LIBRARY: LibraryIndex = {
  palette: "pap-night@1",
  assets: [
    { id: "castle", kind: "building", w: 64, h: 56, frames: 1, tags: ["castle", "goal", "night", "stone"] },
    { id: "moon", kind: "decor", w: 24, h: 24, frames: 1, tags: ["sky", "night", "moon"] },
    { id: "skyline", kind: "backdrop", w: 96, h: 40, frames: 2, tags: ["city", "parallax", "tileable", "night"] },
    { id: "tiles", kind: "tile", w: 16, h: 16, frames: 8, tags: ["terrain", "ground", "pipe", "bridge", "tileable"] },
    { id: "qblock", kind: "block", w: 16, h: 16, frames: 3, tags: ["question", "mystery", "platformer"] },
    { id: "powerups", kind: "icon", w: 16, h: 16, frames: 5, tags: ["powerup", "profile", "focus", "trophy"] },
    { id: "props", kind: "prop", w: 24, h: 32, frames: 6, tags: ["signpost", "flag", "flagpole", "lamp", "bush"] },
    {
      id: "items",
      kind: "icon",
      w: 12,
      h: 12,
      frames: 6,
      tags: ["pickup", "pc", "gamepad", "handheld", "phone", "heart", "star"],
    },
    { id: "map", kind: "map-tile", w: 16, h: 16, frames: 8, tags: ["overworld", "node", "path"] },
    { id: "gamers", kind: "crowd", w: 16, h: 24, frames: 6, tags: ["people", "crowd", "walk"] },
    { id: "font-5x8", kind: "font", w: 5, h: 8, frames: 64, tags: ["text", "caption", "bitmap"] },
    {
      id: "lantern",
      kind: "logo",
      w: 24,
      h: 24,
      frames: 2,
      tags: ["brand", "flame"],
      scope: "private",
      description: "Project logo: private to Lantern.",
    },
  ],
};

/** a new 30 s QuestDay pitch, as Start makes it from the draft: its own cues and the plan's 4 scenes, no Lantern art */
export function makeQuestDayDoc(id: string, title: string, brief: Partial<ProjectT["brief"]> = {}): ProjectT {
  const doc = makeDoc(id, title, {
    idea: "A 30 s pitch for QuestDay, a todo app that turns tasks into quests.",
    audience: "Investors",
    ask: "",
    tone: [],
    mustSay: [],
    references: [],
    narration: "none",
    ...brief,
  });
  doc.script.cues = CUES_QUESTDAY;
  doc.composition.duration = "30";
  doc.scenes = QUESTDAY_SCENES.map((s) => ({
    kind: "decl" as const,
    id: s.id,
    title: SCENE_TITLES[s.id] ?? s.id,
    from: s.from,
    to: s.to,
    cues: [],
    notes: "",
    recipes: [],
    layers: [],
  }));
  doc.assets = [];
  doc.delivery = [{ id: "main", scale: 6, crf: 16, out: "questday-pitch.mp4" }];
  doc.notes = [];
  return doc;
}
