# Rights and privacy

Short rules. When in doubt, mark it **private** and ask the user (through the Producer).

## 1. What is private

| Thing | Private? | Why |
|---|---|---|
| A **likeness**: a sprite that depicts a real, recognisable person | Always | Consent and personality rights |
| A **logo** or brand mark, even if pixelated | Always | Trademark |
| A **trademark** in any form: product names drawn as art, mascots, distinctive icons of a real product or platform | Always | Trademark |
| A **reference** the user uploads (photos, logos, voice recordings, style references) | Always | It is the user's material |
| A **derivative** of anything above (kitbash, recolour, crop, edit) | Always (it inherits) | Inheritance |
| Generic art from a spec with no references (a castle, a moon, a generic gamepad) | Public candidate | Only after the import gate and the user's opt-in |

A private asset lives only in its project's `assets/` folder. Its ref says `"flags": { "private": true }`, plus `likeness` or `brand` where they apply.

## 2. References

1. A reference has a type (`likeness`, `logo`, `style`, `as-is`, `sound`, `voice`) and rights (`mine`, `licensed`, `unsure`). `unsure` blocks its use until the user answers.
2. Likeness references are **references only**: capture 2–3 traits, never trace them.
3. A reference file never leaves the project folder, except as an image input to the model that needs it (see §4).
4. Never write a reference into `library/`, `docs/`, `examples/`, a test fixture or a commit.

## 3. Logos and trademarks

- Never draw a real logo or a platform's mark from memory. The user supplies the file, and it is quantized to the palette.
- Use generic stand-ins in public art: "a generic gamepad (no brand)", "a smartphone", "a tower PC".
- A spec, description, tag or file name of a public asset never names a real brand, product or person.
- Before using any likeness or brand asset in a video, the user must confirm it. This is always the user's call.

## 4. What providers see

| Sent to the model provider | Never sent |
|---|---|
| The prompt, the spec, the palette, rendered sheets and stills | API keys (they live in the OS settings, never in a project or the repo) |
| Likeness references, only to the Pixel Artist and Art Director calls that need them, and only when the user chose a cloud provider for those roles | Other projects' files |
| The brief and the script | Files outside the project folder |

- The user can pick a local profile (`local`) to keep references on the machine.
- Log what was sent in the ledger (task, model, which reference files by name).

## 5. What never enters the public library

- Likeness, logo, brand, trademark, or any derivative of them
- Anything from a reference
- Anything with `rights.public: false`, an unknown licence, or empty provenance
- Anything that fails a hard rule of [PAP-STANDARD.md](PAP-STANDARD.md)
- Names of real people, companies or products in ids, tags or descriptions

Publishing is **opt-in**, it is the user's call, and the Librarian runs it after the import gate.

## 6. Checklist (Librarian, before each publish)

- [ ] `rights.likeness`, `rights.brand` and `rights.trademark` are all false
- [ ] No source in `provenance.sourceAssets` is private
- [ ] No reference was used (`refs` in the spec is empty)
- [ ] The description and tags name no real person, brand or product
- [ ] The licence is `LicenseRef-PAP-Library` or an SPDX id the user chose
- [ ] The user approved the publish

## 7. Two libraries, and promote

- The repo's `library/` is the public **seed**. At run time it is read-only.
- The crew's publish (`lib.publish`, after the person's yes) writes to the person's **own library**: `settings.paths.library`, by default `<appData>/library`. Search, `library_get`, `cast_asset` and rendering read both, and the person's library wins on an id both have. Publish never writes over an id either library has.
- The person's answer is stored on the asset ref (`publish: "yes" | "no"`), so the question is asked once per asset.
- Moving an asset into the public seed is a separate, deliberate step: `pap library promote <id> [--from <user-library>]`. It refuses, and leaves the asset where it is, when:
  - `rights.likeness`, `rights.brand` or `rights.trademark` is true, or `rights.public` is false;
  - the rights are missing (the file isn't an asset file), the licence is private or unknown, or the provenance is empty;
  - it comes from a reference (`provenance.ref`, an import) or derives from other assets;
  - a hard rule of [PAP-STANDARD.md](PAP-STANDARD.md) fails;
  - the seed already has that id (a new version is an edit, not a promote).
- On success it copies `asset.json` (with the fresh standard result) and `sheet.png`, and adds the entry to `library/index.json`. The §6 checklist items code can't check (names of real people, brands or products in the id, tags and description) stay a person's review before the commit.

