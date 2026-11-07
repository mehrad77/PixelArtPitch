# Glossary

One line per term. Where a term has a source file, it is named in brackets.

| Term | Meaning |
|---|---|
| **project** | A folder holding `pitch.json` (the project document), `assets/`, `code/` and `out/`. It can live anywhere. |
| **project document** | `pitch.json`, validated by `Project` [`packages/schema/src/doc.ts`]. It describes the whole video. |
| **brief** | What the user wants: idea, purpose, audience, ask, `lengthSec`, tone, must-say, must-avoid, narration, references, deadline. |
| **cue** | One line of the script: `{ id: "c03", text: "…" }`. It carries one idea of 12 words or fewer, and is also one caption. |
| **cue id** | `c01`, `c02` …: lower-case, unique, and stable when the text changes. |
| **anchor** | The thing a time hangs off: a cue's start or end, a scene's edge, or a named event. |
| **time expression** | A string that resolves to seconds: `S(c03)`, `E(c03)+0.4`, `intro.to`, `@land`, `min(a, b)`, `hold`, `endHold`, `duration` [`packages/schema/src/time.ts`]. Check one with `time_eval`. |
| **raw time** | A plain number of seconds. Allowed only where a lint allows it (lint `raw-seconds`). Prefer an expression. |
| **event** | A named time in `events`, e.g. `"land": "S(c04)+0.6"`, used as `@land`. |
| **timing mode** | `estimate`: cue times come from word counts (`wps`, `pause`, `lead`, `minCue`). `aligned`: cue times come from the recorded narration. |
| **wps** | Words per second of speech. The guides use 2.3. |
| **alignment** | The Editor's step that finds where each cue is spoken in the voice file (`vo_align`). Everything anchored to cues moves with it. |
| **scene** | A window of time `[from, to]` that carries some cues. It is either `decl` (recipes and layers) or `code` (a code bundle). |
| **storyboard** | The ordered list of scenes with their windows and cues (`storyboard_set`). |
| **recipe** | A ready-made beat from a closed menu (`walk_in`, `block_bump`, `end_card_loop` …) with a few params. It expands to layers, sounds and shakes [`packages/engine/src/recipes.ts`, `docs/RECIPES.md`]. |
| **param** | A recipe setting: a number, an enum, an asset id or a time expression. Each has a default and a range (`recipe_list`). |
| **layer** | One drawable thing in a scene: `backdrop`, `tiled`, `sprite`, `actor`, `text`, `panel`, `group`, `shape`, `fx`, `widget`, `code`. |
| **actor** | A layer that plays a character's frames (idle, run, jump, wave) on its own. |
| **widget** | A built-in drawn element: banner, toast, nameTag, qblock, counter, flagpole … [`packages/engine/src/decl-spec.ts`]. |
| **behaviour** | Motion attached to a layer: `walk`, `jumpArc`, `arc`, `bob`, `blink`, `pulse`, `shake`, `squash`, `appear`, `disappear`, `attach`, `dissolve`, `dust`, `sparkle` [`docs/BEHAVIORS.md`]. Some of them emit sounds. |
| **key** | A keyframe `{ t, v, ease }` on a layer prop or the camera. |
| **hit-stop** | A short freeze of world motion (about 0.06 s) on a big impact. Recipes add them as `pauses`. |
| **code bundle** | An ES module in `code/` that draws a whole scene itself. It runs in the render sandbox. It is used only when recipes can't do the job (Scene Coder). |
| **hold** | The still first frame before anything moves (`composition.hold`, 3 s by default). Render, audio and subtitles are shifted by it. |
| **end card** | The last scene: product name, call to action and URL, held as a loop for `composition.endHold` seconds. |
| **dissolve** | The pixel dissolve that opens each scene (`composition.dissolveIn`, 0.3 s). |
| **caption** | A cue's text burned into the picture at the bottom. The same text is also written out as SRT and VTT. |
| **caption zone** | The bottom of the frame, below y = 146. Nothing important is drawn there. |
| **contact sheet** | One frame per second across the video, in one image (`render_contact`). It is the quickest way to judge pacing. |
| **still** | One rendered frame at a time (`render_still`). |
| **animatic** | The first full render, made from library assets and placeholders, used to judge pacing before any art is paid for (gate G2). |
| **rough cut** | The full video with real art and sound, before the final polish (gate G3). |
| **gate** | A stop where the user decides: `g0_brief`, `g1_script`, `g2_animatic`, `g3_rough`, `g4_final`. The verdict is approve, approve with notes, or changes. |
| **stage** | Where the project is: brief, script, storyboard, art, animate, narrate, sound, review, deliver. |
| **task** | One unit of crew work with a role, a status, a cost and an ETA, e.g. "Drawing hero, variant 2 of 3, critique 1". |
| **question** | A multiple-choice card for the user (`ask_user`). It has 2–6 options and a recommended one. Crew members ask Pip (`ask_pip`), and Pip asks the person only what they alone know. |
| **note** | Feedback pinned to a scene, cue, asset, time range or track, routed to the role that owns it (`note_add`). Its status moves open → picked_up → proposed → done or declined. |
| **patch** | An RFC 6902 JSON Patch on the document with an author and a reason. It is the only way the document changes, and every patch can be undone [`packages/schema/src/patch.ts`]. |
| **rev** | The document revision. Every read returns it; pass it back as `baseRev` when you write. A stale `baseRev` over the same paths is refused (409). |
| **seq** | The number of a patch in the history; `project_undo` takes it. |
| **lint** | A deterministic check over the document and its frames (`cue-long`, `caption-zone`, `text-clipped` …) [`packages/engine/src/lints.ts`]. Lints run before any vision review. |
| **blocker** | A review finding that must be fixed before shipping. It always carries a timestamp. |
| **polish** | A review finding that is nice to have. |
| **library** | `library/`: public, reusable assets on the `pap-night` palette. No private assets ever go here. |
| **asset** | A sprite file: letter-grid frames plus metadata (`AssetFile`). |
| **asset ref** | How a project uses an asset: `{ id, src: "lib:castle@1" \| "file:assets/x.json", frameAlias?, flags }`. |
| **casting** | Choosing library assets for a project (`cast_asset`) before ordering new art. |
| **letter grid** | A frame drawn as rows of single letters, one letter per pixel; `.` is transparent. The letters come from the palette. |
| **palette** | `library/palettes/pap-night.json`: letter → colour, plus the sky colour `#0f1411`. |
| **standard** | PAP asset standard v1 [`docs/PAP-STANDARD.md`, `packages/engine/src/standard.ts`]. Hard rules reject an asset; soft rules go to vision review. |
| **hard rule / soft rule** | A hard rule is deterministic, and failing it means rejection with no override. A soft rule is judged by eye and can be overridden with a recorded reason. |
| **provenance** | Where an asset came from: source, role, model, provider, origin, `sourceAssets`, `judgeReason`. |
| **rights** | `likeness`, `brand`, `trademark` and `public` on an asset. Likeness, brand and trademark mean private. |
| **likeness** | A recognisable real person. It is always private. |
| **derivative** | An asset made from another asset; listed in `provenance.sourceAssets`. It inherits every rights flag of its sources. |
| **import gate** | The Librarian's checklist before an asset enters a project or the library [`docs/PAP-STANDARD.md`]. |
| **kitbash** | Building a new character from a base body plus hair, beard, glasses and outfit tones, instead of drawing from scratch [`docs/ASSET-KINDS.md`]. |
| **variant** | One of several drawings of the same spec. The judge picks the best. |
| **critique round** | The artist looks at its own render and returns a revised grid (at most 2). |
| **repair** | An automatic fix after a hard-rule failure, such as a wrong row width or an illegal letter (at most 2). |
| **judge** | A pairwise comparison of finished variants that keeps the better one, with a reason. |
| **keep table** | With a voice: how many of each SFX type survive, e.g. `coin: 4`. A type missing from the table is dropped. |
| **minGap** | With a keep table, no two SFX closer than this (0.6 s). |
| **bed** | The music under everything (`chip-bed`). It lifts during one scene and settles from another. |
| **LUFS / dBTP** | Integrated loudness / true peak. The targets are −16 ±1 LUFS and ≤ −1 dBTP. |
| **delivery** | An output spec: `scale` 4, 6 or 12 (720p, 1080p, 4K), `crf`, file name. |
| **golden** | Stored frame hashes of a known project; the engine must reproduce them byte for byte. |
| **profile** | Which models the crew uses: `best`, `balanced`, `local` or `custom`. |
| **ledger** | Every model call with its tokens and cost. |
| **digest** | The Producer's 2–3 sentence status summary. |
