#!/usr/bin/env bash
#
# Copyright 2026 Seillen Ltd. Licensed under the Apache License, Version 2.0.
#
# Prove an EXTERNAL system can call a webhook
# trigger and start a run. Creates + publishes a webhook-started workflow, signs
# a payload with HMAC-SHA256, POSTs it to /hooks/<triggerId> (the ingress an
# outside caller hits), and asserts a matching execution appears.
#
# IMPORTANT: run this against a HOST `metis up` started from this repo root, so
# the `metis` CLI and the running server share the project database. The
# prebuilt Docker image ISOLATES the CLI's database from the server's, so trigger
# registration there is not visible to the server (a documented limitation).
#
# Usage:
#   metis up                       # in one shell, from the repo root
#   ./scripts/prove-webhook.sh     # in another
#
# Env: METIS_URL (default http://localhost:3000), METIS_ADMIN_USER/SECRET
#      (default admin/metis), METIS_CLI (default: run the CLI from source).
set -euo pipefail
cd "$(dirname "$0")/.."

BASE="${METIS_URL:-http://localhost:3000}"
USER="${METIS_ADMIN_USER:-admin}"
SECRET="${METIS_ADMIN_SECRET:-metis}"
METIS="${METIS_CLI:-npx tsx packages/metis-cli/src/bin.ts}"
WEBHOOK_SECRET="${WEBHOOK_SECRET:-s3cret}"

jq_get() { python3 -c "import sys,json;print(json.load(sys.stdin)$1)"; }
say() { printf '\n\033[1m==> %s\033[0m\n' "$1"; }

say "1. Login ($USER) at $BASE"
TOKEN=$(curl -sf "$BASE/api/auth/login" -H 'content-type: application/json' \
  -d "{\"userId\":\"$USER\",\"secret\":\"$SECRET\"}" | jq_get '["token"]')
AUTH="authorization: Bearer $TOKEN"

say "2. Create + publish a webhook-started workflow (webhookconfig -> code)"
# The code node reads the webhook trigger's seeded state via substitution:
# config.input = {{<webhookconfig>.data}}. Substitution string-embeds the
# object, so the code parses it and pulls out the delivered body.
WF=$(curl -sf "$BASE/api/workflows" -H "$AUTH" -H 'content-type: application/json' -d '{
  "name":"webhook-proof","type":"workflow",
  "nodes":[
    {"id":"node-11111111-1111-4111-8111-111111111111","type":"webhookconfig","version":"v1",
     "data":{"label":"In","config":{"triggerType":"webhook"}}},
    {"id":"node-22222222-2222-4222-8222-222222222222","type":"code","version":"v1",
     "data":{"label":"Handle","config":{
       "code":"const e = typeof input === '\''string'\'' ? JSON.parse(input) : input; return { received: (e||{}).body };",
       "input":"{{node-11111111-1111-4111-8111-111111111111.data}}"}}}
  ],
  "edges":[{"id":"e1","source":"node-11111111-1111-4111-8111-111111111111",
            "target":"node-22222222-2222-4222-8222-222222222222","sourceHandle":null}]
}' | jq_get '["workflowId"]')
echo "   workflowId = $WF"
curl -sf -X POST "$BASE/api/workflows/$WF/publish" -H "$AUTH" >/dev/null
echo "   published."

say "3. Register the webhook trigger (HMAC-signed) via the CLI"
TRIG=$($METIS triggers add webhook "$WF" --verification hmac --secret "$WEBHOOK_SECRET" \
  | grep -oE 'trg_[a-f0-9-]+' | head -1)
if [ -z "${TRIG:-}" ]; then echo "   FAILED to register trigger"; exit 1; fi
echo "   triggerId = $TRIG  ->  POST $BASE/hooks/$TRIG"

say "4. External call: sign the body and POST it to the hook"
BODY='{"hello":"world","order":42}'
SIG=$(printf '%s' "$BODY" | openssl dgst -sha256 -hmac "$WEBHOOK_SECRET" -binary | base64)
CODE=$(curl -s -o /tmp/wh_resp -w '%{http_code}' -X POST "$BASE/hooks/$TRIG" \
  -H 'content-type: application/json' -H "x-metis-signature: $SIG" --data "$BODY")
echo "   HTTP $CODE  $(cat /tmp/wh_resp)"
[ "$CODE" = "202" ] || { echo "   FAIL: expected 202"; exit 1; }

say "5. Negative: a bad signature is rejected"
BADCODE=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$BASE/hooks/$TRIG" \
  -H 'content-type: application/json' -H "x-metis-signature: wrong" --data "$BODY")
echo "   bad signature -> HTTP $BADCODE (expect 401)"
[ "$BADCODE" = "401" ] || echo "   WARN: expected 401 for bad signature"

say "6. Verify the run fired and received the body"
sleep 2
DETAIL=$(curl -sf "$BASE/api/executions?workflowId=$WF" -H "$AUTH")
COUNT=$(printf '%s' "$DETAIL" | python3 -c 'import sys,json;print(len(json.load(sys.stdin)["items"]))')
echo "   executions for $WF: $COUNT"
[ "$COUNT" -ge 1 ] || { echo "   FAIL: no execution created"; exit 1; }
EID=$(printf '%s' "$DETAIL" | jq_get '["items"][0]["executionId"]')
LOGS=$(curl -sf "$BASE/api/executions/$EID" -H "$AUTH")
printf '%s' "$LOGS" | python3 -c '
import sys,json
d=json.load(sys.stdin)
outs=[l.get("output") for l in d["logs"] if l.get("outcome")=="completed" and l.get("output")]
body=None
for o in outs:
    r=(o or {}).get("received")
    if isinstance(r,dict) and r.get("hello"): body=r
assert body and body.get("hello")=="world", "webhook body did not reach the code node"
print("   OK: the code node received the webhook body:", json.dumps(body))
'

say "PASS: an external HMAC-signed webhook call started a run and delivered its body."
echo "Clean up:  $METIS triggers remove $TRIG"
