#!/usr/bin/env bash
#
# Copyright 2026 Seillen Ltd. Licensed under the Apache License, Version 2.0.
#
# Prove a schedule actually fires a run.
# Native Temporal Schedules are reconciled at runtime STARTUP, so this is two
# phases with a restart between them:
#
#   1. metis up                          # host runtime, from the repo root
#   2. ./scripts/prove-schedule.sh       # setup: create+publish+register a
#                                        #   per-minute schedule, print the WF id
#   3. restart `metis up`                # provisions the Temporal schedule
#   4. ./scripts/prove-schedule.sh watch <WF>   # watch it fire (~3 minutes)
#
# Same host-runtime requirement as prove-webhook.sh (CLI and server must share
# the project database; the prebuilt Docker image does not).
#
# Env: METIS_URL, METIS_ADMIN_USER/SECRET, METIS_CLI (as in prove-webhook.sh).
set -euo pipefail
cd "$(dirname "$0")/.."

BASE="${METIS_URL:-http://localhost:3000}"
USER="${METIS_ADMIN_USER:-admin}"
SECRET="${METIS_ADMIN_SECRET:-metis}"
METIS="${METIS_CLI:-npx tsx packages/metis-cli/src/bin.ts}"

jq_get() { python3 -c "import sys,json;print(json.load(sys.stdin)$1)"; }
say() { printf '\n\033[1m==> %s\033[0m\n' "$1"; }
token() {
  curl -sf "$BASE/api/auth/login" -H 'content-type: application/json' \
    -d "{\"userId\":\"$USER\",\"secret\":\"$SECRET\"}" | jq_get '["token"]'
}

if [ "${1:-setup}" = "watch" ]; then
  WF="${2:?usage: prove-schedule.sh watch <workflowId>}"
  AUTH="authorization: Bearer $(token)"
  say "Watching $WF for scheduled fires (up to ~3 minutes)"
  count_execs() { curl -sf "$BASE/api/executions?workflowId=$WF" -H "$AUTH" \
    | python3 -c 'import sys,json;print(len(json.load(sys.stdin)["items"]))'; }
  START=$(count_execs)
  echo "   executions now: $START"
  for i in $(seq 1 18); do
    sleep 10
    NOW=$(count_execs)
    printf '   +%3ds  executions: %s\n' "$((i*10))" "$NOW"
    if [ "$NOW" -gt "$START" ]; then
      EID=$(curl -sf "$BASE/api/executions?workflowId=$WF" -H "$AUTH" | jq_get '["items"][0]["executionId"]')
      curl -sf "$BASE/api/executions/$EID" -H "$AUTH" | python3 -c '
import sys,json
d=json.load(sys.stdin)
print("   fired execution:", d["meta"]["executionId"], d["meta"]["status"])
'
      say "PASS: the schedule fired at least one run."
      echo "Clean up:  $METIS triggers list   then   $METIS triggers remove <triggerId>   and restart metis up"
      exit 0
    fi
  done
  echo "   FAIL: no new execution within the watch window."
  echo "   Check: did you restart 'metis up' after setup? Is the workflow published?"
  exit 1
fi

# --- setup phase ---
AUTH="authorization: Bearer $(token)"

say "1. Create + publish a schedule-started workflow (scheduleconfig -> code)"
WF=$(curl -sf "$BASE/api/workflows" -H "$AUTH" -H 'content-type: application/json' -d '{
  "name":"schedule-proof","type":"workflow",
  "nodes":[
    {"id":"node-33333333-3333-4333-8333-333333333333","type":"scheduleconfig","version":"v1",
     "data":{"label":"Every minute","config":{"cron":"* * * * *"}}},
    {"id":"node-44444444-4444-4444-8444-444444444444","type":"code","version":"v1",
     "data":{"label":"Tick","config":{"code":"return { tickedWith: input };"}}}
  ],
  "edges":[{"id":"e1","source":"node-33333333-3333-4333-8333-333333333333",
            "target":"node-44444444-4444-4444-8444-444444444444","sourceHandle":null}]
}' | jq_get '["workflowId"]')
echo "   workflowId = $WF"
curl -sf -X POST "$BASE/api/workflows/$WF/publish" -H "$AUTH" >/dev/null
echo "   published."

say "2. Register a per-minute schedule via the CLI"
$METIS triggers add schedule "$WF" --cron "* * * * *"

say "NEXT STEPS"
cat <<EOF
   Schedules provision at runtime startup, so:
     1) restart 'metis up'   (watch its log for: Scheduled $WF (* * * * *).)
     2) ./scripts/prove-schedule.sh watch $WF

   Or open the Temporal UI (http://localhost:8233) and look for schedule
   sch_t1_$WF firing 'helixWorkflow' runs each minute.
EOF
