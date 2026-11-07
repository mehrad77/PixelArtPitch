# PixelArtPitch

A local web app where a crew of AI agents makes short pixel-art pitch videos from a brief. You describe the idea, length, references, budget and deadline; a Producer, Writer, Director, Art Director, Pixel Artists, Animators, Sound Designer, Mixer, Editor, Reviewer and Librarian work through it while you watch, steer and answer their questions. Everything the crew can do is also exposed over MCP, so any other agent can drive a project or join the crew.

Status: early. This first commit holds the proof-of-concept tooling the app grows from and the seed of the public asset library.

## What is here

| Path | What |
|---|---|
| `library/` | The public asset library: sprites, tiles, icons and the 5×8 font, each as a letter grid (`asset.json`) plus a preview sheet (`sheet.png`), on the `pap-night` palette (`library/palettes/`). |
| `poc/` | The proof-of-concept scripts from the first video: a 320×180 frame-buffer renderer piped to ffmpeg, the synthesized 8-bit SFX and chiptune bed, the ffmpeg mix, subtitles, and the draw → validate → critique → judge sprite loop. Scene code, script and private assets of that video live in its own (private) project. These get ported into `packages/`. |
| `vendor/painter/` | A small dependency-free pixel-art toolkit (grid, PNG encoder, sprite checks, shading passes), vendored from the author's own repo. |

## Rules that will not change
- A project is a folder that can live anywhere. Private assets (likenesses of real people, logos, trademarks, and anything derived from them) stay in their project and never enter the public library.
- Keys are never stored in a project folder or the repo.
