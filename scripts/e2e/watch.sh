#!/bin/sh
# usage: PAP_E2E_HOME=<home> watch.sh   a line whenever a project's needs, running state or status line changes;
# ends when the watchdog stops the studio or the server exits
#    or: [PAP_E2E_HOME=<home>] watch.sh --project <id>   follows <home>/projects/<id>/runs/events.jsonl from the
# start (home defaults to ~/.pixelartpitch): a line per finished task, open question, gate, status that waits on
# the person, whole dollar spent, crew report or question, and warn or error log (watch_filter.py); Ctrl-C ends it
P=$(dirname "$0")
if [ "$1" = "--project" ]; then
  id="${2:?usage: watch.sh --project ID}"
  H="${PAP_E2E_HOME:-$HOME/.pixelartpitch}"
  f="$H/projects/$id/runs/events.jsonl"
  [ -d "$H/projects/$id" ] || { echo "no project $id in $H/projects" >&2; exit 1; }
  exec tail -n +1 -F "$f" 2>/dev/null | python3 -u "$P/watch_filter.py"
fi
H="${PAP_E2E_HOME:?set PAP_E2E_HOME to the --home of driver.ts}"
prev=""
while true; do
  cur=$("$P/api.sh" GET /api/projects 2>/dev/null | python3 -c '
import json,sys
try: ps=json.load(sys.stdin)
except Exception: print("API DOWN"); sys.exit()
for p in ps:
  if "status" not in p: continue
  print(p["id"], "| needsYou", p.get("needsYou"), "| running", p.get("running"), "|", p["status"].get("line"))
' 2>&1)
  if [ "$cur" != "$prev" ]; then
    echo "$cur | spent $(cat "$H/e2e/spent.txt" 2>/dev/null)"
    prev="$cur"
  fi
  if grep -q "CAP\|SERVER EXITED" "$H/e2e/driver.log" 2>/dev/null; then grep "CAP\|SERVER EXITED" "$H/e2e/driver.log" | tail -1; break; fi
  sleep 3
done
