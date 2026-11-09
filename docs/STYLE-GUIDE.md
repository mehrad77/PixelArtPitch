# Style guide

The look of every PAP video. Each rule is a number or a yes/no, so you can check it on a still.
Terms: [GLOSSARY.md](GLOSSARY.md). Recipes and their params: [RECIPES.md](RECIPES.md) and `packages/engine/src/recipes.ts`.

## 1. Canvas

| Rule | Value |
|---|---|
| Buffer | 320 × 180 px, 30 fps |
| Output | Scaled ×4 (720p), ×6 (1080p) or ×12 (4K) with nearest-neighbour. Never smooth it. |
| Motion | Whole pixels only. A position is an integer on every frame. |
| Ground | Feet stand on y = 148 (`GROUND`). |
| Sky colour | `#0f1411` (not a palette letter; transparent cells show it) |

## 2. The night palette (`pap-night@1`)

The source of truth is `library/palettes/pap-night.json`. `.` is transparent. Never use `#`.

| Group | Letters | Use |
|---|---|---|
| Ink and night | `k` ink, `K` ground tone, `l` line, `e` limb, `F f` near-black, `N` navy, `Y` slate | Outlines, the deepest shadow, ground, dark stone. `k` is the outline. |
| Paper and greys | `P` paper, `p` dim, `q` off, `W w` light grey | Text, highlights, the moon, metal. `P` is the text colour. |
| Accent green | `g` dark, `G` strong, `T` light | The brand of the night: grass, "go", "done", success beats, P1. `T` is green text. |
| Signal orange | `O` | **Tiny doses only**: a lit window, a spark, a flash, a cursor, a tie, the P3 marker. A few cells per sprite, never a fill bigger than about 4 × 4. |
| Brass | `B` | Rewards and titles: stars, coins, medals, crowns, the flagpole ball, title text (`title_card` defaults to `B`). |
| Skin | `S` light, `s` shade, `z` deep | Faces and hands |
| Hair | `H h j` straw, `n` umber, `c` chestnut, `A a` black-brown | Hair, wood (`c n`) |
| Cloth and colour | `M m` mint, `D d L` denim, `X x` teal, `C E` turquoise, `Q` sky blue, `U` violet-blue, `I` indigo, `R` wine, `r` red, `V` violet | Clothes, screens (`C E`), hearts (`r R`), P2 (`Q`) |

Rules:
- Each colour group has a light, a mid and a dark tone. Shade with the darker tone of the same group, never with black.
- Use 3–5 tones per object. More than that looks noisy at 1×.
- Orange plus brass together should cover less than 5% of a frame.

## 3. Light, outline, contrast

1. Light comes from the **upper left**. The right and bottom edges of every shape take the darker tone.
2. A **1 px dark outline** (`k`, or the darkest tone of the shape) goes around figures, props and icons.
3. Since the outline is nearly as dark as the sky, the edge that reads is the **first ring inside the outline**. At least 40% of those cells must reach **1.7:1** against the sky (a hard rule); aim for 60% or more (below that is a soft warning). See [PAP-STANDARD.md](PAP-STANDARD.md).
4. Use clusters, not noise: no lone pixels, and no checkerboard dithering unless the spec asks for it.
5. New art faces **right** unless the spec says otherwise. The library NPCs face **left** (`gamer` faces right). Every character and creature asset says which way it looks in its `facing` field, and the engine mirrors it to face the way it walks. Never flip one by hand.
6. **Light sources** (lamps, lanterns, windows) glow in whole palette bands, never a blended halo: the `glow` fx steps from a dark outer tone to a bright core (default `A n c H`), and `B` or `O` may only be the core.

## 4. Icon first, little text

| Rule | Value |
|---|---|
| On-screen text besides the caption | **At most 1** element at a time, **≤ 3 words**, about 12 characters |
| Labels, HUD sentences, speech bubbles | None. Use an icon, a bar, pips or a marker instead. |
| A sign in the world (`label` widget) | Allowed as the scene's one text, ≤ 3 words. It is a painted board on posts, hung from a bar or on its own, never a floating box. |
| Text that repeats the caption | Never |
| Title text | 1–2 words (`title_card`) |
| Lint | `text-crowding` fires at 2 texts of 4+ words at once; `text-clipped` fires on any text off the frame for ≥ 0.5 s |

One icon means one thing for the whole video. Example vocabulary: star = direction found, heart = people like it, `?` block = an open question, medal = something gained, flag = shipped, check mark = done.

## 5. Caption zone and safe areas

