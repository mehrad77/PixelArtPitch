# Pip runs the show: the journey (UI spec)

This is the UI half of "Pip runs the show". `docs/PIP-ORCHESTRATION.md` owns the wire contract (plan, instances, executor). This file owns what the person sees, hears and presses. Where they differ, the contract wins and this file is updated. §7 lists what the UI relies on and what it still asks for, so the two can be reconciled.

The canonical run is "Make a 30-second pitch for my todo app". The product is QuestDay, which is fictional (`examples/questday`). Every number below comes from the **roster** (§2). The mock plays the same roster (§6), so the strings, the counter and the tests all agree.

Words used here:
- **instance**: one crew member brought in for part of the plan ("Animator · scene 3").
- **face**: an instance shown in the crew row.
- **ghost**: a planned instance that isn't working yet.
- **finished**: an instance whose tasks are all over.

## Decisions (the person's OK, 2026-11-07)

The person approved both specs (this one and its sibling) with these answers to the open questions. They override anything below that disagrees.

1. **The logo is never drawn.** It is imported as is (`asset.import`, per `docs/RIGHTS.md`) and appears as a 16×16 icon in an achievement toast or item pickup. There is no sign and no "Pixel artist · sign". A sign recipe is separate engine work, not in this plan. The brief card says "your logo in an achievement toast".
2. **"Just the key picks" (`involvement: key`) is G1 script, the `rights` pick for a likeness or logo, and G3 rough cut.** G2 pacing passes automatically. Pressing "Looks good" at G3 also passes G4 final. "Every step" keeps all five gates; "Let the crew run" keeps only `rights` (never automatic) and the spend guard.
3. **P1 lands as two commits:** first a rules-only executor that matches today's behaviour, then Pip's plan revision and the evals.
4. **`rights` stays a question node in the plan,** answered only by the person, never passed automatically. It is not a new `GateId`.
5. **The $1.50 e2e uses a Sonnet Reviewer with one review round** (`reviewRounds: 1`).
6. The C1–C8 (backend) and C1–C16 (journey) departures are accepted as written, except where 1–2 above change them. The journey's §7.2 needs (N1–N11) are to be met by the backend as part of the phase that uses them.

## 1. Departures from the brief, for the OK

| # | Changed from the brief | Why |
|---|---|---|
| C1 | No "Crew" lane on the timeline (D3) | The timeline is video time and instances live in wall-clock time. The run history is in Finished: start, duration. |
| C2 | A face means a running task. Ghosts follow the server's horizon rule (`Instance.ghost`, ORCHESTRATION §2): a ready task, or a pending one within 2 hops of a running or ready task, gates transparent, at most 3 (D4) | Read literally, "queued" can't show the Director in step 5: it waits on a pick, not a slot. One rule, computed once, so the UI and the mock agree. While the crew waits on a pick, nothing is running, so there are no ghosts. |
| C3 | A redo brings back the same instance: same label, its log continues, and it leaves Finished (D5) | One "Animator · scene 1", not two. |
| C4 | `/new` asks one question card with 3 fields or fewer, then the brief card (D6) | The brief had two cards in a row. |
| C5 | The Projects line is built from state, with no model call (D7): `GET /api/workspace/line` | Free, instant, and the same on any model. |
| C6 | An unstarted `/new` leaves a draft, listed on Projects and removable (D8) | Nothing is lost. Only the conversation is on disk. |
| C7 | "about 11 crew members", not "about 7 people" | 11 is the count of rev 1 instances (§2). People see faces, so we count faces. |
| C8 | "+12 finished", not "+11 finished" | Rev 2 adds Pixel artist · founder: 11 + 1. The redos add none (C3). |
| C9 | Milestone "Plan ready · 11 tasks to start", not "6 tasks to start" | N is the non-gate tasks of rev 1 (§2), counted as the backend does. The 5 picks are on the brief card. |
| C10 | Steps 7 and 11 add three picks: the pacing (G2), the logo on the sign (the `rights` node), the final (G4) | `atGate` treats `key` as G0–G4. RIGHTS.md §3: using a brand asset "is always the user's call". **Open question Q1.** |
| C11 | The four Animators: three start, the fourth is a ghost "waiting for a free slot" | `defaults.concurrency` is 3, and D4. With 4 slots all four start together. |
| C12 | Step 10: the card settles with "Scene 2 redone; the hero is 2× now." The rough cut (G3) comes back, and "A new video is exported" moves to step 11 | The export runs after G3 (`deliver` → `deliver.export` → G4). Pip can't pass G3 for the person. |
| C13 | "Only the key picks", not "Just the key picks" | The kit's writing rule: cut "just". |
| C14 | Role names follow `ROLE_LABEL`: "Pixel artist · founder", "Art director" | Sentence case, as in the kit and the existing UI. ORCHESTRATION §2 writes "Pixel Artist" (`ROLE_WORD`): to reconcile (§7). |
| C15 | "Who's it for?" needs an `audience` field in the brief field registry | `Brief.audience` exists in the schema. The brief's registry left it out. |
| C16 | The estimate line says "plus the time your picks take" | 14 minutes is crew time. The five picks are the person's. |

## 2. The roster (the source of every number)

Plan rev 1 comes from the rules skeleton. Pip's revision adds nothing at G0 (D1). Rev 2 adds the founder drawing (step 7b). Rev 3 sends scene 1 back for the headline (step 9). Rev 4 is the person's change (step 10). A retry inside a task (step 8, `attempt: 2`) is not a revision. Gates are code-inserted, not instances.

| # | Instance (label) | Role | Task kinds | Joins | Leaves | Returns | $ |
|---|---|---|---|---|---|---|---|
| 1 | Writer | writer | `writer.angles` | 5 | 6 | – | 0.22 |
| 2 | Director | director | `director.storyboard` | 7a (ghost from 5) | 7a | – | 0.18 |
| 3 | Art director | art-director | `asset.judge` (casting) | 7b (ghost from 5) | 7b | – | 0.09 |
| 4 | Pixel artist · sign | pixel-artist | `asset.draw` | 7b | 7b | – | 0.28 |
| 5 | Pixel artist · founder | pixel-artist | `asset.draw` (rev 2) | 7b | 7b | – | 0.31 |
| 6 | Animator · scene 1 | animator | `scene.tune` | 7c | 7c | 9 (headline fix, +0.05) | 0.19 |
| 7 | Animator · scene 2 | animator | `scene.tune` | 7c | 7c | 10 (rev 3, +0.08) | 0.20 |
| 8 | Animator · scene 3 | animator | `scene.tune` ×2 tries | 7c | 8 | – | 0.19 |
| 9 | Animator · scene 4 | animator | `scene.tune` | 7c (ghost, then live) | 7c | – | 0.12 |
| 10 | Mixer | mixer | `sound.mix` | 8 (ghost from 7c) | 8 | – | 0.10 |
| 11 | Reviewer | reviewer | `review.final` r1, r2, r3 | 9 (ghost from 7c) | 9 (r2 ran while it was idle, +0.03) | 10 (r3, +0.03) | 0.14 |
| 12 | Editor | editor | `deliver.export` | 11 | 11 | – | 0.00 |

