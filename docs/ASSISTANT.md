# Pip, the studio's assistant

Pip handles everything the crew's pipeline didn't plan for, and is the one place a person asks for things in their own words. Examples: "give me the video and the SRT", "subtitles in Persian too", "make the hero bigger in scene 2", "make another one like this for my bakery".

Pip sits above the orchestrator but never competes with it:

- Pip **reads** anything, and **does** read-only things directly.
- Pip **proposes** anything that writes, spends or deletes, as a card with what will happen, who does it, the time and cost, and any side effects. The person confirms the card, and only then does the server run it, through the same tool registry, as the user (`via: "pip"`).
- **Pip never patches a project while a crew is working on it.** Production changes go to the crew as a change request, which the orchestrator routes like a note. Pip is the front door; the crew stays the factory.
- When Pip can't do something, Pip says so plainly, names the nearest thing it can do, and logs a feature request.

## Name and voice

- **Pip** (pixel + pitch). Short, friendly, gender-neutral; in the UI, "Pip".
- **Voice:** the crew's voice (serif), short sentences, plain words, no jargon, no "I'm just an AI". At most 3 sentences before a card.
- **The status sentence on a project page is Pip talking** ("Your video is ready."). Pip narrates; the crew works.

## Two modes, picked from the model's probed caps

| Mode | When | How |
|---|---|---|
| **agent** | the model passed `tools` and is not local-small (default: Sonnet 5.5) | a tool loop of at most 8 steps over the allowed tools, then a final `reply` with text and cards |
| **menu** | weak or local models, or tools failed | one structured call: `{ intent, params, reply }` with `intent` from a closed set (below), then deterministic code builds the cards |

Menu intents: `files`, `translate_subtitles`, `change`, `new_from_this`, `export`, `status`, `explain`, `other`.

The settings role is `assistant`. Its default model is `anthropic/claude-sonnet-5-5` with the Producer's model as the fallback. Under the Local profile it is the local text model, in menu mode.

## Tools Pip can use

- **Read, run directly:** `project_list`, `project_get`, `timeline_get`, `crew_status`, `note_list`, `question_list`, `library_search`, `recipe_list`, `render_still`, and the new `files_list`.
- **Propose only (a card the person confirms):**
  - `export_video`
  - `subtitles_translate` (new)
  - `crew_request_change` (new)
  - `project_fork` (new)
  - `crew_run`, `crew_pause`
  - `note_add`
  - `question_answer` and `gate_decide`: only when the person asked in words, and the card states the decision
- **Always available:** `feature_request` (new; it runs directly, since it only appends a line).

### New tools (in `packages/tools`, so MCP gets them too)

- **`files_list`** returns `{files:[{name, kind, sizeBytes, url}]}` for a project's `out/`. The `url` is `/api/p/:id/files/:name`.
- **`subtitles_translate({lang, label?})`** has role writer, effects spend.
  - One structured call returns `{cues:[{id, text}]}`. Cue ids and timings come from the project, never from the model.
  - Each cue's length is checked against its original (≤ 1.6× the characters, or one repair).
  - It writes `out/<id>.<lang>.srt` and `.vtt`, and returns the files.
  - It reports `burnInPossible: false` when the pixel font lacks the script's glyphs (check every character with the font's glyph table). The card shows that as a warning: "As a file only: the pixel font can't draw Persian, so the picture keeps English captions."
- **`crew_request_change({text, scene?, cue?, at?})`** turns the request into a note routed to its owner role (the existing note routing).
  - If the crew is idle, it reopens the owning stage and runs the crew from there. Finished work outside the change is kept.
  - If the crew is working, the note is queued and picked up at the next review.
  - It returns `{noteId, owner, stage, queued}`.
- **`project_fork({title?, brief})`** makes a new project.
  - It gets this project's settings, cast and style, and a new brief. The brief is Pip's draft, which the person sees and can edit on the card.
  - The script, storyboard and renders are not copied.
  - The new project waits at G0 (brief) for the person. It returns `{projectId}`.
