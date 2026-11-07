# Sound guide

Everything is synthesized 8-bit sound (square, triangle and noise voices). There are no samples. Source: `packages/engine/src/audio.ts`.
Effects come **from events in the picture**, so they stay in sync when the timing moves. You rarely place one by hand.

## 1. The 23 SFX types

| Type | Sounds like | Use it for |
|---|---|---|
| `select` | Two quick high blips | A menu cursor; a subtitle or URL line appearing |
| `confirm` | A fast 4-note rising arpeggio | A menu choice confirmed; "go" |
| `whoosh` | A 0.25 s rising noise sweep | A scene change (added automatically) |
| `coin` | A bright two-note ping | An item collected; a counter reaching its value |
| `jump` | A short rising square sweep | Take-off |
| `bump` | A low thud with a click | A head hitting a block; a title slamming down |
| `sign` | A thin 3-note chime | A sign or board appearing |
| `pipe` | A 0.45 s warble | Entering a pipe; teleporting |
| `land` | A short noise thud | Feet hitting the ground |
| `fall` | A falling sweep, 0.45 s | Something dropping from the sky |
| `join` | A cheerful 4-note arpeggio | A character joining the team |
| `powerup` | A 10-note rising zigzag | Gaining an ability or a tool |
| `cheer` | Crowd noise plus a small tune, 0.9 s | A crowd cheering |
| `block` | A short two-note blip | A block or tile placed |
| `fanfare-short` | A 4-note major arpeggio with bass, about 0.6 s | A small win |
| `achieve` | A high 3-note sparkle | A toast or banner arriving |
| `quest` | A two-tone call | A goal announced |
| `flag` | A rapid 5-note rise | A flag reaching the top |
| `alarm` | 3 repeated alerts, about 1 s | A warning or deadline (use rarely) |
| `brick` | A crack with a low knock | A brick breaking; a plank set down |
| `flagpole` | A 1 s slow rising sweep | A flag climbing the pole |
| `fanfare` | A full 3-voice fanfare, about 1.2 s | **The** finale payoff: once per video |
| `start` | "Press start": two blips and a high note | The end card's call to action |

There is no `shake` sound. Use `bump` for an impact.

## 2. Event → SFX map

| Source | Emits |
|---|---|
| Every scene start except the first | `whoosh` |
| Behaviour `jumpArc` (with `sfx: true`) | `jump` at take-off, `land` at landing |
| Behaviour `arc` | Its `sfx` param on arrival (default `coin`) |
| Behaviour `appear` / `disappear` | Its `sfx` param (default none) |
| Widget `banner` / `toast` | Its `sfx` (default `achieve`) |
| Widget `qblock` with a `hit` | Its `sfx` (default `bump`) |
| Widget `counter` | Its `sfx` when it reaches the end value (default `coin`) |
| Widget `flagpole` with a `raise` | `flagpole`, then `flag`, then `fanfare` |
| Recipe `title_card` | `bump` (+ `select` with a subtitle) |
| Recipe `block_bump` | `jump`, `bump`, `coin`, `land` |
| Recipe `item_collect` | `coin` per item |
| Recipe `spawn_join` | `fall`, `land`, `join` |
| Recipe `toast`, `banner` | `achieve` |
| Recipe `crowd_cheer` | `cheer` |
| Recipe `flag_raise` | `flagpole`, `flag`, `fanfare` |
| Recipe `end_card_loop` | `land`, `start`, `select` |
| `audio.sfx.events` | Extra events you place by hand (`sfx_set`), on cue-anchored times |

The code is in `collectSfx()` in `packages/engine/src/decl.ts` and each recipe's `sfx` list (`recipe_list`). The behaviour params are documented in [BEHAVIORS.md](BEHAVIORS.md).

## 3. Thinning

**Without a voice** (`narration: "none"`): set `keep: null`. Every event plays, with no gap rule. Still remove events that pile up: no more than about 2 effects per second.

**With a voice** (`narration: "user"` or `"tts"`): use the voice keep table. The first video went from 86 effects to 19 this way.

| Type | Keep at most |
|---|---|
| `confirm` | 1 |
| `bump` | 2 |
| `coin` | 4 |
| `join` | 2 |
| `powerup` | 2 |
| `cheer` | 1 |
| `achieve` | 3 |
| `flag` | 3 |
| `fanfare` | 1 |
| `start` | 1 |

How it works (`thinSfx`):
1. Events are taken in time order.
2. **A type missing from the table is dropped entirely**: `whoosh`, `jump`, `land`, `select`, `flagpole`, `fall` and the rest all go.
3. Each type keeps its first N events.
4. **No two kept effects are closer than 0.6 s** (`audio.sfx.minGap`), across all types.
5. `keep: null` turns all of this off.

To keep a beat that thinning drops, add its type to the table with a count, and say why in the patch reason.

## 4. Music bed

- Generator `chip-bed`: a calm night chiptune, Am–F–C–G at 84 BPM, made of a soft detuned triangle pad, a quiet arpeggio and a triangle bass, with a light echo.
- It **fades in over the hold** and **fades out over the last 4 s**.
- **Lift:** from the start of scene `audio.music.lift`, it rises 35% over 2 s (use it for the finale or payoff).
- **Settle:** from the start of scene `audio.music.settle`, it eases back over 4 s (usually the end card).
- It loops under the end card.
- Set `audio.music` with `project_patch`, e.g. `{ "generator": "chip-bed", "lift": "finale", "settle": "end" }`.

## 5. Mix targets

| Setting | Value | Where |
|---|---|---|
| Integrated loudness | **−16 ±1 LUFS** | `mix.lufs` (set it to −16; the schema default is −15) |
| True peak | **≤ −1 dBTP** | Read `truePeakDb` from `audio_render`; lower `mix.limiter` if it is above −1 |
| Effects | −15 dB | `mix.sfxDb` |
| Music | −14 dB | `mix.musicDb` |
| Voice high-pass | 80 Hz | `mix.voHighpass` |
| Ducking | Effects and music duck under the voice (sidechain) | automatic |
| No voice | Effects +9 dB and music +6 dB over the levels above | automatic |

Gain is a static gain to `mix.lufs`, followed by a peak limiter (`mix.limiter` is the linear ceiling: 0.84 ≈ −1.5 dBFS). Don't use a loudness normalizer that rides the gain: in the first video one pumped the quiet opening above the voice.

## 6. What to check (after `audio_render`)

- [ ] `mix.lufs` is between −17 and −15
- [ ] `truePeakDb` ≤ −1
- [ ] `sfx.kept` is ≤ about 1 effect per 4 s of voice (for a 90 s voiced video, about 20)
- [ ] There is no effect under the first word of any cue that matters
- [ ] `fanfare` plays at most once, at the payoff
- [ ] The music is audible but never covers a word; it lifts at the payoff and settles on the end card
- [ ] Every effect matches a visible event within 1 frame (check with stills at the event times)
- [ ] The hold is quiet: music fading in, and no effects
