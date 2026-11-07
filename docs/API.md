# Studio server API (v1)

The local server (`apps/server`, Hono on 127.0.0.1) serves the studio UI (`apps/web`) and MCP. JSON everywhere; auth is a cookie set by the one-time launch URL plus an `X-PAP-Token` header on every mutating request. Errors are `{ ok: false, error: { code, message, fix?, path? } }` with a 4xx/5xx status.

## Shapes
```ts
type ProjectSummary = { id: string; title: string; dir: string; rev: number; stage: Stage; spentUsd: number; capUsd: number;
  etaSec: number | null; deadline: string | null; needsYou: number; updatedAt: string };
type Stage = "brief" | "script" | "storyboard" | "art" | "animate" | "narrate" | "sound" | "review" | "deliver";
type Task = { id: string; kind: string; role: Role; title: string;            // "Drawing hero, variant 2 of 3, critique 1"
  status: "upcoming" | "queued" | "working" | "waiting_user" | "waiting" | "done"
    | "partial" /* ended on a stand-in (kept as built, lints only, a library asset); crew/retry redoes it */
    | "failed" | "cancelled";
  model?: string; usd: number; estUsd?: number; etaSec?: number; startedAt?: string; endedAt?: string;
  summary?: string; error?: { message: string; fix?: string }; lastImage?: string /* URL */; parent?: string;
  planTask?: string /* the plan task this row is an attempt at */; instance?: string /* "animator:s03" */ };
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
  digest: string /* Producer's latest 2-3 sentence summary */;
  crew: { running: boolean; paused: boolean; stage: Stage; lastActiveAt: string | null;
    queued: number /* plan tasks ready but waiting for a slot or the budget */;
    slots: Record<string, { size: number; used: number }> /* per endpoint, plus "render" */;
    runStartedAt: string | null /* the current or last run's start: older failures belong to an older run */;
    held: string | null /* the run is held for the person, and why (a rejected key, Pip's hold) */ };
  status: { line: string; phase: number;
    problem?: { text: string; action: "retry" | "change_model" | "add_budget" | "fix_key"; taskId?: string;
      provider?: string /* fix_key: the provider to fix in Settings → Providers */;
      kind?: "auth" | "credit" | "unreachable" | "rate" | "budget" | "other" };
    waiting?: "plan" | "budget" /* the crew waits on a card in Pip's thread: a wait, not a problem */ };
  needs: { count: number; words: string | null; waiting: number /* plan waits no gate or question stands for */ } /* "Needs you": questions, gates, the crew's open Pip cards (a plan
    change, the budget) and the plan's other waits, each once; also ProjectSummary.needsYou */;
  plan: PlanView | null /* the production plan; null until a crew first runs (GET never writes one) */;
  instances: Instance[] /* the crew members that come and go (docs/PIP-ORCHESTRATION.md §2), join order */ };
// A crew member, derived from the event log (never stored). `id` is its key: "writer", "animator:s03", "pixel-artist:founder".
type Instance = { id: string; role: Role; label: string /* "Animator · scene 3" */; subject?: { scene?: string; asset?: string };
  model: string | null /* its latest attempt's */;
  state: "planned" | "live" /* a task holds a slot, or it waits on your pick */ | "idle" | "finished";
  ghost: boolean /* the horizon rule: at most 3, nearest first */; running: number /* tasks holding a slot now */;
  spawnedAt: string | null; endedAt: string | null /* set only while finished */;
  lives: { from: string; to: string | null; reason?: string /* the line that opened it: spawn or return */ }[];
  reason: string /* the spawn line: "Pip brought in the Writer for three script angles" */; endReason?: string;
  tasks: string[] /* its plan task ids (row ids for a project from before the plan) */; usd: number /* every attempt */;
  outcome: "done" | "partial" | "stopped" | "failed" | null /* null until finished */;
  lastReport?: { status: "done" | "partial" | "blocked"; did: string; couldnt?: string } };
type InstanceLog = { instance: Instance; entries: (
  | { at: string; source: "task"; taskId: string; kind: ActivityKind; title: string; detail?: unknown; thinking?: string; image?: string }
  | { at: string; source: "channel"; msg: ChannelMsg })[] /* by time */ };
// The production plan (docs/PIP-ORCHESTRATION.md §4.2). `budget.estTotalUsd` and `time.etaSec` come from it once it exists.
type PlanTaskView = { id: string; kind: string; role: Role | "person"; gate?: PlanGate; scene?: string; asset?: string;
  round?: number; instance: string; label: string /* "Animator · scene 3", sentence case */; stage: Stage;
  dependsOn: string[]; tier: "role" | "strong" | "light"; model: string | null /* resolved */;
  estUsd: [number, number]; conditional: boolean;
  status: "pending" | "ready" | "running" | "waiting_person" | "done" | "skipped" | "failed" | "dropped";
  taskIds: string[]; addedIn: number; reason?: string };
type PlanGate = "g0_brief" | "g1_script" | "g2_animatic" | "rights" | "g3_rough" | "g4_final";
type PlanView = { rev: number; at: string; by: "rules" | "pip" | "person" | "code"; reason: string; tasks: PlanTaskView[];
  estimate: { usd: [number, number]; sec: [number, number]; rough: boolean } /* spent + remaining */;
  approvedUsd: number | null; pip: { mode: "on" | "shadow" | "off"; proposals: number; max: 6 };
  pending?: { rev: number; cardId: string; tasks: string[] } };
type PlanRevisionSummary = { rev: number; at: string; by: PlanView["by"]; trigger: string; reason: string;
  ops: { op: "add" | "drop" | "retier" | "expand"; task: string; label: string; reason: string }[];
  deltaUsd: [number, number] };
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
| `POST /api/p/:id/crew/run` | `{ stage? }` | `{ ok }`: continues the plan; `stage` reruns it from that stage (finished work from there on runs again as fresh plan tasks) |
| `POST /api/p/:id/crew/retry` | `{ taskId? }` (a plan task id or a `state.tasks` row id) | `{ ok, started, resumed }`. A held run (PIP-ORCHESTRATION §1.8) goes on (`resumed`). Else a `by: "person"`, `trigger: "retry"` revision: failed plan tasks go back to pending, and `fallback` ones run again as fresh copies with the finished work after them (gates included, never publish); `taskId` limits it to that one task when it is failed or a fallback. With nothing to redo, the current stage reruns. `409 busy` while a run works and isn't held |
| `GET /api/p/:id/plan/revisions` | | `PlanRevisionSummary[]` from `runs/plan.jsonl`, oldest first |
| `GET /api/p/:id/instances/:iid/log` | | `InstanceLog`: the kept log of one crew member (read-only): every attempt row's transcript (thread, tool calls, patches, errors) and its channel messages (briefs, asks, answers, reports from or to its role whose `ref` is its subject, a plan task or a row of it; a singleton also gets its role's messages with no `ref`), merged by time. `404` with a `fix` for an unknown id |
| `POST /api/p/:id/crew/pause` | `{ mode: "after_step" \| "now" }` | `{ ok }` |
| `POST /api/p/:id/crew/resume` | | `{ ok }` |
| `GET /api/p/:id/events` | SSE, `Last-Event-ID` resumes | events below |
| `GET /api/p/:id/files/:name` | Range | an output file (mp4, srt, vtt, wav, png) |
| `GET /api/p/:id/variants/:name` | | a drawn variant's sheet, `runs/<asset>-v<n>.png` (an `asset.draw` task's `lastImage`); `/api/p/:id/runs/:name` is the same, for older logs |
| `POST /api/p/:id/vo` | `audio/wav` or `audio/webm` body, `?take=name` | `{ file }` |
| `POST /api/p/:id/vo/align` | `{ file }` | `{ proposal: { cue: string; start: number; end: number }[] }` then a patch to approve |
| `GET /api/settings` | | `Settings` (keys never included: `hasKey: boolean`) |
| `PUT /api/settings` | partial `Settings` | `Settings` |
| `PUT /api/settings/providers/:id/key` | `{ key }` | `{ hasKey: true }`; a non-empty key lifts every run held on this provider (`Crew.providerFixed`, PIP-ORCHESTRATION §1.8) |
| `POST /api/settings/providers/:id/test` | | `{ ok, models: string[], error? }`; `ok` lifts every run held on this provider |
| `GET /api/models` | | `ModelRow[]` (capability matrix) |
| `GET /api/ledger` | `?project=&limit=` | ledger rows |
| `GET /api/library` | | `library/index.json` |
| `GET /api/library/:id` | | the asset file |
| `GET /api/library/:id/sheet.png` | | its preview sheet |
| `GET /api/pip` | `?project=` | `{ items: PipItem[], name: "Pip", model, mode: "agent" \| "menu", busy, summary: PipSummary \| null }` (shapes in `docs/ASSISTANT.md`; a summary carries `freed`) |
| `POST /api/pip` | `{ project?, text, about?: { instance } }` | `202 { turnId }`; `409` while a turn runs in that conversation; progress as SSE `pip` events. `/undo`, `/budget [usd]`, `/why` answer without a model; `/compact` makes one call. `about` ("Ask Pip about this") puts that instance's record into the turn's context (`docs/ASSISTANT.md`); `400` for a malformed one, `404` for an unknown instance |
| `PUT /api/pip/summary` | `{ project?, text }` | `{ summary }` (the person's correction; used from the next turn) |
| `GET /api/p/:id/channel` | | `ChannelMsg[]`: the crew channel ("Behind the scenes") |
| `POST /api/pip/cards/:cardId` | `{ project?, decision: "confirm" \| "decline", edit? }` | `{ card }` (status `running`/`submitted` at once; the final state comes as a `pip` `card` event); `409` if already decided. A plan card the crew asked for carries `revision?: { rev, ops, fromUsd, toUsd }` and `whoInstances?: { instance, label }[]` (a revision past the 20% line: confirm runs its tasks, decline drops them), or is the overrun's "Raise the cap" card (decline: the crew goes on only with steps that fit) |
| `GET /api/events` | SSE | the workspace stream: `pip` events for the conversation with no project |
| `GET /api/connections` | | the person's MCP servers: `{ name, transport, command?, args, url?, envKeys, headerKeys, enabled, trust, status, tools, toolNames, error?, fix? }[]` (secret values never; `url` has no login, query or fragment, shown as `… (query hidden)`; `error` has every URL cut the same way and the connection's secret values masked) |
| `POST /api/connections` | `{ json }` (pasted `mcpServers` JSON) | `{ added: { name, status, tools: string[], error?, fix? }[] }` (`error` redacted as above) |
| `PATCH /api/connections/:name` | `{ enabled?, trust?: "ask" \| "read" }` | the connection |
| `DELETE /api/connections/:name` | | `{ ok }` (its secrets are deleted too) |
| `POST /api/connections/:name/test` | | `{ name, status, tools, error?, fix? }` |
| `GET /api/docs` | | `{ docs: DocEntry[] }`: the repo's docs meant for reading (the Docs page, below) |
| `GET /api/docs/file` | `?path=<a path from GET /api/docs>` | `DocFile`; `400` (`bad_path`: `..`, absolute, a backslash, not `.md`, outside the repo) or `404` (`not_found`: not in the listing, or a symlink) with a `fix` |
| `GET /api/docs/tools` | | `{ tools: ToolDoc[] }`: every tool in the registry, with the input schema MCP's `tools/list` serves |
| `GET /api/docs/connections` | | `{ connections: ConnDoc[] }` (`[]` with none); an enabled connection is connected to list its tools (8 s each at most), an off one never starts |

```ts
type Settings = { providers: { id: string; kind: "anthropic" | "openai" | "openrouter" | "lmstudio" | "ollama" | "llamacpp" | "custom";
    label: string; baseUrl: string; hasKey: boolean; enabled: boolean }[];
  profile: "best" | "balanced" | "local" | "custom"; roles: Record<Role, { model: string; fallback?: string }>;
  defaults: { capUsd: number; askAtFraction: number; involvement: "every" | "key" | "auto"; concurrency: number;
    pipPlan: "on" | "shadow" | "off" /* Pip's plan revision; default "shadow" */;
    reviewRounds: 1 | 2 /* review rounds per crew run; default 2 */ };
  paths: { roots: string[]; library: string; ffmpeg: string } };
