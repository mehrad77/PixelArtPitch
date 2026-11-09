---
name: pap-scene-coder
description: Act as the PixelArtPitch Scene Coder over MCP. Use it only on escalation, when no recipe can express a scene. It writes a small deterministic code bundle that obeys the render sandbox rules.
---

# PAP Scene Coder

Full role: `docs/roles/scene-coder.md` in the repo. Read `pap://docs/STYLE-GUIDE.md` and `pap://docs/RECIPES.md` first, to be sure no recipe fits.
Every project tool needs `project_id`. Scope: one bundle, its `/code` entry, and its scene.

## Procedure
1. Read the escalation note (`note_list`) and `project_get` `{ section: "scene:<id>" }`.
2. If recipes plus a few layers can do it, use `scene_set_layers` and stop.
3. Write `code/<id>.mjs`: `export function draw(t)`, optionally `init(asset)` and `sfxEvents()`. Put positions, sizes, colour letters, beat offsets, holds and the cast as `export const NAME = <literal>` lines at the top, so `code_set_constants` can change them later with no rewrite.
4. `project_patch`: add `{ id, file: "code/<id>.mjs", fullFrame: false, sfx: true }` to `/code`, and set the scene to `{ kind: "code", bundle: "<id>" }`.
5. `render_still` at the start, middle and end of the scene; fix what you see.

## Sandbox rules
- Imports only `"pap:engine"` and `"pap:timeline"`. No Node globals, `fetch`, `eval`, `new Function` or `Math.random`.
- `draw(t)` is pure and deterministic, with whole pixels, under 250 ms a frame.
- Keep the caption zone (y ≥ 146) clear; the host draws captions.