- **`feature_request({text, context})`** appends to `~/.pixelartpitch/feature-requests.jsonl`.

## Facts Pip must know (in its system prompt, generated from code where possible)

- **Canvas:** 320×180 at 16:9 only. Vertical (9:16) is not supported yet.
- **The pixel font is basic Latin only:** captions burned into the picture can't be Persian, Arabic, CJK and so on, but subtitle files can.
- **No AI voice yet:** narration comes from your recording (Record page).
- The recipe menu (`recipeCatalog()` names), the stage names, and what each crew role does (one line each).
- **Budget:** the project's cap, what's been spent, and how much is left. A plan card that would pass the cap says so and offers "Raise the cap to $X".

## Conversation storage

- **Per project:** `<project>/runs/pip.jsonl`, one JSON line per turn item.
- **Workspace-level** (asked from the Projects page, no project): `~/.pixelartpitch/pip.jsonl`. From there Pip can list projects, fork one, or start a new one: it drafts a brief and opens the composer prefilled with it.
- The model sees the last 20 items plus a fresh project summary, never the whole log.

## Item and card shapes (the contract between server and UI)

```ts
type PipItem =
  | { id: string; at: string; kind: "user"; text: string }
  | { id: string; at: string; kind: "pip"; text: string; cards: PipCard[]; model?: string; usd?: number }
  | { id: string; at: string; kind: "thinking" };                // transient, while Pip works (never stored)

type PipCard =
  | { id: string; type: "files"; files: { name: string; kind: string; sizeBytes: number; url: string }[] }
  | {
      id: string; type: "plan";
      title: string;                       // "Translate subtitles to Persian"
      detail: string;                      // one line: what happens
      who: RoleT[];                        // crew faces shown on the card; [] when Pip does it alone
      usd: [number, number] | null;        // estimate range, null when unknown
      sec: [number, number] | null;
      effects: string[];                   // "Reopens Pictures. Scenes 1, 3 and 4 stay as they are."
      warning?: string;                    // a limit the person should know before confirming
      confirmLabel: string;                // verb first: "Translate", "Ask the crew", "Make it"
      editable?: { field: string; label: string; value: string };   // e.g. the drafted brief for project_fork
      status: "proposed" | "running" | "done" | "declined" | "failed";
      result?: { text: string; files?: PipFile[]; projectId?: string; error?: string };
      // a plan revision past the 20% line (PIP-ORCHESTRATION §4.4): its ops and the new p50 total
      revision?: { rev: number; ops: { op: string; task: string; label: string; reason: string }[]; fromUsd: number; toUsd: number };
      whoInstances?: { instance: string; label: string }[];   // "Pixel artist · keeper": who the revision brings in
      // server-only: { tool, input, projectId, crew? }
    }
  | { id: string; type: "cant"; text: string; nearest?: string };   // "Vertical video isn't possible yet."
```

## API

- **`GET /api/pip?project=<id>`** returns `{ items: PipItem[], name: "Pip", model, mode: "agent"|"menu" }`.
- **`POST /api/pip`** with `{ project?, text }` returns `202 { turnId }`.
  - Progress comes over the existing SSE stream as events named `pip`, with `{type: "thinking"|"item"|"card", ...}`. Without a project it uses `/api/events`, a new workspace stream; add one if none exists.
  - One turn at a time per conversation. A second POST while a turn runs returns 409.
- **`POST /api/pip/cards/:cardId`** with `{ project?, decision: "confirm"|"decline", edit?: string }`.
  - It runs the card's action as `author = user, via pip`, updates the card's `status`/`result`, and emits a `card` event.
  - Writes need `X-PAP-Token`, as with every other write.
- **Spend:** Pip's own model calls are metered on the project's guard (`taskKind: "assistant.turn"`, role `assistant`). Workspace-level turns go on a `_workspace` guard, capped at $1 per day by default.

## UI

- **Simple view:**
  - The status sentence becomes Pip's line, with Pip's face beside it, above the crew faces.
  - Under the crew faces sits the ask bar: a pill with "Ask Pip…", `/` to focus, and 2 to 4 suggestion chips from the project's state.
  - Asking expands a sheet in place, upward from the bar, with the video still visible above. Esc collapses it.
  - Cards render inside Pip's replies. When the crew takes over after a handoff, the sheet collapses, the step bar reopens, and the named faces start working.
