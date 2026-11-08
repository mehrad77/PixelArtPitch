#!/bin/sh
# usage: PAP_E2E_HOME=<home> api.sh METHOD PATH [JSON]   one call to the e2e studio (the port and token from server.json)
H="${PAP_E2E_HOME:?set PAP_E2E_HOME to the driver's --home}"
read -r PORT T <<EOT
$(python3 -c "import json;s=json.load(open('$H/server.json'));print(s['port'],s['token'])")
EOT
curl -s -X "$1" "http://127.0.0.1:$PORT$2" -H "x-pap-token: $T" -H "origin: http://127.0.0.1:$PORT" -H "content-type: application/json" ${3:+-d "$3"}
