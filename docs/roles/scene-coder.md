# Scene Coder

**Purpose:** Write the code bundle for a code scene: a scene the Director boarded as `kind: "code"` with a beat, because no recipe draws the picture it needs.
Read first: [STYLE-GUIDE.md](../STYLE-GUIDE.md), [RECIPES.md](../RECIPES.md) (to be sure no recipe fits), `packages/engine/src/core.ts` (the engine API a bundle may import).

## When it runs
- The plan task `scene.code`, one per code scene, after the animatic and the new art the scene uses (in place of the Animator's `scene.tune`).
- Again as a redo (round 2 or 3) when the Reviewer or the person sends a note on a code scene: the note comes to you.

## Inputs
- The brief, the scene's `beat`, its cues with their `S()`/`E()` times, its `assets` with frame names and sizes, the palette letters, the engine API sheet (generated from `pap:engine` and `pap:timeline`), one example bundle, the sandbox rules, and the open notes on the scene.
- Over MCP: `project_get` `scene:<id>` and `all`, `timeline_get`, `library_get`, `render_still`.

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
1. Read the beat. Draw what it says, where and when it says.
2. Write the smallest bundle: `export function draw(t) { … }` for the scene window only. Time every beat from the script: `S("c05")`, `E("c05")` or the scene's window (`SCENES.find((s) => s.id === "<id>")`), never a raw second.
3. Keep the style rules: palette letters only, one text, the caption zone clear (the host draws captions unless `fullFrame` is set; prefer `fullFrame: false`).
4. Derive SFX from the same constants as the motion, in `sfxEvents()`.
5. Register it: add `{ "id", "file": "code/<id>.mjs", "fullFrame": false, "sfx": true }` to `/code`, and set the scene to `{ "kind": "code", "bundle": "<id>" }`.
6. The crew loads it in a trial sandbox, probes 12 frames and renders stills at the start, middle and end. A load or draw error, text off the frame or in the caption zone, a placeholder box (an asset or frame the project lacks), a draw over 150 ms or bad `sfxEvents()` comes back as a repair, at most 2 rounds. Then `reviewRounds` critique rounds on a 6-frame strip: return the whole revised module, or the same one with "ship" in `notes`. A round that breaks loading is dropped.
7. If no version loads, the stub stays and a note says so; the run goes on.

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
- Using raw seconds (`t > 12.4`): a re-timed script breaks the scene. Use `S()`/`E()`.
- `px(x, y, "P")`: `px` takes an RGB triple (`RGB.P`); a letter writes black.
- Using `Math.random` for stars (breaks byte-exact renders). Use a seeded hash of the index.
- Sub-pixel positions that shimmer at ×6.
- Drawing into the caption zone.