- Rev 1 has 11 instances and 11 tasks. The gates after G0 are G1 script, G2 pacing, the `rights` pick for the sign, G3 rough and G4 final: 5 picks.
- The crew spends $2.02 and Pip's own calls $0.12, so the run costs $2.14. That is inside $1.80–2.60, under the $3 cap. The change is $0.11 (Animator $0.08, Reviewer $0.03, plus Pip), which rounds to "about $0.12".
- Rev 2 adds $0.31, 17% over rev 1's p50 ($1.80). That is under the 20% bound, so it needs no card.
- **The final counter is "+12 finished".**

**Dependencies** (they decide the ghosts; gates are written `[G1]`):
- `writer.angles`
- → [G1] → `director.storyboard`
- → [G2] → `asset.judge` (Art director)
- → `asset.draw` sign, and `asset.draw` founder (rev 2)
- → `scene.tune` s1–s3, which need the founder, and s4, which needs the sign and [rights]
- → `sound.mix`, which needs all four scenes
- → `review.final` → [G3] → `deliver.export` → [G4]

**The row at each checkpoint**, by the horizon rule (C2). The node test asserts this table exactly (§6).

| Checkpoint | Live | Ghosts | Counter |
|---|---|---|---|
| 5: Writer working | Writer | Director, Art director | – |
| 6: G1 open | – | – | +1 |
| 7a: Director working | Director | Art director, Pixel artist · sign, Animator · scene 1 | +1 |
| 7a: G2 open | – | – | +2 |
| 7b: Art director working, after rev 2 | Art director | Pixel artist · sign, Pixel artist · founder, Animator · scene 1 | +2 |
| 7b: both drawing | Pixel artist · sign, Pixel artist · founder | Animator · scene 1, 2, 3 | +3 |
| 7c: three animating | Animator · scene 1, 2, 3 | Animator · scene 4 (free slot), Mixer, Reviewer | +5 |
| 7c: scene 1 done | Animator · scene 2, 3, 4 | Mixer, Reviewer | +6 |
| 8: Mixer working | Mixer | Reviewer, Editor | +9 |
| 9: Reviewer working | Reviewer | Editor | +10 |
| 9: scene 1 back | Animator · scene 1 | Reviewer (idle, round 2 pending), Editor | +9 |
| 9: G3 open | – | – | +11 |
| 10: scene 2 back | Animator · scene 2 | Reviewer, Editor | +9 |
| 11: Editor working | Editor | – | +11 |
| 11: G4 open, and after | – | – | +12 |

## 3. Screens and components

### 3.1 The crew row (simple view, `CrewStrip`)

The order is Pip first, then live faces in join order, then ghosts, then the finished counter. The row wraps and never scrolls sideways.

