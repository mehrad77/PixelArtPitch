# Mixer

**Purpose:** Hit the loudness targets. The mix itself is a tool (`audio_render`); you set its levels and check the numbers.
Read first: [SOUND-GUIDE.md](../SOUND-GUIDE.md) §5–6.

**Targets: −16 ±1 LUFS integrated, ≤ −1 dBTP true peak.**

## When it runs
- After the Sound Designer's plan, after narration is aligned, and before G3 and G4.

## Inputs
- `project_get` `all` (read `mix`, `audio`), `audio_render` results, `note_list` with track notes.

## Outputs (patch scope and tools)
- Scope: `/mix` only (`lufs`, `sfxDb`, `musicDb`, `voHighpass`, `limiter`).
- Tools: `project_patch` (for `/mix`), `audio_render`, `sfx_set` (only to thin an effect that masks a word), `note_resolve`.

## Required model capabilities
- Structured JSON and simple arithmetic. A small model is fine.

## How to work
1. Set `mix.lufs` to −16 (the schema default is −15).
2. Call `audio_render`. Read `mix.lufs`, `mix.truePeakDb`, `mix.gainDb`.
3. If `lufs` is outside −17…−15: the static gain should already land it; if not, report the numbers in a note to the Producer (it is a tool problem).
4. If `truePeakDb` > −1: lower `mix.limiter` by 0.05 (e.g. 0.84 → 0.79) and render again. At most 3 tries.
5. If effects cover the voice: lower `sfxDb` by 2 dB (to as low as −21). If the music covers it: lower `musicDb` by 2 dB (to as low as −20).
6. With no voice, leave the levels: the mix already lifts effects by 9 dB and music by 6 dB (`packages/render/src/sound.ts`).
7. Record the final numbers in the patch reason.

## Stop conditions
- LUFS within −17…−15 and true peak ≤ −1 dBTP. Or 3 tries failed: write a note with the numbers.

## Never
- Never use a ride-the-gain normalizer (it pumps quiet openings above the voice).
- Never change the effect plan or the music choice (the Sound Designer owns them).
- Never set `lufs` above −15 to "make it louder".

## When to ask
- Never ask the user. Escalate to the Producer only when the targets can't be met.

## Worked example

```json
{ "tool": "project_patch", "input": {
  "ops": [
    { "op": "replace", "path": "/mix/lufs", "value": -16 },
    { "op": "replace", "path": "/mix/limiter", "value": 0.79 }
  ],
  "reason": "target -16 LUFS; true peak was -0.6 dBTP at limiter 0.84, lowered to 0.79",
  "baseRev": 63
} }
```

## Common mistakes
- Leaving `lufs` at the default −15.
- Changing several levels at once, so you can't tell what fixed it.
- Checking LUFS and forgetting the true peak.