type ModelRow = { id: string /* provider/model */; provider: string; label: string; local: boolean;
  caps: { vision: Cap; structured: Cap; tools: Cap; longOutput: Cap }; ctx: number; maxOut: number;
  price: { inPerMTok: number; outPerMTok: number; source: "table" | "provider" | "manual" } | null;
  speed: { ttftMs: number; tokPerSec: number; samples: number } | null; spend30dUsd: number; fit?: Record<Role, number> };
type Cap = "passed" | "claimed" | "failed" | "unknown";
```

## The Docs page (`/docs`)
`apps/server/src/docs.ts`. Read-only, behind the same cookie and Host/Origin checks as every `/api` route.
- **Which docs:** every `README.md`, the root `AGENTS.md`, `docs/**/*.md` and `skills/*/SKILL.md`. Never walked: `node_modules`, `dist`, `out`, `private`, `data`, `coverage`, `poc`, `vendor`, `.git`, any folder the root `.gitignore` names, any folder with a `pitch.json` (a project) and any symlink. `GET /api/docs/file` serves only a path that listing returns, and checks again that its real path is inside the repo.
- **Approval:** a registry tool has `approval: true` when `effects` is not `read` and it isn't `feature_request`: Pip proposes it as a card the person confirms (`docs/ASSISTANT.md`). A connection's tool has `approval: false` only when it is `readOnly` and the connection's trust is `read`.
- **Secrets:** a `ConnDoc` carries no args, env, headers, `cwd`, nor a URL's path, query or login. Its `error` is a fixed sentence per error code, never the server's own message (which can echo a URL or stderr).

```ts
type DocEntry = { path: string /* repo-relative */; group: string /* folder; "" is the root, "skills" holds every SKILL.md */;
  title: string /* first heading */; summary: string /* front matter `description`, else the first paragraph, ≤ 180 chars */ };
