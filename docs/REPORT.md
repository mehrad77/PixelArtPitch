# The run report (`pap report`)

`pap report` turns a project's run into one HTML page: who worked when, what it cost, what failed, and what the crew drew. It reads only files that are already on disk, makes no model calls and costs nothing. Run it while the studio is running too: it takes no lock and writes nothing into the project, except its default output folder.

## Usage

```bash
node apps/server/src/cli.ts report <project> [--run <id> | --all] [--notes findings.md] [--picks picks.jsonl] [--out <dir>] [--include-private]
```

| Flag | What |
|---|---|
| `<project>` | A project folder (one with `pitch.json`), or a project id from the PAP home. Ids are looked up as the studio does: in the roots from `settings.json` (`paths.roots`, else `$PAP_HOME/projects`) and in `projects.json`. |
| `--run <id>` | Only that run: from its `run … start` event to its end (`done`, `failed` or `stopped`). The run ids are in `runs/events.jsonl`. An unknown id fails and lists the ids. |
| `--all` | Every run in the project. This is the default. |
| `--notes <file>` | A Markdown file shown as the Findings section (see below). |
| `--picks <file>` | A JSONL file shown as the Picks section, one pick per line: `{ "project", "where", "options": [], "chose", "why", "by": "person" }`. |
| `--out <dir>` | Where to write. The default is `<project>/out/report/`. |
| `--include-private` | Show the images of assets flagged private, likeness or brand. Off by default. |

`PAP_HOME` decides the home, as for every command (default `~/.pixelartpitch`). The ledger is `$PAP_HOME/ledger.sqlite`.

Example, for an archived home:

```bash
PAP_HOME=/path/to/home node apps/server/src/cli.ts report my_project --notes findings.md --out /tmp/my-report
```

It prints the page's path, the number of images, the calls and the cost. Open `index.html` in a browser.

## What it writes

- `index.html`: one page with the summary embedded as JSON. It loads nothing from the network.
- `img/`: the pictures the page shows. These are the kept asset sheets (`asset-<id>.png`), the drawn variants of assets that weren't kept (`<asset>-v<n>.png`), `contact.png` and `animatic-contact.png`. No other file from `out/` is ever copied.

The studio serves the same page at `GET /api/p/:id/report` (docs/API.md), and the ⋯ menu on Projects opens it as "Run report".

From code, use `buildReport(projectDir, { run, ledger, notes, picks, includePrivate, out })` from `@pap/report`. It returns `{ html, summary, images }` (`images` are `{ name, data }`, with `name` like `img/contact.png`). With `out`, it also writes the files.

## What it reads

| File | For |
|---|---|
| `pitch.json` | The title, the brief's idea, the budget cap, the scene order, the assets and their flags, the delivery file names |
| `runs/events.jsonl` | Tasks (folded by id: start, end, status, cost, model, error), gates, runs and status lines |
| `runs/plan.jsonl`, `runs/plan.json` | Plan revisions (who, why, how many tasks added, the estimate) and fallback notes (`partial: …` or `outcome: "fallback"`) |
| `runs/pip.jsonl` | Pip's thread: only each item's text and its card titles, never its trace |
| `runs/channel.jsonl` | The crew's reports: the "Couldn't: …" part of `partial:` and `blocked:` reports |
| `assets/*.json`, `assets/*.png`, `runs/<asset>-v<n>.png` | The new art |
| `$PAP_HOME/ledger.sqlite` | Every model call: role, model, prompt template, tokens (thinking included), cost, time, stop reason. Opened read-only; missing columns read as 0. |

It never reads `auth.json`, `settings.json`'s keys, or anything under the project's `private/`.

**What is hidden, and what isn't.** Only the images and descriptions of private, likeness and brand assets are left out (unless `--include-private`). Asset ids, task titles and Pip's words are shown as they are, so a private asset's id can still appear in a task title or in Pip's thread.

## The page, section by section

