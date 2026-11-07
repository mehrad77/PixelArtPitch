# AGENTS.md

PixelArtPitch (PAP) is a local app where a crew of AI agents makes short pixel-art pitch videos (15–120 s, a 320×180 canvas scaled up, a night palette) while a human watches, steers and answers questions. Everything the crew can do is also a tool over MCP.

These are the instructions for **coding agents working on this repo**. Crew-member guides are in `docs/roles/` and `skills/`.

## Map

| Path | What |
|---|---|
| `packages/schema` | zod schemas: the project document (`doc.ts`), JSON Patch with inverses (`patch.ts`), time expressions (`time.ts`) |
| `packages/engine` | The byte-exact renderer core (`core.ts`), declarative scenes (`decl*.ts`), recipes (`recipes.ts`), lints (`lints.ts`), the asset standard (`standard.ts`), PNG → palette (`quantize.ts`), synth audio (`audio.ts`), the vendored painter (`painter/`) |
| `packages/render` | The render sandbox (`sandbox-child.ts`), frame streaming, ffmpeg encode, sound files and mix, subtitles, the golden check |
| `packages/tools` | The one tool registry (`registry.ts`), the core tools (`defs.ts`), the project store (`store.ts`; `newProjectDoc` is a new project's document), the draft store for `/new` (`drafts.ts`, `$PAP_HOME/drafts/<id>/`), voice alignment (`align.ts`) |
| `packages/crew` | The model gateway and providers over plain HTTP (`llm/`), prices, the orchestrator (`orchestrator.ts`: one handler per plan task kind), the production plan (`plan/`: catalogue, schemas, rules planner, validator, estimates, executor, logo import, storage, Pip's revision, the eval scorer, the crew instances (`instances.ts`: the fold over `events.jsonl`, the ghost horizon, the live tracker); `docs/PIP-ORCHESTRATION.md`), the evals (`evals/`: `plan.ts` runs `plan.jsonl`, outside `pnpm check`), Pip, the assistant (`assistant.ts`, `docs/ASSISTANT.md`), and `/new` as a conversation (`brief/`: the field registry and rules parse `registry.ts`, the reading `read.ts`, the draft conversation and Start `drafts.ts`, the Projects line `line.ts`; PIP-ORCHESTRATION §3). `test/fixtures/instances/` holds recorded `events.jsonl` logs for the instance fold |
| `packages/mcp-client` | A plain MCP client (stdio + Streamable HTTP) for the person's own MCP servers ("connections") |
| `apps/server` | Hono on 127.0.0.1: the studio API (`docs/API.md`), MCP over stdio and HTTP (`mcp.ts`), the CLI (`cli.ts`) |
| `apps/web` | The studio UI (Vite). `src/components/ProjectStage.tsx` is the one shell from `/new` to the project page; the crew as instances (PIP-JOURNEY §3) is `src/lib/instances.ts` (the pure half: glyphs, words, groups), `components/CrewStrip.tsx` (the row), `components/CrewDrawer.tsx` (the drawer's Working / Up next / Finished and the kept log) and `components/CrewRow.tsx` (Studio's Crew tab); `pages/SettingsRoles.tsx` is Settings › Roles (PIP-JOURNEY §10); `lib/cards.ts` keeps a late reply from moving a Pip card back; `lib/locale.ts` is the page language (`?lang=fa`); `src/mock/` is the in-browser backend (`?mock=1`): `journey.ts` plays "Pip runs the show" (docs/PIP-JOURNEY.md §6), `drafts.ts` is `/new`'s drafts and cards ("Make another like this" too) |
| `apps/web/test` | Node tests over the web's pure code: `journey.test.ts` plays the journey through the reducer and checks PIP-JOURNEY §2's checkpoint table, the card race and the "Make another like this" draft |
| `library/` | The public asset library: `<id>/asset.json` + `sheet.png`, `index.json`, `palettes/pap-night.json`. Public assets only. |
| `docs/` | Ground-truth guides, served over MCP as `pap://docs/<file>.md` (top level only) |
| `docs/roles/` | One guide per crew role (12) |
| `skills/` | Agent Skills `pap-<role>/SKILL.md`, served as `pap://skills/pap-<role>` |
| `examples/` | Public example projects (`questday`, a fictional 15 s launch) |
| `poc/`, `vendor/` | The proof-of-concept scripts and the vendored painter. Don't lint or edit them. |

## Commands (from the repo root)

| Command | What |
|---|---|
| `pnpm check` | **The gate**: Biome, `tsc`, every test. Run it before calling work done. |
| `pnpm format` | Biome autofix |
| `node --test packages/engine/test/standard.test.ts` | One test file (`pnpm test` runs them all) |
| `pnpm exec tsc -p apps/web/tsconfig.json` | Type-check the web app (`pnpm check`'s `tsc` covers `packages/` and `apps/server` only) |
| `pnpm --filter @pap/web dev`, then `/?mock=1&journey=todo` | The studio on the mock; add `&auto=1&speed=4` to watch the journey run with no clicks |
| `?lang=fa` on any studio address | Right-to-left with Persian digits, kept for the browser (`?lang=en` turns it back): the RTL check without setting `dir` by hand |
| `node apps/server/src/cli.ts serve [--port 5141] [--dev]` | The studio (UI + API + MCP over HTTP); prints a one-time launch URL |
| `node apps/server/src/cli.ts mcp` | MCP over stdio (proxies to a running `serve`, or runs in-process) |
| `node apps/server/src/cli.ts render <dir> [--delivery id]` | Export a project's video |
| `node apps/server/src/cli.ts still <dir> <t> [--scale 4]` | One PNG into `<dir>/out/` |
| `node apps/server/src/cli.ts golden <dir>` | Check frames against `<dir>/gen/golden.json` |
| `PAP_GOLDEN_PROJECT=<dir> node --test packages/render/test/golden.test.ts` | The golden test (skipped without the env var) |

Node ≥ 24.21 runs `.ts` directly (type stripping). ffmpeg must be on the PATH for renders.

## Conventions

**TypeScript**
- Write erasable TypeScript only (`erasableSyntaxOnly`): no `enum`, no `namespace`, no parameter properties.
- Import with `.ts` extensions (`import { x } from "./store.ts"`). Packages import each other as `@pap/<name>`.
- Biome formats: 2 spaces, double quotes, semicolons, trailing commas, line width 120.

**Boundaries**
- Use zod for every boundary: tool inputs and outputs, the API, MCP, model outputs, files on disk.
- Errors carry a `fix`: `fail(code, message, { fix })` or an error with `.fix`. Write the fix as an instruction a small model can follow ("use one of: …", "move it up so it ends above y=146").
- Add a capability as **one tool** in the registry (`defineTool`). The crew, MCP and the UI all reach it there. Give it `examples` where it helps.

**The document**
- Every document edit is a patch (`project.patch(ops, { reason, baseRev, author })`) with an author and a reason. Never write `pitch.json` directly.
- Every time is a cue-anchored expression (`S(c03)+0.4`, `intro.to`, `@event`). Add a raw number only where a lint allows it.

**The engine**
- The engine is byte-exact. The same document gives the same frames and WAVs. No `Math.random`, no clock, and iteration order is fixed. Recipes run inside the sandbox import graph: no zod, no `eval`.
- A change to drawing or audio must keep the golden test passing. If a change is meant to alter pixels, say so and regenerate the golden on purpose.

**The sandbox (code bundles)**
- A bundle runs as an ES module in a `vm` context in a child process started with `--permission` (fs reads limited to the PAP packages, no child processes or workers) and `--disallow-code-generation-from-strings`.
- It may import only `pap:engine` and `pap:timeline`. It has no Node globals, no network and no randomness.
- It gets 250 ms per frame and 5 s to load. Don't loosen these limits.

**Dependencies**
- Add no SDK dependencies. The firewall blocks npm downloads. Providers are plain HTTP (`packages/crew/src/llm/http.ts`), and MCP is hand-written JSON-RPC.
- Prefer Node built-ins. Ask before adding any package.

**Privacy**
- No private assets in `library/`, `docs/`, `examples/` or tests: no likenesses of real people, logos or trademarks, nor anything derived from them. See `docs/RIGHTS.md`.
- Never name a real person, company or product in public assets, docs or fixtures. Example projects use fictional products.
- Keys are never stored in a project folder or the repo. Settings live in the PAP home folder.
- Private projects (with golden files) stay outside this repo; point `PAP_GOLDEN_PROJECT` at them.

**Commits**
- Use conventional commits: `feat:`, `fix:`, `chore:`, `docs:`, `refactor:`, `test:`, with an optional scope (`feat(engine): …`).
- Commit only when asked.

## Docs that are ground truth

These docs are read by weaker models. Keep them concrete: numbers, checklists, examples.

- Crew-facing: `STYLE-GUIDE`, `WRITING-GUIDE`, `SOUND-GUIDE`, `PAP-STANDARD`, `ASSET-KINDS`, `REVIEW-RUBRICS`, `RIGHTS`, `GLOSSARY`, `RECIPES`, `BEHAVIORS`.
- When you change a number in code (a size class, a lint threshold, a keep table, a default), update the doc that states it in the same change.
- `docs/PAP-STANDARD.md` ends with "Mismatches with the checker": remove an entry once it is fixed.
- Every JSON example in `docs/roles/*.md` of the form `{ "tool", "input" }` must parse with that tool's input schema.
