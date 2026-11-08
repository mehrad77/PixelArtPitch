# Layers, keys and behaviours

Most scenes need only [recipes](RECIPES.md). Use hand-written layers when no recipe fits. They go in a decl scene's `layers` and are drawn on top of the recipe layers. The menu is closed: an unknown kind, prop or param is a compile error, and the error names what is allowed.

```json
{
  "id": "star", "kind": "sprite", "z": 20, "space": "world",
  "show": ["S(c02)", "E(c02)"],
  "props": { "asset": "items", "frame": "star", "x": 150, "y": 90, "outline": "k" },
  "keys": { "y": [{ "t": "S(c02)", "v": 90 }, { "t": "S(c02)+0.4", "v": 70, "ease": "backOut" }] },
  "behaviors": [{ "kind": "bob", "params": { "amp": 2, "hop": true } }]
}
```

- **Times** are absolute and cue-anchored: `"S(c02)+0.4"`. `0` is the only raw number allowed.
- **`space`:** `"world"` (the default) moves with the camera; `"screen"` stays put (HUD, titles).
- **`z`:** higher draws on top. Equal `z` keeps list order.
- **`show`:** `[from, to)` limits when the layer exists.
- **Snapping:** every position snaps to whole pixels.
- **Randomness:** all of it is deterministic.

## Layer kinds and their props

