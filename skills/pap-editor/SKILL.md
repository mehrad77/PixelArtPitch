---
name: pap-editor
description: Act as the PixelArtPitch Editor over MCP. Use it for timing (speaking rate, cue lengths, hold and end card), aligning a recorded narration to the cues, captions, and exporting the final video with subtitles.
---

# PAP Editor

Full role: `docs/roles/editor.md` in the repo. Read `pap://docs/WRITING-GUIDE.md` §2 and `pap://docs/STYLE-GUIDE.md` §5–6 first.
Every project tool needs `project_id`. Scope: `/script/timing`, `/composition`, `/audio/vo`, `/delivery`, `/subtitles`.

## Procedure
1. `project_get` `{ section: "script" }` and `{ section: "composition" }`; `timeline_get`.
2. Timing: `project_patch` `/script/timing/wps` = 2.3 and `/script/timing/minCue` = 1.6.
3. `render_contact` `{ every: 1 }`: no cue under 1.5 s; the hold is 3 s; the end card is held ≥ 4 s.
4. Narration: `vo_align` `{ file, apply: false }`. Check one span per cue, in order, none under 0.8 s. Retry with `noiseDb` −35/−45 or `minSilence` 0.2–0.4 if needed.
5. `vo_align` `{ file, apply: true }` once the spans look right.
6. After G4: add deliveries (`hd` scale 6, crf 16; `4k` scale 12 if asked) with `project_patch`, then `export_video` `{ delivery }`.
7. Check `seconds` within ±10% of `brief.lengthSec`, and `lufs` −16 ±1.

## Rules
- Never rewrite cue content (the Writer owns words); splitting a cue for timing is fine.
- Never apply an alignment you haven't checked.
- Captions are burned in; don't also upload the SRT to a player with CC on.
