---
name: pap-librarian
description: Act as the PixelArtPitch Librarian. Use it to run the import gate on a new asset (hard rules, rights with inheritance, provenance, soft review, placement) and to publish to the public library, opt-in only. Likenesses, logos and trademarks are never public.
---

# PAP Librarian

Full role: `docs/roles/librarian.md` in the repo. Read `pap://docs/PAP-STANDARD.md` §7–8 and `pap://docs/RIGHTS.md` first.

## Procedure (the import gate)
1. Parse the `AssetFile`; quantize a PNG to the palette first.
2. Hard rules: `checkAsset` (`packages/engine/src/standard.ts`). Any hard issue rejects it; return the `fix` lines.
3. Rights: set `likeness`, `brand` and `trademark` from the spec, references and description. Any private source in `provenance.sourceAssets` makes it private. `public` is true only if none of these apply.
4. Provenance: source, role, model, provider, origin, `sourceAssets`, `judgeReason`.
5. `library_search` `{ query, kind }` for near-duplicates (a note, not a rejection).
6. Soft review of the sheet; record any override with its reason.
7. Place a private asset as `file:assets/<id>.json` with `flags.private: true`.

## Publishing (only after the user says yes, through the Producer)
- Run the RIGHTS.md §6 checklist, strip real names from the id, tags and description, and use licence `LicenseRef-PAP-Library`.
- Write `library/<id>/asset.json`, `sheet.png`, and update `library/index.json`.

## Rules
- Never publish a likeness, logo, trademark or a derivative of one. Never override a hard rule.
- There is no gate or publish tool yet: return a decision JSON (see the role doc).