type DocFile = DocEntry & { markdown: string /* front matter removed */; meta: Record<string, string> /* front matter */ };
type ToolField = { name: string /* "a", "a.b", "a[].b" */; type: string; required: boolean; description?: string;
  enum?: unknown[]; default?: unknown };
type ToolDoc = { name; title; description; tier: "basic" | "advanced"; effects: "read" | "write" | "spend" | "destructive";
  roles: "*" | Role[] /* [] = the person and MCP clients only */; project: boolean; approval: boolean;
  inputSchema: JSONSchema /* as MCP serves it, project_id first on project tools */; fields: ToolField[];
  examples: { input: unknown; note?: string }[] };
type ConnDoc = { name; description; transport: "stdio" | "http"; runs: string /* the program's name, or the URL's origin */;
  status: "connected" | "off" | "failed"; trust: "ask" | "read"; error?: string; fix?: string;
  tools: { name; title?; description; readOnly: boolean; destructive: boolean; approval: boolean; inputSchema; fields: ToolField[] }[] };
```

The page's addresses: `/docs`, `/docs/read/<path without .md>`, `/docs/tools/<name>`, `/docs/connections/<server>/<tool>`. The mock (`?mock=1`, `apps/web/src/mock/docs.ts`) reads `apps/web/src/mock/docs-tools.json`; regenerate it with `node scripts/docs-fixture.ts` after a tool changes (a test in `apps/server/test/docs.test.ts` says when).

## SSE events (`GET /api/p/:id/events`)
Each stored event has `id` (event-log seq), `event` name and JSON `data`; a transient one (seq 0) is sent with no `id`, so it never moves the client's `Last-Event-ID`:
`patch` (PatchEntry), `task` (Task), `question` (QuestionT), `note` (Note), `gate` (Gate), `ledger` ({ usd, spentUsd, reservedUsd, model, role }), `digest` ({ text }), `render` ({ kind: "proxy" | "still" | "final", url }), `log` ({ level, text, role? }), `stage` ({ stage }), `pip` ({ type: "thinking" } (transient, id 0) | { type: "item", item: PipItem } | { type: "card", itemId, card: PipCard } | { type: "summary", summary: PipSummary }), `channel` (ChannelMsg), `plan` ({ view: PlanView; revision?: PlanRevisionSummary }: stored when it carries a revision; a status-only change is transient, id 0), `run` ({ id, status: "start" \| "done" \| "failed" \| "stopped" }: stored, a crew run's bounds; at its end the run's still-open plan rows are cancelled with `endedAt`), `plan_status` ({ rev, tasks: { id, status, note?, taskIds? }[] }: stored, just before that transient view: the plan tasks whose status moved, so the instances replay from the log; the UI may ignore it), `instance` ({ instance: Instance; change: "spawn" \| "ghost" \| "live" \| "idle" \| "end" \| "revive" }: transient, derived; a `spawn` or `revive` comes before its task's `working` row, an `end` after its last task event), `milestone` ({ id, at, kind: "gate" \| "answer" \| "stage" \| "export" \| "change" \| "plan", text }; the ones derived from other events are sent live with id 0, and `ProjectState.milestones` derives them all from the log). The `plan` milestones are "Plan ready · N tasks to start" (when G0 passes) and "Plan changed: <reason>" (each revision with ops). The Producer's own milestone is now "Brief read".

## `/new` as a conversation (served since P3)

The server answers these as the mock (`apps/web/src/mock/drafts.ts`) does. The shapes are PIP-ORCHESTRATION §4.2; the UI's needs are PIP-JOURNEY §7.2 (N7–N9, N13–N18, N25). Drafts live in `$PAP_HOME/drafts/<id>/` (`draft.json`, `pip.jsonl`, `refs/`), never in a project root.

| Method + path | Body / query | Returns |
|---|---|---|
| `POST /api/drafts` | `{ from?: projectId }` | `{ draft: Draft, items: PipItem[] }`; the first item is Pip's "What are we making?", or with `from` "Another one like <title>: same style, cast and settings. What's this one about?" (`from` prefills audience, length, narration, involvement, profile, style and budget; never the idea or the files; `404` for an unknown project). Call it on the first send or the first file drop, never on opening `/new` |
| `GET /api/drafts/:id` | | `{ draft, items }` (404 with a `fix` once it is started or removed) |
| `DELETE /api/drafts/:id` | | `{ ok }` (the folder goes) |
| `POST /api/drafts/:id/files` | raw body, `?name=` (an image or a sound file, ≤ 20 MB) | `{ ref: DraftRef }`: rights start `unsure`, the type is guessed from the name; the name is made safe (last path segment, `[A-Za-z0-9._ -]`, ≤ 80 chars); `415` for another kind of file, `413` past 20 MB |
| `GET /api/drafts/:id/files/:name` | | the file (`DraftRef.url` points here) |
| `PATCH /api/drafts/:id/refs/:name` | `{ type?, rights? }` | `DraftRef` (the rights chips; 400 with a `fix` for a bad value) |
| `PATCH /api/drafts/:id` | `{ fields }` | `Draft`: each field checked with the registry (400 with a `fix` and `path`), no model call (N7) |
| `GET /api/drafts/:id/composer` | | `{ title, brief, budgetUsd, profile }` (`budgetUsd`: the draft's, else the brief card's recommendation; `profile`: the draft's, else the settings') |
| `POST /api/projects` | `+ draft?` | `{ id }`; the draft's files move to `private/refs/`, its conversation to `runs/pip.jsonl`, `brief.source` is `composer` (so `producer.plan` stays and G0 waits) |
| `GET /api/workspace/line` | | `{ text, parts: { projectId, kind, text }[] }`, at most 3 clauses, finished → working → failed → waiting, from state (no model call) |
| `GET /api/pip` | `?draft=` | a draft's conversation (`summary: null`) |
| `POST /api/pip` | `{ draft, text }` | `202 { turnId }`; `409` while its turn runs. One reading (`assistant.brief` in agent mode, metered on the `_workspace` guard; the rules parse in menu mode or on a local model), then at most one card. Its events go on `/api/events` as `pip` events with `draft` in `data`. A slash command in a draft gets "Commands work inside a project." |
| `POST /api/pip/cards/:cardId` | `{ draft, decision, values? }` | `{ card }`. A `brief_fields` card's `values` are checked with the field registry (400 with a `fix` and `path` keeps it open); `references` is `[{ name, rights, type? }]`. The `brief` card's confirm is Start and answers `{ card }` with `status: "started"` and `result.projectId` (the project exists before the answer). Decline marks either `superseded` |
| `GET /api/settings/profiles` | | `{ best, balanced, local, custom }`: each `Record<Role, { model, fallback? }>` or null (N22) |
| `POST /api/models/:id/probe` | (the id encoded, or with its slashes as is) | `ModelRow` after a fresh probe (spends a few cents on a paid model), `404` with a `fix` for a model no enabled provider lists (N21) |

- `GET /api/projects` lists drafts too: `{ id: "draft_…", title /* "New video" until the first message */, draft: true, createdAt, updatedAt, status: { line /* Pip's last question */, phase: 0 } }` with the other fields zeroed. Projects also carry `needs` ("one pick", "your OK on the rough cut", "N things").
- `GET /api/settings`: `roles` names every role, defaults included (N20), and `effective: Record<Role, { model, fallback: string | null, source: "saved" | "default", fallbackSource: "saved" | "producer" | "none" }>`.
- An unknown `/api/*` route is a JSON `404` with a `fix`, never the UI's page.
- A `QuestionT` may carry `rights: { asset, private: true }` (the plan's `rights` node, N15): only the person answers it (`403 person_only` otherwise), and it never times out.

**Where the server differs from the mock** (the UI needs no change for any of these):
1. Draft ids are `draft_` + 10 hex characters (the mock: `draft_1`).
2. `DraftRef.url` is `/api/drafts/:id/files/:name` (the mock: a blob URL), and the stored name is made safe.
3. The audience options include `application` ("A selection committee"); the brief's `audience` text is the registry's ("People who might use it" for `users`).
4. The brief card's estimate, ETA, preview and the budget recommendation come from the real rules plan and the ledger (the mock scales fixed numbers). The recommended budget is the p90 plus the reserve, rounded up to $0.50, within $0.50–$50.
5. `picks` is built from the plan's gates and `rights` nodes, so an `unsure` logo or likeness gives no rights pick (it is left out of the plan) and the warning says so.
6. The composer's `profile` defaults to the settings' profile, not "balanced".
7. A second question card comes only for a likeness, voice or logo the first card left `unsure` (or a file dropped after it), and at most 2 question cards come before the brief card. A field the brief card showed with its default is never asked later.
8. Pip's "Make another like this" card is the `draft_create` tool's (title "Make another video like this", confirm "Open it"); its result is `{ text, draftId }` (N25).
9. The budget field takes $0.50–$50 (the registry table said $1–$50; the P4 e2e brief says "under $0.90").
