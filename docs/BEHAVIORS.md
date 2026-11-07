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
| backdrop | style night/plain, sky, band true, stars 70, moon true, moonX 262, moonY 18, skyline true | fills the frame; parallax follows the camera |
| tiled | asset "tiles", frame "ground-top", fill "ground", y 148, tile 16, fromX, toX, gaps [] | a ground row |
| sprite | **asset**, frame, frames [] + fps 4, x, y, anchor topLeft/bottom/center, flip, outline, alpha 1, scale 1–4, colour | `frames` cycles |
| actor | **asset**, x 160 (feet centre), y 148 (feet), facing, artFaces "left", runFps 10, idleFps 2.5, dust true, outline, frames {} | picks idle, run, jump or wave by itself |
| text | **text**, x 160, y 40, align center, scale 1–4, fit false, colour "P", shadow true, alpha, maxW 0, lineH 10 | `fit` shrinks to 304 px |
| panel | x, y, **w**, **h**, border "G", fill "k", alpha 0.88 | dark box with a shadow |
| group | x, y, alpha + `children` | moves its children together |
| shape | shape rect/box/disc/line, x, y, w, h, r, x2, y2, colour, alpha | |
| fx | **fx**: sparkle, ring, dust, twinkle, flash, fireworks, shootingStar; x, y, at, every, colour, n, size, dur, w, h | effects without a sprite |
| widget | **widget**: banner, toast, nameTag, hudSlots, qblock, counter, flagpole (props below) | ready-made UI |

**Actors** choose their frame from what the asset has:
- `run0`–`run3` while walking. Without those, they alternate `idle0`/`idle1` with a 1 px bob.
- `jump` in the air, falling back to `give`.
- `wave`, falling back to `give`.
- To force a pose, use `keys.state` with `"idle" | "run" | "jump" | "wave" | "auto"`.

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

## Keys
`keys` animate a prop over time: `{ "prop": [{ "t": time, "v": value, "ease": name }] }`.
- **Interpolation:** numbers interpolate; text and true/false step.
- **Ease:** a key's `ease` shapes the segment that ends at it. The eases are `linear`, `in`, `out`, `inOut`, `outCubic`, `backOut` (overshoot) and `step`.
- **Keyable on every kind:** x, y, alpha, visible.
- **Keyable per kind:**
  - sprite: frame, scale
  - actor: state, facing
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
- **Behaviours:** jumpArc gives jump and land; arc, appear and disappear give their `sfx`.
- **Widgets:** listed above.
- **Recipes:** listed in [RECIPES.md](RECIPES.md).
- **Scene starts:** every scene but the first starts with a whoosh.

Sound names: select, confirm, whoosh, coin, jump, bump, sign, pipe, land, fall, join, powerup, cheer, block, fanfare-short, achieve, quest, flag, alarm, brick, flagpole, fanfare, start.
