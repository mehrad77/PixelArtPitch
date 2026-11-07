# PAP asset standard v1

Every sprite asset (an `AssetFile`, `packages/schema/src/doc.ts`) must meet this standard before a scene may use it.
The checker is `checkAsset()` in `packages/engine/src/standard.ts`. Per-kind templates: [ASSET-KINDS.md](ASSET-KINDS.md). Rights: [RIGHTS.md](RIGHTS.md).

## 1. Two kinds of rule

| | Hard rule | Soft rule |
|---|---|---|
| Checked by | Code (`checkAsset`), deterministically | A vision reviewer looking at the sheet at 1× and 4× |
| On failure | **Reject.** There is no override. Fix it and resubmit. | A note. It may be overridden only with a recorded reason (in `provenance.override`). |
| Repairs | At most 2 automatic repairs, then back to the artist | At most 2 critique rounds |

## 2. Hard rules (fail = reject)

| Rule id | What passes | Fix hint |
|---|---|---|
| `shape` | The file parses as `AssetFile` | Match the fields in §5 |
| `size` | `w × h` is allowed for its `kind` (§3) | Redraw at an allowed size |
| `frames` | Every name in `frames` is drawn in `grid`, every drawn frame is listed, there is at least 1 frame, and the required frames for the kind exist (§4) | Draw the missing frames or list them |
| `grid` | Every frame has exactly `h` rows, and every row exactly `w` cells | Pad or trim each row |
| `legend` | Only palette letters and `.`; never `#` | Replace illegal letters |
| `feet` | Characters: the bottom row is not empty, except in frames named `jump…` or `fall…` | Move the figure down |
| `orphans` | No opaque cell with all 8 neighbours transparent (fonts are exempt) | Remove or connect the pixel |
| `swap` | Characters and creatures: idle0 → idle1, each run or move step, and perch0 → perch1 repaint ≤ 50% of the opaque cells | Change less between loop frames |
| `contrast` | Kinds drawn on the sky (character, creature, crowd, prop, icon, block, decor, logo): ≥ 40% of the silhouette's edge ring reaches 1.7:1 against `#0f1411`, on every frame | Lighten the ring just inside the outline |
| `rights` | `licence` is not empty, and `provenance` is not empty | Fill both (§5) |

The edge ring is the first ring of non-ink cells next to transparency or ink. Ink means any colour under 1.25:1 against the sky, such as `k`.

## 3. Size classes

| Kind | Allowed sizes (w × h) |
|---|---|
| character (hero or NPC) | 16 × 24 |
| creature (an animal or small being) | 16 × 16 or 16 × 24 |
| crowd | w a multiple of 16, up to 96; h 16 or 24 |
| prop | 24 × 32, 16 × 32 or 16 × 16 |
| icon | 12 × 12, 16 × 16 or 8 × 8 |
| block | 16 × 16 |
| tile | 16 × 16 |
| map-tile | 16 × 16 |
| building | w and h multiples of 8, up to 128 × 112 |
| backdrop | w a multiple of 16, up to 320 × 90 |
| decor | up to 32 × 32 |
| font | 5 × 8 (one glyph per frame) |
| logo | up to 96 × 48 |

## 4. Required frames

| Kind | Required frames |
|---|---|
| character, hero | `idle0 idle1 run0 run1 run2 run3 jump wave` |
| character tagged `npc` | `idle0` (usually also `idle1`, plus one action such as `give`) |
| creature | `idle0 idle1`, plus its motion's frames (not checked): walk `move0`–`move3`; fly `move0`–`move3` and `perch0 perch1`; sit `perch0 perch1` |
| font | `g65`…`g90` (A–Z) and `g48`…`g57` (0–9). Frame name = `g` + the character's code point. Lower case and punctuation are optional. |
| every other kind | At least 1 frame, named for what it shows (`signpost`, `flag0`, `node-done`) |

Loops are named `name0, name1, …` (`flag0 flag1`, `cheer0 cheer1`).

## 5. Fields (metadata and provenance)

```json
{
  "id": "lantern", "version": 1, "kind": "prop", "w": 16, "h": 32,
  "frames": ["lantern0", "lantern1"],
  "palette": "pap-night@1",
  "tags": ["light", "night", "street"],
  "description": "A hanging paper lantern (P p q) with a warm core (B O), 2-frame flicker. Hook on the top row.",
  "licence": "LicenseRef-PAP-Library",
  "rights": { "likeness": false, "brand": false, "trademark": false, "public": true },
  "provenance": {
    "source": "generated", "role": "pixel-artist", "model": "provider/model-id", "provider": "provider",
    "origin": "project <id>, <date>", "sourceAssets": [], "judgeReason": "Variant 2 reads as a lantern at 1x; variant 1 read as a bell."
  },
  "hash": "<16 hex chars, computed on import>",
  "standard": null,
  "grid": { "lantern0": ["…32 rows of 16 cells…"], "lantern1": ["…"] }
}
```

