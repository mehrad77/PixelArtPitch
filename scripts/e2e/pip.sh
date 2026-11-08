#!/bin/sh
# usage: PAP_E2E_HOME=<home> pip.sh <project|draft:ID|-> "text"
# sends to Pip, waits for the turn, prints the new items (text and cards)
P=$(dirname "$0")
where="$1"; text="$2"
case "$where" in
  draft:*) body=$(python3 -c 'import json,sys;print(json.dumps({"draft":sys.argv[1],"text":sys.argv[2]}))' "${where#draft:}" "$text"); q="";;
  -) body=$(python3 -c 'import json,sys;print(json.dumps({"text":sys.argv[1]}))' "$text"); q="";;
  *) body=$(python3 -c 'import json,sys;print(json.dumps({"project":sys.argv[1],"text":sys.argv[2]}))' "$where" "$text"); q="?project=$where";;
esac
before=$("$P/api.sh" GET "/api/pip$q" | python3 -c 'import json,sys;print(len(json.load(sys.stdin)["items"]))' 2>/dev/null || echo 0)
"$P/api.sh" POST /api/pip "$body"; echo
case "$where" in draft:*) exit 0;; esac
for i in $(seq 200); do
  sleep 3
  busy=$("$P/api.sh" GET "/api/pip$q" | python3 -c 'import json,sys;print(json.load(sys.stdin)["busy"])')
  [ "$busy" = "False" ] && break
done
"$P/api.sh" GET "/api/pip$q" | python3 -c '
import json,sys
d=json.load(sys.stdin); n=int(sys.argv[1])
for it in d["items"][n:]:
  print("--", it.get("kind"), (it.get("text") or "")[:900])
  for c in it.get("cards",[]) or []:
    print("   CARD", json.dumps(c)[:900])
' "$before"