| State | When | Face | Accessible name (button) | Visible |
|---|---|---|---|---|
| **live** | the instance has a task `working` | the role's calm glyphs, blinking as today; `lg` size | "Animator · scene 3, working" | the caption under the face |
| **stuck** | its task `failed` and `problemOf` names it | `x x` | "…, stuck" | the caption; it stays until the problem is fixed, and is never folded |
| **needs** | its task is `waiting_user` | `' '`, looking up | "…, waiting for you" | the caption |
| **ghost** | `instance.ghost` is true and nothing is running for it (the server's horizon rule, C2) | `· ·`, a dashed `--stroke-control` edge, `--text-muted` ink, no hue fill | "Director, up next", or "Animator · scene 4, waiting for a free slot" (its task is ready) | the caption, muted |
| **finishing** | for `FINISH_HOLD_MS = 2000` after its last task ends | done: `^ ^` with a ✓ mark. stopped (dropped or cancelled): `– –` with a ■ mark | "Writer, done", or "…, stopped" | the caption plus the word "done" or "stopped" |
| **finished counter** | at least one instance has ended | none: a chip | "12 finished. Show who worked" | `+<bdi>12</bdi> finished` |

- **Ghost cap.** At most 3, nearest first, as the server sends them. The rest show only in the drawer's "Up next". A finished instance whose new task is pending (D5) leaves Finished and shows as a ghost if it is on the horizon.
- **Caption.** The qualifier after " · " ("scene 1", "founder", "sign"), in `--step--2` mono, `max-inline-size: 8ch`, with an ellipsis. The full label is in the name and the popover. An instance without a qualifier has no caption.
- **Face identity, per role.** The hue comes from the role's department (`memberOf`). The calm glyphs are per role, so a Writer and a Director never look alike:

  | Role | Glyphs | Hue |
  |---|---|---|
  | writer | `• •` | 2 |
  | director | `▪ ▪` | 2 |
  | art-director | `* *` | 3 |
  | pixel-artist | `+ +` | 8 |
  | librarian | `□ □` | 3 |
  | animator | `o O` | 4 |
  | scene-coder | `o o` | 4 |
  | sound-designer | `~ ~` | 5 |
  | mixer | `≈ ≈` | 5 |
  | editor | `= =` | 6 |
  | reviewer | `° °` | 7 |
  | producer | `o o` | 1 |

- **Popover** (pressing a face): label, Pip's reason for bringing it in ("Brought in for three script angles"), the line about it, its last picture, "Ask Pip about this", "See what it's doing". A ghost's popover says "Starts after the script pick" or "Waiting for a free slot. 3 are working".
- **Counter.** Pressing it opens the crew drawer with Finished selected.

**Motion.** Faces are pixel UI, so every move is stepped. Durations come from the kit tokens.

| Event | Without reduced motion | With reduced motion |
|---|---|---|
| Enter (a face first shows in the row, live or as a ghost) | It enters from Pip's side: an inline offset of −8px (+8px under `:dir(rtl)`) → 0, scale 0.5 → 1, opacity 0 → 1, all on `--ease-dither` over `calc(var(--dur-step) * 4)`. Several in one batch stagger by `--dur-step`. | It appears in place |
| Ghost → live (`spawn` or `live` on a face already shown) | The edge turns from dashed to solid and the hue fills, `--ease-step` over `--dur-step`. Nothing moves. | instant |
| Ghost leaves the horizon (a pick opens) | opacity → 0 in place, `--ease-dither`, `calc(var(--dur-step) * 4)` | gone |
| Finish (`end`) | The glyphs swap to `^ ^ ✓` (a whole step). After 2 s it folds: scale 1 → 0.5 and opacity → 0 toward the counter (+8px inline), `--ease-dither`, `calc(var(--dur-step) * 4)`. Then the row reflows in one step, and the counter digit swaps. | The ✓ still holds for 2 s, then the face is gone |
| Return (`revive`, D5) | the fold in reverse: it enters from the counter's side (+8px inline → 0); the counter goes down by one | appears |
| Pip conducting | once per batch that has a `spawn` or a `revive` (§3.2) | a still baton for 1.2 s |

- Only live changes animate, never what loads. Take a baseline of the instances on mount and again on every reconnect (`conn` back to `open`), as `useThoughts` does, and animate only what changed against it.
- No layout tweening: the siblings never slide.

**Announcements** (one region owns them): the existing polite region in `CrewStrip`, fed by `useThoughts`.
- One sentence per spawn, return or dismissal. A ghost appearing or leaving is never announced.
- A batch of the same role merges: "Pip brought in 3 Animators, one per scene." "Animator · scene 1 and scene 2 finished."
- At most one announcement per 5 s, with the last 3 sentences joined, as today.
- `StatusLine`'s region (Pip's line, throttled to 10 s) and `PipLive` (Pip's replies) **do not** announce spawns or dismissals, and no Pip line repeats one.
- Focus never moves on its own.

### 3.2 Pip's face

- A new mood, `conducting`: glyphs `◠ ◠` and a 3×3-cell baton at the top inline-end corner. The baton steps between two frames, 6 steps at `--dur-step`.
- Triggered by the first spawn of a batch. A batch is one plan revision, or one executor tick that starts at least one instance.
- The face's name becomes "Pip, bringing in the crew".

### 3.3 The crew drawer (`AgentActivity`)

The side rail becomes three groups. Each group is a list of buttons with `aria-current="true"` on the selected one. A tablist can't hold headings, so this is a structural change.

| Group | Rows |
|---|---|
| Pip | as today: Pip's pane with Behind the scenes |
| **Working** · N | each live, stuck or needs instance: face, label |
| **Up next** · N | every not-started instance in the plan, in plan order, each with a dashed face. Nothing is capped here. |
| **Finished** · N | ended instances, newest `endedAt` first. One line each: face (`^ ^` or `– –`), label, model, time alive, $, outcome |

- **A Finished row**, at 375px on two lines:
  - Line 1: `<face> Pixel artist · founder`
  - Line 2: `Sonnet 5.5 · 3 min · $0.31 · ✓ done`
- **Outcome words** (always an icon and a word): `✓ done`, `◐ partly done`, `■ stopped`, `✕ failed`.
- **Time alive** is the sum of its spans, so a return adds up.
- **The kept log** (opening a finished row) is read-only:
  - A header: label, model, outcome, $, "Joined 21:04 · Left 21:07". Every time is in `<time datetime>`.
  - Pip's reason in quotes: Joined "The library had no founder sprite." Left "Drawn and approved."
  - Then the existing `TaskGroup` threads for every task it ran, oldest first.
  - Then its messages with Pip (Behind the scenes, filtered by instance).
  - A return shows as a hairline marker: "Back for a fix · 21:12".
  - No message box. In its place, one button, "Ask Pip about this". It selects Pip in the same drawer, with "About the Pixel artist · founder: " in Pip's field and focus there, because the person pressed it. The turn is sent with `about: {instance}`.
  - The log comes from `GET /api/p/:id/instances/:iid/log`.
- Esc closes the drawer and returns focus to the face or the counter that opened it.

### 3.4 Studio, the Crew tab (`CrewRow`)

- Pip stays pinned first.
- The department rows become instance rows, grouped Working, Up next, then a **Finished · N** Disclosure. It is open while nothing is live, and closed otherwise.
- **Instance row**: face, label, model chip, status badge (word), $, time, "Ask Pip", "Details". Details opens the crew drawer on that instance; no more TaskDrawer for instances.
- **A "Plan · rev 4" Disclosure** at the end: one line per revision, newest first ("rev 2 · 21:06 · Pip: added a Pixel artist for the founder. The library had no founder sprite.").
- No Crew lane on the timeline (C1). The stage nav stays as it is: a stage is a view over the plan tasks of its kinds.

### 3.5 `/new`: the empty stage

- **Routes.**
  - `/new` is fresh. `/new/:draftId` is a draft. `/new/:draftId/options` is the full composer.
  - Path segments only, because `usePath` ignores the query.
  - `/p/:id` serves a project that has started.
- **One shell, kept mounted.** `/new`, `/new/:draftId` and the `/p/:projectId` it becomes render one component, `ProjectStage`, under one React key (`stage:new`).
  - App remembers the pair `{draftId, projectId}` it adopted. The replaceState to `/new/:draftId` (the first send) and then to `/p/:projectId` (Start returns `card.result.projectId`) keep the thread, the field and the focus.
  - The draft is created (`POST /api/drafts`) on the first send or the first file drop, never on opening `/new`. Until then "What are we making?" is local.
- **No projects yet.** `ProjectsPage` with no projects renders this stage, not `<ComposerPage first />`.

| Part | What it shows |
|---|---|
| film area | a dark 16:9 box at the film's size, `--surface-sunken`, with "Your video shows here" muted in the centre. It is also the drop zone. |
| crew row | Pip only (`PipFace` row size, idle) |
| Pip's line | **"What are we making?"** |
| field | label "Your idea" (visually hidden); placeholder "For example: a 30 s pitch for my bakery, no voice"; a paperclip button "Add files"; `/` focuses it |
| under the field | the chips "A 30 s pitch for investors" and "A 15 s launch teaser" (they fill the field and never send), and the quiet link **"Show all options"** |
| money | hidden; nothing is spent |

**Dropping files.**
- While a drag is over the window, the film area outlines with `--focus-ring` and reads "Drop to add to this video".
- A dropped file becomes a chip in the field: "questday-logo.png", with a Remove button named "Remove questday-logo.png". It uploads when the message is sent.
- The type is guessed by `guessType`.

**The question card** (form card `brief_fields`, one card, 3 fields or fewer):

```
A few things the idea leaves open
  Who's it for?                       ◉ Investors  Recommended
                                      ○ Users
                                      ○ A launch post
  How involved do you want to be?     ◉ Only the key picks  Recommended
                                      ○ Every step
                                      ○ Let the crew run
  questday-logo.png  [Logo ▾]  [Private to this project]
  Is the logo yours to use?           ○ Mine  ○ Licensed  ○ Not sure
  [Use these]   Show all options
```

- Each field is a Fieldset with a legend.
- "Recommended" is a word after the label, never colour alone. The recommended option is preselected.
- Rights are never preselected, because they are the person's claim. Pressing "Use these" without them puts "Pick one: Mine, Licensed or Not sure." under the field.
- "Not sure" is allowed. The brief card then warns "Not sure blocks the logo until you say. The crew uses a stand-in until then."
- "Private to this project" is the info Badge, for logo and likeness references.
- A second question card comes only when an answer opens a new question (D6), for example a likeness, which needs its rights and a cloud-or-local choice.

**The brief card** (type `brief`):

| Row | Value |
|---|---|
| Idea | "A 30 s pitch for QuestDay, a todo app that turns tasks into quests." |
| Length | `<bdi>30 s</bdi>` |
| Narration | None |
| For | Investors |
| Your picks | The key moments |
| Budget | Up to `<bdi>$3</bdi>` |
| Files | questday-logo.png · Logo · Mine · `Private to this project` |

Then three lines:
1. "About <bdi>$1.80–2.60</bdi>, ready in roughly <bdi>14 minutes</bdi>, plus the time your picks take."
2. "About 11 crew members over the run; most art comes from the library, and one new drawing: your logo on a sign."
3. "You'll pick 5 times: the script, the pacing, the logo on the sign, the rough cut and the final."

Buttons: **Start** (primary) · **Show all options** (quiet).
- If the estimate's p90 passes the cap, a warning: "This may pass your $3 cap. Raise it to $4, or ask me for a shorter video." Start stays pressable, and the card says the guard holds at the cap.
- **Show all options** opens `/new/:id/options`: the old `ComposerPage`, filled from the draft's fields.
  - Its submit starts the draft as the brief card's Start does.
  - "‹ Back to the conversation" saves its fields to the draft, with no model call.
  - It never depends on a model.

### 3.6 Projects

- **The head**: `<h1>Projects</h1>`, Pip's line with Pip's face, and one primary button, **"New video"**, which goes to `/new`.
- **Pip's line** is `WorkspaceLine.text` from `GET /api/workspace/line`, built on the server from state.
  - At most 3 clauses, ordered finished → working → waiting, so it ends on what needs the person: "QuestDay teaser is finished. Lantern is waiting on one pick from you."
  - Each `part` makes its project's title a link to that project.
  - "Nothing needs you right now." when no clause applies.
  - It refreshes when the projects list does. The page's polite region gives it once per change.
- **Drafts.** A group, "Drafts · N", is shown last.
  - Each card has no thumbnail (an empty-stage box), the title (from the idea: "QuestDay pitch"), the mark "✎ Draft", Pip's last question as the line, and "Started <time>".
  - The card links to `/new/:id`.
  - Its ⋯ menu has "Remove draft". That opens a Dialog: "Remove this draft? Only the conversation is saved, and it goes too." with **Remove draft** (danger) and **Keep it**.
- **"Make another like this".**
  - It is in a finished card's ⋯ menu and in a finished project's Pip chips.
  - It calls `POST /api/drafts {from}`, which inherits the audience, length, narration, involvement, profile, style and budget (not the idea or the references). Then it goes to `/new/:draftId`.
  - Pip's first line there: "Another one like QuestDay teaser: same style, cast and settings. What's this one about?"
  - The existing `project_fork` plan card ends at the same place.

### 3.7 375px and RTL

| Screen | 375px | RTL (fa) |
|---|---|---|
| Crew row | The row wraps. The faces stay `md`, a live face `lg`. The captions clamp at 8ch. The counter goes to a new line if it must. | The order mirrors with the flow. The spawn offset flips under `:dir(rtl)`. Bubbles use the layout's existing `rtl` branch. |
| Pip's line and thread | the existing simple view | every text node `dir="auto"` |
| Question card | The fields stack, and the radios run in one column. The file row wraps: name, then the chips. | The file name is in `<bdi class="ltr" translate="no">` |
| Brief card | The `dl` turns into label-above-value pairs | Money, durations, counts and times in `<bdi>`, numbers through `Intl` for the page's `lang` |
| Drawer | full width; the rail becomes a horizontal group list above the pane | the rail sits at the inline-start edge |
| Finished row | two lines (§3.3) | `<bdi>` around the model, the time and the $ |
| Projects | one column of cards; the Pip line above the button | The project titles are `<bdi>` inside Pip's sentence |

Throughout:
- Logical properties only.
- Kit semantic tokens only (`--surface*`, `--text*`, `--stroke*`, `--focus-ring`, `--category-*` for the hues).
- No state by colour alone: every state has a glyph or a word.
- Every target is at least `--target-min`.

## 4. The journey

Each step lists:
- **Screen**: the crew row, Pip's line, the thread (newest first), cards and the drawer.
- **Text**: the exact UI strings.
- **SR**: the polite announcement from the crew region (§3.1) unless another region is named.
- **Focus**: where focus is, given that it never moves on its own.
- **RM**: the reduced-motion variant.

### Step 1. Opening the app

- **Screen**:
  - Projects: Pip's line, then New video, then the groups.
  - Needs you: Lantern. Finished: QuestDay teaser. Drafts: none.
- **Text**:
  - Pip's line: "QuestDay teaser is finished. Lantern is waiting on one pick from you."
  - Button: "New video".
- **SR**: nothing. The page has loaded; it isn't news.
- **Focus**: the page's normal start.
- **RM**: the same (no motion).

### Step 2. Saying the idea

- **Screen**:
  - `/new`: the empty stage, the crew row is Pip only, and Pip's line is "What are we making?".
  - The person types "a 30 s pitch for QuestDay, my todo app that turns tasks into quests. no voice. keep it under $3", drops `questday-logo.png` and sends.
  - The URL becomes `/new/<draftId>` (replaceState). The message shows in the thread with its file chip.
  - Pip's face shows `thinking`.
- **SR**: `PipLive` announces "Pip is thinking", as today.
- **Focus**: stays in the field, which empties after the send.
- **RM**: the thinking face stays still.

### Step 3. Pip asks only what's missing

- **Screen**: Pip's reply, with the question card (§3.5) under it.
- **Text**:
  - Pip: "30 seconds, no voice, under $3. Three quick picks, then I'll sum it up."
  - The card: as in §3.5.
- **The reading**: length 30, narration none, cap 3, purpose pitch. Left open: audience, involvement and the logo's rights.
- **Changed from the brief**: one card with three fields instead of two cards (C4); "Only the key picks" (C13); `audience` (C15).
- **SR**: `PipLive` announces Pip's reply text.
- **Focus**: stays in the field. The person tabs or clicks into the card.
- **RM**: the same.

### Step 4. The brief

- **Screen**: "Use these" settles the question card into a one-line summary, "✓ Investors · only the key picks · logo: mine". The brief card arrives (§3.5).
- **Text**:
  - Pip: "Here's the brief."
  - Then the card as specified.
- **Changed from the brief**: the preview counts (C7) and the picks line (C10, C16).
- **SR**: `PipLive` announces "Here's the brief."
- **Focus**: "Use these" unmounts, so focus goes to the Pip field. This is the existing handoff rule: only when the person's own press removes the control they pressed.
- **RM**: the same.

### Step 5. Pip assembles the crew

- **Screen**:
  - The person presses Start. That passes G0 as the person. The brief card settles to "✓ Started".
  - Pip's face conducts. The Writer slides out from Pip, and then two ghosts enter after it: Director and Art director ("up next").
  - The URL becomes `/p/<projectId>` with nothing remounted, and the money line appears: "$0.04 of $3".
- **Text**:
  - Milestone: "Plan ready · 11 tasks to start".
  - Bubble over Pip: "Brought in the Writer for three script angles".
  - Pip's line: "The Writer is drafting three angles for the script."
- **Changed from the brief**: the milestone text (C9).
- **SR**: "Pip brought in the Writer for three script angles."
- **Focus**: Start unmounts, so focus goes to the Pip field.
- **RM**: the faces appear without the slide, and the baton is still for 1.2 s.

### Step 6. The first pick

- **Screen**:
  - The Writer's face shows `^ ^ ✓` for 2 s, then folds into "+1 finished".
  - Nothing is running now, so the two ghosts fade (C2). The row is Pip and "+1 finished".
  - The G1 pick (NeedsYou, the Pip variant) sits under Pip's line.
- **Text**:
  - Pip's line: "The Writer has three angles. The walker is closest to your brief."
  - The pick: "Which script should the crew make?", with ◉ The walker (Recommended), ○ The quest board, ○ The numbers, and the button "Use this script".
- **SR**: "Writer finished." Then the status region (10 s throttle) gives Pip's line.
- **Focus**: unchanged. `Q` jumps to the pick, as today.
- **RM**: the ✓ holds for 2 s, then the face is gone and the counter reads +1.

### Step 7. The crew grows and shrinks

The faces at each moment are the §2 checkpoint table.

**7a. Story.**
- The person picks The walker. The Director slides out from Pip, followed by three ghosts: Art director, Pixel artist · sign, Animator · scene 1.
- Bubble over Pip: "Brought in the Director to board 4 scenes".
- The Director finishes and folds (+2), and the ghosts fade while the pick is open.
- The G2 pick: "Happy with the pacing?", with the buttons "Looks good" · "Change something".
- Pip's line: "The Director boarded 4 scenes. Have a look at the pacing."
- **Changed from the brief**: the pacing pick is added (C10).
- SR: "Director finished."

**7b. Art.**
- "Looks good" passes G2. The Art director slides out, with ghosts for Pixel artist · sign and Animator · scene 1 (and 2).
- The Art director reports `partial`: "No founder sprite in the library."
- Plan rev 2, a milestone in the thread: "Plan changed: added a Pixel artist for the founder".
- Pixel artist · founder enters as a ghost.
- The Art director finishes and folds (+3). Both Pixel artists turn live together, and Pip conducts.
  - Bubble over Pip: "Brought in a Pixel artist for the sign. Brought in a Pixel artist for the founder" (merged).
  - The ghosts are now Animator · scene 1, 2 and 3.
- Pixel artist · sign finishes (+4). The `rights` pick sits under Pip's line:
  - "Your logo on the sign. Use it in the video?"
  - Under it, the still of the sign and the info Badge "Private to this project".
  - Buttons: "Use it" · "Redraw".
- The person presses "Use it". Pixel artist · founder finishes: +5.
- **Changed from the brief**: the `rights` pick is added (C10, RIGHTS.md §3).
- SR, merged: "Pip brought in the Art director to cast from the library." then "Art director finished. Pip brought in a Pixel artist for the sign. Pip brought in a Pixel artist for the founder." then "Pixel artist · sign finished." and so on.

**7c. Motion.**
- Pip conducts. The three Animator ghosts turn live together.
- Animator · scene 4 enters as a ghost, "waiting for a free slot". After it come the Mixer and the Reviewer ("up next").
- Scene 1 finishes and folds (+6), and Animator · scene 4 turns live.
- Scene 2 finishes and folds (+7).
- The row never holds more faces than there are running tasks. The ghosts are labelled as ghosts.
- Pip's line: "Three Animators are putting the scenes in motion; scene 4 starts when one is free."
- **Changed from the brief**: 3 live and 1 ghost (C11).
- SR: "Pip brought in 3 Animators, one per scene." "Animator · scene 1 finished." …

**Focus** in 7a to 7c: unchanged throughout. The picks are reached by Tab or `Q`.

**RM**: no slides and no folds. The ✓ holds for 2 s.

### Step 8. A member hits a wall

- **Screen**:
  - Animator · scene 3 reports `partial`. Its bubble: "No recipe for two people talking."
  - In Behind the scenes, Pip answers with an `answer` message: "Use a toast for the line and keep both characters left of the box."
  - Bubble over Pip: "Told the Animator · scene 3: use a toast for the line".
  - The Animator stays live, tries again (`attempt: 2`, the same task), finishes and folds: +8.
  - Animator · scene 4 folds (+9).
  - The Mixer turns live; the Reviewer and the Editor are ghosts. Then the Mixer folds (+10).
- **Text**: Pip's line: "Scene 3 needed a workaround; the Animator used a toast for the line." There is no question to the person.
- **SR**: "Animator · scene 3 is partly done: no recipe for two people talking." Then "Animator · scene 3 finished."
- **Focus**: unchanged.
- **RM**: the bubbles appear and leave without the fade; the faces as above.

### Step 9. The rough cut

- **Screen**:
  - The Reviewer ghost turns live, with the Editor as a ghost. It finds one blocker: "The headline is clipped in scene 1".
  - Code adds review round 2 (rev 3). The Reviewer goes idle and shows as a ghost; it isn't finished, so the counter doesn't move.
  - Animator · scene 1 **returns from Finished**: it enters from the counter's side, and the counter goes to +9.
    - Bubble over Pip: "Brought the Animator back to fix the scene 1 headline".
  - It finishes and folds (+10). The Reviewer turns live for round 2, finds it clean, and folds (+11).
- **Text**:
  - Milestone: "Plan changed: scene 1 goes back to the Animator for the headline" (rev 3).
  - Pip: "The rough cut is ready. One fix was made on scene 1."
  - The G3 card: "Happy with the cut?", with the buttons "Looks good" · "Change something".
- **SR**: "Pip brought the Animator back to fix the scene 1 headline." "Animator · scene 1 finished." "Reviewer finished."
- **Focus**: unchanged.
- **RM**: as above.

### Step 10. A change request

- **Screen**:
  - The person types "make the hero bigger in scene 2".
  - Pip's plan card: title "Make the hero bigger in scene 2". Who: the Animator · scene 2 and Reviewer faces with their labels. Detail: "Animator · scene 2 tunes the size, then the Reviewer checks." "About $0.12 · about 2 minutes". Effects: "Reopens scene 2. Scenes 1, 3 and 4 stay as they are." Confirm label "Ask the crew".
  - On confirm: plan rev 4 (milestone "Plan changed: scene 2 goes back to the Animator for a bigger hero").
    - Animator · scene 2 returns from the counter's side. The Reviewer and the Editor show as ghosts, and the Reviewer leaves Finished with its new pending task (+9).
    - Scene 2 finishes (+10). The Reviewer turns live, checks, and folds (+11).
  - The card settles: "✓ Scene 2 redone; the hero is 2× now."
  - G3 comes back under Pip's line: "The rough cut is ready again, with your change."
- **Changed from the brief**: C12.
- **SR**: `PipLive` announces the card. The crew region: "Pip brought the Animator back for a bigger hero in scene 2." "Animator · scene 2 finished." "Reviewer finished."
- **Focus**: "Ask the crew" unmounts, so focus goes to the Pip field.
- **RM**: as above.

### Step 11. Done

- **Screen**:
  - "Looks good" passes G3. The Editor slides out from Pip (no ghost: the pick had emptied the horizon), exports, and folds: **+12**.
  - The G4 card under Pip's line, with the files card: Download (`questday-pitch.mp4`), Subtitles (`questday-pitch.srt`), Open (plays it in the stage).
  - Then "Approve the final" (primary) · "Change something".
  - Approving settles it to "✓ Final approved". The crew row is Pip and "+12 finished".
- **Text**:
  - Pip: "Your video is ready. A new video is exported, with scene 2's change."
  - Pip's line after the approval: "Your video is ready."
  - The milestone: "Your video is ready".
- **Changed from the brief**: C8 and C12 (the G4 approve).
- **SR**: "Editor finished." Then the status region gives Pip's line.
- **Focus**: unchanged. "Approve the final" unmounts on press, so focus goes to the Pip field.
- **RM**: the same, with no motion.

### Step 12. Looking back

- **Screen**:
  - The person presses "+12 finished". The crew drawer opens with Finished selected, newest first: Editor, Reviewer, Animator · scene 2, …
  - The Pixel artist · founder row reads: "Pixel artist · founder · Sonnet 5.5 · 3 min · $0.31 · ✓ done".
  - Opening it shows the kept log (§3.3), with Joined "The library had no founder sprite."
  - "Ask Pip about this" puts the person in Pip's field. They ask "why did you add a Pixel artist?".
- **Text**: Pip: "The library had no founder sprite, so I added one drawing. It was $0.31 of your $3."
- **SR**: `PipLive` announces the reply.
- **Focus**: opening the drawer goes into the dialog, as the kit Drawer does. "Ask Pip about this" goes to the field. Esc returns to the counter.
- **RM**: the drawer opens without the slide.

## 5. Every string, by place

| Place | Strings |
|---|---|
| Spawn bubble (over Pip) | `instance.reason` with its leading "Pip " dropped and the first letter capitalized: "Pip brought in the Writer for three script angles" → "Brought in the Writer for three script angles". The reason is the server's, in Pip's words or the catalogue template. It uses the role word with an article, never the qualified label. |
| Return bubble | the reason of the life that opened, made the same way: "Brought the Animator back to fix the scene 1 headline" |
| SR, spawn and return | the reason verbatim, plus "." A batch of one role over scenes merges to "Pip brought in {n} {Role}s, one per scene." |
| SR, leave | "{label} finished." · "{label} stopped." · "{label} is partly done: {lastReport.couldnt}" (here the qualified label) |
| Ghost names | "{label}, up next" · "{label}, waiting for a free slot" |
| Ghost popover | "Starts after {the script pick / the pacing pick / …}" · "Waiting for a free slot. {n} are working." |
| Counter | "+{n} finished" · name "{n} finished. Show who worked" |
| Drawer groups | "Working" · "Up next" · "Finished" |
| Outcomes | "✓ done" · "◐ partly done" · "■ stopped" · "✕ failed" |
| Kept log | "Joined {time}" · "Left {time}" · "Back for a fix · {time}" · "Ask Pip about this" |
| Milestones (server, `kind: "plan"`) | "Plan ready · {n} tasks to start" · "Plan changed: {revision.reason}", the reason verbatim with its first letter lowered |
| `/new` | "What are we making?" · "Your idea" · "Add files" · "Drop to add to this video" · "Your video shows here" · "Show all options" |
| Question card | "A few things the idea leaves open" · "Recommended" · "Use these" · "Pick one: Mine, Licensed or Not sure." |
| Brief card | "Here's the brief." · "Start" · "✓ Started" · the estimate, crew and picks lines (§3.5) |
| Drafts | "Drafts" · "✎ Draft" · "Remove draft" · "Remove this draft? Only the conversation is saved, and it goes too." · "Keep it" |
| Too many revisions | "I've changed the plan 6 times on this run. The next change is yours to approve." (Pip, with a plan card) |
| Over 20% | "Adding the {label} raises the estimate by {p}%. Add it?", with "Add it" · "Not now" (a plan card) |

## 6. The mock script (`?mock=1`, journey `todo`)

- **Where.** The journey lives in `apps/web/src/mock/journey.ts` as pure data: a list of beats, `{at: tick, when?: waitFor, emit: ServerEvent | PipEvent}`. `MockClient` plays it. The same list drives a node test with no DOM.
- **Turning it on.** `?mock=1&journey=todo` seeds two fixture projects: "QuestDay teaser" (finished) and "Lantern · demo night" (one open pick).
- **Flags**, read once at boot:

  | Flag | Effect |
  |---|---|
  | `speed=N` | divides every delay (default 1; `speed=20` for tests) |
  | `slots=N` | concurrency (default 3); `slots=1` gives 1 live + 3 ghosts in 7c |
  | `auto=1` | answers every pick with its recommended option, Mine for the rights, and types the step 2 and 10 messages, so the run goes end to end with no clicks |

- **Determinism.**
  - The ids come from a counter (`inst_1`, `t_1`, `pip_1`), never from `Date.now()`. `mock/pip.ts`'s `uid` stays for the other intents.
  - No `Math.random`. The pictures come from `drawFrame` with fixed inputs, and the logo fixture is a drawn, fictional "Q" badge.
- **Time.** One tick is 1 s ÷ `speed`. The displayed durations are the compressed real ones: the Finished list says "9 s", not "3 min". Tests match patterns, not durations.
- **Waits.** A beat with `when` waits for a person's action: `card:<id>`, `answer:<qid>`, `gate:<id>`, `ask:<text>`. With `auto=1`, each one resolves 3 ticks after it opens.

The Tick column counts from that row's trigger. A row with no trigger keeps counting from the last trigger above it.

The ids are the server's instance keys (`writer`, `animator:s01`, `pixel-artist:founder`). Every `instance` event is `{instance, change}` (ORCHESTRATION §4.3). The mock computes `ghost` with the same horizon rule, in `mock/journey.ts`, and emits `change: "ghost"` when a face enters the horizon.

| Step | Trigger | Tick | Emits |
|---|---|---|---|
| 2 | send | +0 | `POST /api/drafts` → `draft_1` (listed with `draft: true`); `pip` (with `draft`) item user; `pip thinking` |
| 3 | | +2 | `pip item` Pip text + `brief_fields` card `c_q` (3 fields) |
| 4 | `card:c_q` | +0 | `pip card` c_q done; `pip thinking` |
| | | +1 | `pip item` "Here's the brief." + `brief` card `c_b` |
| 5 | `card:c_b` (Start) | +0 | `pip card` c_b started, `result.projectId: "questday-pitch"`; `gate` g0 passed (`by: "user"`) |
| | | +1 | `plan` rev 1 (11 tasks) with `revision`; `milestone` (`kind: "plan"`) "Plan ready · 11 tasks to start" |
| | | +1 | `instance` writer `spawn`; `task` t_1 working; `instance` director, art-director `ghost` |
| | | +2…+5 | `activity` beats for t_1 (the existing `opening`/`middle`) |
| 6 | | +6 | `channel` report done; `task` t_1 done; `instance` writer `end` (done); director and art-director drop off the horizon (`ghost: false`); `question` q_angle open; `status` |
| 7a | `answer:q_angle` | +0 | `gate` g1 passed; `instance` director `spawn`; `task` t_2 working; art-director, pixel-artist:sign, animator:s01 `ghost` |
| | | +5 | `task` t_2 done; director `end`; the ghosts go; `gate` g2 open |
| 7b | `gate:g2_animatic` | +0 | art-director `spawn`; `task` t_3 working; pixel-artist:sign, animator:s01, animator:s02 `ghost` |
| | | +3 | `channel` art-director report partial "No founder sprite in the library."; `plan` rev 2 (+t_5) with `revision`; `milestone` "Plan changed: added a Pixel artist for the founder"; pixel-artist:founder `ghost` |
| | | +4 | `task` t_3 done; art-director `end`; pixel-artist:sign and pixel-artist:founder `spawn`; t_4, t_5 working; animator:s01–s03 `ghost` |
| | | +6 | `task` t_4 done; pixel-artist:sign `end`; `question` q_rights open (the `rights` plan node for the sign) |
| | | +8 | `task` t_5 done; pixel-artist:founder `end` |
| 7c | `answer:q_rights` and t_5 done | +0 | animator:s01–s03 `spawn`; t_6–t_8 working; t_9 (s4) ready → animator:s04 `ghost`; mixer, reviewer `ghost` |
| | | +4 | t_6 done; animator:s01 `end`; animator:s04 `spawn` (t_9 working) |
| | | +5 | t_7 done; animator:s02 `end` |
| 8 | | +6 | `channel` animator:s03 report partial "No recipe for two people talking."; `channel` Pip answer "Use a toast for the line and keep both characters left of the box." |
| | | +7 | t_8 working again, `attempt: 2` (the same instance stays live) |
| | | +9 | t_8 done; animator:s03 `end`; t_9 done; animator:s04 `end`; mixer `spawn`; t_10 working; editor `ghost` |
| | | +12 | t_10 done; mixer `end` |
| 9 | | +12 | reviewer `spawn`; t_11 working |
| | | +15 | `x-state` findings: a blocker on s1, "The headline is clipped in scene 1"; t_11 done (blockers); `plan` rev 3 (`by: "code"`, +t_12 `scene.tune` s1 r2, +t_13 `review.final` r2); `milestone` "Plan changed: scene 1 goes back to the Animator for the headline"; reviewer `idle` (and `ghost`); animator:s01 `revive`; t_12 working |
| | | +18 | t_12 done; animator:s01 `end`; reviewer `live`; t_13 working |
| | | +20 | t_13 done clean; reviewer `end`; `gate` g3 open; `pip item` "The rough cut is ready. One fix was made on scene 1." |
| 10 | `ask:make the hero bigger in scene 2` | +2 | `pip item` + plan card `c_ch` (`who: ["animator", "reviewer"]`, `whoInstances` animator:s02 and reviewer; usd [0.10, 0.14]) |
| | `card:c_ch` | +0 | `plan` rev 4 (`by: "person"`); `milestone` "Plan changed: scene 2 goes back to the Animator for a bigger hero"; animator:s02 `revive`; t_14 working; reviewer and editor `ghost` |
| | | +4 | t_14 done; animator:s02 `end`; reviewer `spawn`; t_15 working |
| | | +6 | t_15 done; reviewer `end`; `pip card` c_ch done "Scene 2 redone; the hero is 2× now."; `gate` g3 open |
| 11 | `gate:g3_rough` | +0 | editor `spawn`; t_16 working |
| | | +4 | t_16 done; editor `end`; `x-state` files; `gate` g4 open; `pip item` "Your video is ready…" |
| | `gate:g4_final` | +0 | `gate` g4 passed; `milestone` "Your video is ready" |
| 12 | `ask:why did you add a Pixel artist?` (with `about: {instance: "pixel-artist:founder"}`) | +2 | `pip item` "The library had no founder sprite, so I added one drawing. It was $0.31 of your $3." |

The `ledger` events follow each task's `usd` from §2. Pip's turns are metered at $0.01–0.02 each, for a total of $0.12.

**The node test** (`apps/web/test/journey.test.ts`) plays the beats through `applyEvent` with `auto=1`. It checks:
1. at every §2 checkpoint, the live set, the ghost set and the counter equal the checkpoint table exactly;
2. at every tick, live faces = instances with a `working` task, plus stuck ones, and never more than 3 ghosts;
3. every `spawn` or `revive` comes before its task's `working`, and every `end` after its last task's end;
4. with `slots=1`, never more than one `working`, and in 7c one live Animator with three ghosts;
5. animator:s01 and animator:s02 keep their ids through their returns, and no second instance with their label ever exists;
6. the final counter is 12;
7. spend is $2.14 ± 0.01;
8. no gate or `rights` pick passes except on a person's action (`by: "user"`);
9. every bubble, announcement and milestone the run emits matches its §5 template.

## 7. Needs from the backend

Checked against `docs/PIP-ORCHESTRATION.md` as it stands today. The first list is what the UI uses as that doc defines it. The second is what the UI still asks for, or where the two differ.

### 7.1 Used as specified there

- `ProjectState.plan: PlanView | null` and SSE `plan {view, revision?}` (§4.2, §4.3). The stage nav and the "Plan · rev N" disclosure read from `GET /api/p/:id/plan/revisions`.
- `ProjectState.instances: Instance[]` and SSE `instance {instance, change}`.
  - The UI uses `state`, `ghost`, `running`, `label`, `subject`, `model`, `lives`, `reason`, `endReason`, `usd`, `outcome` and `lastReport`.
  - Each `change` maps to the motion in §3.1: `ghost` = enter as a ghost, `spawn` = enter live (or ghost → live), `live` and `idle` = solidify or go dashed, `end` = the finish hold and fold, `revive` = enter from the counter.
- `Task.instance`, `Task.planTask`.
- The `kind: "plan"` milestones: "Plan ready · N tasks to start" and "Plan changed: <reason>".
- The `rights` plan node as a person question, never auto-passed (their C2). The UI shows it with NeedsYou as "Your logo on the sign. Use it in the video?", with "Use it" · "Redraw".
- `GET /api/p/:id/instances/:iid/log` for the kept log, and `POST /api/pip {about: {instance}}` for "Ask Pip about this".
- Drafts:
  - `POST /api/drafts {from?}`, `GET`/`DELETE /api/drafts/:id`, `POST /api/drafts/:id/files`, and `PATCH /api/drafts/:id/refs/:name` for the rights chips;
  - `GET /api/drafts/:id/composer` and `POST /api/projects {draft}` for "Show all options";
  - the `pip` events with `draft` on `/api/events`;
  - `ProjectSummary.draft` and `needs`.
- The `brief_fields` form card (`fields: BriefFieldAsk[]`, submitted with `values`) and the `brief` card (`fields`, `refs`, `estimate`, `eta`, `preview`, `warning`, `status`, `result.projectId`). The question card in §3.5 renders `BriefFieldAsk` choices, and the brief card renders `preview.line`.
- `GET /api/workspace/line` for the Projects line.
- The registry's `audience` field (their §3.2), which covers C15.

### 7.2 Still needed, or different

| # | The UI needs | Why | There today |
|---|---|---|---|
| N1 | A reason on each life: `lives: {from, to, reason}[]` | the return bubble and announcement ("Brought the Animator back to fix the scene 1 headline") | one `reason` per instance (the spawn) |
| N2 | `whoInstances?: {instance, label}[]` on plan cards | `who: RoleT[]` can't say "Animator · scene 2" | `PlanCard & {revision?}` |
| N3 | Ordering: an `instance` `spawn` or `revive` before its task's `working` event, and an `end` after its last task event, in stream order | the row would flash a face with no work, or a working task with no face | not stated |
| N4 | `GET /api/p/:id` carries `plan` and `instances`, so a reconnect re-baselines without animating | §3.1 never animates what loads | implied by `ProjectState` |
| N5 | Role words in sentence case ("Pixel artist", "Art director") in `label` and `reason` | the kit and `ROLE_LABEL` (C14) | `ROLE_WORD` "Pixel Artist" |
| N6 | `crew.slots` in state | the ghost popover: "Waiting for a free slot. 3 are working." | slots exist in the executor; not on the wire |
| N7 | `PATCH /api/drafts/:id {fields}` | the composer's "‹ Back to the conversation" keeps its edits without a model call | no draft fields write |
| N8 | Draft creation on the first send or drop, not on opening `/new` | an opened-and-left `/new` must not leave an empty draft | `POST /api/drafts` returns Pip's first item; the UI calls it late |
| N9 | Per-field labels in the card may be Pip's wording: "Investors", "Users", "A launch post" | the brief's step 3 copy | allowed ("only the label wording is Pip's"); the mock uses these |
| N10 | `ChannelMsg.ref` set to the instance's subject or task id on every brief, ask, answer and report | the kept log and the drawer filter by instance | the log endpoint filters this way |
| N11 | A note on the ghost horizon: no ghosts while only a person's pick is open | §2's checkpoints rely on it (C2); if the backend instead counts an open gate as a horizon source, steps 6, 7a, 9 and 10 change | follows from "running or ready" |

## 8. Open questions for the person

- **Q1. What "Only the key picks" covers.**
  - Today `key` stops at all five gates (G0–G4), and a brand asset is always the person's call.
  - The journey above shows all of them (C10): 6 picks including Start.
  - Should `key` skip the pacing (G2), or fold the final (G4) into the rough cut's "Looks good"? Either one would bring the run back to the brief's three picks.
