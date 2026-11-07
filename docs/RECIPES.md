# Recipes

A recipe is a ready-made beat. Pick one, fill a few params, and the engine draws a finished night pixel-platformer moment: layout, motion, effects and sounds. Recipes go in a decl scene's `recipes` list:

```json
{
  "id": "grind", "kind": "decl", "from": 0, "to": "S(c02)", "cues": ["c01"],
  "recipes": [
    { "id": "walk_in", "params": { "faces": "left" } },
    { "id": "block_bump" }
  ]
}
```

## Rules that hold for every recipe
- **Only required params are needed.** Everything else has a default that fits the scene. Start with `{}` and change one thing at a time.
- **Times are cue-anchored strings:** `"S(c02)"` (cue start), `"E(c02)+0.3"` (cue end + 0.3 s), `"@land"` (a named event), `"grind.to"` (a scene edge). Never write raw seconds like `2.5`. The `raw-seconds` lint flags them.
- **`t0`** is the first moment worth animating: scene start + 0.35 s, after the pixel dissolve. In the first scene it is 0.2 s.
- **Layering:** recipe layers are drawn under the scene's own `layers`, in list order. Later recipes can use earlier ones. For example, `block_bump` makes `walk_in`'s hero jump.
- **One hero per character:** `walk_in`, `item_collect`, `flag_raise` and `end_card_loop` reuse an actor an earlier recipe in the scene drew with the same asset (it walks on, collects, cheers) instead of drawing a twin. Pass `"second": true` to draw another copy on purpose.
- **Text fits:** banners wrap to two lines or drop a scale, toasts widen, `fit` titles wrap; what still does not fit ends in "...". Typographic dashes, quotes, ellipses and non-breaking spaces are drawn as their plain ASCII glyphs.
- **Layer ids** are `<recipe id>_<part>` (`walk_in_hero`, `block_bump_block`). A recipe used twice in one scene gets `walk_in2_hero`.
- **Default backdrop:** a scene with no backdrop gets the night sky, ground, lamp and bush automatically. Use `backdrop_night` to change them.
- **Asset slots** (`hero`, `crowd`, `items`...) are asset ids from the project's `assets`. Some recipes also draw fixed ids (`castle`, `moon`, `skyline`, `tiles`); the crew casts those from the library after the storyboard. The `missing-asset` lint names the `cast_asset` call and library source to add, e.g. `{ "id": "hero", "src": "lib:mentor-ai@1" }`.
- **Art direction:** `faces` says which way the hero art looks. It defaults to `"left"`, like every library character. Set `"faces": "right"` for art drawn looking right.
- **Screen layout:** 320×180 px. The ground top is y=148. Captions sit below y=146, so keep words above that.

