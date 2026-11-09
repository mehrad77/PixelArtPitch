# The promo video

The tools that made PixelArtPitch's own promo: a 1:32 keynote-style trailer, music and type only, that opens as a
PixelArtPitch video and pulls back into the studio making it. `SHOTS.md` is the shot sheet; `timing.json` is the bar
grid (120 BPM, a bar is 2 s) that the score, the compositor and the cuts all read.

Nothing here is the promo's content. The pixel scenes are a studio project of their own, the captures and renders go to
a work folder outside the repo (`../pap-promo-work/` by default), and private art never enters this folder.

| Script | What it does |
|---|---|
| `pixels.mjs <project> <out>` | the project's frames as native 320×180 PNGs, exactly as the engine draws them, and `--times` stills at night, dusk and day |
| `score.mjs [--out dir]` | the chiptune score from `timing.json`: `score.wav`, `hits.json` (every accent), `sfx/*.wav`; checks that every accent is on the grid |
| `mix.mjs --audio <dir>` | the score with the UI effects placed on the picture's moments (`mix.wav`), and the score's loudness per frame (`envelope.json`) |
| `record.mjs --url <url> --out <dir>` | records a real studio page while you drive it: JPEG frames at 3840×2160 from a 1440×810 viewport, steered by commands appended to `cmds.jsonl` (type into Pip, click, switch view or tab, scroll, change the frame rate, `js`, `stop`). It does real things, so point it only at a project you mean to work on |
| `capture.mjs` | stills and clips of the studio's built-in mock (`?mock=1`), with a privacy scan; `still --url` for one page |
| `compose.html` + `compose.mjs` | the compositor: the page builds each moment from the work folder (DOM layers, CSS 3D, blur and springs, all functions of `t`), and the driver steps it frame by frame in headless Chrome into ffmpeg. `--format tall` lays it out at 9:16, `--thumb` draws the thumbnail, `--still t` one PNG |
| `cut.mjs --ranges 0-24,66-76` | a shorter cut: renders the ranges (on bar lines, so the music joins on the beat) and joins picture and sound |

All of it is plain Node 24 and Chrome over the DevTools Protocol, no npm dependencies.

## Making it again

1. Render the pixel parts' frames: `node scripts/promo/pixels.mjs <promo project> <work>/pixel --times 7.3`, then
   upscale them ×6 and ×12 with ffmpeg (`scale=…:flags=neighbor`) into `pixel/frames2k` and `pixel/frames4k`.
2. `node scripts/promo/score.mjs`, then `node scripts/promo/mix.mjs --audio <work>/audio`.
3. Record the studio with `record.mjs` (a real brief and crew run, real pages) and list the shots in
   `<work>/shots/index.json` (`{ id, files: [...] }`, paths relative to `shots/`).
4. `node scripts/promo/compose.mjs --work <work> --out promo.mp4 --w 3840 --h 2160 --audio <work>/audio/mix.wav`.
