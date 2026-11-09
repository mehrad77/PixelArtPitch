# Changelog

Each release's section is also its GitHub release notes: the release job in `.github/workflows/ci.yml` publishes the section whose heading matches the tag.

## v0.5.2 (unreleased)

### Crew
- **Every change has a tier.** `classifyChange` sorts a note into `edit` (free: Pip does it), `tune`, `code_patch` or `replan`, with the scenes it touches. "Make it in daytime" is a free edit when every code scene draws its sky from `TIME`; "move the logo up a bit" is an edit of the scene's `LOGO_Y`; "take the extra gamer out of every scene" patches only the scenes that have the gamer; only a story change re-plans.
- **Pip makes small edits itself.** The time of day, a caption, a recipe scene's settings, a code scene's named constants, the sound plan or the pace: Pip makes the edit in the same turn, shows a still before and after, and adds an Undo card. A rule-decided edit on a card says "I can do this now: free". Never while the crew works.
- **A code scene's change card tells the truth.** The Scene Coder reads your note, so the card no longer warns that it can't; the title names the scene by number instead of repeating the "At 0:54 (…)" anchor; a code scene's own pace is its hold constant, or a patch, never a full rewrite.
- **Two edits with no model call.** `look_set_time` sets the time of day; `code_set_constants` changes a code scene's named constants after a trial render, and a value that fails it changes nothing. `project_get` lists each code scene's constants.

### Studio
- **One timeline for Pip's thread and the milestones.** The simple view's separate "Milestones" column is gone: milestones sit among the turns, newest first, on one spine with a dot per entry (a turn hangs its framed block off its dot, a milestone is one quiet line, the newest dot is lit). The three newest milestones always show; a longer run between two turns keeps its first and folds the rest into "N more milestones", which expands in place. The timeline sits on the page, with no panel behind it.
- **A plan change's reason shows once, in whole sentences; Pip's timeline has no nested boxes.** The card's detail carries the reason whole (cut, if at all, at a sentence); Pip's line is "The plan grew past what you approved." and each effect names only who joins.

## v0.5.1 (unreleased)

