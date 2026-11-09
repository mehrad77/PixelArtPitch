# End-to-end driver

The paid check (PIP-ORCHESTRATION §1.15) in one command: a throwaway `PAP_HOME`, the web app built first, a real studio to drive in the browser, and a watchdog on the whole run's spend. The picks are made by hand in the studio (or with `pip.sh` and `api.sh`). It costs real money: run it only with the person's go-ahead.

```sh
node scripts/e2e/driver.ts --home /tmp/pap-e2e --port 5199 --cap 8 --copy ~/somewhere/questday_teaser
```

| Flag | Default | What |
|---|---|---|
| `--home` | `$PAP_E2E_HOME` | the throwaway PAP home (never `~/.pixelartpitch`); a restart with the same home keeps its ledger and projects |
| `--port` | 5199 | the studio's port |
| `--cap` | `$PAP_E2E_CAP`, else 8 | the watchdog: past this many dollars over the whole home, the studio stops |
| `--copy <dir>` | none | a project to copy in on the first start (repeatable), without its lock |

- **First start.** Settings come from `~/.pixelartpitch/settings.json` (providers and prices) with the run's roles: Opus 5.5 for the Pixel Artist, Sonnet 5.5 for Pip and the heavy roles, Haiku 5.5 for the light ones; defaults `capUsd: 6`, `involvement: key`, `pipPlan: shadow`, `reviewRounds: 1`. The user library starts empty and there are no connections.
- **Keys.** The driver never reads, prints or stores a key. The studio reads keys the way it always does (keychain or environment).
- **Output** in `<home>/e2e/`: `driver.log` (ready, spend, Pip cards, the cap), `server.log`, `url.txt` (the sign-in link), `spent.txt`, `workspace-events.jsonl`.

Helpers (set `PAP_E2E_HOME` to the same home):

- `api.sh METHOD PATH [JSON]`: one API call with the studio's token.
- `pip.sh <project|draft:ID|-> "text"`: send Pip a message, wait for the turn, print what came back.
- `watch.sh`: a line whenever a project's needs, running state or status line changes.
- `watch.sh --project <id>`: follows `<home>/projects/<id>/runs/events.jsonl` from its start (home from `PAP_E2E_HOME`, else `~/.pixelartpitch`; no studio needed), one timed line per task done, failed or fallback (kind, title, cost), open question (id and text), gate open, passed or changes, status line that waits on the person, whole dollar of project spend, crew report or question in the channel, and warn or error log. The filter is `watch_filter.py` (stdin to stdout); its test is `apps/server/test/e2e-watch.test.ts` on `test/events.jsonl`.
- `answer.sh <project> <question-id> <option-id> [note]`: answers a question as the person and prints its id and status; on a non-200 or an unknown id it prints the studio's message and exits 1.

Afterwards: `node apps/server/src/cli.ts report <home>/projects/<id> --notes findings.md --picks picks.jsonl` (docs/REPORT.md).
