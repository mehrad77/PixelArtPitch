# The PixelArtPitch promo: shot sheet

An Apple-keynote-style trailer, about 1:32, music and on-screen type only (no voice). It opens as a PixelArtPitch
video, breaks the fourth wall into the studio that is editing it, then shows the whole app.

## Grid

- 120 BPM: a beat is 0.5 s, a bar 2 s. Every cut lands on a bar (or a half bar for the fast claims).
- 30 fps. Master 3840×2160; the pixel canvas (320×180) scales by exactly 12.
- Studio captures: a 1920×1080 viewport at device scale 2 (3840×2160 PNGs), dark theme.
- Type: Inter (OFL), white on near-black (#000 stage, #f5f5f7 type, #86868b secondary), tight tracking on big lines.
  One accent: the studio's green.

## Shots

| # | Bars | Time (s) | Shot | Source |
|---|---|---|---|---|
| 1 | 0–4 | 0–10 | **Cold open, full frame.** Night city. The pixel Mehrad walks in from the left (run cycle, feet on the ground line), stops under a lamp, looks up at the stars. Type fades up over the pixels: *"Every idea deserves a trailer."* | promo project, scene `open` |
| 2 | 5–8 | 10–18 | **The fourth wall.** Mehrad turns to the camera and waves. A Pip line slides in from the right edge, outside the pixel frame. On the downbeat of bar 7 the frame pulls back (ease-in-out, 2 bars) into the studio: the same video playing in the player, Pip's timeline beside it, the crew's faces at work. Type: *"This video is being made. Right now."* | promo project (continues), studio capture `break` with the player rect |
| 3 | 9–11 | 18–24 | **Title.** Black. The pixel flower and crew faces assemble; *PixelArtPitch*. Then *"Pitch videos, made by a crew of AI agents."* | type layer |
| 4 | 12–16 | 24–34 | **"Tell Pip your idea."** A new project: the idea typed, the brief card filling itself in, a reference uploaded, the rights question answered, Start. | mock studio capture `brief` |
| 5 | 17–24 | 34–50 | **"A crew of twelve."** The twelve faces in a row with their names; then the plan unfolding, three scripts to pick from, the storyboard, the animatic, code scenes written, the Reviewer's notes. Quick pushes, one per bar. | mock capture `crew-*` |
| 6 | 25–29 | 50–60 | **"Art, drawn and kept."** Pixel Artist variants, the library grid moving, walk cycles, night / dusk / day. A one-bar glimpse of P8: the real team as pixel characters. | captures `library`, `sheet`, P8 frames |
| 7 | 30–32 | 60–66 | **"And it sounds right."** Chiptune and effects on the beats, captions, subtitles. | type layer + waveform, capture `sound` |
| 8 | 33–37 | 66–76 | **Three claims**, half a bar to a bar each: *"Every pixel exact." "Every edit undoable." "Every dollar counted."* Over: the golden test, the patch history with Undo, versions, the budget bar with its reserve, the run report. | captures `history`, `budget`, `report` |
| 9 | 38–41 | 76–84 | **"Any model. Every tool."** Anthropic, OpenAI, OpenRouter, local; a Claude Code session driving a project over MCP; the Docs page. | captures `settings`, `docs`, `mcp` |
| 10 | 42–45 | 84–92 | **Back into the player.** The studio pushes in on the player until the pixel frame fills the screen: Mehrad reaches a castle, the PixelArtPitch flag goes up. End card: *Open source. Runs on your machine.* `github.com/mehrad77/PixelArtPitch` · PRESS START. | promo project, scene `finale` |

## The cuts

- **Master:** 16:9, 3840×2160, plus a 1920×1080 copy.
- **X:** 16:9, 30–45 s: shots 1, 2, 3, the fastest bars of 5, 8, 10.
- **Reels:** 9:16, 1080×1920, under 90 s: the same story re-laid out (the pixel frame and captures stacked or panned, the type above and below).
- **Thumbnail** (1280×720) and **captions** (SRT of the on-screen lines).

## Private art

The Mehrad, Ebrahim and Farzad sprites and the GameScrobbler/Divan marks are private. The promo project lives in
matthiola's `packages/pitches/pap-promo`; nothing of it is committed here. This folder holds only the tools
(capture, compose, score) and this sheet.
