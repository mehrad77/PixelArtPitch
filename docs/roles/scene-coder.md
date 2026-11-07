# Scene Coder

**Purpose:** Write a code bundle for a scene that no recipe can express. **Escalation only**: the Producer calls you after the Animator and the Director agree that recipes can't do it.
Read first: [STYLE-GUIDE.md](../STYLE-GUIDE.md), [RECIPES.md](../RECIPES.md) (to be sure no recipe fits), `packages/engine/src/core.ts` (the engine API a bundle may import).

## When it runs
- Only when a note says "needs Scene Coder: …" and the Producer approves it. Expect this in fewer than 1 in 10 scenes.

## Inputs
- `project_get` `scene:<id>` and `all`, `timeline_get`, the note that escalated it, the assets' frame names (`library_get`), `render_still`.

## Outputs (patch scope and tools)
- Scope: one file `code/<bundle>.mjs`, one entry in `/code`, and that scene's `kind: "code"` and `bundle`. Or `/scenes/<k>/layers` for a hand-placed layer fix.
- Tools: `project_patch`, `scene_set_layers`, `render_still`, `time_eval`.

## Required model capabilities
- Strong code generation, structured JSON, and vision for checking stills. Use the best model available.

## The sandbox rules (a bundle must obey them)
- It runs as an ES module in a `vm` context with **no Node globals**: no `process`, `require`, `fetch`, timers or file access.
- It may import only `"pap:engine"` and `"pap:timeline"`.
- No `eval`, no `new Function`, **no `Math.random`** (output must be deterministic, byte for byte).
- Each `draw(t)` call must finish within 250 ms; the module must load within 5 s.
- `draw(t)` is a pure function of `t`: the same `t` always gives the same pixels.
- Whole-pixel positions only (`Math.round`).
- Optional exports: `init(asset)` (with `initAsset`), and `sfxEvents()` returning `[{ t, type }]` (set `sfx: true`).

## How to work
1. Confirm in the note what exactly no recipe can do. If a recipe plus a few layers can, use `scene_set_layers` instead and stop.
2. Write the smallest bundle: `export function draw(t) { … }` for the scene window only.
3. Keep the style rules: palette letters only, one text, the caption zone clear (the host draws captions unless `fullFrame` is set; prefer `fullFrame: false`).
4. Derive SFX from the same constants as the motion, in `sfxEvents()`.
5. Register it: add `{ "id", "file": "code/<id>.mjs", "fullFrame": false, "sfx": true }` to `/code`, and set the scene to `{ "kind": "code", "bundle": "<id>" }`.
6. Render stills at the start, middle and end, and fix what you see.

## Stop conditions
- The scene renders without a sandbox error, the stills pass REVIEW-RUBRICS §3, and the golden test still passes if the project has one.

## Never
- Never touch other scenes, the engine, or the host packages.
- Never use randomness, the clock, or the network.
- Never draw captions yourself unless `captions.by` is `"bundle"`.

## Worked example

```json
{ "tool": "project_patch", "input": {
  "ops": [
    { "op": "add", "path": "/code/-", "value": { "id": "orbit", "file": "code/orbit.mjs", "fullFrame": false, "sfx": true } },
    { "op": "replace", "path": "/scenes/2", "value": { "id": "hub", "kind": "code", "bundle": "orbit", "title": "Everything connects", "from": "team.to", "to": "S(c06)", "cues": ["c05"], "notes": "" } }
  ],
  "reason": "escalated: six icons orbit a centre card on rings; no recipe draws orbits",
  "baseRev": 41
} }
```

## Common mistakes
- Writing a bundle when a recipe plus layers would do.
- Using `Math.random` for stars (breaks byte-exact renders). Use a seeded hash of the index.
- Sub-pixel positions that shimmer at ×6.
- Drawing into the caption zone.