### Crew
- **The players stay on screen in code scenes too.** The Scene Coder's prompt keeps the listed players on the ground line, idling and reacting, even when the beat doesn't name them.
- **Code scenes are priced from what they cost.** A `scene.code` task counts one write plus one repair or critique at p50 and three at p90 (it was five, which put a code scene's p90 at $2.64). Past five ledger rows the ledger prices each call.
- **The brief card follows your files.** Adding a file, or changing a file's type or rights, rebuilds the open brief card in place, so its files, price and warning are current.
- **The players stay on stage.** The Director lists the brief's players in every scene after the first and says where they stand; players join by walking in, not by dropping. A board that leaves one out gets one repair, and a code scene that still does gets them added to its assets. P7's teammates vanished after the first scene.
- **A list becomes counted boxes.** The Writer counts a list from the brief out loud ("Divan gives us three things:", then one cue per item), and the Director boards it as one code scene with that many numbered slots filling one per cue, not a walk-in. The board check asks once when a counted cue gets no slots.
- **A change that changes nothing says so.** When the Director's re-plan comes back with the scenes as they were, nothing is applied, the task is a fallback a retry redoes, your note stays open, and Pip says "Nothing was changed" instead of "re-planned". P7's "make the sky sunny" ended done at $0 with no patch.
- **A code redo reads your note.** The Scene Coder gets your change ahead of the Director's beat, and the change wins where they disagree; its critique checks the change too. A re-plan must rewrite a code scene's beat for the change.
- **The Reviewer checks the change it was asked for.** After your change, the Reviewer sees your note and must say whether the cut now does it. If it doesn't, the cut is never "ready to ship": each changed scene gets a blocker and is redone.
- **The time of day, from the idea to a change.** Pip reads it from the idea ("sunny", "in the day", "at sunset"), the brief card shows "Time of day", and Start sets the canvas. "Make it day" or "sunset instead" later is a `look.time` task with no model call: it sets the canvas time and the palette follows, recipe scenes follow, and only the code scenes are re-coded, with your note. If a cue still says "Night falls", Pip says so in one line.

### Engine
- **A walking hero runs instead of waving.** `walk_in`, `item_collect`, `flag_raise` and `end_card_loop` key their wave after the walk, and a state before its first key took that key's value, so the hero slid in on the wave frame. A forced state now applies from its first key on, and before it the walk's run cycle shows. The QuestDay golden is regenerated for it (only the hero's pixels change).
- **Characters face the way their art faces.** Character and creature assets have a `facing` field (`"right"` for drawn heroes, `"left"` for the library NPCs; `gamer` is `"right"`). The engine mirrors an actor by it to face its walk, so drawn heroes no longer walk backwards. The recipes' `faces` and the actor's `artFaces` lose their `"left"` default and only override it. An asset without the field takes "facing left/right" from its description, else left. Code scenes get `faceTo(id, dir)`, and the Scene Coder's asset lines say which way each character faces and what it is.
- **Walk, flag and slots for code scenes.** `pap:engine` gains a kit (`packages/engine/src/kit.ts`): `walk(id, { x0, x1, y, t0, t1, t, fps })` steps run0-run3 one step per 4 px so the feet never slide, faces its travel and breathes before and after; `flag(logo, { x, y, pole, t, up })` flies the logo's `big` frame on a green cloth with a light ring and a rippling tail; `slots(n, { x, y, w, h, filled, t })` draws numbered panels that fill one per cue with a flash. A trial render records the sprites a bundle draws, and a character with a run cycle that moves on only idle or wave frames is a `walk-glide` warning. The Scene Coder's prompt teaches all three and the end card's final hold (logos, PRESS START and the URL together), with three example bundles written fresh: a walk-in, a counted list and a finale.
- **SVG logos and flat backgrounds.** A dropped `.svg` is kept as the source and refused with a fix only when it can't be drawn; the logo import draws it at 512 px with transparency (`@resvg/resvg-js`, prebuilt). Before quantizing, a near-uniform border colour (ΔE < 8 over 90% of the edge) is flood-filled away, so a logo on a white square comes out on a clear surround; a shape that reaches the edge is left alone. The import makes two frames, `icon` 16×16 and `big` 32×32, both from the full image, and the standard allows an icon's `big` frame at twice its size.
- **A dead render sandbox no longer takes the studio down.** The renderer rejects pending calls when its child dies, never throws from a send on a closed channel, and starts a fresh child on the next call.
- **Day and dusk.** `canvas.time` (`"night" | "dusk" | "day"`, absent means night, so old projects render byte for byte as before) picks the palette: `pap-day@1` and `pap-dusk@1` keep every `pap-night` letter and hex and add seven of their own (sky ramp, cloud, sun), and `paletteFor()` makes a built-in palette follow the time. `backdrop_night` and `backdrop_rooftop` follow it, or their own `sky` param: day is a blue ramp, a sun, slow clouds, unlit windows, no stars and no lamp glow; dusk an amber ramp, a low sun, the first stars and a few lit windows. Code scenes get `TIME`, `skyGradient()`, `sun()`, `clouds(t)` and `stars(t)`, the stub and the examples draw the sky for `TIME`, and the Scene Coder is told never to hard-code a night. The library passes the sprite check on both new skies.

## v0.5.0 (unreleased)

### Code scenes
- **The Director can board a code scene.** When a beat needs its own picture (a diagram, a map, a build, a transformation, a counter) or the device needs its own language (a game's title screen, HUD or overworld), the scene is `kind: "code"` with a beat, second by second, and the assets it draws. The end card can be one (`endCard: true`). Recipes still tell the beats they fit; the "fewer than 1 in 10" stance is gone.
- **A stub until it's coded.** The board writes each code scene a stub bundle (the night, its title, its assets), so the animatic and the stills work at once.
- **The Scene Coder writes it.** A new plan task, `scene.code`, takes the scene's tune's place: it writes the bundle from the beat, loads it in a trial sandbox and repairs it (at most twice) on a load or draw error, text off the frame or in the caption zone, a placeholder box, a slow draw or bad sound events, then critiques it on a 6-frame strip for `reviewRounds` rounds. A round that breaks it is dropped. If nothing loads, the stub stays with a note and the run goes on.
- **Its prompt can't drift from the engine.** The API sheet is generated from what a bundle really imports, the example bundle is written fresh for PAP, and every beat is timed from the script (`S("c05")`, `E("c05")`), never in raw seconds.
- **Changes reach the coder.** A note on a code scene goes to the Scene Coder and redoes only that scene's code; a story change still re-boards it.
- **Everything knows code scenes:** the estimate before the board counts about a third of the scenes as code scenes, the parts call a stub a sketch, Pip names a code scene by its beat, and the music settles at a code end card.

### Studio art
- Projects can use the studio's private art: another project's likeness or logo is copied in with its flags when a scene uses it, and its rights are still asked.

### Library
- Two new assets from the code-scene smoke run: `gamer`, a 16×24 character with a ponytail, a hoodie and headphones (8 frames), and `vr-headset`, a 16×16 icon.

## v0.4.0 (unreleased)

### Parts and versions
- **Parts:** a project says what it has, as five parts (Idea, Story, Pictures, Sound, Video), each missing, partial, ready or stale. They're worked out from the document, not from where the crew stopped, so a handmade project with a full script, scenes and sound reads as such (`partsOf` in `@pap/tools`).
- **The five steps are gone.** The project page shows its five parts and one version line ("v2 · exported 3 Nov · up to date", "v2 is older than your changes · Export v3", "Making v3 · v2 still plays", "No video yet · Export"), with a free Export (a local render, no model calls). Cards show five part marks, and "Finished" is now **Has a video**. A rerun stays in Working with "v2 plays". A video exported before versions counts as v1.
- **The crew starts from what the project has.** A project no crew has run starts where its content ends, with the gates of the parts it already has passed by content. A change starts where its note belongs, not where the crew last stopped, so an animation note on a handmade project no longer reruns everything from the brief. The run ends on "Exported v<N>".
- **Versions:** every export is a numbered version (v1, v2, …) with the document rev it was made from. The video is copied to `out/versions/v<N>.mp4` and listed in `history/versions.jsonl`, which stays with the project. `GET /api/p/:id` sends `parts` and `versions`, `GET /api/p/:id/versions/:v.mp4` plays an older one, and the export's task row records its `v`.

## v0.3.0 (unreleased)

Fixes for what the P5 run showed: Pip and the crew now share one picture of the run, the same words reach the same crew member, a note closes once it's done, and the crew knows what the engine can draw.

### Pip and the crew in step
- **A hold always asks.** When the crew stops for you, there's a question with real choices (Redo with the Director, Accept the look, Tell Pip what to change; or Fix the key, Try again), and it counts in Needs you. Answering it starts the crew again.
- **A change answers a held crew.** Asking for a change while the crew waits on you starts it at once, instead of "picked up at the next review".
- **Pip says what is really happening:** started now, queued behind a named step, or waiting for your answer to a named question.
- **Asking you is Pip's last resort.** A refused plan change is corrected once before Pip asks you, and the recommended answer is the cheapest one that fits the budget: library art before new drawings.

### Changes and notes
- **One door for changes.** Pip, a gate's "Change something" and a hold's "Tell Pip" send the same words to the same crew member: cast, staging, backdrops and cards to the Director, timing and motion to the Animator. Ticked items keep their scene.
- **The estimate matches the route.** `POST /api/p/:id/changes/preview` says who a change goes to, the scenes it redoes, what it costs and how long it takes, before anything runs.
- **A note closes when the work that applies it is done**, so an approved rough cut exports once, with no extra cut after it.
- **"Let the crew run"** no longer stops at the rough cut over leftover problems: they're logged and the video exports.

### The crew knows its tools
- **Sit, fly, glow and a sign from the recipe menu:** `walk_in` `then: "sit"` and `prop` (a glowing lantern beside the hero), `spawn_join` `motion: "fly"` and `follow`, lanterns and candles with `glow: true` in the backdrops, and `nameTag: "sign"`. The Director's menu lists every on-screen param, and its cards no longer say "no recipe does that".
- **`spawn_join` needs `who`**, and its banner is off unless you ask for one. A storyboard without `who` is sent back with the cast to use.

### Readable and playable
- **A playable rough cut:** each review writes `out/proxy.mp4` with its sound.
- **No ids in what you read.** The crew channel, the chat's markers and Pip's cards name scenes and assets, not `lib:owl@1` or `t_draw_owl`, and long lines end on a whole word. The script pick shows whole cues.
- **One marker per thing that happened**, and the status line leaves "Waiting for you" once you answer a gate.
- **Pip's reply to a rejected key** says so, with a Fix the key button.
- **Reports read as sentences**, and the Reviewer's says what it found ("Found 6 problems in scenes 2 and 4.").

### The studio
- **Asks in Pip's chat, in the crew drawer too.** Open questions and gates show inline in Pip's thread, answerable there.
- **Turns read on their own.** Each exchange is its own block, read top to bottom; milestones are a separate "newest first" track.
- **The page goes to what needs you.** A new ask glides into view; while you type, a "Needs you" pill points to it instead.
- **The contact sheet opens full screen**, frame by frame (← →, Esc closes).
- **The rough cut plays with sound** once its proxy exists; without one the player says it's a silent preview and keeps the last good frame.
- **Pip's questions show every option**, Pip is never "the producer", and a hold's "Fix the key" and "Tell Pip what to change" act (Settings, or a field on the card).
- **G3's "Change something" shows who will do it and what it costs**, from the server's routing, not "the animator redoes all of animation".
- **The Library shows all three folders**: the public library, your own library and each project's private assets (likenesses, logos), each with its path. Scope filters by folder, and a project's assets say which project they belong to. Before, "Private to a project" never listed anything.
- **Remove a project** from its card's ⋯ menu. It leaves the list and its folder stays; a project in PixelArtPitch's own projects folder can also move to PixelArtPitch's trash folder. Nothing is deleted.
- **A rerun is Working on Projects**, not ✓ Finished; Pip's box never keeps words typed on New video; an old UI build says so in a banner.

### For contributors
- `pap serve` warns when the studio UI build is older than its source; `--build` rebuilds it, and `GET /api/build` tells the page.
- `scripts/e2e/` holds the end-to-end driver: a throwaway home, the web app built first, a spend watchdog, no keys.

## v0.2.0 (unreleased)

Fixes for everything the first long paid run showed: failures now stop and tell you, changes cost what they touch, and you decide how much the crew may spend and think.

### When something goes wrong
- **A rejected key, no credit or a model server that's down pauses the crew.** It no longer carries on with stand-ins. Pip tells you once what happened and what was kept, the status line names the cause, and "Fix the key" opens Settings at that provider. Saving the key, or a passing test, picks the run up where it stopped.
- **"Redo what failed"** reruns only the failed steps and the ones that fell back to a stand-in, with the work after them.
- **A wait is not a crash.** A plan change or the budget waiting on you shows as "Waiting for you", never as "stuck", and these cards count in Needs you.
- **Pip reads the live state** each turn, so it no longer says the crew is still working after the export.

### Changes, gates and the library
- **A change redoes only what it touches.** Art you already have and questions you already answered stay as they are, so estimates stay honest.
- **A rerun asks again at the gates it reopened.** An old approval no longer passes a new rough cut, and "Change something" is never taken as a pass.
- **Publishing goes to your own library**, and you're asked once per asset. The repo's library is a read-only seed; `pap library promote <id>` moves an asset into it on purpose, after the standard and rights checks.
- **Slash commands are never changes**, and Pip's plan changes are checked before they're accepted.

### Cost and speed
- **Highest thinking effort** (Settings → Defaults, default medium) caps how hard any model thinks.
- **Drawings per new asset** (1–3, default 2, or per project). With one there's no judging step.
- **Finish within the budget.** At 80% of the cap the first choice is "Finish within $X", which lists exactly what the crew leaves out. "Raise the cap" comes second.
- **Creatures** (a moth, an owl) are drawn at their own size, walking, flying or perching, not as a walking hero.

### The studio
- **The script angles show in full** at the first pick, each with "Use this one".
- **The simple view never sends you to Studio.** "Change something" opens a field on the card.
- **The crew drawer is readable and live.** Each step is named ("Drew variant 2"), a working step shows "Thinking… about 4,200 tokens · 48 s", and Settings › Experimental can paint a drawing row by row as it streams.
- **A plan change shows the old price struck through, the new total and the difference**, and names who re-planned.
- **Pip's thread is chat bubbles**, newest first. "Ask Pip about this" is a clearable chip.
- **Run report** in a project's ⋯ menu, and `pap report` on the command line: one page with who worked when, what it cost, what failed and what was drawn. No model calls.

### Engine and library
- **A rooftop backdrop, fly and sit behaviours, a glow for lamps and lanterns, and a sign-style label.** The new `rooftop` example uses them all.
- **A common library pack of 35 assets**, authored in code with no model calls: ground, floors, walls, roof, water, sky, clouds, stars, plants, props, lights and fire, icons, a spinning coin and fx. Later runs cast them instead of paying to draw.
- **The moth and the owl** from the paid run joined the library, and like every library character they face left.

### For contributors
- **The mock plays the paid run's situations** without any model calls: `?mock=1&journey=todo&scenario=revision|overrun|publish|keyfail`.

## v0.1.0 (2026-11-07)

The first release: a local studio where a crew of AI agents makes short pixel-art pitch videos while you watch, steer and pick.

![The mock journey: one sentence to Pip, then the crew writes, draws, scores and finishes a 30 s QuestDay pitch](https://raw.githubusercontent.com/mehrad77/PixelArtPitch/v0.1.0/docs/screenshots/journey.gif)

*The mock studio (`?mock=1&journey=todo&auto=1`) playing a whole 30 s pitch on its own, at 3× speed. No model is called.*

### Pip runs the show
- **`/new` is a conversation.** Say what you're making in one line ("a 30 s pitch for my bakery, no voice, under $3"). Pip asks at most one question, then shows a brief card with the crew, the picks you'll make and an estimate. Start builds the plan.
- **A production plan behind the crew.** Code builds the plan from the brief, and the gates are inserted by code too. Pip can propose changes to the plan, but for now they run in shadow mode only: in the Sonnet eval Pip didn't beat the rules plan.
- **Crew members come and go.** They join the crew row when their task starts and leave when it ends. Each one's log is kept, with its model, what it was asked and how long it worked.
- **Change requests through Pip.** Notes from the picture go to the right crew member. A change comes back as a card you confirm. `/undo`, `/budget`, `/why`, `/compact` and `/context` work in the chat.
- **One line on Projects** says what each video is doing and what it waits on from you.

### The crew and the engine
- **Twelve roles do small, checkable jobs**, each from a fixed task catalogue with a schema, lints and a repair loop. When a model is weak there's a fallback, and each endpoint has its own lane, so local models take turns.
- **A byte-exact engine.** The renderer is ported to TypeScript, and code scenes run in a sandbox. Declarative scenes use a closed menu of recipes and behaviours. There are lints and an asset standard, and a golden check proves the same document renders the same frames.
- **The budget is a hard cap.** Every call reserves its worst case first. A card asks you before the spend crosses 20% over the cap. A failed run never waits on you.
- **Any model:** Anthropic, OpenAI, OpenRouter, LM Studio, Ollama and llama.cpp. Each model is probed before it gets a role.
- **Resume after a crash.** State is rebuilt from the event log, and saved responses are reused.

### The studio
- **A Simple view and a Studio view.** Simple has the film, the five steps (replaced by parts in v0.4), and Pip with the crew faces. Studio adds the HUD, the stage nav, a 7-track timeline, and the Crew, Inbox, Notes and Changes panels.
- **Each crew face carries a small mark of its trade.** Pip wears the crown.
- **Settings → Roles** follows the crew. Profiles (Best, Balanced, Local, Custom) are priced per 60 s video, and each role has a fallback model.
- **The Docs page** reads the repo's guides in place. It lists every studio tool with its inputs and examples, and the tools your own MCP servers add.
- **A startup pitch pack** of 18 library assets.

### Tools and MCP
- **One tool registry** serves Pip, the crew, the studio and MCP (stdio and Streamable HTTP). Another agent can drive a project or join the crew, and the crew can use your own MCP servers.

### Security
- **Local-first.** The studio binds to 127.0.0.1 only and checks Host and Origin. A one-time launch URL signs the browser in, and every write needs a token.
- **Keys stay in the Keychain or a private file**, never in a project or the repo. A connection's URL and its secrets never reach the browser or the logs.
- **Private stays private.** Likenesses, logos and trademarks never leave their project, and the public library refuses them in code.

### Screenshots

| | |
|---|---|
| ![Projects](https://raw.githubusercontent.com/mehrad77/PixelArtPitch/v0.1.0/docs/screenshots/projects.png) | ![The Simple view with Pip and the crew](https://raw.githubusercontent.com/mehrad77/PixelArtPitch/v0.1.0/docs/screenshots/pip.png) |
| Projects | Simple view: the film, the steps, Pip and the crew |
| ![The Studio view](https://raw.githubusercontent.com/mehrad77/PixelArtPitch/v0.1.0/docs/screenshots/studio.png) | ![Settings, Roles](https://raw.githubusercontent.com/mehrad77/PixelArtPitch/v0.1.0/docs/screenshots/roles.png) |
| Studio: HUD, stages, timeline, Pip | Settings → Roles |
| ![Docs](https://raw.githubusercontent.com/mehrad77/PixelArtPitch/v0.1.0/docs/screenshots/docs.png) | |
| Docs: the repo's guides and every MCP tool | |

All screenshots show the mock studio's fictional projects.

### Not yet
- **A paid end-to-end run** of a whole video and a change request is still to come. The paid checks so far each stopped at a gate.
- **Pip's plan changes** stay in shadow mode until they beat the rules plan.
- **No licence is chosen yet.**