```
y   0 ┌──────────────────────────────────────┐
      │ HUD: icons only (x 4, y 4)  1 gauge →│  top 20 px: HUD
      │                                      │
      │        subject, faces, icons         │  keep text inside x 8..312
y 140 │ ─ heads, icons and effects end here ─│
y 146 │ ═══ CAPTION_TOP: text/panels end ═══ │
y 148 │ feet / ground tiles                  │
      │      caption text, about y 152-176   │
y 180 └──────────────────────────────────────┘
```

- Text, panels and widgets must end above **y = 146**. Sprites and actors must start above y = 146 (lint `caption-zone`).
- Faces, icons, effects and props on a head: above **y = 140**.
- Captions are drawn by the host, wrap at 296 px and sit 4 px off the bottom.
- Keep text 8 px or more from the left and right edges.

## 6. Pacing

| Rule | Value |
|---|---|
| Opening hold | 3 s still frame (`composition.hold`) |
| First motion | Within **1 s** after the hold ends: a body in motion, or an impact |
| One idea | Shown for **≥ 1.5 s**, with only one new thing appearing at a time |
| Cue on screen | ≥ 1.5 s (lint `cue-short`) |
| Items collected | ≥ 0.5 s apart |
| Walk speed | 30 px/s default; 20–40 px/s under narration. Crossing the full frame takes about 10 s. |
| Scene length | ≥ the recipe's `minDurationSec`; 3–12 s is typical |
| A promised list ("three things") | It must count on screen: 1, 2, 3, one at a time |

## 7. Players, cast and markers

| Slot | Colour | Marker |
|---|---|---|
| P1 (the hero) | `T` green | A 5 × 3 down-pointing triangle above the head, bobbing 1 px at 2 Hz |
| P2 | `Q` blue | Same triangle in `Q`. A lead or founder may also wear a 5 × 4 `B` crown, in every scene they appear in. |
| P3 | `O` orange | Same triangle in `O` |

- A player keeps the same colour in every scene.
- Characters join in the order the caption names them.
- Use a name or "PLAYER 2" only as that scene's one text, and only while that character is the subject.
- Show a character big (a 2× close-up) at least once when they matter: the hello, the joins, the key moment.

## 8. HUD

- **Top-left:** icons only (item slots 15 px apart from x 4, y 4; see `item_collect`).
- **Top-right:** at most one icon gauge (pips or a bar).
- No sentences, counters of words, or labels in the HUD.

## 9. Transitions and game feel

| Thing | Value |
|---|---|
| Scene in | Pixel dissolve, 0.3 s (`composition.dissolveIn`). It must never cover the subject after its first 0.12 s; start the subject's entrance after the dissolve (recipes use `t0` = scene start + 0.35 s). |
| Video out | Fade 0.4 s (`composition.fadeOut`) |
| Impact | Camera shake of 1–2 px for 0.25 s, squash on landing, dust, a 0.06 s hit-stop on big hits |
| Title slam | `title_card` (drop, shake, ring) |

## 10. End card

- Use the `end_card_loop` recipe: product name, a 1–2 word call to action ("PRESS START"), and a URL line (it may swap to a second URL).
- Hold it **≥ 4 s** (`composition.endHold`); longer for an application video. It loops: twinkles and a slow pulse, never a frozen frame.
- The call to action pulses. It never blinks fully off for more than half the time.
- At most 3 text lines on the card.

## 11. Do and don't (from the first video)

| Don't | Do |
|---|---|
| Open on a static menu for 2+ s | Body in motion or an impact within 1 s of the hold |
| 14 labels on one map frame | One text of ≤ 3 words; everything else an icon |
| Speech bubbles that overprint labels | No bubbles; a marker or an icon |
| Introduce characters in a different order from the caption | Same order as the caption |
| A HUD that repeats the caption ("DONE!", "???") | Icons in the HUD only |
| 4 items in 2 s; 3 people in one 2.5 s cue | ≥ 1.5 s per idea, one new thing at a time |
| "Three things" said, never counted | A 1-2-3 counter filling one at a time |
| Characters only at long-shot scale | A 2× close-up for each key character moment |
| No game feel | Shake, squash, dust, hit-stop on impacts |
| A small, faint payoff (a 20 × 14 flag) | A big, clear payoff that fills a third of the frame |
| A dissolve hiding the subject | The subject enters after the dissolve |
| Text clipped at the frame edge | Text inside x 8..312; `fit: true`; run the lints |
| A lamp or prop sitting on a head | Props placed clear of every head (≥ 4 px gap) |
| A round icon that reads as a second moon | Icons distinct in shape from the moon; check what each one reads as at 1× |
| Fast walk (the first cut's walk was halved) | 30 px/s or less under narration |