1. **Header.** The title, the brief, whether the video was exported (a delivery file exists in `out/`), and how each run ended.
2. **The numbers.** The amount spent of the cap (this project's ledger rows only), the minutes from the first mark to the last, the model calls, the assets of the project's own that were kept, the share of the money that went to the most expensive role, and the thinking share of the role that thought most.
3. **The cut.** The last cut's contact sheet and the animatic's, when they exist.
4. **The new art.** One card per asset of the project's own and per asset that has drawn variants. A card shows the sheet and its tags:
   - "Kept in the project", or "Not kept" (with the library asset that stands in, if one does).
   - "Variant N: rejected by the standard", "hit the token limit" or "key rejected", one tag per failed draw.
   - "Publish: …", the Librarian's note.
   - "Private".

   Cost, model time and "hit the limit" count the ledger calls of that asset's drawing tasks.
5. **The crew, minute by minute.** One lane per crew instance, in role order (Producer, Writer, Director, Art director, Pixel artist, Animator, …, Librarian). Pixel artists are ordered by first start, animators by scene order. The top lane shows Pip's turns: a filled dot is Pip, a ring is you. The ticks above the lanes are plan revisions. Hatched bands are gates waiting on you (from `open` until `passed`). Dashed red lines are incidents. Hover for details; the table under it has the same rows.
6. **Plan revisions.** Each revision's author, its reason, the tasks it added, its estimate (low–high), and what had been spent when it was made. Under the table: the first estimate against the final cost.
7. **Where the money and the time went.** Cost and model time by role, and every project in the same ledger over the same time span (this one is marked).
8. **Where it failed most.**
   - **Failures by role**: a count per role and kind. Only the kinds that happened get a column.
   - **Thinking against answer**: one bar per call for the role with the most thinking tokens. A red "limit" marks a call that stopped at `max_tokens`.
   - **What the crew said it couldn't do**: the first 6 reports, with the rest folded.
9. **The picks** (with `--picks`) and **Findings** (with `--notes`).

### Colours

| Mark | Colour | Means |
|---|---|---|
| Bar | blue `#3987e5` | The task worked and is done |
| Bar | amber `#c98500` | The task fell back to a stand-in (its plan note starts `partial:`) |
| Bar | red `#d03b3b` | The task failed |
| Bar segment | orange `#d95926` | Thinking tokens (the answer is blue) |

These four colours are checked to stay apart on the panel surface (`#101512`).

### Failure kinds

A task's kind comes from its error (`error.kind` when the crew wrote one, else the message), or from its fallback note. A pause is not a failure.

| Kind | Column | From |
|---|---|---|
| `limit` | Hit the token limit | A ledger call with `stop = max_tokens` (counted per call, not per task) |
| `auth` | Key rejected | 401 or 403, "authentication", "x-api-key" |
| `credit` | Out of credit | "credit", "billing", "quota" |
| `unreachable` | Provider unreachable | ECONNREFUSED, "fetch failed", "can't reach" |
| `rate` | Rate limited | 429, 529, "rate limit", "overloaded" |
| `budget` | Stopped by the budget | "budget", "over the cap" |
| `standard` | Rejected by the standard | "fails the standard" |
| `fallback` | Fell back to a stand-in | A `partial:` note of any other kind |
| `other` | Other failure | Anything else |

**Incidents** are the first `auth`, `credit`, `unreachable`, `rate` and `standard` failure of the run, plus every run that ended `failed`. A failed run is labelled with the status problem showing at that moment: "Run failed: The artist got stuck."

### Findings

`--notes` takes Markdown. Use `#` headings to make groups. Without headings, a bullet that starts with an ALL-CAPS tag is grouped by that tag: `- BUG: …`, `- UI (the person): …`, `- COST + SPEED: …`. Other bullets go under "Notes". Indented `-` lines are sub-points. Only `` `code` `` and `**bold**` are formatted, and everything else is shown as text. The raw file is folded under the groups.

## Privacy

- **Keys and tokens.** Every string is scrubbed before it reaches the page: `sk-…` keys, `Bearer …`, `x-api-key: …`/`token=…` values, and long hex or mixed-case base64 runs. Some providers echo part of a key in their 401 text.
- **Paths.** The project folder shows as `<project>` and your home folder as `~`.
- **`private/`.** Nothing under it is read or copied. An image whose real path (symlinks resolved) is outside the project or inside `private/` is skipped, even by name.
- **Private assets.** An asset is private when:
  - its ref in `pitch.json` has `flags.private`, `flags.likeness` or `flags.brand`, or
  - its file's `rights` say `likeness`, `brand` or `trademark`.

  Its card shows a "private" label and no image or description. The contact sheets are hidden too while any asset of the project is private, since they show it. `--include-private` shows them all.

## Reading it

- **A lane that is mostly red or amber** is a crew member that kept failing. Hover the bar to read why: the error, or the fallback note.
- **A long hatched band** means the run sat waiting on you. If Needs you showed 0 at that time, that is a bug.
- **Many ticks close together** above the lanes means Pip revised the plan in a burst. Read their reasons in the revisions table.
- **Orange-heavy bars** with a red "limit" are calls that thought until they ran out of tokens. Lower that card's `effort`.
- **The estimate line** says how far the first estimate was from the cost. More than ×1.5 over the high end means the estimator is missing something.
