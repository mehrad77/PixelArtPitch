#!/bin/sh
# usage: PAP_E2E_HOME=<home> watch.sh   a line whenever a project's needs, running state or status line changes;
# ends when the watchdog stops the studio or the server exits
P=$(dirname "$0")
H="${PAP_E2E_HOME:?set PAP_E2E_HOME to the driver's --home}"
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
