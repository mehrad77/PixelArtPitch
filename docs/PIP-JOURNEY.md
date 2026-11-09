# Pip runs the show: the journey (UI spec)

This is the UI half of "Pip runs the show". `docs/PIP-ORCHESTRATION.md` owns the wire contract (plan, instances, executor). This file owns what the person sees, hears and presses. Where they differ, the contract wins and this file is updated. §7 lists what the UI relies on and what it still asks for, so the two can be reconciled.

The canonical run is "Make a 30-second pitch for my todo app". The product is QuestDay, which is fictional (`examples/questday`). Every number below comes from the **roster** (§2). The mock plays the same roster (§6), so the strings, the finished count and the tests all agree.

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

This file now matches those answers: the roster (§2), C7–C12, the brief card (§3.5), the journey (§4), the strings (§5) and the mock (§6) have no sign and three picks. §9 says what the UI's P1 built, in mock.

## 1. Departures from the brief, for the OK

| # | Changed from the brief | Why |
|---|---|---|
| C1 | No "Crew" lane on the timeline (D3) | The timeline is video time and instances live in wall-clock time. The run history is in Finished: start, duration. |
| C2 | A face means a running task. Ghosts follow the server's horizon rule (`Instance.ghost`, ORCHESTRATION §2): a ready task, or a pending one within 2 hops of a running or ready task, gates transparent, at most 3 (D4) | Read literally, "queued" can't show the Director in step 5: it waits on a pick, not a slot. One rule, computed once, so the UI and the mock agree. While the crew waits on a pick, nothing is running, so there are no ghosts. |
| C3 | A redo brings back the same instance: same label, its log continues, and it leaves Finished (D5) | One "Animator · scene 1", not two. |
| C4 | `/new` asks one question card with 3 fields or fewer, then the brief card (D6) | The brief had two cards in a row. |
| C5 | The Projects line is built from state, with no model call (D7): `GET /api/workspace/line` | Free, instant, and the same on any model. |
| C6 | An unstarted `/new` leaves a draft, listed on Projects and removable (D8) | Nothing is lost. Only the conversation is on disk. |
| C7 | "about 11 crew members", not "about 7 people" | 10 rev 0 instances plus the new drawing's placeholder (§2). People see faces, so we count faces. |
| C8 | "11 have finished", the brief's count | Rev 1 turns the placeholder into Pixel artist · founder: 10 + 1. The redos add none (C3). (With the sign, before Decision 1, it was 12.) |
| C9 | Milestone "Plan ready · 11 tasks to start", not "6 tasks to start" | N is the non-gate tasks of rev 0 (§2), counted as the backend does. The picks are on the brief card. |
| C10 | One pick is added: the logo (the `rights` node), right after the import at step 5 | RIGHTS.md §3: using a brand asset "is always the user's call". Decision 2 settles the rest: under "Only the key picks" G2 passes in code and the G3 press passes G4, so the person picks 3 times (the script, the logo, the rough cut). |
| C11 | Scene 4 animates beside the founder's drawing; when it is drawn, two of scenes 1–3 start and the third is a ghost "waiting for a free slot" | `defaults.concurrency` is 3, and D4. Scene 4 (the end card, with the logo toast) needs no new art, so it doesn't wait for the drawing (ORCHESTRATION §1.3, expansion). |
| C12 | Step 10: the card settles with "Scene 2 redone; the hero is 2× now." The rough cut (G3) comes back, and "A new video is exported" moves to step 11 | The export runs after G3 (`deliver` → `deliver.export` → G4). Pip can't pass G3 for the person. Its "Looks good" also passes G4 (Decision 2). |
| C13 | "Only the key picks", not "Just the key picks" | The kit's writing rule: cut "just". |
| C14 | Role names follow `ROLE_LABEL`: "Pixel artist · founder", "Art director" | Sentence case, as in the kit and the existing UI. ORCHESTRATION §2 writes "Pixel Artist" (`ROLE_WORD`): to reconcile (§7). |
| C15 | "Who's it for?" needs an `audience` field in the brief field registry | `Brief.audience` exists in the schema. The brief's registry left it out. |
| C16 | The estimate line says "plus the time your picks take" | 10 minutes is crew time. The three picks are the person's. |

## 2. The roster (the source of every number)

`apps/web/src/mock/journey.ts` plays this roster, and `apps/web/test/journey.test.ts` reads the checkpoint table below from this file, so the two can't drift. After the Decisions above there is no sign: the logo is imported as is (`asset.import`, the Art director, code, $0), and the `rights` pick for it sits in the plan before scene 4, whose achievement toast shows it as a 16 px icon.

- Plan rev 0 comes from the rules skeleton (the server's first plan is rev 0, N26), with the 4 scenes expected for 30 s. The new drawing is a placeholder (priced, with no face) until the cast says what it is.
- Pip's revision adds nothing at G0 (D1).
- Rev 1 (by code, the expansion) turns the placeholder into Pixel artist · founder, when the Art director's cast finds no founder sprite (step 7b). It was priced in rev 0, so it needs no 20% card.
- Rev 2 (by code) sends scene 1 back for the headline (step 9). Rev 3 is the person's change (step 10).
- A retry inside a task (step 8, `attempt: 2`) is not a revision. Gates are code-inserted, not instances.
- The mock folds an asset chain (spec → draw ×2 → judge) into one `asset.draw` task on the Pixel artist; the backend runs the whole chain.

| # | Instance (label) | Role | Task kinds | Joins | Leaves | Returns | $ |
|---|---|---|---|---|---|---|---|
| 1 | Writer | writer | `writer.angles` | 5 | 6 | – | 0.22 |
| 2 | Art director | art-director | `asset.import` (the logo), then `art.cast` | 5 (it asks the logo pick, then idles as a ghost; without a logo it joins at 7b) | 7b | – | 0.00 |
| 3 | Director | director | `director.storyboard` | 7a (ghost from 5) | 7a | – | 0.18 |
| 4 | Pixel artist · founder | pixel-artist | `asset.draw` (rev 1) | 7b (ghost after rev 1) | 7c | – | 0.31 |
| 5 | Animator · scene 4 | animator | `scene.tune` (the end card, with the logo toast) | 7b, beside the founder | 7c | – | 0.12 |
| 6 | Animator · scene 1 | animator | `scene.tune` | 7c | 7c | 9 (headline fix, +0.05) | 0.19 |
| 7 | Animator · scene 2 | animator | `scene.tune` | 7c | 7c | 10 (rev 3, +0.08) | 0.20 |
| 8 | Animator · scene 3 | animator | `scene.tune` ×2 tries | 7c (ghost, "waiting for a free slot") | 8 | – | 0.19 |
| 9 | Mixer | mixer | `sound.mix` | 8 (ghost from 7c) | 8 | – | 0.10 |
| 10 | Reviewer | reviewer | `review.final` r1, r2, r3 | 9 (ghost from 7c) | 9 (r2 ran while it was idle, +0.03) | 10 (r3, +0.03) | 0.14 |
| 11 | Editor | editor | `deliver.export` | 11 | 11 | – | 0.00 |

- Rev 0 has 10 instances and 11 tasks ("Plan ready · 11 tasks to start"; 10 without a logo). The brief card counts the new drawing's placeholder as one more crew member: "about 11 crew members".
- Under "Only the key picks" (Decision 2) the person picks 3 times: the script (G1), the logo (`rights`) and the rough cut (G3). G2 passes in code, and "Looks good" at G3 also passes G4. Start (G0) is the brief card's button.
- The crew spends $1.65 and Pip's own six metered turns $0.12 (the revision after Start, the answer to scene 3, the rough cut, the change card, the export, the why), so the run costs **$1.77**. That is inside the brief card's $1.40–2.20, under the $3 cap. The change is $0.11 (Animator $0.08, Reviewer $0.03) plus Pip's card, "about $0.12".
- **The final line under the row is "11 have finished · See who worked".**

**Dependencies** (they decide the ghosts; gates are written `[G1]`):
- `writer.angles` and `asset.import` (the logo), both right after G0
- `asset.import` → [rights]
- `writer.angles` → [G1] → `director.storyboard` (which also waits on the import, so the Director sees the logo in its list)
- → `art.cast` → [G2]
- → `asset.draw` founder (rev 1), and `scene.tune` s4, which needs [G2] and [rights] only
- → `scene.tune` s1–s3, which need the founder
- → `sound.mix`, which needs all four scenes
- → `review.final` → [G3] → `deliver.export` → [G4]

**The row at each checkpoint**, by the horizon rule (C2), with `slots=3`. The node test asserts these rows, in this order.

| Checkpoint | Live | Ghosts | Finished |
|---|---|---|---|
| 5: the crew comes in | Writer, Art director | Director, Animator · scene 4, Mixer | – |
| 5: the logo pick open (the Art director asks) | Writer, Art director | Director | – |
| 5: the logo picked, Writer working | Writer | Art director, Director | – |
| 6: G1 open (the Writer asks) | Writer | – | – |
| 7a: Director working | Director | Art director, Animator · scene 1, 2 | 1 |
| 7b: Art director casting | Art director | Animator · scene 1, 2, 3 | 2 |
| 7b: after rev 1 | Art director | Pixel artist · founder, Animator · scene 1, 2 | 2 |
| 7b: the founder drawn, scene 4 animated | Pixel artist · founder, Animator · scene 4 | Animator · scene 1, 2, 3 | 3 |
| 7c: the founder done | Animator · scene 4, 1, 2 | Animator · scene 3 (free slot), Mixer, Reviewer | 4 |
| 7c: scene 4 done | Animator · scene 1, 2, 3 | Mixer, Reviewer | 5 |
| 7c: scene 1 done | Animator · scene 2, 3 | Mixer, Reviewer | 6 |
| 7c: scene 2 done | Animator · scene 3 | Mixer, Reviewer | 7 |
| 8: Mixer working | Mixer | Reviewer, Editor | 8 |
| 9: Reviewer working | Reviewer | Editor | 9 |
| 9: scene 1 back | Animator · scene 1 | Reviewer (idle, round 2 pending), Editor | 8 |
| 9: round 2 | Reviewer | Editor | 9 |
| 9: G3 open | – | – | 10 |
| 10: scene 2 back | Animator · scene 2 | Reviewer, Editor | 8 |
| 10: round 3 | Reviewer | Editor | 9 |
| 10: G3 open again | – | – | 10 |
| 11: Editor working | Editor | – | 10 |
| 11: the final passed, and after | – | – | 11 |

- A member whose task waits on the person stays live, its face in the "needs you" mood, with its pick under Pip's line; it is finished only once answered (N19). So the Art director stays while the logo pick is open, and the Writer stays through the G1 pick; the finished count reaches 1 when the script is picked.
- Without a logo (the draft had no logo file) there is no import, no logo pick and no logo toast: the Art director first joins to cast at 7b, rev 0 has 10 tasks ("Plan ready · 10 tasks to start"), the person picks twice (the script and the rough cut), and the run still ends at +11 and $1.77 (the import costs $0). The test plays both.
- The first row lasts one tick (the import). Animator · scene 4 and the Mixer are ghosts there because the horizon walks `asset.import` → [rights] → s4 → mix, though s4 also waits on G2, far off. That is the rule as ORCHESTRATION §2 states it; §7.2 N12 asks whether a pending task should need all its dependencies within reach.
- With `slots=1` the Animators run one at a time: when the founder is done, one Animator is live and the other three are ghosts (§6, test 4).

## 3. Screens and components

### 3.1 The crew row (simple view, `CrewStrip`)

The order is Pip first, then live faces in join order, then ghosts. The row holds only those, and it is start-aligned, never centred: Pip's face sits at the row's inline start (left in LTR, right in RTL), right above Pip's conversation, whose vertical rule hangs from the bottom of the face; the crew follows toward the inline end and wraps after Pip. Who has finished is one quiet line under the crew faces, aligned with the first of them (never under Pip, so it doesn't cut the rule); with nobody live it sits just after Pip's column, on its middle. The row never scrolls sideways.

