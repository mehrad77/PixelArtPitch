# Studio server API (v1)

The local server (`apps/server`, Hono on 127.0.0.1) serves the studio UI (`apps/web`) and MCP. JSON everywhere; auth is a cookie set by the one-time launch URL plus an `X-PAP-Token` header on every mutating request. Errors are `{ ok: false, error: { code, message, fix?, path? } }` with a 4xx/5xx status.

## Shapes
```ts
type ProjectSummary = { id: string; title: string; dir: string; rev: number; stage: Stage; spentUsd: number; capUsd: number;
  etaSec: number | null; deadline: string | null; needsYou: number; updatedAt: string };
type Stage = "brief" | "script" | "storyboard" | "art" | "animate" | "narrate" | "sound" | "review" | "deliver";
type Task = { id: string; kind: string; role: Role; title: string;            // "Drawing hero, variant 2 of 3, critique 1"
  status: "upcoming" | "queued" | "working" | "waiting_user" | "waiting" | "done" | "failed" | "cancelled";
  model?: string; usd: number; estUsd?: number; etaSec?: number; startedAt?: string; endedAt?: string;
  summary?: string; error?: { message: string; fix?: string }; lastImage?: string /* URL */; parent?: string };
type Gate = { id: "g0_brief" | "g1_script" | "g2_animatic" | "g3_rough" | "g4_final"; status: "locked" | "open" | "passed" | "changes";
  items: { label: string; ref?: string }[] };
type Note = { id: string; target: { scene?: string; cue?: string; asset?: string; range?: [number, number]; track?: string };
  category: "too_fast" | "too_slow" | "unclear" | "art" | "sound" | "text" | "other"; text: string; assignee: Role | "producer";
  status: "open" | "picked_up" | "proposed" | "done" | "declined"; reason?: string; createdAt: string };
// Question: see packages/tools/src/registry.ts (QuestionT). PatchEntry: packages/schema/src/patch.ts.
type ProjectState = { doc: Project; rev: number; timeline: Timeline /* cues, scenes, duration, hold, events */;
  stage: Stage; gates: Gate[]; tasks: Task[]; questions: QuestionT[]; notes: Note[];
  budget: { capUsd: number; spentUsd: number; reservedUsd: number; estTotalUsd: [number, number] | null };
  time: { startedAt: string | null; etaSec: [number, number] | null; deadline: string | null };
  files: { name: string; url: string; bytes: number; kind: "video" | "subtitles" | "audio" | "image" }[];
  digest: string /* Producer's latest 2-3 sentence summary */ };
```

