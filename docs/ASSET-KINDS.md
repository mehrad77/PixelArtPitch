# Asset kinds: spec templates

One template per kind. The Art Director fills in a template, and the Pixel Artist draws from it.
Sizes and required frames come from [PAP-STANDARD.md](PAP-STANDARD.md) (the checker is the final word). Palette letters: [STYLE-GUIDE.md](STYLE-GUIDE.md) §2.

Every spec has this shape:

```json
{ "name": "<id>", "kind": "<kind>", "w": 16, "h": 24, "frames": ["idle0"], "palette": "kSsAaGgTqP",
  "describe": "<the description template, filled in>", "variants": 3, "rounds": 2, "refs": [] }
```

`palette` lists the letters the artist may use (5–12 letters is typical). `refs` holds reference files, for likeness only (private; see [RIGHTS.md](RIGHTS.md)).

**Search the library first** (`library_search`), and write a spec only when nothing fits. The library has no hero, so a hero is always kitbashed or drawn.

## character (hero)
- **Size:** 16 × 24. **Frames:** `idle0 idle1 run0 run1 run2 run3 jump wave`. Tags: `hero`.
- **Palette roles:** outline `k`; skin `S s z`; hair (one group); top (one group, P1 `T G g`); trousers `D d` or `F f`; shoes `k F`.
- **Describe:** "A <age/build> <person> facing RIGHT: <hair>, <top>, <trousers>, <one prop or trait>. idle0/idle1 breathe (1 px chest move). run0-3: contact, passing, contact, passing. jump: knees up, arms up. wave: right arm raised. Feet on the bottom row."
- Check: feet on row 23 in all but `jump`; the head is about 8 × 8; the run swaps ≤ 50% of cells; one strong trait reads at 1× (hair shape, glasses, hat).

## NPC (a character tagged `npc`)
- **Size:** 16 × 24. `kind: "character"`, tags `["npc", …]`. **Frames:** `idle0` required; usually `idle0 idle1 give`.
- **Palette roles:** like the hero, but the outfit must not use any player colour (`T`, `Q`, `O`) as its main tone.
- **Describe:** "A <role> NPC facing LEFT (toward the player): <hair>, <outfit>, holding <one prop that says the role>. idle0/idle1 breathe; give holds the prop out. Feet on the bottom row."
- Check: the prop tells the role without text; faces left; not confusable with a player.

## crowd
- **Size:** w 16–96 in steps of 16; h 16 or 24. **Frames:** `cheer0 cheer1`.
- **Palette roles:** varied hair and tops, 3–4 groups; outline `k`.
- **Describe:** "<N> small people side by side, each about 8-10 px wide, varied hair and tops, <one prop>. cheer0: arms down. cheer1: arms up, 1 px higher. Feet on the bottom row in cheer0."
- Check: each person is separate (1 px gap); cheer1 differs clearly from cheer0.

## prop
- **Size:** 24 × 32, 16 × 32 or 16 × 16. **Frames:** one per prop, or a 2-frame loop (`flag0 flag1`).
- **Palette roles:** material (wood `c n`, metal `p q`, stone `e q l`), and one accent (`B` or `O`, tiny).
- **Describe:** "<object> standing on the bottom row, <material letters>, <detail>. Transparent background."
- Check: it sits on the bottom row; it reads at 1×; nothing in it looks like a head-mounted item when placed beside a character.

## icon
- **Size:** 12 × 12, 16 × 16 or 8 × 8. **Frames:** one per icon, or `name0 name1` for a glow.
- **Palette roles:** one main group plus `P` highlight; outline `k`.
- **Describe:** "<thing> centred in the frame with a 1 px dark outline: <shape>, <colours>. No brand logos, no text."
- Check: one meaning only; distinct in shape from every other icon and from the moon; readable at 8 × 8 if it is a HUD icon.

## block
- **Size:** 16 × 16. **Frames:** for example `normal glow used`.
- **Palette roles:** body (one group), rivets `k`, symbol `P`.
- **Describe:** "A 16x16 platformer block with a 1 px outline and riveted corners: <body colours>, <symbol>. <frame list with what changes>."
- Check: `used` is clearly spent (grey-brown, no symbol); `glow` is brighter, not a different shape.