- **Studio:** a "Pip" tab first in the right column, showing the same conversation.
- **Every page:** the header's Crew popover gets Pip at the top, with an ask field. On the Projects page Pip has no project and can fork or draft a new one.
- **Pip's face:**
  - It has its own look: a little larger than the crew discs, neutral ink with an accent ring.
  - Moods use the same two-glyph language as the crew: idle `◠ ◠`, listening, thinking (animated), happy `^ ^`, sorry `; ;`.
  - It follows `prefers-reduced-motion`.
- **A Download button on the finished card,** for the plain case, so nobody has to ask Pip for it.
- **Mock mode:** `?mock=1` scripts Pip's replies for the main intents, so the UI works without a server.

## Custom MCP servers (connections)

People can extend the studio with their own MCP servers, for example a stock-music search, their company's brand kit, or a translation service. The UI calls them **connections**.

**Adding one**
- **In Settings:** a "Connections" tab lists each server with its status (connected / failed + why / off), a tool count, a "Trust" choice, an on/off toggle and Remove. "Add connection" opens the same form Pip shows.
- **From Pip:** "add an MCP server" → Pip replies with a `form` card (a small generative UI): one big field for pasting the server JSON, in the common `mcpServers` shape used by Claude Desktop and Claude Code. Several servers can be pasted at once.
  - The card parses the JSON as you paste it, then shows each server as a row: name, transport (stdio command or HTTP URL), and the env/header keys with their values hidden.
  - Submit → the server validates it, saves it, connects, lists the tools, and Pip replies "Connected: 6 tools. I can use them now." with the tool names. On failure Pip shows the error and a fix (command not found, 401, timeout).

**Safety**
- **A stdio server runs a command on this computer.** The form always shows the exact command and arguments, and the submit button says what it does: "Run `npx foo-mcp` and connect". Nothing is spawned before you confirm.
- **Secrets** (env values, Authorization headers) go to the existing `SecretStore` (env → Keychain → 0600 file). Only references are stored in `~/.pixelartpitch/settings.json`. They are never echoed back to the UI or written to logs or transcripts.
- **Trust per connection:**
  - **Ask every time** (the default): every call to the server is a plan card.
  - **Allow read-only tools:** tools marked with the MCP annotation `readOnlyHint: true` run directly. Everything else is still a card.
  - A server's annotations are its own claim, so the card says "This connection says the tool only reads".
- **Children are limited:** spawned servers get an env made of PATH, HOME and their declared env, nothing else. They start lazily, and stop after 10 minutes idle and when the studio stops.

**How tools reach agents (context stays light)**
- External tools are **not** in any crew role's tool list by default, and not in Pip's base prompt either.
- Pip sees a one-line catalogue per connection (name + a short description + a tool count). It loads a connection's full tool schemas only when a request needs it. A `connection_tools({server})` read tool returns them, and they are added to that turn's tool list only.
- **Lending tools to the crew:** a plan card that hands work to the crew may name external tools (`lend: ["server.tool", …]`, shown on the card as "Lends: Freesound search").
  - Only that task's role gets them, in that task's tool list, under that connection's trust rule.
  - The grant ends when the task ends. Nothing persists on a role.
- **External tool results are untrusted data.** They are wrapped as data in the prompt, and instructions inside them are never followed. Text and images are capped, and long results are truncated with a note.
- **Names and MCP:** external tools appear to models as `ext_<server>__<tool>`. They're never re-exported through PAP's own MCP server.

**Implementation**
- `packages/mcp-client`: a plain MCP client, with no SDK and no new dependencies.
  - Supported: stdio (newline-delimited JSON-RPC) and Streamable HTTP (POST + SSE), the `initialize` handshake, and `tools/list` (with pagination), `tools/call` and `notifications/tools/list_changed`.
  - Timeouts are 15 s to connect and 60 s per call.