## Routes
| Method + path | Body / query | Returns |
|---|---|---|
| `GET /api/session` | | `{ version, token, workspace: { roots: string[], libraryDir } }` |
| `GET /api/projects` | | `ProjectSummary[]` |
| `POST /api/projects` | `{ title, brief, budgetUsd, dir? }` | `{ id }` (a new folder under the first project root unless `dir`) |
| `POST /api/projects/open` | `{ dir }` | `{ id }` |
| `GET /api/p/:id` | | `ProjectState` |
| `GET /api/p/:id/history` | `?since=seq` | `PatchEntry[]` |
| `POST /api/p/:id/patch` | `{ ops, reason, baseRev }` | `{ rev, seq }` (409 on stale `baseRev` over overlapping paths) |
| `POST /api/p/:id/undo` | `{ seq, reason }` | `{ rev, seq }` |
| `GET /api/p/:id/frame` | `?t=<scene seconds>&scale=1..6` | `image/png` (cached by input hash) |
| `GET /api/p/:id/contact` | `?every=1` | `image/png` |
| `GET /api/p/:id/proxy.mp4` | Range | the latest x4 preview with sound (`404` until built; an SSE `render` event announces it) |
| `POST /api/p/:id/tools/:name` | `{ input }` | `ToolResult` |
| `POST /api/p/:id/questions/:qid/answer` | `{ optionId?, value?, note? }` | `QuestionT` |
| `POST /api/p/:id/notes` | `{ target, category, text?, assignee? }` | `Note` |
| `POST /api/p/:id/gates/:gate` | `{ verdict: "approve" \| "approve_notes" \| "changes", items?: string[], reasons?: string[] }` | `Gate` |
| `POST /api/p/:id/crew/run` | `{ stage? }` | `{ ok }` |
| `POST /api/p/:id/crew/pause` | `{ mode: "after_step" \| "now" }` | `{ ok }` |
| `POST /api/p/:id/crew/resume` | | `{ ok }` |
| `GET /api/p/:id/events` | SSE, `Last-Event-ID` resumes | events below |
| `GET /api/p/:id/files/:name` | Range | an output file (mp4, srt, vtt, wav, png) |
| `POST /api/p/:id/vo` | `audio/wav` or `audio/webm` body, `?take=name` | `{ file }` |
| `POST /api/p/:id/vo/align` | `{ file }` | `{ proposal: { cue: string; start: number; end: number }[] }` then a patch to approve |
| `GET /api/settings` | | `Settings` (keys never included: `hasKey: boolean`) |
| `PUT /api/settings` | partial `Settings` | `Settings` |
| `PUT /api/settings/providers/:id/key` | `{ key }` | `{ hasKey: true }` |
| `POST /api/settings/providers/:id/test` | | `{ ok, models: string[], error? }` |
| `GET /api/models` | | `ModelRow[]` (capability matrix) |
| `GET /api/ledger` | `?project=&limit=` | ledger rows |
| `GET /api/library` | | `library/index.json` |
| `GET /api/library/:id` | | the asset file |
| `GET /api/library/:id/sheet.png` | | its preview sheet |
| `GET /api/pip` | `?project=` | `{ items: PipItem[], name: "Pip", model, mode: "agent" \| "menu", busy }` (shapes in `docs/ASSISTANT.md`) |
| `POST /api/pip` | `{ project?, text }` | `202 { turnId }`; `409` while a turn runs in that conversation; progress as SSE `pip` events |
| `POST /api/pip/cards/:cardId` | `{ project?, decision: "confirm" \| "decline", edit? }` | `{ card }` (status `running`/`submitted` at once; the final state comes as a `pip` `card` event); `409` if already decided |
| `GET /api/events` | SSE | the workspace stream: `pip` events for the conversation with no project |
| `GET /api/connections` | | the person's MCP servers: `{ name, transport, command?, args, url?, envKeys, headerKeys, enabled, trust, status, tools, toolNames, error?, fix? }[]` (secret values never) |
| `POST /api/connections` | `{ json }` (pasted `mcpServers` JSON) | `{ added: { name, status, tools: string[], error?, fix? }[] }` |
| `PATCH /api/connections/:name` | `{ enabled?, trust?: "ask" \| "read" }` | the connection |
| `DELETE /api/connections/:name` | | `{ ok }` (its secrets are deleted too) |
| `POST /api/connections/:name/test` | | `{ name, status, tools, error?, fix? }` |

```ts
type Settings = { providers: { id: string; kind: "anthropic" | "openai" | "openrouter" | "lmstudio" | "ollama" | "llamacpp" | "custom";
    label: string; baseUrl: string; hasKey: boolean; enabled: boolean }[];
  profile: "best" | "balanced" | "local" | "custom"; roles: Record<Role, { model: string; fallback?: string }>;
  defaults: { capUsd: number; askAtFraction: number; involvement: "every" | "key" | "auto"; concurrency: number };
  paths: { roots: string[]; library: string; ffmpeg: string } };
type ModelRow = { id: string /* provider/model */; provider: string; label: string; local: boolean;
  caps: { vision: Cap; structured: Cap; tools: Cap; longOutput: Cap }; ctx: number; maxOut: number;
  price: { inPerMTok: number; outPerMTok: number; source: "table" | "provider" | "manual" } | null;
  speed: { ttftMs: number; tokPerSec: number; samples: number } | null; spend30dUsd: number; fit?: Record<Role, number> };
type Cap = "passed" | "claimed" | "failed" | "unknown";
```

## SSE events (`GET /api/p/:id/events`)
Each event has `id` (event-log seq), `event` name and JSON `data`:
`patch` (PatchEntry), `task` (Task), `question` (QuestionT), `note` (Note), `gate` (Gate), `ledger` ({ usd, spentUsd, reservedUsd, model, role }), `digest` ({ text }), `render` ({ kind: "proxy" | "still" | "final", url }), `log` ({ level, text, role? }), `stage` ({ stage }), `pip` ({ type: "thinking" } (transient, id 0) | { type: "item", item: PipItem } | { type: "card", itemId, card: PipCard }).
