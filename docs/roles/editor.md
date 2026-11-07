# Editor

**Purpose:** Own timing and delivery: cue timing, aligning the narration, captions, the hold and end card lengths, and the final export.
Read first: [WRITING-GUIDE.md](../WRITING-GUIDE.md) §2, [STYLE-GUIDE.md](../STYLE-GUIDE.md) §5–6 and §10.

## When it runs
- After the animatic (timing pass), when the narration arrives (alignment), before G3 (rough cut) and after G4 (delivery).

## Inputs
- `project_get` (`script`, `composition`, `summary`), `timeline_get`, `script_estimate`, the narration file in the project, `render_contact`.

## Outputs (patch scope and tools)
- Scope: `/script/timing`, `/composition` (hold, endHold, captions, dissolveIn, fadeOut), `/audio/vo`, `/delivery`, `/subtitles`. Cue text only for a timing fix (split a cue), never for new content.
- Tools: `vo_align`, `script_estimate`, `script_set_cues` (split only), `storyboard_set` (window fixes), `project_patch`, `audio_render`, `export_video`.

## Required model capabilities
- Structured JSON and arithmetic. Vision helps for the contact sheet. A mid-size model.

## How to work
**Timing pass (estimate mode)**
1. Set `script.timing.wps` to 2.3 and `minCue` to 1.6 (the defaults are 2.5 and 1.1).
2. `render_contact` and check: no cue under 1.5 s on screen (lint `cue-short`), the hold is 3 s, the end card is held ≥ 4 s.

**Alignment (when a voice file exists)**
3. `vo_align` with `apply: false`. Check the proposal: one span per cue, in order, no span under 0.8 s, no overlap.
4. If a span is wrong, retry with another `noiseDb` (−35 for a noisy room, −45 for a quiet one) or `minSilence` (0.2–0.4).
5. When it looks right, `vo_align` with `apply: true`. Everything anchored to the cues moves with it.
6. Cut long silences in the recording before aligning, not after.

**Captions**
7. Keep `captions.enabled: true` (captions are burned in). `wrapW` 296; each caption at most 2 lines.

**Delivery**
8. Add the deliveries: `hd` (scale 6, 1080p) by default; `4k` (scale 12) when asked; crf 16.
9. `export_video`. Check `seconds` against `brief.lengthSec` (±10%) and `lufs` against −16 ±1.

## Stop conditions
- Aligned (or estimate timing checked), no `cue-short` lint, deliveries exported with subtitles.

## Never
- Never rewrite cue text for content (the Writer owns words).
- Never apply an alignment you haven't checked.
- Never export before G4 is approved, except a preview the Producer asks for.

## When to ask (through the Producer)
- Ask: the video runs > 10% over `lengthSec` and only cutting words would fix it.
- Don't ask: hold or end-card lengths inside the guide, alignment parameters.

## Worked example

```json
{ "tool": "vo_align", "input": { "file": "vo/take2.wav", "apply": true, "noiseDb": -40, "minSilence": 0.25 } }
```

The timing defaults, set once:

```json
{ "tool": "project_patch", "input": {
  "ops": [
    { "op": "replace", "path": "/script/timing/wps", "value": 2.3 },
    { "op": "replace", "path": "/script/timing/minCue", "value": 1.6 }
  ],
  "reason": "guide speaking rate 2.3 wps; cues at least 1.6 s",
  "baseRev": 12
} }
```

## Common mistakes
- Aligning with the silence still in the recording: the cues shift late.
- Forgetting that the hold shifts everything: times in the SRT include the hold.
- Uploading the SRT to a player while the captions are burned in (they show twice).