| Field | Rule |
|---|---|
| `id` | Lower case, digits and `-`; unique in the library |
| `version` | Integer ≥ 1. Bump it on any pixel change; projects pin `lib:<id>@<version>`. |
| `description` | What it shows, the letters it uses, and the anchor ("feet on the bottom row"). It is used for search. |
| `tags` | 3–7 search words. `npc` changes the required frames, and `hero` adds the face-right check. |
| `provenance.source` | `generated`, `drawn` (by a human), `imported` or `derived` |
| `provenance.sourceAssets` | Every asset this one was built from (for kitbash and edits). Required when `source` is `derived`. |
| `provenance.judgeReason` | Why this variant won, or null |
| `provenance.override` | Only when a soft rule was overridden: `{ "rule": "...", "reason": "...", "by": "role or user" }` |
| `standard` | Set by the gate to the check result; null until checked |

## 6. Soft rules (vision review)

Check each one on the sheet at 1× and 4×, against the sky. The full checklist is in [REVIEW-RUBRICS.md](REVIEW-RUBRICS.md) §1.
1. It reads as its description at 1×. Name what it looks like in 3 words; that must match.
2. Light from the upper left; the right and bottom edges are darker.
3. Edge ring between 40% and 60% at 1.7:1: confirm it still reads.
4. Characters: feet planted, the head and hands read in idle and run, the run alternates contact and passing poses, and no frame pops.
5. Heroes face right; library NPCs face left.
6. Tiles and backdrops tile seamlessly left to right.
7. It is not confusable with another icon in the same video (for example, any round pale icon next to the moon).
8. Likeness, brand or trademark: confirm the rights and the private flag (see §7).

## 7. Rights and licences

- `rights.likeness`, `rights.brand` or `rights.trademark` true means **private**: `rights.public` must be false, and the asset never enters `library/`.
- **Derivatives inherit** every flag of every asset in `sourceAssets`. A private source makes a private derivative.
- Allowed licences: `LicenseRef-PAP-Library` (the library's own; see `library/LICENSE.md`), or an SPDX id the user chose (`CC0-1.0`, `CC-BY-4.0`, `MIT`). An imported asset with an unknown licence is private.
- The full rules are in [RIGHTS.md](RIGHTS.md).

## 8. The import gate (Librarian)

For each asset, in this order. Stop at the first failure.
1. **Parse:** it must be an `AssetFile`, or come from a PNG through quantizing to the palette (`packages/engine/src/quantize.ts`).
2. **Hard rules:** run `checkAsset`. Any hard issue rejects it, with the `fix` lines sent back.
3. **Rights:** set `likeness`, `brand` and `trademark` from the spec and the references; apply inheritance from `sourceAssets`; set `public`.
4. **Provenance:** source, role, model, provider, origin, `sourceAssets`, `judgeReason` are present.
5. **Soft review:** a vision pass on the sheet (§6). Record any override with its reason.
6. **Hash and version:** compute `hash`, and bump `version` if the pixels changed.
7. **Place:** a private asset goes to the project's `assets/` (`file:assets/<id>.json`, with `flags.private: true` on the ref). A public asset goes to the project first.
8. **Publish (opt-in, the user's call):** only when `rights.public` is true and none of likeness, brand or trademark is set, after the user approves. Write `library/<id>/asset.json` and `sheet.png`, and update `library/index.json`.

## Mismatches with the checker

Where this document and `packages/engine/src/standard.ts` (or the schema) differ today:
1. There is **no `npc` kind**. The schema's `AssetFile.kind` has no `npc`; an NPC is `kind: "character"` with the tag `"npc"`.
2. **Rights are only soft-flagged.** `checkAsset` notes likeness and brand but does not reject `rights.public: true` together with likeness, brand or trademark. Until it does, step 3 of the gate enforces this.
3. **Inheritance is not enforced.** Nothing checks that a derivative inherits its sources' flags, or that `sourceAssets` is set for `derived`.
4. **Rights live in two shapes.** `AssetFile.rights` (`likeness`, `brand`, `trademark`, `public`) and the project's `AssetRef.flags` (`private`, `likeness{person, refs}`, `brand{owner, trademark}`) overlap. Keep them consistent by hand.
5. `provenance.override` and the licence allow-list are conventions of this document; the checker does not read them.
6. There is no `asset_submit` tool yet (the MCP prompt `draw-asset` names it). For now, artists hand AssetFile JSON to the Art Director, and the gate is run in code.
7. The library has no hero (no 8-frame, right-facing character). All three library characters are left-facing NPCs (`idle0 idle1 give`).