| State | When | Face | Accessible name (button) | Visible |
|---|---|---|---|---|
| **live** | the instance has a task `working` | the role's calm glyphs, blinking as today; `lg` size | "Animator · scene 3, working" | the caption under the face |
| **stuck** | its task `failed` and `problemOf` names it | `x x` | "…, stuck" | the caption; it stays until the problem is fixed, and never leaves the row |
| **needs** | its task is `waiting_user` | `' '`, looking up | "…, waiting for you" | the caption |
| **ghost** | `instance.ghost` is true and nothing is running for it (the server's horizon rule, C2) | `· ·`, a dashed `--stroke-control` edge, `--text-muted` ink, no hue fill | "Director, up next", or "Animator · scene 4, waiting for a free slot" (its task is ready) | the caption, muted |
| **finishing** | for `FINISH_HOLD_MS = 2000` after its last task ends | done: `^ ^` with a ✓ badge on the disc's block-end inline-end edge. stopped (dropped or cancelled): `– –` with a ■ badge. The trade mark stays inside the disc | "Writer, done", or "…, stopped" | the caption, and the word "done" or "stopped" on its own line under it |
| **finished line** | at least one instance has ended (hidden while nobody has) | none: one muted line under the row, at the row's start, in body size; "See who worked" is a link-style button | "See who worked, 11 have finished" (the button) | `<bdi>11</bdi> have finished · See who worked` ("1 has finished") |

- **Ghost cap.** At most 3, nearest first, as the server sends them. The rest show only in the drawer's "Up next". A finished instance whose new task is pending (D5) leaves Finished and shows as a ghost if it is on the horizon.
- **Caption.** The qualifier after " · " ("scene 1", "founder"), in `--step--2` mono, `max-inline-size: 8ch`, with an ellipsis. The full label is in the name and the popover. An instance without a qualifier has no caption.
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

- **Popover** (pressing a face): label, Pip's reason for bringing it in ("Brought in the Writer for three script angles."), the line about it, its last picture, "Ask Pip about this", "See what it's doing". A ghost's popover says "Starts after the script pick" or "Waiting for a free slot. 3 are working".
- **The finished line.** "See who worked" opens the crew drawer on its Finished group (the newest finished member selected). The count counts a member as soon as its ✓ hold ends, so it ticks up while the face fades.

**Motion.** Pip brings the crew in and takes them back: a face comes out of Pip and merges back behind it when it is done. Moves are short and smooth (`--ease-enter` in, `--ease-exit` out), so a busy row keeps up with the crew; only the conducting baton steps. Durations come from the kit tokens.

**One row.** The row is always Pip, then one face per crew member. A project with no crew instances yet (before Pip's plan, or an older project) shows its departments in the same row and shapes: working ones live, finished ones in the count under the row, the rest as quiet upcoming faces.

**Thought bubbles** sit over the face they belong to, placed from where each face rests, so faces spawning together never pull their bubbles toward Pip. They are laid out again when faces join or leave, the row resizes, or the page scrolls. When there is no room above the row (under the sticky header or the window's top), they hang below the faces, with the dots trailing up.

| Event | Without reduced motion | With reduced motion |
|---|---|---|
| Enter (a face first shows in the row, live or as a ghost) | It comes out of Pip: it starts at Pip's centre (`--pip-x`/`--pip-y`, measured from where the face will rest), at scale 0.3 and hidden, and flies to its place, on `--ease-enter` over `--dur-slow`. Pip sits above the row, so the face appears from behind it. Several in one batch stagger by half of `--dur-fast`. | It appears in place |
| Ghost → live (`spawn` or `live` on a face already shown) | The edge turns from dashed to solid and the hue fills, `--ease-enter` over `--dur-fast`. Nothing moves. | instant |
| Ghost leaves the horizon (a pick opens) | The same merge as a finish: back behind Pip, then the slot closes | fades out over `--dur-fast` |
| Finish (`end`) | The glyphs swap to `^ ^ ✓` (a whole step). After 2 s it merges back behind Pip over `--dur-slow` × 1.5 on `--ease-exit`: it flies to Pip's centre and shrinks to 0.3, fading as it reaches Pip; then its slot closes, so the faces after it slide over instead of jumping into a hole. The count in the line under the row ticks up as it goes. | The ✓ still holds for 2 s, then it fades out over `--dur-fast` (no flight, no slide) |
| Return (`revive`, D5) | as an entrance: it comes back out of Pip; the finished count goes down by one | appears |
| Pip conducting | once per batch that has a `spawn` or a `revive` (§3.2) | a still baton for 1.2 s |

- Only live changes animate, never what loads. Take a baseline of the instances on mount and again on every reconnect (`conn` back to `open`), as `useThoughts` does, and animate only what changed against it.
- No layout tweening: the siblings never slide.
- A face that holds focus, or whose popover is open, stays in the row until focus leaves it; only then does it fade or go. Its finish holds (✓, full opacity) past the 2 s while its popover is open: a face that faded under an open popover left the popover floating unanchored and stale over the card under the row, where a press on "Change something" landed on "See what it's doing" and opened that member's drawer (the P4 run's Reviewer). A ghost that leaves the horizon closes its popover with it.
- **Needs you** comes from a row waiting on the person (`waiting_user`) or a plan task waiting on them (`waiting_person`: the publish question's Librarian); the angle pick and the rights OK put the member they depend on in "needs you" (the Writer), as the server's instance fold does. **Stuck** (`x x`) is only for a live problem (`problemOf`: none while the crew runs past it), and its popover carries the problem's one button (`ProblemButton`: Try again, Fix the key, Use a different model, Add budget).
- Each move ends on its `animationend`; a page in the background never sends one, so a timer settles it too.

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
| **Up next** · N | every not-started instance in the plan, and every idle one (the Art director between the logo and the cast, the Reviewer between rounds), in plan order, each with a dashed face and its ghost line ("Starts after the script pick."). Nothing is capped here. |
| **Finished** · N | ended instances, newest `endedAt` first. One line each: face (`^ ^` or `– –`), label, model, time alive, $, outcome |

- **A Finished row**, at 375px on two lines:
  - Line 1: `<face> Pixel artist · founder`
  - Line 2: `Sonnet 5.5 · 3 min · $0.31 · ✓ done`; with more than one life, `Sonnet 5.5 · 4 min · 2 lives · $0.39 · ✓ done`. Model names are `modelShort` everywhere ("Opus 5.5", a local one "gpt-oss 20b")
- **Outcome words** (always an icon and a word): `✓ done`, `◐ partly done`, `■ stopped`, `✕ failed`.
- **Time alive** is the sum of its lives (`from` → `to`), so a return adds up; "N lives" follows it when there is more than one.
- **The kept log renders the log's entries as they come**: a task id the state holds gets its title and status; one it doesn't (a project from before the plan, whose rows carry no `instance`) is "Earlier work". A kept row with no end time ends with the life it ran in.
- **The kept log** (opening a finished row) is read-only:
  - A header: label, model, outcome, $, "Joined 21:04 · Left 21:07". Every time is in `<time datetime>`.
  - Pip's reason in quotes: Joined "The library had no founder sprite." Left "Drawn and approved."
  - Then the existing `TaskGroup` threads for every task it ran, oldest first.
  - Then its messages with Pip (Behind the scenes, filtered by instance).
  - A return shows as a hairline marker: "Back for a fix · 21:12".
  - No message box. In its place, one button, "Ask Pip about this". It selects Pip in the same drawer, with a scope chip "About the Pixel artist · founder ×" at the start of Pip's field and focus there, because the person pressed it. The field stays empty for the person's words. The turn is sent with `about: {instance}` and the words "About the Pixel artist · founder: <text>" (the server strips that lead before it matches a command, and a command such as `/context` is sent bare). The chip clears after the message goes, or with its ×; it lives in the conversation's store, so the drawer's field and the simple view's show and clear the same one. Words put in a field (the /new examples, the steer popover) are taken once and leave the store, so a field that mounts later never fills them again.
  - The log comes from `GET /api/p/:id/instances/:iid/log`.
- Esc closes the drawer and returns focus to the face, or the "See who worked" button, that opened it.
- A working member's pane is its live thread (its tasks' transcripts) with "Ask Pip about this" and the message box one step away (`DirectControls`), as before.
- **Steps are named, not "Sent the prompt".** A model call reads as what was asked and what came back, from its prompt card and the task kind the server logs with it (`detail.kind`): "Asked for variant 2" → "Drew variant 2", "Asked for a critique of variant 1" → "Critiqued variant 1", "Fixed the grid of variant 1" (a repair), "Picked the better one" (the judge), "Wrote the spec", "Read the brief", "Wrote three angles", "Sketched the storyboard", "Tuned the motion", "Watched the cut" (`lib/activity.ts` `stepWords`, `stepsOf`). Each carries a small task icon that stays in view when its prompt and answer are folded. A task group's head names the asset and the variant ("Drawing the moth · variant 2"). The last answer still shows the task's summary under its name.
- **Code-only steps leave a line** (`step`): the standard check ("Checked variant 2 against the PAP standard: it passes"), the judge by the rules (one variant passed: a short "Choosing the best moth" row, "Picked variant 2: the only one that passed the standard"), the publish question and answer, the script pick, a cast with nothing new. So "Nothing has happened here yet" and "No record kept for this one" mean just that.
- **The working step is live** (the `progress` event, `docs/API.md`): "Thinking… about 4,200 tokens · 48 s", then "Writing…" with the answer's newest words as they stream, in a dashed bubble at the end of the thread. Tokens are estimated, so the line says "about".
- **The live canvas** (Settings › Experimental, per browser, off by default): while a Pixel Artist draws, the working step paints the grid it is writing, a whole row at a time, at 6× in whole cells, in the drawing's own palette (sent with the event). The face's popover shows it in place of the last picture. After the judge, the face's picture is the chosen variant (the judge row's `lastImage`).
- A stuck member's pane says the live problem under its name, with its one button.
- **The Project picker** (the header's Crew button, with more than one project) sits in the head row, on one line between the title and the ×: a small muted "Project" label, then the select (about 17rem, at the inline end). The kit Dialog takes no head content and its head is a `<form method="dialog">`, so the picker stays in the body (no nested form) and is laid over the head, which keeps its height. Under 40rem it takes a second line under the title, full width, and the head's rule moves under it. It mirrors in RTL.

### 3.4 Studio, the Crew tab (`CrewRow`)

- Pip stays pinned first.
- The department rows become instance rows, grouped Working, Up next, then a **Finished · N** Disclosure. It is open while nothing is live, and closed otherwise, until the person toggles it; then it stays as they left it.
- **Instance row**: face, label, model chip, status badge (word), $, time, "Ask Pip", "Details". Details opens the crew drawer on that instance; no more TaskDrawer for instances.
- **A "Plan · rev 3" Disclosure** at the end: one line per revision, newest first ("rev 1 · 21:06 · Pip: added a Pixel artist for the founder: the library had no founder sprite."). The author word is "Rules", "Pip" (Pip's and code's revisions) or "You"; the reason is the revision's, its first letter lowered.
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
1. "About <bdi>$1.40–$2.20</bdi>, ready in roughly <bdi>10 minutes</bdi>, plus the time your picks take."
2. "About 11 crew members over the run; most art comes from the library, one new drawing and your logo in an achievement toast." (`preview.line`)
3. "You'll pick 3 times: the script, your logo and the rough cut." (`picks`, a UI extension on the card; "Every step" says "5 times: the script, the pacing, your logo, the rough cut and the final"; "Let the crew run" says "The crew runs on its own; you'll only say yes to your logo.")

Buttons: **Start** (primary) · **Show all options** (quiet).
- If the estimate's p90 passes the cap, a warning: "This may pass your $3 cap. Raise it to $4, or ask me for a shorter video. The guard holds at the cap." Start stays pressable.
- **Show all options** opens `/new/:id/options`: the old `ComposerPage`, filled from the draft's fields.
  - Its submit starts the draft as the brief card's Start does.
  - "‹ Back to the conversation" saves its fields to the draft, with no model call.
  - It never depends on a model.

### 3.6 Projects

- **The head**: Pip's line with Pip's face, then one primary button, **"New video"**, which goes to `/new`. There is no visible "Projects" heading (the app header's Projects item names the page); the page's one `<h1>Projects</h1>` is visually hidden, for screen readers. With no projects at all, Projects goes straight to `/new` (replaceState).
- **Pip's line** is `WorkspaceLine.text` from `GET /api/workspace/line`, built on the server from state.
  - At most 3 clauses, ordered finished → working → waiting, so it ends on what needs the person: "QuestDay teaser is finished. Lantern is waiting on one pick from you."
  - Each `part` makes its project's title a link to that project.
  - "Nothing needs you right now." when no clause applies.
  - It refreshes when the projects list does. The page's polite region gives it once per change.
- **Drafts.** A group, "Drafts · N", is shown last.
  - Each card has no thumbnail (an empty-stage box), the title (from the idea: "QuestDay pitch"), the mark "✎ Draft", Pip's last question as the line (the summary's `status.line`), and "Started <time>" (the summary's `createdAt`, N14).
  - The card links to `/new/:id`.
  - A project card's ⋯ menu has "Remove…" (not while a crew works on it). Its Dialog, "Remove <title>?", says the project leaves the list and shows its folder, which stays untouched. **Remove from the list** (danger), **Move to the trash** (only for a project in PixelArtPitch's own projects folder: it moves to `<PAP_HOME>/trash`, nothing is deleted) and **Keep it**.
  - Its ⋯ menu has "Remove draft". That opens a Dialog: "Remove this draft? Only the conversation is saved, and it goes too." with **Remove draft** (danger) and **Keep it**.
- **"Make another like this".**
  - It is in a finished card's ⋯ menu and in a finished project's Pip chips. The chip doesn't ask Pip: like the menu item, it calls the route directly, with no model call.
  - It calls `POST /api/drafts {from}`, which inherits the audience, length, narration, involvement, profile, style and budget (not the idea or the references). Then it goes to `/new/:draftId`, on a new stage (the stage that made the project never carries over).
  - Pip's first line there: "Another one like QuestDay teaser: same style, cast and settings. What's this one about?" It is the stage's line, in place of "What are we making?", and the thread leaves it out.
  - Pip repeats only what the person said, never what the copy inherited. With every askable field inherited, the idea alone brings the brief card straight away ("Got it.").
  - Typed instead ("make another one like this"), Pip answers with a plan card, "Make another video like this", whose confirm makes the same draft: its result carries `draftId` (N25), and the card ends at the same place, `/new/:draftId`. It goes there on its own only in the tab where the person pressed "Make it"; elsewhere the card's result links to it ("Go to the new video").
  - A failure is one line: under the card on Projects ("✕ Didn't start another one: …"), or under Pip's field for the chip.

### 3.7 375px and RTL

| Screen | 375px | RTL (fa) |
|---|---|---|
| Crew row | Pip stays at the start; the faces wrap after it. The faces stay `md`, a live face `lg`. The captions clamp at 8ch. The finished line sits under the first crew face. | The order mirrors with the flow. The spawn offset flips under `:dir(rtl)`. Bubbles use the layout's existing `rtl` branch. |
| Pip's line and thread | the existing simple view | every text node `dir="auto"` |
| Question card | The fields stack, and the radios run in one column. The file row wraps: name, then the chips. | The file name is in `<bdi class="ltr" translate="no">` |
| Brief card | The `dl` turns into label-above-value pairs | Money, durations, counts and times in `<bdi>`, numbers through `Intl` for the page's `lang` |
| Drawer | full width; the groups sit in a list above the pane (at most 14rem, it scrolls), each row with its full text | the rail sits at the inline-start edge |
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
- **Milestones without the server's** (an older server): the web derives them from finished tasks (`milestones`). A picked drawing names its asset ("Founder drawn"), one per asset, or says "Picked the drawing" when the task's title names none.
- **The thread as turns** (the simple view, `NewestThread`): each turn is its own framed block, read top-down: your message as a bubble at the inline end (a scope shows as a quiet "About the moth" line over its words), Pip's reply and its card as a bubble at the inline start under it. A message Pip starts on its own is a turn of its own. Turns are newest first, with the time at the top of each frame, so you read down inside a turn and back in time between turns. A reply that carries a card takes the turn's width. **The milestones share the turns' timeline** (v0.5.2; v0.3 had them in a track of their own beside the turns): one list, "Timeline · newest first", with a spine at the inline start and a dot per entry. A turn hangs its frame off a ring dot; a milestone is one quiet line (time, then its words) with a smaller dot; the newest entry's dot is lit, whichever kind it is. At the same moment a turn comes before a milestone. The three newest milestones always show; a run of milestones between two turns keeps its first and folds the rest into "N more milestones" (a button, `aria-expanded`, "Hide these N milestones" once open), but never folds just one. A milestone said twice in a row is one row, and a long one is cut on a word with "…" (`lib/thread.ts` `trackOf`, `timelineOf`, `foldRuns`; `lib/text.ts`). The sheet has no panel of its own: the timeline sits on the page. Studio's Pip tab and the drawer keep the oldest-first thread, its milestones as hairline rows by time.
- **A plan-change card** (a revision past the 20% line) shows its price as a diff: the old total dimmed and struck, "about $1.95" large, and a "+$0.91" chip; the title loses its price ("Plan change"). The crew is named by instance, the planner first: "Director re-planned · brings in Animator · scene 2 and Reviewer" (`revision.planner`, `whoInstances`), with one face per role; any plan card with `whoInstances` names them that way. Its last line says what really waits (`docs/API.md`).
- **Nothing in the simple view goes to Studio.** "Change something" on a gate opens a text field on the card; a face opens its popover and the crew drawer; a problem's button goes to Settings at most (a key, a model). "Record narration" opens the record page (`/p/:id/record`), its own page, not a Studio stage.
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
  - Pip's face conducts (P2). The Writer and the Art director slide out from Pip together: the Writer for the script, the Art director to bring in the logo.
  - For the one tick of the import, three ghosts show: Director, Animator · scene 4 and Mixer (the horizon walks import → [rights] → scene 4, §2). The import ends and the Art director stays as a face in the "needs you" mood while it asks; once the logo is picked it goes idle and shows as a ghost, and the ghosts are Art director and Director ("up next").
  - The `rights` pick opens under Pip's line, with the 16 px icon as its picture and "Private to this project":
    - "Your logo in an achievement toast. Use it in the video?", the recommended "Use it" shown.
    - Buttons: "Looks good" · "Change something" (Use it, Leave it out). No "Let the crew decide": the question carries `rights` (N15), and the crew never decides it.
  - The URL becomes `/p/<projectId>` with nothing remounted, and the money line appears: "$0.02 of $3".
- **Text**:
  - Milestone: "Plan ready · 11 tasks to start".
  - Bubble over Pip (P2): "Brought in the Writer for three script angles".
  - Pip's line: the status sentence, "Writing your script", then "The artist has a question for you." while the logo pick is open.
- **Changed from the brief**: the milestone text (C9); the logo pick comes here, right after the import (C10).
- **Studio art**: the studio's private art (another project's likenesses and logos, docs/RIGHTS.md §1) is in the Director's asset list too. When the board uses one, the Art director casts it into this project as a copy, flags and all, and its `rights` pick opens after the animatic, the same question as for a fresh likeness or logo. It is never answered for the person.
- **SR**: "Pip brought in the Writer for three script angles. Pip brought in the Art director to bring in your logo."
- **Focus**: Start unmounts, so focus goes to the Pip field.
- **RM**: the faces appear without the slide, and the baton is still for 1.2 s.

### Step 6. The first pick

- **Screen**:
  - The Writer's work is done, but it waits on the person: its face stays, in the "needs you" mood (`' '`, looking up), and its task row reads "Waiting for you to pick an angle" (N19).
  - Nothing is running now, so the ghosts fade (C2). The row is Pip and the Writer.
  - When the person picks, the Writer shows `^ ^ ✓` for 2 s, then fades out in place, and the line under the row reads "1 has finished" (step 7a).
  - The G1 pick (NeedsYou, the Pip variant) sits under Pip's line, after the logo pick if that is still open.
- **Text**:
  - The pick: "Which script should the crew make?", every angle at once, each with its line and its own "Use this one" (The walker carries the word "Recommended" and the primary button), then "Let the crew decide". Picking one answers the question that G1 waits on, so the gate passes with it; there is no separate "Looks good" for G1. On the real server G1's item points at the question (`items[].ref`), and the card shows the gate as that pick: one thing that needs you, counted once in the header and the status line ("The writer has a question for you."). The question blocks the script (`blocks: ["script"]`), so Studio's Script panel shows it too, with all options, and hides G1's own "Looks good" while it is open.
- **SR**: the status region (10 s throttle) gives Pip's line; "Writer finished." comes with the pick.
- **Focus**: unchanged. `Q` jumps to the pick, as today.
- **RM**: the face stays still; after the pick the ✓ holds for 2 s, then the face fades out in place and the line reads "1 has finished".

### Step 7. The crew grows and shrinks

The faces at each moment are the §2 checkpoint table.

**7a. Story.**
- The person picks The walker. The Writer finishes and fades out (1 has finished). The Director slides out from Pip, followed by three ghosts: Art director, Animator · scene 1 and 2.
- Bubble over Pip: "Brought in the Director to board 4 scenes".
- The Director finishes and fades out (2).
- SR: "Director finished."

**7b. Art.**
- The Art director (idle since the import) turns live to cast from the library. The ghosts are Animator · scene 1, 2 and 3.
- The Art director reports `partial`: "No founder sprite in the library."
- Plan rev 1 (by code, the expansion), a milestone in the thread: "Plan changed: added a Pixel artist for the founder: the library had no founder sprite."
- Pixel artist · founder enters as a ghost.
- The cast ends (3) and G2 passes in code (Decision 2). Two faces turn live together, and Pip conducts:
  - Pixel artist · founder, drawing;
  - Animator · scene 4, the end card with the logo toast, which needs no new art.
  - Bubble over Pip: "Brought in a Pixel artist for the founder. Brought in an Animator for scene 4" (merged).
  - The ghosts are Animator · scene 1, 2 and 3, which wait on the founder.
- **Changed from the brief**: no pacing pick; G2 passes in code under "Only the key picks" (Decision 2).
- SR, merged: "Art director is partly done: No founder sprite" (its last report was partial) then "Pip brought in a Pixel artist for the founder. Pip brought in an Animator for scene 4."

**7c. Motion.**
- The founder is drawn (4). Pip conducts: Animator · scene 1 and 2 turn live beside scene 4.
- Animator · scene 3 stays a ghost, "waiting for a free slot". The Mixer and the Reviewer are ghosts too ("up next").
- Scene 4 finishes and fades out (5), and Animator · scene 3 turns live.
- Scene 1 finishes and fades out (6), then scene 2 (7).
- The row never holds more faces than there are running tasks. The ghosts are labelled as ghosts.
- **Changed from the brief**: scene 4 runs beside the drawing, and the third of scenes 1–3 waits for a slot (C11).
- SR: "Pip brought in 2 Animators, one per scene." "Pixel artist · founder finished." "Animator · scene 4 finished." …

**Focus** in 7a to 7c: unchanged throughout. The picks are reached by Tab or `Q`.

**RM**: no slides and no shrinking. The ✓ holds for 2 s, then the face fades out in place.

### Step 8. A member hits a wall

- **Screen**:
  - Animator · scene 3 reports `partial`. Its bubble: "No recipe for two people talking."
  - In Behind the scenes, Pip answers with an `answer` message: "Use a toast for the line and keep both characters left of the box."
  - Bubble over Pip: "Told the Animator · scene 3: use a toast for the line".
  - The Animator stays live, tries again (`attempt: 2`, the same task), finishes and fades out: 8.
  - The Mixer turns live; the Reviewer and the Editor are ghosts. Then the Mixer fades out (9).
- **Text**: Pip's line: the status sentence ("Adding music and sound"). There is no question to the person.
- **SR**: "Animator · scene 3 is partly done: No recipe for two people talking." Then "Mixer finished."
- **Focus**: unchanged.
- **RM**: the bubbles appear and leave without the fade; the faces as above.

### Step 9. The rough cut

- **Screen**:
  - The Reviewer ghost turns live, with the Editor as a ghost. It finds one blocker: "The headline is clipped in scene 1".
  - Code adds review round 2 (rev 2). The Reviewer goes idle and shows as a ghost; it isn't finished, so the finished count doesn't move.
  - Animator · scene 1 **returns from Finished**: it comes back into the row from Pip's side, and the count goes to 8.
    - Bubble over Pip: "Brought the Animator back to fix the scene 1 headline".
  - It finishes and fades out (9). The Reviewer turns live for round 2, finds it clean, and fades out (10).
- **Text**:
  - Milestone: "Plan changed: scene 1 goes back to the Animator for the headline" (rev 2).
  - Pip: "The rough cut is ready. One fix was made on scene 1."
  - The G3 card: "Happy with the cut?", with the buttons "Looks good" · "Change something".
- **SR**: "Pip brought the Animator back to fix the scene 1 headline." "Animator · scene 1 finished." "Reviewer finished."
- **Focus**: unchanged.
- **RM**: as above.

### Step 10. A change request

- **Screen**:
  - The person types "make the hero bigger in scene 2".
  - Pip's plan card: title "Make the hero bigger in scene 2". Who: the Animator · scene 2 and Reviewer faces with their labels (`whoInstances`, N2). Detail: "Animator · scene 2 tunes the size, then the Reviewer checks." "About $0.12 · about 2 minutes". Effects: "Reopens scene 2. Scenes 1, 3 and 4 stay as they are." Confirm label "Ask the crew".
  - On confirm: plan rev 3 (milestone "Plan changed: scene 2 goes back to the Animator for a bigger hero"). G3 locks again.
    - Animator · scene 2 comes back into the row from Pip's side. The Reviewer leaves Finished with its new pending task, and it and the Editor show as ghosts (8).
    - Scene 2 finishes (9). The Reviewer turns live, checks, and fades out (10).
  - The card settles: "✓ Scene 2 redone; the hero is 2× now."
  - G3 comes back under Pip's line, and Pip says: "The rough cut is ready again, with your change."
- **Changed from the brief**: C12.
- **Since v0.5.2 (the change router, PIP-ORCHESTRATION §1.12)**: a note is sorted into a tier before any card. "Make the hero bigger in scene 2" on a recipe scene is an `edit`: Pip sets the recipe's params itself in the same turn, shows a still before and after, says "Done: …" and adds an Undo card, for $0, with no crew. A rule edit (the time of day, the pace) is the card "I can do this now: free". Only a `tune`, a `code_patch` or a `replan` makes the "Ask the crew" card above; its title names the scene by number ("Ask the crew: scene 2, too fast"). The mock still plays this step on the crew path; `scenario=edits` plays it as Pip's own edit.
- **SR**: `PipLive` announces the card. The crew region: "Pip brought the Animator back for a bigger hero in scene 2." "Animator · scene 2 finished." "Reviewer finished."
- **Focus**: "Ask the crew" unmounts, so focus goes to the Pip field.
- **RM**: as above.

### Step 11. Done

- **Screen**:
  - "Looks good" passes G3, and with it G4 (Decision 2). The Editor slides out from Pip (no ghost: the pick had emptied the horizon), exports, and fades out: **11 have finished**.
  - G4 passes as the export ends; no "Approve the final" card under "Only the key picks". ("Every step" keeps it.)
  - The files card: Download (`questday-pitch.mp4`), Subtitles (`questday-pitch.srt`, `.vtt`).
  - The crew row is Pip alone, with "11 have finished · See who worked" under it.
- **Text**:
  - Pip: "Your video is ready. A new video is exported, with scene 2's change."
  - Pip's line: "Your video is ready."
  - The milestone: "Your video is ready".
  - The parts line: Idea, Story, Pictures, Sound and Video each ✓, and beside them the version line "v1 · exported 9 Nov · up to date".
- **Changed from the brief**: C8 and C12; the G3 press passes G4 (Decision 2).
- **SR**: "Editor finished." Then the status region gives Pip's line.
- **Focus**: "Looks good" unmounts on press, so focus goes to the Pip field.
- **RM**: the same, with no motion.

### Step 12. Looking back

- **Screen**:
  - The person presses "See who worked". The crew drawer opens on its Finished group, the newest selected, newest first: Editor, Reviewer, Animator · scene 2, …
  - The Pixel artist · founder row reads: "Pixel artist · founder · Opus 5 · 4 s · $0.31 · ✓ done" (in mock, the compressed time).
  - Opening it shows the kept log (§3.3), with Joined "Pip brought in a Pixel artist for the founder" and Left "Drawn and approved."
  - "Ask Pip about this" puts the person in Pip's field. They ask "why did you add a Pixel artist?".
- **Text**: Pip: "The library had no founder sprite, so I added one drawing. It was $0.31 of your $3."
- **SR**: `PipLive` announces the reply.
- **Focus**: opening the drawer goes into the dialog, as the kit Drawer does. "Ask Pip about this" goes to the field. Esc returns to "See who worked".
- **RM**: the drawer opens without the slide.

### v0.3: what needs you, where you are (the P5 run's UI fixes)

- **Asks in Pip's chat, the drawer too.** What needs you (`needsItems`: gates, picks, questions, narration, a problem) is said under Pip's line in the simple view, and asked again at the newest end of the crew drawer's Pip pane, under "Waiting for you · N", every item at once and answerable there (the same `PickItem`, `QuestionItem`, `GateItem` from `NeedsYouCard.tsx`, their ids prefixed by `where`). The drawer's Pip row says "Waiting for your answer" while one is open, and its thread shows the milestones.
- **Pip's own questions show every option.** A question from Pip, or any with `hold: true` (Pip holds the run until it is answered: "Redo with the Director · Accept the look · Tell Pip what to change"), is a pick: every option with "Use this one", the recommended one marked "Recommended". A hold has no "Let the crew decide" (the crew couldn't); Pip's other questions say "Let Pip decide". Pip is "Pip" in every sentence ("Pip has a question for you."), never "the producer". Two of a hold's answers act differently: "Fix the key" is **Open Settings** (Settings › Providers; saving a key lifts the hold), and "Tell Pip what to change" is **Write it**, which opens a field on the card that takes the focus; **Send to Pip** sends the words as the answer's note (an empty one is never sent: the server keeps the question open without words).
- **Scroll to attention.** When `needsItems` gains a key, the page glides to the ask (`scrollToNeed()`: smooth, centred; instant under reduced motion) and the card shows that ask. The keys on load and after a reconnect are the baseline, so loading never scrolls. While the person is typing (the field, a note) the page stays put and a pill, "Needs you ↓" (or ↑), points at it; pressing it glides there and focuses the ask's first button. Q and "Show me" use the same glide, then focus. With the crew drawer open the page doesn't move: the drawer asks.
- **The picture, full screen.** The picture beside an ask is a button ("View" on hover and focus). It opens a kit Dialog (as wide as the window allows): a contact sheet (`out/contact.png`: one still a second at 1×, six columns of 320×180, the last row partial, `lib/sheet.ts`) steps frame by frame at the biggest whole-number scale that fits, "Frame 5 of 30 · 0:04", with ← → (mirrored in right-to-left), Home, End and the buttons; "Whole sheet" shows it as drawn. Any other picture (a scene's frame, a member's drawing), or a sheet that isn't whole frames, shows whole. Esc closes it and the focus goes back to the picture.
- **A playable rough cut.** With a proxy (the review writes `out/proxy.mp4` with the mix and says `render {kind: "proxy"}`; a HEAD probe finds one from before the visit), Play plays it with sound, unmuted by the press; a browser that blocks sound plays it muted and says so. Under the bar: "♫ Rough cut with sound", or without a proxy "Silent preview, frame by frame". A proxy older than the person's changes (`state.proxy.fresh === false`) is never played: the frames draw, silent, under "Silent preview: the rough cut with sound is catching up with your changes", until the server's re-render lands. The first press always answers at once: the button turns to Pause, and "Loading frames…" with a stepped spinner sits on the frame until one lands. A scene being redrawn (stale) keeps its last good frame ("Redrawing this scene · showing the last good frame"), and a frame that fails keeps the one before, never an empty sky.
- **"Change something" at a gate, priced as you type.** The note goes to `POST /api/p/:id/changes/preview` (debounced, newest answer wins) and the line beside "Send changes" is the server's route and price: "The Director re-boards scene 3, then the Animator redoes it and the Reviewer checks: about $0.14–$0.18, about 2 min." A server without the route falls back to the card's own estimate. "Send changes" asks again ("Yes, send changes") only when the upper price passes $0.50. The rough cut's sheet isn't a checkbox: only scene items are, under "Which scenes need another pass" (optional).
- **Readable text.** "0 of 0 steps" is never said (a stage with no steps of its own says nothing); a done plan card's faces come from its roles by instance (a Director re-plan shows the Director), and an update that carries only the result keeps them.
- **Fix the key, from Pip.** When Pip's own key is rejected, its reply carries the fix (a card `{type: "fix", action: "fix_key", provider}`, or `problem` on the item): "Fix the key", which opens Settings › Providers on that provider with its key field focused.
- **Projects.** A rerun (a change after the video exists) is Working ("Working · v1 plays"), never ✓ Has a video: `running` is read before `version`. The Has a video group is a version and no crew running.
- **Parts and versions, not steps (v0.4).** The page shows what the video has, not where the crew is: five parts (Idea, Story, Pictures, Sound, Video), each an icon and a word ("Story ✓", "Pictures 3 of 5", "Video older than your changes"), from `parts` (never `stage`). A part that isn't ready links to its Studio stage. The card shows the same five as small marks, one screen-reader label: "Idea ready, Story ready, Pictures 3 of 5, Sound missing, no video". A handmade project no crew has worked on is Not started, whatever parts it has.
- **The version line** sits beside the parts (`lib/versions.ts`), in one of four forms:
  - "v2 · exported 3 Nov · up to date"
  - "v2 is older than your changes · **Export v3**"
  - "Making v3 · v2 still plays" (a crew is running; the last version keeps playing)
  - "No video yet · **Export**", only once Idea to Sound are ready. Otherwise, with no version, it says nothing.

  Export (`POST /api/p/:id/export`) is the local render of the next version: "Free: a local render, no model calls". It isn't offered while a crew runs.
