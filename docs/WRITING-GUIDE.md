# Writing guide

How to write a pitch script for PAP. The script is a list of **cues**. Each cue is one idea, one caption and one line of narration.

## 1. The shape

| # | Beat | Job | Typical share |
|---|---|---|---|
| 1 | **Hook** | A problem the viewer feels, or a surprising fact | 1 cue |
| 2 | **Who** | Who you are, or who it is for | 1 cue |
| 3 | **What** | The product in one plain sentence | 1–2 cues |
| 4 | **Why** | Why it matters, or why now, or why you | 1–3 cues |
| 5 | **Ask** | What you want from the viewer (try it, join, fund, hire) | 1 cue |
| 6 | **Call to action** | 2–5 words, shown on the end card | 1 cue |

A 15 s video may merge Who into Hook and Why into What. Never drop the Hook, What or Call to action.

## 2. The word budget

```
word budget = (duration − hold − endHold) × 2.3
```

| Length | hold | endHold | Budget |
|---|---|---|---|
| 15 s | 0.5 | 3.5 | (15 − 0.5 − 3.5) × 2.3 = **25 words** |
| 30 s | 1 | 4 | 25 × 2.3 = **57 words** |
| 60 s | 3 | 6 | 51 × 2.3 = **117 words** |
| 90 s | 3 | 12 | 75 × 2.3 = **172 words** |

- Write 5–10% under the budget; the pauses between cues use it up.
- Check it with `script_estimate`. It returns `wordBudget` and flags each line over 12 words. It also subtracts the 0.6 s `lead`, so its number is about 1 word lower.
- A cue shorter than 1.5 s on screen trips the `cue-short` lint. Give short lines a few more words, or raise `script.timing.minCue`.

## 3. Rules for one cue

1. **One idea, ≤ 12 words.** If it has "and" joining two claims, split it.
2. **Plain spoken English.** Write it the way you would say it aloud: short words, active voice, present tense.
3. **No jargon, acronyms or numbers that need a pause** ("2.3×" is bad; "twice as fast" is good).
4. **No stage directions** in the text. The picture is the Director's job.
5. **It must be drawable as an icon.** If you can't picture it in a 320 × 180 frame, rewrite it.
6. **Say names in the order they appear on screen.**
7. **The last cue is the call to action**, and it can be read in under 2 s.
8. Use what the brief must say (`mustSay`), and nothing it must avoid (`mustAvoid`).
9. **Count a list out loud.** When the brief lists what a program or product gives ("mentors, weekly demo days and a deadline"), one cue names the count ("It gives us three things:") and each item gets its own cue, in order. The Director shows it as that many numbered slots filling one per cue. Never fold the list into one cue.

Bad and good:

| Bad | Good |
|---|---|
| "Leveraging AI, our platform streamlines end-to-end ticket triage workflows." (10 words, jargon) | "Every morning, support drowns in tickets." |
| "We have 3 founders, 2 pilots and a 40% weekly retention rate." (two ideas, numbers) | "Two teams already use it every week." |
| "Then the hero walks to the castle." (a stage direction) | "Now the whole team ships together." |

## 4. Three distinct angles

The Writer always offers **3 angles** at gate G1. They must differ in the **hook and the frame**, not only in wording.

| Angle | Hook comes from | Example frame |
|---|---|---|
| **Problem first** | The pain the viewer has today | "Your to-do list feels like a grind." |
| **Person first** | Who is speaking, and why them | "I'm a nurse who codes at night." |
| **Outcome first** | The world after the product | "Imagine finishing every task by noon." |

Other valid frames: a question, a number the viewer can feel, a before/after, a "what if".
For each angle, give a title (≤ 5 words), the hook cue, a one-sentence summary and the full cue list. The three must not share a hook.

## 5. Example: 15 s launch (a fictional to-do app)

Brief: QuestDay turns tasks into quests; audience: people whose lists feel like a chore; no narration; hold 0.5, endHold 3.5. Budget 25 words; this script has 24.

```json
{ "cues": [
  { "text": "Your to-do list feels like a grind." },
  { "text": "QuestDay turns every task into a quest." },
  { "text": "Clear tasks, collect stars, raise your flag." },
  { "text": "QuestDay. Press start." }
], "reason": "15 s problem-first angle, 24 words" }
```

Beats: Hook (c01), What (c02), Why (c03, shown as three icons), Call to action (c04). This is `examples/questday/pitch.json`.

## 6. Example: 60 s pitch (a fictional support tool)

Brief: Tidepool groups support tickets into a weekly fix list; audience: small software teams; the founder narrates; hold 3, endHold 6. Budget 117 words; this script has 100.

```json
{ "cues": [
  { "text": "Every Monday, our support inbox had two hundred new tickets." },
  { "text": "Most of them were the same five problems." },
  { "text": "I'm Sam. I ran support for a small app team." },
  { "text": "So we built Tidepool." },
  { "text": "It reads your tickets and groups them by problem." },
  { "text": "Then it ranks the groups by how many people they hurt." },
  { "text": "Every Friday, your team gets one short fix list." },
  { "text": "Fix the top three, and half the tickets stop coming." },
  { "text": "Two teams already use it every week." },
  { "text": "Now we want ten more teams to try it." },
  { "text": "It takes five minutes to connect your inbox." },
  { "text": "Tidepool. Fix what hurts most." }
], "reason": "60 s problem-first angle, 100 words under a 117 budget" }
```

Beats: Hook (c01–c02), Who (c03), What (c04–c06), Why (c07–c09), Ask (c10–c11), Call to action (c12).
Each cue is drawable: an inbox icon with a counter, five repeated icons, a character waving, a title card, items flying into groups, a 1-2-3 bar, a scroll, a counter falling, a crowd of two, ten empty slots, a plug, the end card.

## 7. Checklist before you submit

- [ ] Total words ≤ the budget (`script_estimate`), and every cue ≤ 12 words
- [ ] The shape is complete: hook, what and call to action at least
- [ ] Each cue is one idea that can be drawn as an icon
- [ ] A list in the brief is counted ("three things:"), one cue per item
- [ ] Names in on-screen order; nothing from `mustAvoid`; everything from `mustSay`
- [ ] Read it aloud in the target time
- [ ] 3 angles with different hooks (at G1)
