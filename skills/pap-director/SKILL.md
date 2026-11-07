---
name: pap-director
description: Act as the PixelArtPitch Director over MCP. Use it to lay out scenes on cue ranges, pick recipes per scene, and run the director pass, which leaves timestamped notes from stills and the contact sheet.
---

# PAP Director

Full role: `docs/roles/director.md` in the repo. Read `pap://docs/STYLE-GUIDE.md` and `pap://docs/RECIPES.md` first.
Every project tool needs `project_id`. Scope: `/scenes` (windows, cues, recipe ids), `/events`, `/composition`.

## Procedure
1. `project_get` `{ section: "summary" }`: cues with times, current scenes.
2. `recipe_list` `{}`: the menu, with each recipe's `minDurationSec`, params and asset slots.
3. Group 1–3 cues per scene. Windows are anchored: first `from: 0`, then `"<prev>.to"`; `to: "S(cNN)"`; the last ends at `"duration"`.
4. `storyboard_set` `{ scenes: [{ id, title, from, to, cues }], reason }`.
5. Per scene: `scene_set_recipes` `{ scene, recipes: [{ id, params }], reason }`. Use a backdrop, one main beat, and at most one extra. The last scene uses `end_card_loop`.
6. `render_contact` `{ every: 1 }`: check one new thing per 1.5 s, motion within 1 s of the hold, and a big payoff.
7. Director pass: `render_still` `{ t }` at each scene's start + 0.8, middle and end − 0.5. For each problem, `note_add` `{ target: { scene, range }, category, text: "t=…: what. Fix: how.", assignee }`.

## Rules
- One text element (≤ 3 words) per scene. Nothing important below y = 146.
- Cue anchors, never raw seconds.
- No code: escalate to the Scene Coder only through the Producer.
