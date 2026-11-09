#!/bin/sh
# usage: PAP_E2E_HOME=<home> answer.sh <project> <question-id> <option-id> [note]
# answers a crew question as the person; prints the question status, or the server message and exits 1
proj="${1:?usage: answer.sh PROJECT QUESTION-ID OPTION-ID [NOTE]}"
qid="${2:?usage: answer.sh PROJECT QUESTION-ID OPTION-ID [NOTE]}"
opt="${3:?usage: answer.sh PROJECT QUESTION-ID OPTION-ID [NOTE]}"
body=$(python3 -c '
import json,sys
b={"optionId":sys.argv[1]}
if len(sys.argv)>2 and sys.argv[2]: b["note"]=sys.argv[2]
print(json.dumps(b))' "$opt" "$4")
H="${PAP_E2E_HOME:?set PAP_E2E_HOME to the --home of driver.ts}"
PT=$(python3 -c 'import json,sys;s=json.load(open(sys.argv[1]));print(s["port"],s["token"])' "$H/server.json") || exit 1
PORT=${PT% *}
T=${PT#* }
out=$(curl -s -X POST "http://127.0.0.1:$PORT/api/p/$proj/questions/$qid/answer" -H "x-pap-token: $T" \
  -H "origin: http://127.0.0.1:$PORT" -H "content-type: application/json" -d "$body" -w '\n%{http_code}')
code=$(printf '%s\n' "$out" | tail -n 1)
resp=$(printf '%s\n' "$out" | sed '$d')
printf '%s' "$resp" | python3 -c '
import json,sys
code=sys.argv[1]
raw=sys.stdin.read()
try: d=json.loads(raw)
except ValueError: d=None
if code=="200" and isinstance(d,dict) and d.get("status"):
  print(d.get("id"), d["status"]); sys.exit(0)
err=(d or {}).get("error") if isinstance(d,dict) else None
msg=(err or {}).get("message") or raw.strip() or "no answer from the studio"
fix=(err or {}).get("fix")
print("HTTP", code or "?", msg + (" (" + fix + ")" if fix else ""), file=sys.stderr); sys.exit(1)
' "$code"
