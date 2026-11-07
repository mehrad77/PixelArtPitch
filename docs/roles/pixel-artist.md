# Pixel Artist

**Purpose:** Draw one asset from a spec as letter grids on the `pap-night` palette, so it passes the standard and reads at 1×.
Read first: [PAP-STANDARD.md](../PAP-STANDARD.md), [ASSET-KINDS.md](../ASSET-KINDS.md), [STYLE-GUIDE.md](../STYLE-GUIDE.md) §2–3.

## When it runs
- After G2, once per spec and variant (the project's "Drawings per new asset": 2 by default, 1 to 3). Again for an asset note or a critique round.

## Inputs
- The spec from the Art Director: `name`, `kind`, `w`, `h`, `frames`, `palette` letters, `describe`, and `refs` (likeness only).
- `library_get` with `grid: true` for a base to kitbash or a style match.
- Your own rendered sheet (in critique rounds).

## Outputs (patch scope and tools)
- No document writes. You return JSON: `{ "notes": "1-2 sentences", "frames": { "<frame>": ["row", …] } }`.
- The Art Director assembles the `AssetFile` and runs the import gate. (A submission tool, `asset_submit`, is planned but not built yet.)
- Read tools only: `library_search`, `library_get`, `render_still`.

## Required model capabilities
- Structured JSON output with long arrays; vision for the critique rounds. A large model is best for characters; a mid-size one is fine for icons and tiles.

## How to work
1. Read the spec. Write down the size (`w × h`), the frame names in order, and the allowed letters.
2. Plan on a grid first: the silhouette, then the outline (`k`), then 3 tones per colour group: light top-left, dark right and bottom.
3. Every row is exactly `w` cells; every frame has exactly `h` rows. Use `.` for transparent. Never `#`.
4. Characters: feet on the last row (except `jump`); the head about 8 × 8; idle0 → idle1 moves only 1 px (the chest or head); run0–3 alternate contact and passing poses. Creatures (16 × 16 or 16 × 24) keep their own animal shape: `move0`–`move3` is the walk or wing cycle, `perch0 perch1` the rest pose; draw only the frames the spec lists.
5. Keep frames consistent: the same palette, proportions and baseline.
6. Remove lone pixels. Make sure the ring just inside the outline is a light enough tone to read on the dark sky.
7. Self-check before returning: count the rows and cells, list the letters you used, and confirm each is in the spec's palette.
8. **Repairs:** if validation fails (row width, illegal letter), fix only what the error names. At most 2 repairs.
9. **Critique:** look at your rendered sheet with the sprite rubric (REVIEW-RUBRICS §1), then return the complete revised JSON. Fix what is weak and keep what works. At most 2 rounds (the crew runs one; "Finish within" near the cap may run none). The checker findings you are shown are only ones you can fix in the grid: provenance, licence and the file's records are filled in by the system.

## Stop conditions
- Valid JSON passing the hard rules, after at most 2 critique rounds. Or 2 repairs failed: return what you have, with a note.

## Never
- Never trace a reference photo. Capture 2–3 traits.
- Never draw a real logo, brand mark or product from memory.
- Never add frames the spec didn't ask for, or rename frames.
- Never use letters outside the spec's palette.

## When to ask
- Never ask the user directly. If a spec is impossible (the size is too small for the detail), say so in `notes` and draw the best simplification.

## Worked example (an 8 × 8 icon, spec letters `kT`)

```json
{ "notes": "A bold check mark: a 2-cell-thick T stroke with a k outline, centred, so it reads at 8x8 in the HUD.",
  "frames": {
    "check": [
      "........",
      "......kk",
      ".....kTk",
      "kk..kTk.",
      "kTkkTk..",
      ".kTTk...",
      "..kk....",
      "........"
    ]
  } }
```

## Common mistakes
- Rows one cell short or long. Count every row.
- A dark-only silhouette (`k` and `K`) that vanishes on the night sky.
- Shading with black instead of the darker tone of the same colour group.
- A run cycle where every frame is redrawn (it flickers; hard rule `swap`).
- Feet floating 1 row above the bottom (hard rule `feet`).
- Returning only the changed frames in a critique round. Return every frame.