| kind | props (defaults) | notes |
|---|---|---|
| backdrop | style night/plain/rooftop, sky, band true, stars 70, moon true, moonX 262, moonY 18, skyline true, chimneys [252] (rooftop only) | fills the frame; parallax follows the camera. `rooftop` draws a slate roof whose ridge is y=148 (see [backdrop_rooftop](RECIPES.md#backdrop_rooftop)) |
| tiled | asset "tiles", frame "ground-top", fill "ground", y 148, tile 16, fromX, toX, gaps [] | a ground row |
| sprite | **asset**, frame, frames [] + fps 4, x, y, anchor topLeft/bottom/center, flip, outline, alpha 1, scale 1–4, colour | `frames` cycles |
| actor | **asset**, x 160 (feet centre), y 148 (feet), facing, artFaces "left", runFps 10, idleFps 2.5, dust true, outline, frames {} | picks idle, run, jump or wave by itself |
| text | **text**, x 160, y 40, align center, scale 1–4, fit false, colour "P", shadow true, alpha, maxW 0, lineH 10 | `fit` shrinks to 304 px |
| panel | x, y, **w**, **h**, border "G", fill "k", alpha 0.88 | dark box with a shadow |
| group | x, y, alpha + `children` | moves its children together |
| shape | shape rect/box/disc/line, x, y, w, h, r, x2, y2, colour, alpha | |
| fx | **fx**: sparkle, ring, dust, twinkle, flash, fireworks, shootingStar, glow; x, y, at, every, colour, n, size, dur, w, h; glow also tones, pulse, period | effects without a sprite ([glow](#glow) below) |
| widget | **widget**: banner, toast, nameTag, label, hudSlots, qblock, counter, flagpole (props below) | ready-made UI |

**Actors** choose their frame from what the asset has:
- `run0`–`run3` while walking (a creature's `move0`–`move3` when it has no `run` frames). Without those, they alternate `idle0`/`idle1` with a 1 px bob.
- `jump` in the air, falling back to `give`.
- `wave`, falling back to `give`.
- While a [`fly`](#fly-needs-at) moves them: `move0`–`move3`, falling back to `run0`–`run3`, then `idle0`/`idle1`. While they [`sit`](#sit-needs-at): `perch0`/`perch1`, falling back to `idle0`/`idle1`. Sprites pick the same way during fly and sit.
- To force a pose, use `keys.state` with `"idle" | "run" | "jump" | "wave" | "fly" | "perch" | "auto"`.

**Widgets**

| widget | props | SFX |
|---|---|---|
| banner | **text**, **at**, dur 1.7, colour "O", y 34, scale 2, sfx "achieve" | sfx at `at` |
| toast | **title**, sub, iconAsset "items", icon "star", **at**, dur 2.4, y 118, w 150, colour "B", sfx "achieve" | sfx at `at` |
| nameTag | **label**, x, y, colour "T" | none |
| hudSlots | x 4, y 4, slots 4, items `[{asset, frame, at}]`, colour "G", check true | none (the arcs ring) |
| qblock | asset "qblock", x, y 78, hit, bump 6, sfx "bump" | bump at `hit` |
| counter | label, from 0, **to**, **at**, dur 1, x, y, align, scale, pad, colour "B", sfx "coin" | coin at the end |
| flagpole | x 240, y 148, height 96, asset "props", frames [flag0, flag1], raise, dur 1.6, sfx true | flagpole, flag, fanfare |
| label | **text**, x 160 (board centre), y 100 (board top), style "wood", mount "posts", scale 1, colour "P" | none |

### label
A painted sign in the world: a board with a lit top-left edge, a dark bottom-right edge, wood grain and four nails, and the words painted on it. Use it for a shop sign, a door plaque or a place name. It is the scene's one text (STYLE-GUIDE §4). The board is as wide as the words plus 14 px, and `8 × scale + 8` px tall (16 at scale 1). Words wider than 200 px end in "...".

| prop | default | what |
|---|---|---|
| **text** | | 1–3 words, about 12 characters |
| x | 160 | centre x of the board |
| y | 100 | top y of the board |
| style | wood | `wood`: dark planks (`n`, lit `c`, shade `A`); `slate`: a grey stone plaque (`F`, lit `Y`, shade `f`) |
| mount | posts | `posts`: two legs down to the ground (y=148); `hang`: two cords up to a bar 8 px above the board; `none`: the board alone |
| scale | 1 | 1–2, text scale |
| colour | "P" | paint colour of the words |

```json
{ "id": "sign", "kind": "widget", "z": 5, "props": { "widget": "label", "text": "READING ROOM", "x": 56, "y": 108 } }
```
**Mistakes:**
- A sentence on the board. Keep to 1–3 words, as on a real sign.
- `mount: "posts"` on a sign up in the sky: the legs reach all the way down to the ground. Use `hang` or `none` up there.
- A board bottom below y=146 (the caption zone). With its 2 px shadow the board takes `8 × scale + 10` px, so at scale 1 keep `y` at 128 or less.
- A sign over a character's body (`covers-actor`): stand it beside them.

`nameTag` is the small name tag `walk_in` and `spawn_join` draw for their `label` param. It stays a plain box; use a `label` widget when the words belong to the place.

### glow
Radial light for lamps, lanterns, windows and fires. It paints whole bands of palette colours from an outer tone to a bright core, with no blended colours. A band only lights cells darker than itself, so a brighter thing under the glow keeps its colour. Put it under the lamp and the characters (a lower `z`, for example −45 under the backdrop's lamp at −40).

| prop | default | what |
|---|---|---|
| x, y | 160, 60 | centre of the light (the flame or bulb) |
| size | 18 | outer radius in pixels, 1–160 |
| tones | ["A", "n", "c", "H"] | palette letters from the outer band to the core, 1–8. Inner bands are narrower, so the light falls off from a small core |
| pulse | 0 | 0–8: how many pixels the radius breathes in and out (0 is steady) |
| period | 2 | 0.2–20 seconds per breath |
| at | scene start | the light comes on |

```json
{ "id": "lamp_glow", "kind": "fx", "z": -45, "props": { "fx": "glow", "x": 24, "y": 122, "size": 16, "pulse": 1, "period": 1.8 } }
```
That lights the default lamp at x=24. A cool light: `"tones": ["N", "I", "D", "Q"]`.
**Mistakes:**
- A glow above a character's `z`: it is opaque, so it paints over their dark outline. Keep it under them.
- `B` or `O` as an outer band. Brass and orange are for tiny doses: use them for the core tone only (the `glow-tones` lint warns).
- A `#rrggbb` colour or a letter not in the palette in `tones` (a compile error, then a `glow-tones` lint error).
- A `pulse` above 2. Real lamps flicker by a pixel; more looks like a heartbeat.

## Keys
`keys` animate a prop over time: `{ "prop": [{ "t": time, "v": value, "ease": name }] }`.
- **Interpolation:** numbers interpolate; text and true/false step.
- **Ease:** a key's `ease` shapes the segment that ends at it. The eases are `linear`, `in`, `out`, `inOut`, `outCubic`, `backOut` (overshoot) and `step`.
- **Keyable on every kind:** x, y, alpha, visible.
- **Keyable per kind:**
  - sprite: frame, scale
  - actor: state (`idle`, `run`, `jump`, `wave`, `fly`, `perch`, `auto`), facing
  - text: text, colour, scale
  - shape: w, h, colour
  - panel: w, h

## Camera
`camera: { "keys": { "x": [...], "y": [...] }, "shakes": [{ "at": "S(c02)+0.5", "amp": 2, "dur": 0.25 }] }`
- **Keys:** pan world layers.
- **Shakes:** jitter them, fading out.
- **Hit-stops:** `block_bump` adds a 0.06 s freeze of world motion.

## Behaviours
`{ "kind": ..., "at": time, "until": time, "params": {...} }`
- **`at`:** defaults to the layer's show start, or the scene start. Kinds marked *needs at* must have it.
- **`until`:** defaults to the show end, or the scene end.
- **Order:** behaviours apply in list order. `attach` always applies first.

### walk *(needs at)*
Walks along x to `to` and slows to a stop. Actors play their run cycle and puff dust every 0.55 s.

| param | default | range |
|---|---|---|
| **to** | | −2000–4000 |
| speed | 30 | 4–200 |
| decel | 0.3 | 0–2 |

```json
{ "kind": "walk", "at": "S(c01)", "params": { "to": 140 } }
```
**Mistake:** chaining two walks that overlap in time. Start the second after the first stops.

### jumpArc *(needs at)*
A parabolic jump. Actors show `jump`, squash for 0.12 s on landing and kick up dust both ways.

| param | default | range |
|---|---|---|
| height | 30 | 2–120 |
| dur | 0.6 | 0.15–3 |
| dx | 0 | −300–300 |
| squash | true | |
| sfx | true | |

**SFX:** jump at `at`, land at `at+dur`.
```json
{ "kind": "jumpArc", "at": "S(c01)+1.2", "params": { "height": 20, "dx": 24 } }
```
**Mistake:** a height of 30 under a block at y=78 is exactly a head bump. Higher goes through it.

### arc *(needs at)*
Flies from where the layer is to (`toX`, `toY`) on a bowed path, with a sparkle trail.

| param | default | range |
|---|---|---|
| **toX** | | |
| **toY** | | |
| screen | false | target in screen pixels |
| dur | 0.5 | 0.1–4 |
| lift | 20 | −120–120 |
| trail | true | |
| hide | false | vanish on arrival |
| sfx | "coin" | |

**SFX:** `sfx` on arrival.
```json
{ "kind": "arc", "at": "E(c02)", "params": { "toX": 7, "toY": 7, "screen": true, "hide": true } }
```
**Mistake:** a HUD target without `screen: true` on a world layer (it misses once the camera moves).

### bob
Floats up and down.

| param | default | range |
|---|---|---|
| amp | 1 | 0–20 |
| period | 1.6 | 0.1–20 |
| phase | 0 | 0–1 |
| hop | false | upward hops only |

```json
{ "kind": "bob", "params": { "amp": 2, "hop": true } }
```

### blink
Switches on and off between `at` and `until`.

| param | default | range |
|---|---|---|
| rate | 2.5 | cycles per second |
| duty | 0.5 | 0.05–0.95, share of each cycle it shows |

```json
{ "kind": "blink", "at": "E(c03)", "params": { "rate": 2 } }
```

### pulse
Breathes opacity between `min` and full.

| param | default | range |
|---|---|---|
| min | 0.6 | 0–1 |
| period | 1.6 | 0.1–20 |

**Mistake:** `min` 0 on a call to action (it vanishes once a cycle).

### shake *(needs at)*
Jitters this layer only (use camera shakes for the world).

| param | default | range |
|---|---|---|
| amp | 2 | 0–12 |
| dur | 0.25 | 0.02–3 |

### squash *(needs at)*
Squashes a sprite or actor for an impact.

| param | default | range |
|---|---|---|
| dur | 0.12 | 0.02–1 |

### appear *(needs at)*
Hidden before `at`, then comes in.

| param | default | range |
|---|---|---|
| style | fade | fade, pop, drop (backOut slam), slideLeft, slideRight, slideUp, slideDown, none |
| dur | 0.2 | 0–3 |
| dist | 40 | 0–400 |
| sfx | null | |

```json
{ "kind": "appear", "at": "S(c02)", "params": { "style": "drop", "dur": 0.4, "dist": 60, "sfx": "bump" } }
```

### disappear *(needs at)*
Fades out from `at`, then gone.

| param | default | range |
|---|---|---|
| style | fade | fade, none |
| dur | 0.2 | 0–3 |
| sfx | null | |

### attach
Follows another layer's position (with its visibility), for name tags or carried items. Works across world and screen space.

| param | default | range |
|---|---|---|
| **to** | | layer id |
| dx | 0 | −400–400 |
| dy | 0 | −400–400 |

```json
{ "kind": "attach", "params": { "to": "walk_in_hero", "dy": -40 } }
```
**Mistake:** attaching to an id that does not exist. Recipe ids are `<recipe>_<part>`.

### fly *(needs at)*
Flies from where the layer is through the `path` points at `speed`, with a bob, cycling the move frames (`move0`–`move3`, else `run0`–`run3`, else `idle0`/`idle1`). It turns to face the way it goes: an actor through `artFaces`, a sprite as if its art faces right (set `flip: true` on art drawn facing left). A one-way flight slows over its last 0.4 s and then hovers at the last point. With `loop: true` it flies back to its start and goes round again until `until`. After `until` it stays where it got to, with its idle frames, so a `sit` can take over.

| param | default | range |
|---|---|---|
| **path** | | `[[x, y], ...]`, 1 point or more, in the layer's own terms (an actor's feet, a sprite's anchor) |
| speed | 24 | 2–200 px/s |
| loop | false | |
| bob | 2 | 0–20 px |
| bobPeriod | 0.8 | 0.1–10 s |
| fps | 8 | 1–24 move frames per second |

```json
{ "kind": "fly", "at": "S(c01)", "until": "S(c01)+4.2", "params": { "path": [[100, 50], [200, 70]], "speed": 56 } }
```
A moth circling a lantern at (136, 120): `{ "kind": "fly", "at": "S(c01)", "params": { "path": [[158, 104], [136, 92], [114, 104]], "loop": true, "speed": 22, "bob": 1 } }` on a sprite placed at (136, 112) with `flip: true` (the library's moth, like every library character, faces left).
**Mistakes:**
- A path that ends inside the caption zone (y > 146) or off the frame for a long time.
- A one-way flight longer than its window: the distance over `speed` (plus 0.2 s) must fit before `until`, or it never reaches the last point.
- A loop on a creature that should land: give the `fly` an `until` and start the `sit` there.

### sit *(needs at)*
Lands on an anchor and holds there with the perch frames (`perch0`/`perch1`, else `idle0`/`idle1`). The anchor is (`x`, `y`), or another layer's position with `on` (it follows that layer as it moves). Then `dx`, `dy` are added. Over `land` seconds it glides in from wherever it is on a small hop, still flapping. It squashes for 0.1 s on touchdown and plays `sfx`. After `until` it stays on the anchor with its idle frames. With no `x`, `y` or `on`, it perches where it is.

| param | default | range |
|---|---|---|
| on | "" | layer id to sit on; "" for a fixed point |
| x, y | where the layer is | anchor, in the layer's own terms (an actor's feet, a sprite's anchor) |
| dx, dy | 0 | −400–400 |
| land | 0.4 | 0–3 s (0: already there, no squash) |
| lift | 6 | −60–60 px, how high the landing hop bows |
| fps | 1.5 | 0.1–12 perch frames per second |
| squash | true | |
| sfx | null | sound at `at + land` |

**SFX:** `sfx` on touchdown.
```json
{ "kind": "sit", "at": "S(c01)+4.2", "params": { "x": 243, "y": 125, "land": 0.6, "sfx": "land" } }
```
That lands an actor's feet on top of a `backdrop_rooftop` chimney at x=236. On a moving layer: `{ "kind": "sit", "at": "S(c02)", "params": { "on": "walk_in_hero", "dy": -24 } }` rides on the hero's head.
**Mistakes:**
- Listing `sit` before the `fly` it ends. Behaviours apply in list order, so keep them in time order: `fly`, then `sit`, then any later `fly`.
- An `on` id that does not exist, or the layer itself (a compile error that names the problem).
- `y` as the top of the creature: `y` is where its feet (or a sprite's anchor) go. For a sprite with the default `anchor: "topLeft"`, use `"anchor": "bottom"` so `y` is the perch line.

### dissolve *(needs at)*
A pixel dissolve, in or out. Two texts at the same spot, one `out` and one `in` at the same `at`, make a swap.

| param | default | range |
|---|---|---|
| dir | in | in, out |
| dur | 0.5 | 0.05–5 |
| block | 1 | 1–10 px |

### dust *(needs at)*
Dust puffs at the layer's feet, once or every `every` seconds until `until`.

| param | default | range |
|---|---|---|
| every | 0 | 0–10 |
| n | 3 | 1–10, specks per side |
| spread | 0.7 | 0.1–3 |
| dx | 0 | −100–100 |
| colour | "q" | |

### sparkle *(needs at)*
A ring of sparkles around the layer's centre.

| param | default | range |
|---|---|---|
| colour | "B" | |
| every | 0 | 0–10 |
| dx | 0 | −200–200 |
| dy | 0 | −200–200 |
| size | 18 | 4–80 |

## Sound
Scenes collect sounds into `compiled.sfx`, which the mixer adds to `audio.sfx.events`:
- **Behaviours:** jumpArc gives jump and land; arc, appear, disappear and sit give their `sfx`.
- **Widgets:** listed above.
- **Recipes:** listed in [RECIPES.md](RECIPES.md).
- **Scene starts:** every scene but the first starts with a whoosh.

Sound names: select, confirm, whoosh, coin, jump, bump, sign, pipe, land, fall, join, powerup, cheer, block, fanfare-short, achieve, quest, flag, alarm, brick, flagpole, fanfare, start.
