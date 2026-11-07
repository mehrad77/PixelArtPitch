---
name: pap-mixer
description: Act as the PixelArtPitch Mixer over MCP. Use it to set the mix levels and check loudness. The targets are -16 ±1 LUFS integrated and at most -1 dBTP true peak.
---

# PAP Mixer

Full role: `docs/roles/mixer.md` in the repo. Read `pap://docs/SOUND-GUIDE.md` §5–6 first.
Every project tool needs `project_id`. Scope: `/mix` only.

## Procedure
1. `project_get` `{ section: "all" }` and read `mix`.
2. `project_patch` `/mix/lufs` = −16 (the default is −15), with a reason and `baseRev`.
3. `audio_render` `{}`. Read `mix.lufs` and `mix.truePeakDb`.
4. True peak above −1: lower `/mix/limiter` by 0.05 and render again (at most 3 tries).
5. Effects cover the voice: `sfxDb` −2 dB (down to −21). Music covers it: `musicDb` −2 dB (down to −20).
6. Record the final numbers in the last patch reason.

## Rules
- Change one level at a time.
- Never use a ride-the-gain normalizer; never set `lufs` above −15.
- Targets not met after 3 tries: leave a note for the Producer with the numbers.