- The server owns a `Connections` manager.
- **API:**
  - `GET /api/connections`
  - `POST /api/connections` `{json}` → `{added:[{name, status, tools, error?}]}`
  - `PATCH /api/connections/:name` `{enabled?, trust?}`
  - `DELETE /api/connections/:name`
  - `POST /api/connections/:name/test`

**Form card shape** (added to `PipCard`):
```ts
| { id: string; type: "form"; form: "mcp_add"; title: string; detail: string;
    status: "open" | "submitted" | "done" | "failed";
    result?: { added: { name: string; status: "connected" | "failed"; tools: string[]; error?: string; fix?: string }[] } }
```
It is submitted with `POST /api/pip/cards/:cardId` `{decision: "confirm", edit: "<pasted json>"}`. The server parses it, and the UI's preview is only a convenience.

## Slash commands

There are four. All but `/compact` run without a model call (instant, free, the same on any model). Anything else that starts with `/` goes to Pip as plain text.

| Command | Does | Reply |
|---|---|---|
| `/undo` | proposes undoing the last change (patch, export, translation or settings change Pip made) | a plan card naming exactly what goes back, with author and reason; confirm runs `project_undo` (or the matching inverse) |
| `/budget <usd>` | proposes a new cap; with no number, shows spent / reserved / cap and the estimate | a plan card "Raise the cap to $10" with what it allows (ETA, roughly how many more steps); confirming sets `budget.cap` |
| `/why` | explains Pip's last answer | a text item: which tools ran (name → ok/error), model, mode (agent/menu), tokens, cost, prompt version, and which cards it made and why. It is built from the stored turn trace, never by asking the model |
| `/compact` | folds everything before the last 6 items into Pip's summary; this is the one command that makes a model call (one call on Pip's own model, so the summary is as good as Pip's judgement) | a divider in the thread, "Earlier conversation, summarized", that expands to show the summary. The full thread stays on disk and in the UI, and only what Pip's model sees shrinks |

- **API:** `POST /api/pip` with `{text: "/undo"}` is parsed on the server. Every Pip turn stores a trace `{tools:[{name, ok, ms}], model, mode, usage, usd, promptVersion}` on its item, for `/why`.
- **UI:** typing `/` as the first character opens a small menu above the field. It lists the four commands, each with a one-line hint (`/budget 10`: "Change the budget cap"), filters as you type, and works with arrow keys, Enter and Esc.
  - The menu is a listbox wired to the field (`aria-activedescendant`).
  - With an unknown command the menu shows "Not a command — Pip will read it as a message".
- The global `/` shortcut still just focuses the field. Typing `/` inside the field opens the menu.

**Pip's summary (the memory a long conversation needs)**
- It lives in `runs/pip-summary.json`, as `{text, upTo: itemId, at}`: at most about 250 words of standing decisions, preferences, open requests and anything promised, written as plain lines.
- Pip's model always sees it, plus the items after `upTo` (still capped at the last 20).
- **Auto-compact:** whenever items would fall out of that window, they're folded in first, so nothing drops silently. `/compact` just does it now.
- The person can read the summary under the divider and correct it in place: "Edit" saves the new text, and Pip uses it from the next turn.
- The summary is per project. The workspace conversation has its own.

## Pip as the orchestrator (the crew channel)

Pip directs the crew. The rules plan is Pip's rails: code writes today's stage machine out as a production plan (`runs/plan.json`, [`PIP-ORCHESTRATION.md`](PIP-ORCHESTRATION.md)), and the executor runs its tasks as their dependencies finish, so routine work costs no extra model calls. Pip steps in whenever something needs judgment.

