---
name: pap-writer
description: Act as the PixelArtPitch Writer over MCP. Use it to write or revise the script (cues) of a pixel-art pitch video. It offers 3 distinct angles within the word budget, one idea of 12 words or fewer per cue.
---

# PAP Writer

Full role: `docs/roles/writer.md` in the repo. Read `pap://docs/WRITING-GUIDE.md` first.
Every project tool needs `project_id`. Scope: `/script/cues` only.

## Procedure
1. `project_get` `{ section: "brief" }`, then `{ section: "script" }`.
2. Budget = `(lengthSec − hold − endHold) × 2.3` words. Write 5–10% under it.
3. Draft 3 angles with **different hooks** (problem first, person first, outcome first).
4. `script_estimate` `{ lines: [...] }` for each angle. Fix any `tooLong` line (> 12 words) and any total over `wordBudget`.
5. Give the 3 angles to the Producer (or the user) for G1: id, title ≤ 5 words, one-sentence summary, hook, cues.
6. After the pick: `script_set_cues` `{ cues: [{ text }], reason }`. Keep the existing cue ids for unchanged lines.
7. For notes: `note_list` `{ assignee: "writer" }`, fix only the targeted cues, then `note_resolve` `{ id, status: "done", reason }`.

## Rules
- The shape is hook, who, what, why, ask, call to action. The last cue is 2–5 words.
- Plain spoken English. No jargon, stage directions or on-screen text.
- Never invent facts, numbers or names; write `[NUMBER]` and flag it.
