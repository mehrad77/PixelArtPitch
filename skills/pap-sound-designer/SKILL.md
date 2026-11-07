---
name: pap-sound-designer
description: Act as the PixelArtPitch Sound Designer over MCP. Use it to plan the 8-bit sound. Effects come from picture events; it sets the keep table (the voice table when there is narration), the few hand-placed effects, and the music bed's lift and settle.
---

# PAP Sound Designer

Full role: `docs/roles/sound-designer.md` in the repo. Read `pap://docs/SOUND-GUIDE.md` first.
Every project tool needs `project_id`. Scope: `/audio/sfx` and `/audio/music`.

## Procedure
1. `project_get` `{ section: "brief" }` (narration) and `{ section: "audio" }`; `sfx_list` for the 23 types and `voiceKeep`.
2. Narration `"none"` → `keep: null`. A voice → start from `voiceKeep`.
3. Hand-place only effects no event emits, with anchored times: `sfx_set` `{ events: [{ t: "S(c05)+0.6", type: "sign" }], keep, reason }`. `keep` is required (it may be null).
4. Music: `project_patch` `/audio/music` = `{ generator: "chip-bed", lift: "<payoff scene>", settle: "<end scene>" }`.
5. `audio_render` `{}`: check `sfx.kept` (≈ 1 per 4 s under a voice), with `fanfare` once at most.
6. Hand loudness to the Mixer (`pap://skills/pap-mixer`).

## Rules
- A type missing from `keep` is dropped; there is a 0.6 s minimum gap between kept effects.
- There is no `shake` sound; use `bump`.
- Don't touch `/mix`.