## tile
- **Size:** 16 × 16. **Frames:** a set such as `ground-top ground brick bridge`.
- **Palette roles:** soil `n c`, grass `T G g`, mortar `k`.
- **Describe:** "Tileable <surface>: <frame> = <what>, tileable <left-right / all directions>."
- Check: the left and right edges join (and the top and bottom edges, if tiled vertically); no orphans at the edges.

## map-tile
- **Size:** 16 × 16. **Frames:** `node-locked node-open node-done path-h tree hill water grass` or a subset.
- **Describe:** "Top-down overworld tiles at night: <frame> = <what>."
- Check: the three node states differ by more than colour (padlock, glow, flag).

## building
- **Size:** w and h multiples of 8, up to 128 × 112. **Frames:** usually 1.
- **Palette roles:** stone `e q l k`, windows `O B` (a few), banner `G T`.
- **Describe:** "<building> at night: <silhouette>, <door>, <a few lit windows>, base on the bottom row."
- Check: a strong stepped silhouette; lit windows ≤ 6.

## backdrop
- **Size:** w a multiple of 16, up to 320 × 90. **Frames:** parallax layers, e.g. `far near`.
- **Palette roles:** far `l e`, near `K l`, windows `B O T` (scattered).
- **Describe:** "<scene> silhouettes, tileable left to right; transparent above the rooftops; <frame> = <depth and details>."
- Check: it tiles seamlessly; far is lower in contrast than near; ≤ 1 lit window per 16 px.

## decor
- **Size:** up to 32 × 32. **Frames:** usually 1.
- **Describe:** "<sky or ground ornament> (<letters>), transparent background."
- Check: only one moon-like round pale shape per scene.

## font
- **Size:** 5 × 8. **Frames:** `g<code point>`: A–Z and 0–9 required; then a–z and `. , ! ? ' " - : ; ( ) / + & % # @ > * _`.
- **Palette roles:** `P` only (the renderer recolours it).
- **Describe:** "One glyph per frame, 5 wide and 8 tall, a 1 px stroke, a baseline on row 6, descenders on rows 7-8."
- Check: draw it in chunks of about 16 glyphs (one big request is too large); `O` and `0`, and `I`, `l` and `1`, are distinct.

## logo
- **Size:** up to 96 × 48. **Frames:** 1, or a 2-frame glow.
- Always **private**: `rights.brand: true` (and `trademark: true` when it is a mark). It is never drawn from memory: the user supplies it, and it is quantized from their file (`packages/engine/src/quantize.ts`).
- Check: the user confirmed the rights; it is flagged private on the asset ref.

## Kitbash: a new character from parts

Use a kitbash when you need a hero or a variant of a person. It costs one critique round instead of a full draw.
1. **Base body:** start from a 16 × 24 character with all 8 frames (a project hero, or the nearest library character mirrored for an NPC). Record it in `provenance.sourceAssets`.
2. **Hair:** repaint rows 0–7 only. Pick a hair group (`H h j`, `n c`, `A a`, `p q` for grey). The light tone goes top-left, the deep tone at the right and back.
3. **Beard / glasses:** a beard uses the hair's mid and deep tones over the jaw rows (about rows 6–8). Glasses are a 1 px `k` or `F` frame across the eye row, with a `P` glint top-left.
4. **Outfit tones:** swap the top's group letter-for-letter (light→light, mid→mid, dark→dark), e.g. `T G g` → `Q L D`. Keep the outline cells unchanged.
5. **Apply it to every frame** at the same rows, so the swap rule still holds.
6. Set `provenance.source: "derived"`. The new asset **inherits every rights flag** of its sources; if a likeness reference was used, it is private.
7. Run `checkAsset`, then one critique round (silhouette at 1×, the trait reads).

Example swap table, recorded in the spec's `describe`:

```text
base: file:assets/hero.json (8 frames)   hair: A a -> n c   top: T G g -> Q L D   add: glasses row 4 (k, P glint)
```