**What Pip's decisions do to the plan**
- `crew_redo` adds `scene.tune(s, round + 1)` on the same instance (the same "Animator · scene N" comes back). Whatever waited on the scene's last tune waits on the redo too.
- `crew_reboard` adds a scoped `director.storyboard` and `art.cast` over those scenes, then a tune for each.
- After a review, a redo is followed by a review round that checks the fixes before the rough cut. With `defaults.reviewRounds: 1` there is no second round.
- Each of these is a plan revision (`by: "pip"`, `trigger: "conductor"`), shown as a "Plan changed: …" marker. The fixed rules write the same revision with `by: "code"`.
- The end-of-stage check ("on track?") runs when the plan's stage view moves past a stage: the stage of the earliest unfinished task.
- `crew_replan` takes Pip's plan ops (`PlanDiffOut`: add a drawing, a logo import or a scene redo; drop or retier a pending task by its id). The validator checks them like any revision; a refused one is posted as "Kept the default plan: <first error>". The conductor's prompt lists the live task ids only while the run has proposals left.

**Pip's plan revision** (`assistant.plan`, prompt `assistant/plan.md`, [`PIP-ORCHESTRATION.md`](PIP-ORCHESTRATION.md) §1.4)
- Once per run, right after G0 passes (or right after Start on a `/new` project), Pip reads the rules plan and may propose a small diff: at most 8 ops, each with a reason of at most 90 characters. `{ops: [], summary: ""}` is a good answer.
- Code expands an added asset into its chain (spec, two drawings, the judge, and the person's OK when it comes from a reference) and adds the dependencies. Gates are never Pip's.
- One call on Pip's own model (never escalated to a fallback), metered as `assistant.plan`; one repair turn with the validator's errors; then the rules plan stands and the channel says "Kept the default plan: <first error>".
- `defaults.pipPlan`: `on` applies it (a `by: "pip"` revision, "Plan changed: <summary>"); `shadow` (the default) runs the call and posts "Shadow plan (not applied): …" on the channel; `off` makes no call. Menu mode and local models never call.
- At most 6 proposals per run, failures included (`crew_replan` counts too). The 7th trigger has no `crew_replan` tool.

**Cards the crew asks for**
- **A revision past the 20% line:** when a revision's p50 total goes past 1.2 × what the person last approved (the G0 verdict, Start, or the last confirmed card), its added tasks wait and Pip posts a plan card "Plan change: $X → about $Y" with `revision` (rev, ops, fromUsd, toUsd) and `whoInstances` ("Pixel artist · keeper"). "Go ahead" runs them; declining drops them in a `decline` revision. Everything else keeps running. A person's change card skips the rule: it is consent in itself.
- **The overrun:** when spend crosses `askAtFraction` of the cap, or the next task's p90 doesn't fit, the crew starts nothing new and Pip posts "Raise the cap to $X" (X = spent + the plan's remaining p90, rounded up to $0.50). Confirm sets the cap and the crew goes on; keeping it lets the crew go on only with steps that fit, then it waits with the "add budget" problem.

**Messages**
- They live in one channel per project, `runs/channel.jsonl`, shown to people as "Behind the scenes".
- Every message is `{id, at, from, to, kind, text, ref?, replyTo?}`.
  - `from`/`to`: `pip` or a role.
  - `ref`: a scene, cue, note or task.
- **Pip → member: `brief`.** A direction attached to that member's next task, e.g. "Use cast-founder and cast-developer in s01; the founder walks in, the developer pitches with a toast". It's part of that task card's inputs, as high priority as the person's notes.
- **Member → Pip: `report`.** Every task ends with one, part of its output schema:
  `{status: "done"|"partial"|"blocked", did: string, couldnt?: string, needs?: string}`.
  - "partial" or "blocked" must say why, e.g. "the recipe menu has no dialogue; used a toast".
- **Member → Pip: `ask`.** Members never ask the person directly any more: `ask_user` becomes `ask_pip`.
  - Pip answers from the brief, the person's standing decisions, or the project. That is cheap and usually enough.
  - Pip escalates to the person only for things only they know (names, claims, rights, taste forks, budget), using the existing question cards.
- **Pip → member: `answer`,** a reply to an `ask`.

**When Pip thinks.** These are the only triggers, so cost stays bounded:
1. a member `ask`
2. a `partial` or `blocked` report
3. a Reviewer blocker on a scene a person asked to change
4. a request from the person
5. the end of a stage, as one short check against the plan: "on track?"

Routine "done" reports are not triggers.

**What Pip can do on a trigger.** These are orchestrator calls, exposed as Pip tools, still bounded by the budget guard. A person-visible plan card is required only when it spends beyond the current plan, or changes what the person approved.
- `crew_brief(role, text, ref)`
- `crew_answer(askId, text)`
- `crew_redo(scope: scene ids | stage, why)`
- `crew_reboard(scenes, direction)`: the Director re-plans only those scenes.
- `crew_next(stage)`
- `crew_hold(why)`: stop and tell the person.
- `crew_escalate(question)`

**Hard limits**
- Each scene gets at most 2 redo rounds per request. After that, Pip stops and tells the person what's still wrong.
- Pip can't approve the gates that are always the person's call (brief, script, likeness and brand assets, final). Gates are inserted by code: no plan revision may add, drop or move one.
- The likeness or logo OK (`rights` in the plan) is a question from Pip ("Use it" · "Redraw", or "Leave it out" for a logo). It never passes by itself, at any involvement.
- At most 40 plan revisions per crew run; past that the crew holds and Pip tells the person.
- Every Pip decision is a channel message with its reason, so the person can see why.

**On weak or local models**
- Pip's triggers fall back to fixed rules: answer from defaults, redo once, then hold.
- Members still write reports, so a person reading "Behind the scenes" sees the same story.

**In the UI**
- Thought bubbles show messages as they arrive. For example, Pip's bubble says "Asked the Animator to add the founder", and the Animator's says "Can't do dialogue; using a toast".
- The drawer's Pip pane gets a "Behind the scenes" section with the channel, collapsed by default. A crew member's pane shows its own messages with Pip.
- Pip's line under the crew summarises in plain words what's happening.

## Rules the code must enforce

1. **"Propose, don't act" is enforced in code, not in the prompt.**
   - Pip's loop runs a tool directly only when `ToolDef.effects === "read"`, or when the tool is `feature_request`. Any other call becomes a plan card, whatever the model asks for.
   - Direct reads run as `author {kind: "user", via: "pip"}`, so registry role checks don't block them. The effects allowlist above is therefore the only gate, and it must stay strict.
   - A card's `{tool, input, projectId}` lives on the server only. On confirm, the server never takes them from the client, except the one `editable` field.
2. **The gateway gets a metered, lane-scheduled `chat()` that takes tools.**
   - Each step replays `res.assistant` verbatim, opaque thinking blocks included.
   - Never force `tool_choice`: Sonnet 5.5 rejects it. Finish with `auto` plus an instruction, or with a closing `json()` call for `{text, cards}`.
   - Image tool results (`render_still`) go only to providers that accept them (Anthropic). They are left out in menu mode.
3. **`crew_request_change` must actually redo the work.**
   - It marks the target scene stale (`sceneStatus` back to a non-ready state, so the resume skip doesn't skip it).
   - It reopens `g3_rough`/`g4_final`, marks the old export as superseded, and sets the stage back to the owner's stage.
   - The note's text must reach the owner's prompt, e.g. the Animator's task card.
   - Prove it on a real project ("make the hero bigger in scene 2"): the scene's layers change, and the new export differs.
4. **`subtitles_translate` writes its files without the `plainText` normaliser.** That normaliser exists for the pixel font, and a translated file never passes through the font.
5. **`assistant` joins the `Role` enum everywhere roles are listed:**
   - `ROLES`, `PROFILES`/`rolesForProfile`, priors/estimator, the Settings › Roles tab, and the `fit` map in `wire.ts`
   - Pip's tools are registered after the crew tools in `wireCrew`.

## Tests and evals

- **Unit tests:**
  - card confirm/decline and the 409 on a busy conversation
  - "never patches while the crew works": `crew_request_change` is queued, not applied
  - translate keeps the cue ids and timings, and flags `burnInPossible`
  - a fork doesn't copy renders
- **Eval items** (`packages/crew/evals/assistant.jsonl`, about 12): request → expected intent or tool, plus the facts that must be stated (Persian burn-in, vertical not supported, and so on).
