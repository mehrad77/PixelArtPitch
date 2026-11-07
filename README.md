# PixelArtPitch

![PixelArtPitch: Pip and the crew in front of a pixel city at night](docs/banner.png)

[![CI](https://github.com/mehrad77/PixelArtPitch/actions/workflows/ci.yml/badge.svg)](https://github.com/mehrad77/PixelArtPitch/actions/workflows/ci.yml)

**Short pixel-art pitch videos, made by a crew of AI agents while you watch, steer and pick.**

You tell Pip what you're making: a 30-second pitch for your app, a launch teaser, a demo-day opener. Pip runs a crew of AI agents: a Writer, Director, Art Director, Pixel Artists, Animators, Sound Designer, Mixer, Editor and Reviewer. They work through your video on a 320×180 night canvas and ask you only for the picks that matter: which script, does the animatic feel right, is the rough cut good. Everything runs on your machine, and every dollar is counted before it is spent.

> Status: early and moving fast. It already makes real videos end to end. See [`examples/questday`](examples/questday), a fictional 15 s launch.

## What it does

- **Pip runs the show.** One chat sits at the top of each project. Pip tells you where things stand, passes your notes to the right crew member, and asks you only when the crew needs you. Slash commands: `/undo`, `/budget`, `/why`, `/compact` and `/context`.
- **The crew does small, checkable jobs.** Each task comes from a fixed catalogue and has a schema, lints and a repair loop. Scenes are built from a closed menu of recipes and behaviours, not free-form code, so weaker and local models can do the job too.
- **The pixels are exact.** A byte-exact engine renders the same frames and WAVs from the same document, every time. Every edit is a JSON Patch with an author and a reason, so it can always be undone.
- **The budget is a hard cap.** Every model call reserves its worst case before it runs. The studio shows the spend, the in-flight reserve and the ETA, and asks you before the cap is crossed.
- **Any model:** Anthropic, OpenAI, OpenRouter, and local servers (LM Studio, Ollama, llama.cpp). Each model is probed for vision, tools and structured output before it is trusted with a role.
- **Everything is a tool.** Pip, the crew and the studio share one tool registry, and the same tools are served over MCP (stdio and Streamable HTTP). Any other agent can drive a project or join the crew. The crew can also use your own MCP servers.
- **Docs inside the studio.** The Docs page reads the repo's guides in place and lists every tool: the studio's own, with their inputs, examples and whether they need your OK, and the ones your MCP servers add.
- **Private stays private.** A project is a folder that can live anywhere. Likenesses of real people, logos and trademarks never leave their project, and the public library refuses them in code.

## Quick start

You need Node ≥ 24.21 (it runs the TypeScript directly), pnpm and ffmpeg.

```bash
pnpm install
```

```bash
pnpm --filter @pap/web build
```

```bash
node apps/server/src/cli.ts serve
```

Open the one-time launch URL it prints, add a model key in Settings, and press **New video**. Keys are kept in the macOS Keychain, or in a private file in the PAP home folder, never in a project or this repo.

More commands:

| Command | What |
|---|---|
| `node apps/server/src/cli.ts mcp` | MCP over stdio. It proxies to a running studio, or runs in-process |
| `node apps/server/src/cli.ts render <dir>` | Export a project's video |
| `node apps/server/src/cli.ts still <dir> <t>` | One frame as a PNG |
| `node apps/server/src/cli.ts report <project> [--run <id>\|--all] [--notes findings.md] [--picks picks.jsonl] [--out <dir>]` | A run as one HTML page: the crew's timeline, cost by role, failures, the new art ([docs/REPORT.md](docs/REPORT.md)) |
| `pnpm check` | The gate: Biome, `tsc` and every test |
| `node scripts/banner.ts` | Redraw the banner above with the engine and the library |

## How it is built

A pnpm workspace on Node 24 with type stripping (no build step for the server), zod at every boundary, and no SDK dependencies: providers are plain HTTP, and MCP is hand-written JSON-RPC.

| Path | What |
|---|---|
| `packages/schema` | The project document, JSON Patch with inverses, cue-anchored time expressions |
| `packages/engine` | The byte-exact renderer core, declarative scenes, recipes, lints, the asset standard, synth audio |
| `packages/render` | The render sandbox, frame streaming, the ffmpeg encode, the mix, subtitles, the golden check |
| `packages/tools` | The one tool registry, the core tools, the project store |
| `packages/crew` | Providers, the ledger and budget guard, the orchestrator, the roles, and Pip |
| `packages/mcp-client` | A small MCP client for your own MCP servers |
| `packages/report` | `pap report`: a project's run files and the ledger as one HTML page |
| `apps/server` | Hono on 127.0.0.1: the studio API, SSE, MCP and the CLI |
| `apps/web` | The studio UI (React, Vite, [ShabUI](https://ui.shab.boo)) |
| `library/` | The public asset library: sprites, tiles, icons and a 5×8 font on the `pap-night` palette |
| `docs/` | The crew's ground truth: style, writing, sound, the asset standard, rubrics, rights, one guide per role |
| `skills/` | The same know-how as Agent Skills, served over MCP |

Coding agents working on this repo should read [`AGENTS.md`](AGENTS.md).

## Rules that will not change

- A project is a folder that can live anywhere. Private assets (likenesses of real people, logos, trademarks, and anything derived from them) stay in their project and never enter the public library.
- Keys are never stored in a project folder or the repo, and never logged.
- The server binds to 127.0.0.1 only and checks Host and Origin on every request.

## Licence

No licence has been chosen for the code yet. The library's assets are under [`library/LICENSE.md`](library/LICENSE.md).