The menu, in order of use: [backdrop_night](#backdrop_night) · [title_card](#title_card) · [walk_in](#walk_in) · [block_bump](#block_bump) · [item_collect](#item_collect) · [spawn_join](#spawn_join) · [toast](#toast) · [banner](#banner) · [crowd_cheer](#crowd_cheer) · [flag_raise](#flag_raise) · [end_card_loop](#end_card_loop)

---

## backdrop_night
Night sky with twinkling stars, a moon, a two-row parallax skyline, ground tiles, a lamp and a bush. Add it only when you want to change the default backdrop.
**Slots:** `moon`, `skyline`, `tiles`, `props` (fixed ids). **Anchors:** none. **SFX:** none.

| param | type | default | range | what |
|---|---|---|---|---|
| stars | int | 70 | 0–200 | how many stars |
| moon | bool | true | | draw the moon |
| skyline | bool | true | | draw the skyline |
| ground | bool | true | | draw the ground tiles |
| decor | list | lamp at 24, bush at 290 | | `[{ "frame": "lamp" \| "bush" \| "signpost", "x": 24 }]` |
| gaps | list | [] | | `[[fromX, toX]]` holes in the ground |

```json
{ "id": "backdrop_night", "params": { "decor": [{ "frame": "signpost", "x": 260 }] } }
```
**Mistakes:** putting decor where a character stops (it hides them); `gaps` wider than a jump.

## title_card
A big title drops in, slams down with a shake and a ring, and bobs. An optional subtitle fades in under it.
**Slots:** none (needs `font`). **Anchors:** `at` (default t0 + 0.1 s). **SFX:** bump (on landing), select (subtitle).

| param | type | default | range | what |
|---|---|---|---|---|
| title | text | **required** | | 1–2 words, about 12 characters |
| subtitle | text | "" | | one short line |
| at | time | t0 + 0.1 s | | when it starts to drop |
| colour | colour | "B" | | title colour |
| y | num | 34 | 4–90 | title top |

```json
{ "id": "title_card", "params": { "title": "QUESTDAY", "subtitle": "TASKS ARE QUESTS" } }
```
**Mistakes:** a sentence as the title (it shrinks to fit and turns small); a subtitle that repeats the caption.

## walk_in
The hero walks in from an edge at whole pixels, kicks up footstep dust, slows to a stop at `x`, then waves. The start point is worked out so the hero arrives exactly at `arrive`.
**Slots:** `hero` (lib:mentor-ai@1). **Anchors:** `at` (scene start), `arrive`. **SFX:** none (feet are quiet).

| param | type | default | range | what |
|---|---|---|---|---|
| hero | asset | "hero" | | character asset id |
| faces | right/left | left | | which way the art looks |
| x | num | 120 | 16–304 | where they stop (centre) |
| from | left/right | left | | entry edge |
| speed | num | 30 | 10–80 | px/s (used when `arrive` is far off) |
| at | time | scene start | | walk starts |
| arrive | time | at + 60% of the scene, max 3 s | | they stop |
| wave | bool | true | | wave 0.3 s after stopping |
| label | text | "" | | name tag above the head |
| scale | int | 1 | 1–3 | how big the hero is drawn (2 = twice the size, feet stay on the ground) |
| second | bool | false | | draw a second copy even if the scene already has this hero |

```json
{ "id": "walk_in", "params": { "faces": "left", "x": 140, "arrive": "E(c01)-0.8" } }
```
**Mistakes:** `arrive` before `at`; the wrong `faces` for the art (the hero moonwalks).

## block_bump
The hero jumps and hits a ? block from below. The block bumps up, everything freezes for a 0.06 s hit-stop, the camera shakes, the block turns used and a star pops out and floats. If an earlier recipe made an actor, that actor jumps under the block where it stopped.
**Slots:** `qblock`, `tiles` (bricks), `rewardAsset` (items). **Anchors:** `hit` (actor arrival + 0.35 s). **SFX:** jump, bump, coin, land.

| param | type | default | range | what |
|---|---|---|---|---|
| actor | layer id | "" (last actor) | | who jumps |
| hero | asset | "hero" | | used only if there is no actor yet |
| faces | right/left | left | | that hero's art |
| x | num | where the actor stops, else 176 | 16–304 | block centre |
| y | num | 78 | 40–100 | block top (78 = one jump above ground) |
| hit | time | actor arrival + 0.35 s | | head meets block (the jump starts 0.3 s before) |
| reward | frame | "star" | | what pops out ("" for none) |
| rewardAsset | asset | "items" | | |
| bricks | bool | true | | a brick each side |

```json
{ "id": "block_bump", "params": { "hit": "S(c01)+1.8", "reward": "heart" } }
```
**Mistakes:** listing it before `walk_in` (there is no actor to reuse yet, so it makes its own); a `hit` earlier than the arrival (the hero jumps mid-walk).

## item_collect
Items pop up above the hero one by one and fly on arcs into HUD slots at the top left, each landing with a coin, a flash and a tick. With `walk: true` the items lie on the ground and the hero walks over them instead. The hero waves when the last one lands.
**Slots:** `itemAsset` (items), `hero`. **Anchors:** `at` (t0 + 0.1 s), `until` (scene end − 0.6 s). **SFX:** coin per item.

| param | type | default | range | what |
|---|---|---|---|---|
| items | frames | ["star","heart","star"] | 1–8 | one per slot, in order |
| itemAsset | asset | "items" | | frames: pc, gamepad, handheld, phone, heart, star |
| hero | asset | "hero" | | |
| faces | right/left | left | | |
| walk | bool | false | | false: pop above the hero; true: walk over them |
| x | num | 112 | 16–304 | where the hero stands (a hero already in the scene stays where it stopped) |
| at | time | t0 + 0.1 s | | first item |
| until | time | scene end − 0.6 s | | last item is in its slot |
| hudX, hudY | num | 4, 4 | | HUD corner |
| slots | int | 0 (one per item) | 0–8 | |
| filled | frames | [] | | slots already full (carried from an earlier scene) |
| second | bool | false | | draw a second hero instead of reusing walk_in's |

```json
{ "id": "item_collect", "params": { "items": ["star", "star", "heart", "star"], "faces": "left" } }
```
**Mistakes:** more than 8 items; a window under 2 s (items pile up); a second hero in the same scene (item_collect brings its own).

## spawn_join
A second character drops in from the sky, lands with a squash, dust and a small shake, and a banner announces them.
**Slots:** `who` (lib:mentor-gtm@1). **Anchors:** `at` (t0 + 0.1 s), landing = at + 0.45 s. **SFX:** fall, land, join.

| param | type | default | range | what |
|---|---|---|---|---|
| who | asset | "friend" | | character asset id |
| faces | right/left | left | | art direction |
| facing | right/left | left | | which way they look after landing |
| x | num | 200 | 16–304 | landing spot |
| at | time | t0 + 0.1 s | | starts falling |
| banner | text | "PLAYER 2" | | "" for none |
| label | text | "" | | name tag |

```json
{ "id": "spawn_join", "params": { "who": "friend", "x": 180, "banner": "PARTY UP" } }
```
**Mistakes:** landing on top of the hero (keep 24 px apart); a banner sentence (use 1–3 words).

## toast
A small achievement panel slides in from the right with an icon, a title and an optional second line, then slides out.
**Slots:** `iconAsset` (items). **Anchors:** `at` (t0 + 0.25 s). **SFX:** achieve.

| param | type | default | range | what |
|---|---|---|---|---|
| title | text | **required** | | about 16 characters |
| sub | text | "" | | about 20 characters |
| icon | frame | "star" | | |
| iconAsset | asset | "items" | | |
| at | time | t0 + 0.25 s | | slides in |
| dur | num | 2.4 | 0.8–8 | seconds on screen |
| colour | colour | "B" | | border and title |

```json
{ "id": "toast", "params": { "title": "NEW QUEST", "sub": "3 TASKS TODAY", "at": "S(c02)+0.9" } }
```
**Mistakes:** a title over 16 characters (runs past the panel); two toasts overlapping in time.

## banner
A big two-scale word panel slides down from the top, flashes, then leaves.
**Slots:** none. **Anchors:** `at` (t0 + 0.2 s). **SFX:** achieve (or `sfx`).

| param | type | default | range | what |
|---|---|---|---|---|
| text | text | **required** | | 1–3 words |
| at | time | t0 + 0.2 s | | slides in |
| colour | colour | "O" | | border and flash |
| y | num | 34 | 4–110 | top |
| dur | num | 1.7 | 0.6–8 | seconds |
| sfx | sound | "achieve" | | `null` for none |

```json
{ "id": "banner", "params": { "text": "LEVEL UP", "at": "E(c02)-1" } }
```
**Mistakes:** more than about 12 characters at scale 2 (it wraps to two lines, then shrinks); putting it over an item flight.

## crowd_cheer
A small crowd stands on the ground and bursts into a cheer, with sparkles over their heads.
**Slots:** `crowd` (lib:gamers@1, frames cheer0 and cheer1). **Anchors:** `at` (t0 + 0.45 s). **SFX:** cheer.

| param | type | default | range | what |
|---|---|---|---|---|
| crowd | asset | "crowd" | | |
| x | num | 16 | −40–300 | left edge of the first group |
| count | int | 1 | 1–4 | groups side by side (52 px apart) |
| at | time | t0 + 0.45 s | | starts cheering |
| sparkles | bool | true | | |

```json
{ "id": "crowd_cheer", "params": { "count": 2, "at": "S(c03)+1" } }
```
**Mistakes:** placing the crowd under the castle or the pole; `count: 4` with a flag at x=196 (they overlap).

## flag_raise
A flagpole beside a castle. The flag climbs to the top, then a flash, fireworks, a camera shake and a fanfare. With `hero` set, the hero walks to the foot of the pole, then hops and waves when the flag tops out.
**Slots:** `castle`, `flagAsset` (props: flag0, flag1), `hero`. **Anchors:** `at` (t0 + 0.25 s), top = at + dur. **SFX:** flagpole, flag, fanfare (and jump/land with a hero).

| param | type | default | range | what |
|---|---|---|---|---|
| x | num | 196 | 8–290 | pole x |
| at | time | t0 + 0.25 s | | flag starts to climb |
| dur | num | 1.6 | 0.4–5 | climb time |
| castle | bool | true | | castle right of the pole |
| castleX | num | x + 22 | −60–320 | castle left edge |
| flagAsset | asset | "props" | | |
| fireworks | bool | true | | flash and fireworks at the top |
| hero | asset | "" | | "" for none; reuses the scene's hero with that asset |
| faces | right/left | left | | |
| second | bool | false | | draw a second copy instead |

```json
{ "id": "flag_raise", "params": { "hero": "hero", "faces": "left", "at": "S(c03)+0.5" } }
```
**Mistakes:** `x` above 250 with the castle on (it runs off the right edge); `at + dur` after the scene end (no payoff).

## end_card_loop
The end card. The title drops in, PRESS START bounces in and pulses, and a URL line fades up. The URL can pixel-dissolve into a second URL. Twinkles and a slow shooting star keep the card alive for as long as it holds. An optional hero waves every 6 s.
**Slots:** `hero` (optional; needs `font`). **Anchors:** `at` (t0). **SFX:** land, start, select.

| param | type | default | range | what |
|---|---|---|---|---|
| title | text | **required** | | product name |
| press | text | "PRESS START" | | call to action, 1–2 words |
| url | text | "" | | optional URL line |
| url2 | text | "" | | replaces `url` after `swapAfter` |
| swapAfter | num | 4 | 0.5–60 | seconds after the URL appears |
| at | time | t0 | | title drops |
| colour | colour | "B" | | title colour |
| hero | asset | "" | | "" for none; reuses the scene's hero with that asset |
| faces | right/left | left | | |
| second | bool | false | | draw a second copy instead |

```json
{ "id": "end_card_loop", "params": { "title": "QUESTDAY", "url": "questday.example", "url2": "play.questday.example", "swapAfter": 2, "hero": "hero", "faces": "left" } }
```
**Mistakes:** a swap later than the end card lasts (`composition.endHold`); a long URL (keep it under about 40 characters).

## Checking your work
`lintProject(doc, timeline, { assets, colours, sky })` from `@pap/engine/lints` reports, with a `fix` for each problem:
- raw seconds
- crowded or clipped text
- words in the caption zone
- cues that are too long or too short
- scenes that overlap or leave a gap
- recipe params out of range
- missing assets (with the `cast_asset` call that fills them)
- sprites that vanish into the sky
- two copies of one character in a scene (`duplicate-actor`)
- a prop over a character's face (`covers-face`)
- a toast, panel or banner over a character's body, a third of it or more for 0.3 s (`covers-actor`)
- banners and toasts off the frame (`text-clipped`)
- frames that are almost all black (`empty-frame`; `lintFrames` checks rendered frames, cuts included)

`examples/questday/pitch.json` is a complete project built only from recipes, and lints clean.