- **An old build.** `GET /api/build` says when the served UI is older than its sources: one quiet line under the header, "This studio is running an old build. Rebuild with `pnpm --filter @pap/web build`.", with Hide.

## 5. Every string, by place

| Place | Strings |
|---|---|
| Spawn bubble (over Pip) | `instance.reason` with its leading "Pip " dropped and the first letter capitalized: "Pip brought in the Writer for three script angles" → "Brought in the Writer for three script angles". The reason is the server's, in Pip's words or the catalogue template. It uses the role word with an article, never the qualified label. |
| Return bubble | the reason of the life that opened, made the same way: "Brought the Animator back to fix the scene 1 headline" |
| Batch bubble | one bubble over Pip per change, its reasons joined by ". ": "Brought in a Pixel artist for the founder. Brought in an Animator for scene 4"; one role over scenes: "Brought in 2 Animators, one per scene" |
| Pip's answer bubble | over Pip: "Told the {label}: {text, first letter lowered}" ("Told the Animator · scene 3: use a toast for the line …"); a crew report floats over its own face |
| Pip conducting | the face's name "Pip, bringing in the crew. Ask Pip" |
| SR, spawn and return | the reason verbatim, plus "." A batch of one role over scenes merges to "Pip brought in {n} {Role}s, one per scene." |
| SR, leave | "{label} finished." · "{label} stopped." · "{label} is partly done: {lastReport.couldnt}" (here the qualified label) |
| Ghost names | "{label}, up next" · "{label}, waiting for a free slot" |
| Ghost popover | "Starts after {the script pick / the pacing pick / your logo pick / the rough cut pick / the final pick}." (a pick the person has, or will have under this involvement) · else "Starts after the {label}." (the nearest member still at work) · "Waiting for a free slot. {n} are working." ("1 is working") |
| Face popover | the label; Pip's reason as a bubble ("Brought in the Writer for three script angles."); one line (its task, "Waiting for you.", the problem, or its end reason); its last picture; "Ask Pip about this" · "See what it's doing" |
| Finished line | "{n} have finished · See who worked" ("1 has finished") · the button's name "See who worked, {n} have finished" |
| Drawer groups | "Working" · "Up next" · "Finished" |
| Outcomes | "✓ done" · "◐ partly done" · "■ stopped" · "✕ failed" |
| Drawer, Finished row | "{modelShort} · {time alive} · {n} lives · {$} · {outcome}" ("{n} lives" only past one) · a log task the state lacks: "Earlier work" |
| Model names | `modelWords`: "Sonnet 5.5 · Anthropic", a local model "gpt-oss 20b · LM Studio" (its last path segment, a hyphen before a number read as a space); `modelShort` is the part before " · " |
| Studio, Plan | "Plan · rev {n}" · "rev {n} · {time} · {Rules / Pip / You}: {reason}." · "Loading the plan's changes…" · "No changes kept for this plan." |
| Kept log | "Joined {time}" · "Left {time}" · "Back for a fix · {time}" · "Ask Pip about this" |
| Milestones (server, `kind: "plan"`) | "Plan ready · {n} tasks to start" · "Plan changed: {revision.reason}", the reason verbatim with its first letter lowered |
| `/new` | "What are we making?" · "Your idea" · "Add files" · "Drop to add to this video" · "Your video shows here" · "Show all options" |
| Question card | "A few things the idea leaves open" · "Recommended" · "Use these" · "Pick one: Mine, Licensed or Not sure." |
| Brief card | "Here's the brief." · "Start" · "✓ Started" · the estimate, crew and picks lines (§3.5) · "Show all options" |
| Question card, settled | "✓ Investors · only the key picks · logo: mine" (the choices' labels, then each file's type and rights) |
| Logo pick (`rights`) | "Your logo in an achievement toast. Use it in the video?" · "Use it" · "Leave it out" · "Private to this project" |
| Drafts | "Drafts" · "✎ Draft" · "Remove draft" · "Remove this draft? Only the conversation is saved, and it goes too." · "Keep it" |
| Make another like this | "Make another like this" (the finished card's ⋯ menu, a finished project's chip) · Pip's opening line "Another one like {title}: same style, cast and settings. What's this one about?" · the plan card "Make another video like this", "Make it", its result "The new video is ready for its idea." and the link "Go to the new video" · "Didn't start another one: {message}." |
| A route the studio lacks | "This studio doesn't have that yet." with the fix "Update the studio server and restart it." (a server that answers an `/api` route with its page) |
| Asks (v0.3) | "Waiting for you · {n}" (the drawer) · "Waiting for your answer" (Pip's drawer row) · "Pip has a question for you." · "I need you to pick one." · "Let Pip decide" · "Needs you ↓" / "Needs you ↑" |
| The picture (v0.3) | "View" · "{title}: view full screen" · "Frame {i} of {n} · {m:ss}" · "Previous frame" · "Next frame" · "Whole sheet" · "← → step through the frames · Esc closes" · "Loading the picture…" |
| Playback (v0.3) | "Rough cut with sound" · "Silent preview, frame by frame" · "Loading frames…" · "Starting the rough cut…" · "Redrawing this scene · showing the last good frame" · "This frame isn't drawn yet · showing the last good one" · "Your browser kept the sound off. Press Pause, then Play, to hear it." |
| Change something (v0.3) | "What should change" · "For example: the owl should sit on the roof in scene 3." · "Which scenes need another pass" · "Say what to change, and Pip says who does it and what it costs." · "Working out who does it and what it costs…" · "Send changes" · "Cancel" |
| Fix and build (v0.3) | "Fix the key" · "Opens Settings › Providers at {provider}. Save a new key or test it, then ask me again." · "This studio is running an old build. Rebuild with pnpm --filter @pap/web build." · "Hide" |
| Too many revisions | "I've changed the plan 6 times on this run. The next change is yours to approve." (Pip, with a plan card) |
| Over 20% | "Adding the {label} raises the estimate by {p}%. Add it?", with "Add it" · "Not now" (a plan card) |

## 6. The mock script (`?mock=1`, journey `todo`)

- **Where.** The journey lives in `apps/web/src/mock/journey.ts`. It is data (the plan's tasks, how many ticks each runs, what each reports and the revisions it triggers) played by a small deterministic executor in the same file: slots, the horizon rule and the instance fold. A list of hand-written beats couldn't stay true with `slots=1`, so the beats below are what the executor emits, not a list it reads. `MockClient` plays it with timers and the person's presses; the same class drives the node test with no DOM.
- **/new** in mock is `apps/web/src/mock/drafts.ts`: the draft store, the rules parse (ORCHESTRATION §3.3, step 4), the question card and the brief card. Start makes the project, moves the conversation and starts the journey.
- **The film.** The project Start makes has its own doc (`makeQuestDayDoc` in `mock/fixtures.ts`): QuestDay's six cues and the plan's four scenes s01–s04, 30 s, so its slate and timeline are its own ("0:30"), not another fixture's. Its frames are QuestDay's own cut too (`drawFrame` with `look: "questday"` in `mock/art.ts`): s01 the todo list growing beside the founder, s02 the rows turning into quest cards (the founder 2× once the step 10 change is done), s03 the quest board with the founder and a teammate left of the "Quest done!" toast, s04 the end card, "QuestDay · Make the day a quest.", with the achievement toast showing the 16 px Q badge (a star without a logo, or when the logo was left out).
- **Turning it on.** `?mock=1&journey=todo` seeds two fixture projects: "QuestDay teaser" (finished two hours ago) and "Lantern · demo night" (one open pick). Without `journey=todo` the older fixtures stay, and `/new` still works; a project started from a draft always plays this journey.
- **Flags**, read once at boot and kept for the tab (`sessionStorage`), so a reload keeps them:

  | Flag | Effect |
  |---|---|
  | `speed=N` | divides every delay (default 1) |
  | `slots=N` | concurrency (default 3); `slots=1` gives 1 live + 3 Animator ghosts in 7c |
  | `proxy=0` | no playable rough cut, as an older server: the viewer says "Silent preview, frame by frame". By default each review round writes one: a WAV made in the browser (`mock/audio.ts`), so the proxy path is heard; it has no picture, so the frames draw while the sound keeps the time |
  | `stale=1` | `GET /api/build` says the build is old: the banner under the header |
  | `auto=1` | types the step 2 message and drops the logo 3 ticks after an empty `/new` opens, answers each card and pick with its recommended option (Mine for the rights) and presses Start, types the step 10 message at the first G3, confirms its card, approves G3 the second time and asks the step 12 question, each 3 ticks after it opens; the run goes end to end with no clicks. With a `scenario`, it stops at the scenario's own moment and leaves that to you |

- **Scenarios** (`scenario=…`, with `journey=todo`; read once at boot and kept with the other flags). Each plays one of the P4 run's situations on top of the journey, with the server's own card and status shapes (`Pip.revisionCard`, `overrunCard`, `holdNotice`; the orchestrator's `holdRun`, `overrun` and `publish`). The default journey, without one, is unchanged. Start a project from `/new` after loading the address, e.g. `/?mock=1&journey=todo&scenario=keyfail&speed=2`.

  | Scenario | What happens | Where it waits |
  |---|---|---|
  | `revision` | The cast's founder drawing is past 20% of what was approved: Pip posts "Plan change: $1.40 → about $1.95" (`revision: { fromUsd, toUsd, planner: "director" }`, "Go ahead"); `plan.pending` holds the drawing, scene 4 runs on; the status says "Waiting for you: the plan change in Pip's thread" (`waiting: "plan"`) | `card:c_rev`. Confirm runs the drawing and moves `approvedUsd` to $1.95; decline drops it |
  | `overrun` | The cap is $1.50. When a task is about to start with 80% spent, Pip posts "The crew is near the budget: …" with two cards, "Finish within $1.50" (lists "Leaves out the second review round.") and "Raise the cap to $2", neither with a price line (they cost nothing, so no "$0"); the status is "Waiting for you: 80% of the $1.50 cap is spent. Finish within it, or raise it to $2." and the channel "Paused the crew: 80% of the $1.50 cap is spent."; nothing new starts; `waiting: "budget"` | `card:c_finish`. Answering one settles the other ("You chose the other way.", or "Kept as it is." on a decline); "Finish within" writes a `budget` revision and the review runs once; "Raise" sends the new cap |
  | `publish` | Once the founder is drawn, the Librarian asks `Add "founder" to your asset library?` (yes/no); its row is `waiting_user` "Waiting for you: publish founder?", so its face and the drawer say needs you. NeedsYou shows it as a pick of its own two answers, "Yes, add it" (primary) and "Keep it in this project", with no "Let the crew decide" (`isPick`); the card and the status line name "the Librarian", not its department | `answer:q_publish`. The row ends "Published founder" or "Kept founder in this project" |
  | `hold` | v0.3: the cast reports partial and Pip holds the run with a question of its own (`q_hold`, `from: "pip"`, `hold: true`): "Redo with the Director" (recommended, about $0.31) · "Accept the look" · "Tell Pip what to change"; the status is "Waiting for you: Pip's question about the founder" and nothing starts. Redo draws the founder (rev 1 by Pip), Accept goes on with a stand-in, Tell opens a field on the card; its note lifts the hold and goes to the Director | `answer:q_hold` |
  | `holdcard` | v0.3: the same hold; three ticks in, a note is typed instead, and Pip answers with a card that starts now ("Redo the cast with your note", the Director re-planned). Confirming it withdraws the hold's question, lifts the hold and the crew works at once | `card:c_hold` |
  | `g3director` | v0.3: the run stops at the rough cut. "Change something" there is routed as the server routes it (`routeNote`, the server's `routeChange`): cast, staging, sit/fly, the backdrop, text and end cards go to the Director (re-board, then the scenes' Animators, then the Reviewer), timing and motion to the Animator. The preview's price is the revision's delta; the reopened scenes go stale (empty sky on the server, the last good frame in the viewer) until redrawn. After the second G3 approval the export runs and no third cut follows | `gate:g3_rough` |
  | `drawer` | v0.3: stops at the script pick, for the asks in the crew drawer's Pip pane | `answer:q_angle` |
  | `sheet` | v0.3: stops at the rough cut, whose picture is the contact sheet (`out/contact.png`, drawn as the server lays it out): press it for the full-screen dialog | `gate:g3_rough` |
  | `pipkey` | v0.3: stops at the rough cut; every message to Pip is answered "Your Anthropic key was rejected, so I couldn't answer that. …" with a `fix` card, "Fix the key" | `gate:g3_rough` |
  | `edits` | v0.5.2 (the change router, PIP-ORCHESTRATION §1.12): stops at the rough cut. The step 10 message is Pip's own free edit: "Done: the hero in scene 2 is twice the size…" with an Undo card (`c_undo`, $0); no crew card, no Animator redo, and scene 2's hero is 2× at once (`Journey.edited`). "make it in daytime" answers with the free card "I can do this now: free" (`c_free`, "Do it") | `gate:g3_rough` |
  | `keyfail` | The founder's draw gets a rejected key: its row ends `cancelled`, the run holds (nothing new starts), the status is "Waiting for you: Your Anthropic key was rejected" with `problem { text, action: "fix_key", provider: "anthropic" }` and `crew.held`; Pip posts the hold notice; the founder's face is stuck with "Fix the key". The status reads as needs you (no red "Stopped ·"), and the crew channel says "Paused the crew: your Anthropic key was rejected." | `key:anthropic`. Saving the Anthropic key in Settings › Providers, or a passing test, lifts the hold: "Back to work: the hold is lifted.", and the drawing runs again as attempt 2 |

- **Determinism.**
  - The ids come from counters (`t_1`, `pip_1`, `ch_1`, `m_1`, `draft_1`, `c_q1`, `c_b2`), never from `Date.now()`. `mock/pip.ts`'s `uid` stays for the other intents.
  - No `Math.random`. Every timestamp is the run's start + tick × 1 s ÷ `speed`.
  - The logo fixture is a drawn, fictional "Q" badge (`drawLogo` in `mock/art.ts`).
- **Time.** One tick is 1 s ÷ `speed`. The displayed durations are the compressed ones: the Finished list says "4 s", not "3 min". Tests match patterns, not durations.
- **Waits.** The run waits for a person's action: `card:<id>`, `answer:<qid>`, `gate:<id>`, `ask:<text>`, `key:<provider>`. With `auto=1`, each one resolves 3 ticks after it opens (a card with its confirm), except a scenario's own (`card:c_rev`, `card:c_finish`, `answer:q_publish`, `key:anthropic`, `answer:q_hold`, `card:c_hold`), which waits for you, and the moment a v0.3 scenario stops at (`drawer`: `answer:q_angle`; `sheet`, `g3director` and `pipkey`: `gate:g3_rough`).
- **The older fixtures** (Lantern, Harbor lights, Night market, the example) have a crew row too: `mock/fixture-crew.ts` derives one member per role from their task rows (live while a row works or waits on you, finished once every row ended, the next three as ghosts while the crew runs), and the mock sends the changes as `instance` events.

The Tick column counts from that row's trigger. A row with no trigger keeps counting from the last trigger above it. The ids are the server's instance keys (`writer`, `animator:s01`, `pixel-artist:founder`). Every `instance` event is `{instance, change}` (ORCHESTRATION §4.3), and a status-only `plan` view follows every change of a task's status (the UI reads `ready` from it for "waiting for a free slot").

| Step | Trigger | Tick | Emits |
|---|---|---|---|
| 2 | send (or the first drop) | +0 | `POST /api/drafts` → `draft_1` (listed with `draft: true`); the files upload; `pip` (with `draft`) item user, with its file names; `pip thinking` |
| 3 | | +1 | `pip item` "30 seconds, no voice, under $3. Three quick picks, then I'll sum it up." + `brief_fields` card `c_q1` (audience, involvement, the logo's rights) |
| 4 | `card:c_q1` | +0 | `pip card` c_q1 done with its `values`; `pip thinking` |
| | | +1 | `pip item` "Here's the brief." + `brief` card `c_b2` |
| 5 | `card:c_b2` (Start) | +0 | `pip card` c_b2 started, `result.projectId: "questday_pitch"`; the conversation moves to the project; `gate` g0 passed; `plan` rev 0 (11 tasks) with `revision`; `milestone` (`kind: "plan"`) "Plan ready · 11 tasks to start"; `ledger` Pip's revision ($0.02) |
| | | +0 | the first tasks start with the plan: `instance` writer `spawn`; `task` t_1 working; `instance` art-director `spawn`; `task` t_2 (`asset.import`) working; director, animator:s04, mixer `ghost` |
| | | +1 | t_2's work done: `task` t_2 `waiting_user` ("Waiting for your OK on the logo"; its `lastImage` is the 16 px icon); `question` q_rights open (`rights: {asset: "logo"}`); art-director stays live (needs you); s04 and mixer drop off the horizon |
| | `answer:q_rights` | +0 | `task` t_2 done; art-director `idle` (a ghost) |
| 6 | | +5 | t_1's work done: `task` t_1 `waiting_user` ("Waiting for you to pick an angle"); the writer stays live (needs you); the ghosts go; `question` q_angle open |
| 7a | `answer:q_angle` | +0 | `task` t_1 done; writer `end`; `gate` g1 passed; director `spawn`; t_3 working; art-director, animator:s01, s02 `ghost` |
| | | +5 | t_3 done; director `end`; `x-state` sceneStatus (boards) |
| 7b | | +5 | art-director `live`; t_4 (`art.cast`) working; s01–s03 `ghost` |
| | | +7 | `channel` art-director report partial "No founder sprite in the library."; `plan` rev 1 (`by: "code"`, `expand`, +t_draw_founder); `milestone` "Plan changed: added a Pixel artist for the founder: the library had no founder sprite."; pixel-artist:founder `ghost` |
| | | +8 | t_4 done; art-director `end`; `gate` g2 passed (code, Decision 2); founder `spawn` + t_5 working; with q_rights answered, animator:s04 `spawn` + t_6 working; s01–s03 `ghost` |
| 7c | | +12 | t_5 done; founder `end`; s01, s02 `spawn` (t_7, t_8 working); s03 `ghost` (ready, waiting for a free slot); mixer, reviewer `ghost` |
| | | +14 | t_6 done; s04 `end`; s03 `spawn` (t_9 working) |
| | | +16 | t_7 done; s01 `end` |
| | | +17 | t_8 done; s02 `end` |
| 8 | | +17 | `channel` animator report partial "No recipe for two people talking." (`ref: s03`); `channel` Pip answer "Use a toast for the line and keep both characters left of the box."; `ledger` Pip ($0.02); t_9 working again, `attempt: 2` |
| | | +20 | t_9 done; s03 `end`; mixer `spawn`; t_10 working; reviewer, editor `ghost` |
| | | +23 | t_10 done; mixer `end`; reviewer `spawn`; t_11 working |
| 9 | | +26 | t_11 done; `x-state` findings: a blocker on scene 1, "The headline is clipped in scene 1"; `plan` rev 2 (`by: "code"`, +t_tune_s01_r2, +t_review_r2); `milestone` "Plan changed: scene 1 goes back to the Animator for the headline"; animator:s01 `revive` + t_12 working; reviewer `idle` (a ghost) |
| | | +29 | t_12 done; s01 `end`; reviewer `live`; t_13 working |
| | | +31 | t_13 done clean; reviewer `end`; `gate` g3 open; `pip item` "The rough cut is ready. One fix was made on scene 1." |
| 10 | `ask:make the hero bigger in scene 2` | +2 | `pip item` + plan card `c_ch` (`who: ["animator", "reviewer"]`, `whoInstances` animator:s02 and reviewer; usd [0.10, 0.14]) |
| | `card:c_ch` | +0 | `pip card` c_ch running; `gate` g3 locked; `plan` rev 3 (`by: "person"`); `milestone` "Plan changed: scene 2 goes back to the Animator for a bigger hero"; animator:s02 `revive` + t_14 working; reviewer `revive` (idle, a ghost); editor `ghost` |
| | | +4 | t_14 done; s02 `end`; reviewer `live`; t_15 working |
| | | +6 | t_15 done; reviewer `end`; `pip item` "The rough cut is ready again, with your change."; `pip card` c_ch done "Scene 2 redone; the hero is 2× now."; `gate` g3 open |
| 11 | `gate:g3_rough` | +0 | `gate` g3 passed (and G4 approved with it); editor `spawn`; t_16 working |
| | | +4 | t_16 done; editor `end`; `x-state` files and versions (v1); `parts` (Video ✓); `gate` g4 passed; `milestone` "Your video is ready"; `pip item` "Your video is ready. A new video is exported, with scene 2's change." with the files card |
| 12 | `ask:why did you add a Pixel artist?` (with `about: {instance: "pixel-artist:founder"}`) | +2 | `pip item` "The library had no founder sprite, so I added one drawing. It was $0.31 of your $3." |

The `ledger` events follow each task's `usd` from §2 as it ends. Pip's six metered turns are $0.02 each, $0.12 in all.

**The node test** (`apps/web/test/journey.test.ts`) plays the run through `applyEvent`, with `auto=1` unless it says otherwise. It checks:
1. the row passes every §2 checkpoint, in order: live set, ghost set and finished count, read from the table in this file;
2. at every tick, live faces = instances with a `working` or `waiting_user` task, never more than 3 ghosts, and no face both live and a ghost;
3. every `spawn` or `revive` comes before its task's `working`, and no `end` comes while one of its tasks works (N3);
4. with `slots=1`, never more than one `working`, and once one live Animator with three Animator ghosts;
5. animator:s01 and animator:s02 keep their ids through their returns (each ends with two lives), and no label is ever on two instances;
6. the final finished count is 11, the run reaches step 12, and G4 is passed;
7. spend is $1.77 ± 0.01 (the crew $1.65);
8. with `auto` off and nobody answering, the run waits on the script pick and the logo: G1 never passes and q_rights stays open; scene 4 never starts before the logo pick; G2 passes in code; G4 passes only with the G3 press; every answer is `by: "user"`;
9. every milestone and every reason (spawn and return) matches its §5 template, and every label is in sentence case (N5);
10. the picks follow the draft: 3 with a logo, 2 without, and without one there is no import, no logo pick and no rights node;
11. each role's glyphs and hue match the §3.1 table (read from this file), and the Writer and the Director differ;
12. the row's sentences and Pip's bubbles follow §5 (a batch over scenes merges, a return says its life's reason, one sentence per leave), and Pip conducts exactly when it brings someone in;
13. the drawer's groups: no instance in two, Up next uncapped in plan order, Finished newest first; time alive is the sum of the lives; the ghost lines ("Waiting for a free slot. 3 are working.", "Starts after the script pick.");
14. a channel message finds its instance by role and `ref`, and the plan revisions read as one line each.
15. a late reply never moves a card back from where its events took it (a form's "submitted" after its done, a fork's "running" after done), and a failed press reverts only a card still in its optimistic state;
16. "Make another like this" copies the settings (`COPIED`) and never the idea or the files, opens with the copy line, and the idea alone brings the brief card; a fresh draft still opens on "What are we making?".
17. the scenarios: `revision` holds the drawing behind its card and confirming moves `approvedUsd`; `overrun` asks at 80% of $1.50, starts nothing while it asks, and one card settles the other; `publish` asks once and the Librarian needs you; `keyfail` cancels the row, holds with "Fix the key" on a stuck founder, starts nothing, and lifts only for that provider; the scripted fixtures' crew row.

## 7. Needs from the backend

Checked against `docs/PIP-ORCHESTRATION.md` as it stands today. The first list is what the UI uses as that doc defines it. The second is what the UI still asks for, or where the two differ.

### 7.1 Used as specified there

- `ProjectState.plan: PlanView | null` and SSE `plan {view, revision?}` (§4.2, §4.3). The stage nav and the "Plan · rev N" disclosure read from `GET /api/p/:id/plan/revisions`.
- `ProjectState.instances: Instance[]` and SSE `instance {instance, change}`.
  - The UI uses `state`, `ghost`, `running`, `label`, `subject`, `model`, `lives`, `reason`, `endReason`, `usd`, `outcome` and `lastReport`.
  - Each `change` maps to the motion in §3.1: `ghost` = enter as a ghost, `spawn` = enter live (or ghost → live), `live` and `idle` = solidify or go dashed, `end` = the finish hold, then the fade out in place, `revive` = enter from Pip's side.
- `Task.instance`, `Task.planTask`.
- The `kind: "plan"` milestones: "Plan ready · N tasks to start" and "Plan changed: <reason>".
- The `rights` plan node as a person question, never auto-passed (their C2). The UI shows it with NeedsYou as "Your logo in an achievement toast. Use it in the video?", with "Use it" · "Leave it out", the 16 px icon as its picture, and no "Let the crew decide" (N15).
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
| N1 | A reason on each life: `lives: {from, to, reason}[]` | the return bubble and announcement ("Brought the Animator back to fix the scene 1 headline") | **met (P2)**: every life carries the line that opened it: the spawn line first, a return's line after ("Pip brought the Animator back to fix scene 1: the headline is clipped"); a life opened after idling has none (ORCHESTRATION P2 item 24) |
| N2 | `whoInstances?: {instance, label}[]` on plan cards | `who: RoleT[]` can't say "Animator · scene 2" | `PlanCard & {revision?}` |
| N3 | Ordering: an `instance` `spawn` or `revive` before its task's `working` event, and an `end` after its last task event, in stream order | the row would flash a face with no work, or a working task with no face | **met (P2)**: the tracker sends a `spawn` or `revive` on the stored `plan_status` that made the task `running`, which comes before the handler's `working` row, and an `end` on the `plan_status` after its last row (ORCHESTRATION §4.3, P2 item 26) |
| N4 | `GET /api/p/:id` carries `plan` and `instances`, so a reconnect re-baselines without animating | §3.1 never animates what loads | **met**: `plan` (P1) and `instances` (P2); `GET` is the same fold the stream follows |
| N5 | Role words in sentence case ("Pixel artist", "Art director") in `label` and `reason` | the kit and `ROLE_LABEL` (C14) | `ROLE_WORD` "Pixel Artist" |
| N6 | `crew.slots` in state | the ghost popover: "Waiting for a free slot. 3 are working." | on the wire since the backend's P1 (`crew.slots`, per endpoint plus "render"); P2 types it (`CrewInfo.slots`) but counts n from the plan's `running` tasks, which the mock and the server both send |
| N7 | `PATCH /api/drafts/:id {fields}` | the composer's "‹ Back to the conversation" keeps its edits without a model call | **met (P3)**: `PATCH /api/drafts/:id {fields}` checks each field with the registry (400 with a `fix`), marks it `said`, no model call |
| N8 | Draft creation on the first send or drop, not on opening `/new` | an opened-and-left `/new` must not leave an empty draft | **met (P3)**: `POST /api/drafts` makes the folder and returns Pip's first item; nothing is on disk before it |
| N9 | Per-field labels in the card may be Pip's wording: "Investors", "Users", "A launch post" | the brief's step 3 copy | **met (P3)**: the card's labels are the mock's ("Investors", "Users", "A launch post", plus "A selection committee" for `application`); Pip may reword the question, never the ids |
| N10 | `ChannelMsg.ref` set to the instance's subject or task id on every brief, ask, answer and report | the kept log and the drawer filter by instance | the log endpoint filters this way |
| N11 | A note on the ghost horizon: no ghosts while only a person's pick is open | §2's checkpoints rely on it (C2); if the backend instead counts an open gate as a horizon source, steps 6, 7a, 9 and 10 change | **met (P2)**: only running and ready tasks start the walk, so with only a pick open there are no ghosts (ORCHESTRATION §2, P2 item 22) |
| N12 | A ruling on a pending task whose other dependencies are far off: should it need all of them within 2 hops to be a ghost? | as written, the logo import (step 5) puts Animator · scene 4 and the Mixer on the horizon for one tick, though scene 4 also waits on G2 | **ruled (P3)**: as written, any one path within 2 hops; no change |
| N13 | The draft's address: `/new/:draftId` (this file, §3.5), not `/new?draft=<id>` (ORCHESTRATION §4.1) | `usePath` ignores the query, and the shell must stay mounted through the replaceStates | **met (P3)**: the server has no page routes for drafts; `/new/:draftId` is the UI's, and the API is keyed by the id |
| N14 | A draft's summary row carries `createdAt` ("Started …") and `status.line` (Pip's last question) | the Drafts card on Projects | **met (P3)**: `GET /api/projects` lists each draft with `draft: true`, `createdAt`, `updatedAt` and `status.line` (Pip's last question, or "The brief is ready to start.") |
| N15 | The `rights` question says so: `QuestionT.rights: {asset, private: true}` | NeedsYou hides "Let the crew decide" and shows "Private to this project"; nobody but the person answers it | **met (P3)**: `QuestionT.rights: {asset, private: true}` on the `rights` node's question; the store refuses any answer not `by: "user"` (403 `person_only`) and never times it out |
| N16 | The brief card's picks line, `picks` (a string), or the gate list it is built from | line 3 of the card ("You'll pick 3 times: …") depends on involvement and the rights nodes | **met (P3)**: the brief card carries `picks`, built from the rules plan's gates and `rights` nodes under D2 (an `unsure` reference has no node, so no pick) |
| N17 | A user item may carry the names of the files sent with it: `PipItem.files?: string[]` (kind `user`) | the thread shows the message "with its file chip" (step 2) | **met (P3)**: a draft's user item carries `files`, the names dropped since the last message |
| N19 | An instance stays live while one of its tasks waits on the person (`waiting_user`), and isn't finished until it is answered | the member who asks keeps its face, in the "needs you" mood, with its pick under Pip's line; folding it away while it waits reads as if nobody asked | **met (P2)**: live while its own task is `waiting_person`, and while the G1 pick or the `rights` OK it asks is next or open, so the Writer and the Art director keep their faces until answered; G0, G2, G3 and G4 keep nobody (ORCHESTRATION P2 item 22) |
| N18 | Draft ids start with `draft_` | the UI keys a draft's conversation by its id and tells drafts from projects by the prefix | **met (P3)**: `draft_` + 10 hex characters (`^draft_[a-z0-9]+$`, checked before any disk access) |
| N20 | `GET /api/settings` names every role's model, the defaults included (Pip's too) | Settings › Roles shows the model a role really runs on; today a role left unset (Pip, on a fresh install) is missing from `roles`, and the UI assumes the gateway's default, `anthropic/claude-sonnet-5-5` (`DEFAULT_MODEL` in `pages/SettingsRoles.tsx`) | **met (P3)**: `roles` names every role (unset ones get the gateway default, Pip's `anthropic/claude-sonnet-5-5`), and `effective[role]` says `{model, fallback, source: "saved"|"default", fallbackSource: "saved"|"producer"|"none"}` |
| N21 | A way to check one model's skills: `POST /api/models/:id/probe` → `ModelRow` | a "Not checked" row could offer "Check it now"; today it points to Providers › Test, which checks a whole provider | **met (P3)**: `POST /api/models/:id/probe` (the id encoded, or with its slashes as is) runs the probe now and returns the `ModelRow`; 404 with a `fix` for a model no enabled provider lists. A paid model spends a few cents |
| N22 | The profiles' assignments: `GET /api/settings/profiles` → `Record<Profile, Record<Role, {model, fallback?}>>` | each profile's "about $X per 60 s video" and the "What changes" list are computed in the UI (`pickFor`), which may pick differently from the server's `rolesForProfile` | **met (P3)**: `GET /api/settings/profiles` → `{best, balanced, local, custom}` from `rolesForProfile` (`local` is null without a local provider; `custom` only when it is the current profile) |
| N23 | The fallback covers chat turns too, or says it doesn't | the gateway escalates to a role's fallback only for structured (`json`) calls; Pip's tool turns (`chat`) never fall back, so the warning on Pip's row can promise less than it says | **met (P3, documented)**: the gateway falls back only on structured (`json`) calls; Pip's own turn (agent or menu) is retried once whole on the fallback; the conductor's tool turns, `assistant.plan` and `assistant.brief` never fall back (ASSISTANT.md "Fallbacks") |
| N24 | A life ends when its last task ends or is cancelled | on a project from before the plan the Animator's first life runs 1 h 37 min (its five tasks were cancelled with the run and have no `endedAt`), so its time alive reads long though it is the sum of its lives | **met (P2)**: a life ends when the member's last task ends, fails or is cancelled, or when its run stops (a stored `run` event); a run that died without one ends at the last event it wrote, found at the next run's start. `questday_teaser`'s Animator: 13:27:15 to 13:27:15, 8.5 s alive in all (ORCHESTRATION P2 item 29) |
| N25 | "Make another like this" typed to Pip on a project: the `project_fork` plan card's confirm makes a draft (`POST /api/drafts {from}`'s prefill and first line) instead of a project, and its result is `{ text, draftId }` (`PlanCard.result.draftId`, added in the web type). The card has no `editable` brief (the copy never takes the idea) and `usd: [0, 0]` | the card ends where the menu item and the chip do, `/new/:draftId`, and the idea is the person's next message | **met (P3)**: Pip's card for it is now the `draft_create` tool's ("Make another one like this", `usd: [0, 0]`, no `editable`, confirm "Open it"); its result is `{ text, draftId }`. `project_fork` stays in the registry for MCP clients |
| N26 | Plan revision numbers: the rules plan is rev 0, as on the server; each later revision adds one (in the journey: rev 1 the expansion, rev 2 the scene 1 redo, rev 3 the person's change) | "Plan · rev N" and the revision lines show the server's numbers as they are, and the UI shows the plan from rev 0 | **met (P3)**: the person's ruling; this file and the mock count from rev 0 |

## 8. Open questions for the person

- **Q1. What "Only the key picks" covers.** Resolved by Decision 2: G1, the `rights` pick and G3; G2 passes in code, and the G3 press passes G4.
- **Q2.** N12 above: whether the horizon should need all of a pending task's dependencies within reach.

## 9. What is built (UI)

P1 and P2 built the UI in mock (`?mock=1`). P3 wired it to the real server: `/new` is the conversation everywhere (the `NEW_IS_TALK` switch is gone), "Show all options" (`/new/:draftId/options`) is the way to the composer, and Projects with no projects goes straight to `/new`.

| Part | Where | State |
|---|---|---|
| The shell kept mounted: `/new` → `/new/:draftId` → `/p/:projectId` | `components/ProjectStage.tsx`, `lib/stage.ts`, `App.tsx` | built; the field, its words and the focus survive both replaceStates |
| The empty stage: film box and drop zone, Pip alone, "What are we making?", the field with "Add files", the examples, "Show all options" | `ProjectStage.tsx`, `Pip.tsx` (`PipAsk`, `Composer` attach) | built |
| File chips in the field, with the type and "Private to this project" | `Pip.tsx`, `lib/brief.ts` | built |
| The question card (≤ 3 fields, recommended picked, rights never) and its settled line | `components/BriefCards.tsx` | built |
| The brief card, Start, "Show all options" | `BriefCards.tsx` | built |
| The composer filled from a draft, "‹ Back to the conversation", its submit starting the draft | `pages/Composer.tsx` | built |
| Projects: Pip's line from state, "New video", Drafts · N with Remove draft | `pages/Projects.tsx` | built |
| The draft API and the line in mock | `mock/drafts.ts`, `mock/client.ts` | built (P3 builds the server side) |
| The journey and its node test | `mock/journey.ts`, `test/journey.test.ts` | built |
| The crew row: live faces in join order, up to 3 ghosts (dashed, muted, "up next" or "waiting for a free slot"), captions, one polite sentence per spawn, return or finish | `components/CrewStrip.tsx` (`InstanceStrip`, chosen when `state.instances` is present) | built (P1), finished in P2 |
| P2: per-role glyphs and hues (the trade marks kept inside the disc), the ✓ / ■ end badge, the face popover, the stepped enter, hold-and-fade and return motion, Pip conducting (`PipFace` mood `conducting`, `ConductContext`), spawn and return bubbles over Pip, task and channel bubbles over each instance, the finished line under the row opening the drawer on Finished | `lib/instances.ts` (the pure half: glyphs, words, groups, ghost lines), `components/CrewStrip.tsx`, `PipFace.tsx`, `Thoughts.tsx` (instance keys, `say`) | built (mock) |
| P2: the crew drawer's Working / Up next / Finished groups, the kept log (`GET …/instances/:iid/log`, read-only, "Back for a fix" markers, "Ask Pip about this" sending `about: {instance}`) | `components/CrewDrawer.tsx`, `AgentActivity.tsx` (dispatches), `lib/pip.ts` (`about` on the draft) | built (mock); the real endpoint is the backend's P2 |
| P2: Studio's Crew tab: instance rows in Working / Up next / Finished · N, and "Plan · rev N" (`GET …/plan/revisions`) | `components/CrewRow.tsx` (`InstancePanel`) | built (mock) |
| P2: no Crew lane on the video timeline (D3) | `components/TrackTimeline.tsx` has none | confirmed |
| P3: `/new` on the real server: `HttpClient` calls the draft and line routes (`lib/api.ts`); a fresh `/new` holds `/api/events` before the first send, so a reply that beats the re-render is kept (by its `draft`); a route the server lacks (it answers with the page) is an error with a fix, never an empty answer, so nothing is sent on | `lib/api.ts`, `lib/pip.ts`, `components/ProjectStage.tsx`, `App.tsx`, `pages/Projects.tsx` | built; checked against the real studio while its drafts routes were still landing: `/new` opens, nothing is sent; the end-to-end run waits for the backend's P3 |
| P3: a reply never moves a card back: a `brief_fields` form's "submitted" reply after its done event, a fork's "running" after done, and a failed press reverts only a card nothing moved on | `lib/cards.ts` (pure, tested), `lib/pip.ts` (`decidePip`) | built |
| P3: "Make another like this": the finished card's ⋯ menu and the chip call `POST /api/drafts {from}` and open `/new/:draftId` on a new stage; Pip's copy line leads it; the plan card ends there (N25) | `lib/pip.ts` (`makeAnother`, `openDraft`), `pages/Projects.tsx`, `components/Pip.tsx`, `components/ProjectStage.tsx`, `mock/drafts.ts` (`COPIED`, `copyLine`), `mock/pip.ts` | built (mock end to end; the server's prefill and N25 are the backend's P3) |
| P3: the kept log and the plan revisions against the real server: the log of a project from before the plan (questday_teaser: 7 members, "Earlier work", "Back for a fix") renders as in mock; the revisions from the server's own store read as one line each; "Plan · rev N" now shows from rev 0 (N26) | `components/CrewDrawer.tsx`, `components/CrewRow.tsx` | checked |
| P3: `?lang=fa` turns the studio right-to-left (kept for the browser; `?lang=en` turns it back), so the RTL check needs no hand-set `dir`. The words stay English and the digits are Persian through Intl ("$۰٫۴۲ of $۶"); `lang` says "fa" for text that is still English, so it is a check, not a translation | `lib/locale.ts`, `main.tsx`, `lib/format.ts`, `lib/human.ts` | built |
| v0.2 (the P4 run's UI fixes): the angle pick shown whole (G1 and its question one item), the face that holds while its popover is open, named drawer steps with icons, code-only steps logged, the live `progress` line, the live canvas (Settings › Experimental), the plan card as a diff naming the planner, the scope chip, Pip's thread as turns of bubbles | `lib/needs.ts`, `components/NeedsYouCard.tsx`, `components/CrewStrip.tsx`, `lib/activity.ts`, `components/AgentActivity.tsx`, `components/CrewDrawer.tsx`, `components/LiveCanvas.tsx`, `lib/draft.ts`, `lib/experiments.ts`, `lib/plancard.ts`, `lib/about.ts`, `lib/pip.ts`, `lib/thread.ts`, `components/Pip.tsx`, `mock/progress.ts`; `test/simple-view.test.ts`, `packages/crew/test/live.test.ts` | built; checked in the mock journey |
| v0.3 (the P5 run's UI fixes): asks in the drawer's Pip pane, Pip's questions as picks, "Pip" in its own sentences, framed turns and the milestone track, scroll to attention with the "Needs you" pill, the full-screen picture and contact sheet, the rough cut with sound and the last good frame, the routed G3 estimate, Fix the key from Pip, Working before Finished, the old-build line | `components/NeedsYouCard.tsx`, `components/AgentActivity.tsx`, `components/Pip.tsx`, `components/ProjectStage.tsx`, `components/SheetDialog.tsx`, `components/Viewer.tsx`, `components/ProblemButton.tsx` (`openProvider`), `App.tsx` (`StaleBuild`), `lib/needs.ts`, `lib/human.ts`, `lib/thread.ts`, `lib/text.ts`, `lib/attention.ts`, `lib/sheet.ts`, `lib/preview.ts`, `lib/fix.ts`, `lib/projects.ts`, `mock/journey.ts` (the six scenarios, `routeNote`), `mock/audio.ts`, `mock/art.ts` (`drawContactSheet`); `test/v03.test.ts` | built; checked in the mock at 1280 and 400 px, dark and light, and right-to-left |
| The brief read by a model | | the backend's P3 |

## 10. Settings › Roles (`/settings/roles`)

The roles page follows the crew as people see it (`pages/SettingsRoles.tsx`).

- **Pip leads**, on its own row at the top with its crown face and "plans the video, runs the crew and answers you". Its model is `roles.assistant`; left unset it shows "Default (Claude Sonnet 5.5)", the gateway's default (N20). Its fallback, left unset, reads "The Producer's (…)", the gateway's rule.
- **Then the crew**, under "The crew", in `CREW` order with the crew row's faces and trade marks: Producer, Writer, Artist, Animator, Sound, Editor, Reviewer. A member covering more than one role shows each role as a sub-row with its own face (the §3.1 glyphs) and sentence-case name: the Writer covers Writer and Director; the Artist covers Art director, Pixel artist and Librarian; the Animator covers Animator and Scene coder; the Sound covers Sound designer and Mixer. Every role stays settable.
- **Each row**: what the role needs in words ("Needs to see pictures and return structured output."), the model, the fallback, and the cost: "About $1.08 and 5 min per 60 s video" ("Free on this Mac and 2 min per 60 s video", "No price known", ", time not measured yet").
- **The model list** has three groups: "Can do this role", "Not checked yet" (each marked "not checked") and "Can't do this role" (each marked with what it can't do: "can't see pictures"). The fallback list offers only models that can do the role.
- **An incapable model is never the silent choice.** The chosen model's mark stays in the select, and the row says so under it, with an icon and a word on a tint:
  - failed a need: "⚠ Can't: this model can't see pictures. If a task fails on it, the crew falls back to Claude Sonnet 5.5." or "…, the role stops: it has no fallback." (or "its fallback, X, can't do it either");
  - untested: "? Not checked: nobody has tested whether this model can return structured output. …", in the info tint;
  - one button, "Use {the best capable model}" (the Best profile's pick for that role).
- **One quiet line** under the list replaces the per-select "7 hidden" hints: "Each list puts the models that can do the role first; the ones nobody has checked yet, and the ones that can't, come after, marked." plus, when any chosen model is unchecked, "Check a model's skills from Providers (Test)."
- **The total**, under the list: "With these models: about $2.73 and 20 min per 60 s video." (roles with no price known are named after it).
- **Profiles** stay Best, Balanced, Local and Custom, each chip with its whole crew's price per 60 s video ("Balanced about $2.19"; a "+" when some role has no price). A profile picks capable models only, priced ones first (N22).
- **375 px**: under 48rem of room each row is a card, its parts stacked. **RTL**: logical properties throughout; model names in `<bdi>`, the English lines `dir="auto"`.
- The per-60-s numbers are the page's own rough token table (`TOKENS`) times the model's price and measured speed, as before.
