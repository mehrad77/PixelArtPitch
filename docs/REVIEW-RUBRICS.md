# Review rubrics

Checklists for every review in PAP. Answer each item yes or no. A "no" becomes a finding.
Always run the **lints first** (they are free and exact). Then look.

Every finding has this shape:

```json
{ "severity": "blocker", "t": 41.2, "where": "scene finale", "what": "The flag label is clipped at the right edge", "fix": "Move the text 12 px left or set fit: true" }
```

- **Blocker:** must be fixed before shipping. **Always has a timestamp** in seconds.
- **Polish:** nice to have. It has a timestamp when there is one.
- In the crew, each finding becomes one `note_add` (category `art`, `text`, `too_fast`, `too_slow`, `unclear`, `sound` or `other`).

## 1. Sprite critique (Pixel Artist on its own render, or the Art Director)

Look at the sheet on the night sky at 1× and 4×.

| # | Check | Passes when |
|---|---|---|
| 1 | Silhouette at 1× | You can tell what it is from the outline alone |
| 2 | Reads as | Name it in 3 words. That matches the spec's description, and it is not confusable with another asset (an icon is not a second moon) |
| 3 | Light | Upper left is lit; the right and bottom edges are darker on every shape |
| 4 | Outline | A 1 px dark outline all round; no gaps; no double outlines |
| 5 | Edge contrast | The ring inside the outline is visible against the sky (≥ 60% is good; 40% is the hard floor) |
| 6 | Strays | No lone pixels, no noise, no accidental dithering |
| 7 | Frame consistency | The same proportions, palette and baseline in every frame; loop frames change little; no frame pops |
| 8 | Anatomy (characters) | Head about 8 × 8; feet on the bottom row; hands and the main trait visible |
| 9 | Animation (characters) | Idle breathes 1 px; run alternates contact and passing poses; wave is clear |
| 10 | Likeness (only with references) | The person's 2–3 strongest traits show (hair shape, glasses, beard, build); not traced; flagged private |

Output: a short list of what to change, then the complete revised grid. Keep what works.

## 2. Judge (pairwise)

Compare 2 finished variants of the same spec. Repeat until one is left.
1. Which one reads as the spec at 1×? (weight 3)
2. Which has the cleaner silhouette, fewer strays and correct light? (weight 2)
3. Which animates more smoothly (characters)? (weight 2)
4. Which fits the palette roles and the other assets in the video? (weight 1)
5. Did either fail a hard rule? A failed variant loses.

```json
{ "winner": "B", "scores": { "A": 5, "B": 7 }, "reason": "B reads as a lantern at 1x; A's round body reads as a bell." }
```

The reason becomes `provenance.judgeReason`. It names the decisive difference in one sentence.

## 3. Picture review (stills and the contact sheet)

Inputs: `render_contact` (every 1 s), plus `render_still` at each scene's start + 0.8 s, middle and end − 0.5 s. Judge only what you can see.

**Blockers** (any one stops shipping):
- [ ] Text clipped at a frame edge, or cut off mid-word
- [ ] Anything important in the caption zone (text or a panel below y = 146; a face below y = 140)
- [ ] Two texts on screen besides the caption, or a text of 4+ words
- [ ] Overlaps: a prop on a head, a label over another label, a sprite over a face
- [ ] An icon that is unreadable or reads as something else
- [ ] Characters in the wrong order or colour (P1 `T`, P2 `Q`, P3 `O`), or a missing marker
- [ ] A frame with no subject (blank, or only the backdrop for over 1 s outside the hold)
- [ ] The subject hidden by a transition
- [ ] Contradicting the caption (it says "three" and shows two)

**Polish:**
- [ ] An idea shown for < 1.5 s
- [ ] No motion within 1 s after the hold
- [ ] A weak payoff (small, faint, off-centre)
- [ ] Missing game feel on an impact (shake, squash, dust)
- [ ] Long-shot only for a key character moment
- [ ] Unused space or a cluttered HUD

## 4. Sound and sync review

Inputs: the `audio_render` result, the timeline (`timeline_get`), and stills at each effect's time.

**Blockers:**
- [ ] `mix.lufs` outside −17…−15, or `truePeakDb` above −1
- [ ] A cue's caption is on screen while its words are not being spoken (off by > 0.3 s)
- [ ] An effect masks a key word
- [ ] An effect with no visible event, or a big event with an effect more than 2 frames off
- [ ] Silence or clipping where there should be sound

**Polish:**
- [ ] More than 1 effect per 4 s under the voice
- [ ] `fanfare` more than once
- [ ] Music that doesn't lift at the payoff or settle on the end card
- [ ] Effects during the hold

## 5. Final review

Inputs: the brief, the contact sheet and the stills (as in §3). The Reviewer sees the renders and the brief only, never the code.
1. Run every lint and list any `error`.
2. Run §3 and §4.
3. Check against the brief: every `mustSay` is on screen or spoken; nothing from `mustAvoid`; the ask and the call to action are clear; the length is within ±10% of `lengthSec`.
4. Check the end card: product name, call to action, URL, held as a loop ≥ 4 s.
5. Return:

```json
{ "verdict": "fix first: the finale label is clipped", "blockers": [ { "t": 41.2, "what": "…", "fix": "…" } ], "polish": [ { "t": 12.0, "what": "…", "fix": "…" } ] }
```

The verdict is one sentence that starts with `ship` or `fix first`. Ship only with zero blockers.

## 6. Seeded blocker examples

These three kinds of blocker were caught by the final review of the first video. Look for them every time. (The times below are illustrative.)

```json
[
  { "severity": "blocker", "t": 58.4, "where": "map scene, top right", "what": "A stray label is clipped to its first three letters at the right edge", "fix": "Remove the label (it repeats the caption) or move it inside x 8..312" },
  { "severity": "blocker", "t": 22.0, "where": "level scene, the hero", "what": "A street lamp prop sits exactly on the hero's head, so it reads as a hat", "fix": "Move the lamp at least 4 px clear of every head" },
  { "severity": "blocker", "t": 34.5, "where": "hub scene, upper left", "what": "A round pale platform icon sits near the moon and reads as a second moon", "fix": "Use a squarer icon or a different colour, or move it away from the moon" }
]
```
