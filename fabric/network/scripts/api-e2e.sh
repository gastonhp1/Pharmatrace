#!/usr/bin/env bash
# End-to-end test of the REST API (backend/) against the running network: it starts the API,
# drives the whole trip over HTTP and uses the valija simulator (iot/simulator) to upload real
# signed readings. Needs the chaincode deployed (./network.sh deploy), node with backend/
# installed (npm ci), python3 with `cryptography`, curl and jq.
set -euo pipefail
# shellcheck source=scripts/env.sh
source "$(dirname "$0")/env.sh"
cd "$NETWORK_DIR"

REPO=$(cd ../.. && pwd)
HTTP_PORT=${API_PORT:-3101}
API="http://localhost:$HTTP_PORT"
KEY="e2e-$RANDOM$RANDOM"
WORK=$(mktemp -d)
RUN=$(date +%s)

info "Starting the API on $API"
(cd "$REPO/backend" && FABRIC_ORGS_DIR="$ORGS_DIR" API_KEY="$KEY" PORT="$HTTP_PORT" IOT_DATA_DIR="$WORK/iot" \
  node server.js >"$WORK/api.log" 2>&1) &
API_PID=$!
trap 'kill $API_PID 2>/dev/null || true; echo "--- API log"; tail -n 40 "$WORK/api.log"' EXIT
retry 20 curl -sf "$API/healthz" >/dev/null || fatal "the API did not start"

# req <method> <path> <expected status> [json body]: prints the response body.
req() {
  local method=$1 path=$2 want=$3 body=${4:-} status
  local args=(-s -o "$WORK/body" -w '%{http_code}' -X "$method" -H "x-api-key: $KEY" -H 'content-type: application/json')
  [[ -n "$body" ]] && args+=(-d "$body")
  status=$(curl "${args[@]}" "$API$path")
  if [[ "$status" != "$want" ]]; then
    echo "$method $path -> $status (expected $want): $(cat "$WORK/body")" >&2
    fatal "unexpected status"
  fi
  cat "$WORK/body"
}
expect() { [[ "$1" == "$2" ]] || fatal "expected '$2', got '$1'"; ok "$3 = $1"; }

batch() { jq -nc --arg id "$1" '{batchId: $id, gtin: "07791234567890", product: "Vacuna antigripal", lot: "L-E2E", expiryDate: "2027-12-31"}'; }
simulate() { python3 "$REPO/iot/simulator/simulator.py" "$@"; }

E1="E2E-$RUN-1" E2="E2E-$RUN-2" E3="E2E-$RUN-3"
CA="CARGA-$RUN-A" CB="CARGA-$RUN-B"

step() { echo; info "$*"; }

step "1. The regulator authorizes the API's IoT gateway identity (DistMSP User2)"
req POST /api/iot/gateway/authorize 200 | jq -c .

step "2. Lab registers three batches"
for b in "$E1" "$E2" "$E3"; do req POST /api/batches 200 "$(batch "$b")" | jq -c '{id, owner, state}'; done

step "3. Private price Lab -> Dist: Dist reads it, Farma cannot, anyone can verify it"
req PUT "/api/batches/$E1/terms" 200 '{"buyer":"DistMSP","unitPrice":"8450.00","currency":"ARS","quantity":500}' | jq -c .
expect "$(req GET "/api/batches/$E1/terms?leg=manufacturer&as=DistMSP" 200 | jq -r .unitPrice)" 8450.00 "price read by Dist"
req GET "/api/batches/$E1/terms?leg=manufacturer&as=FarmaMSP" 403 >/dev/null && ok "Farma gets 403"
TERMS='{"leg":"manufacturer","seller":"LabMSP","buyer":"DistMSP","unitPrice":"8450.00","currency":"ARS","quantity":500}'
expect "$(req POST "/api/batches/$E1/terms/verify" 200 "$TERMS" | jq -r .matches)" true "real price verifies"
expect "$(req POST "/api/batches/$E1/terms/verify" 200 "$(echo "$TERMS" | jq -c '.unitPrice = "1.00"')" | jq -r .matches)" false "fake price verifies"

step "4. Cargo A ($E1 + $E2) with valija A under a 2-8 C policy"
req POST /api/cargo 200 "$(jq -nc --arg c "$CA" --arg a "$E1" --arg b "$E2" '{cargoId: $c, batchIds: [$a, $b]}')" | jq -c '{id, state, batchIds}'
req POST "/api/batches/$E1/dispatch" 409 '{"to":"DistMSP"}' | jq -c . # it moves with the cargo
PUB_A=$(simulate keygen --key "$WORK/a.pem" | sed -n 's/.*: \(0x[0-9a-f]*\)$/\1/p')
EXPIRY=$((RUN + 31536000))
req POST /api/iot/devices 200 "$(jq -nc --arg d "VAL-$RUN-A" --arg k "$PUB_A" --argjson e $EXPIRY '{deviceId: $d, pubKey: $k, calibrationExpiry: $e}')" | jq -c '{id, org, active}'
req POST /api/iot/policies 200 "{\"policyId\":\"2-8C-$RUN\",\"minTemp\":200,\"maxTemp\":800,\"maxExcursionSeconds\":1800}" >/dev/null
req POST /api/iot/monitoring/start 200 "{\"cargoId\":\"$CA\",\"deviceId\":\"VAL-$RUN-A\",\"policyId\":\"2-8C-$RUN\"}" | jq -c '{cargoId, verdict}'

step "5. Valija A uploads 10 signed readings; the gateway anchors them and proves one on the ledger"
simulate run --key "$WORK/a.pem" --device-id "VAL-$RUN-A" --scenario normal --count 10 --interval 60 --gateway "$API"
req POST "/api/iot/cargo/$CA/anchor" 200 | jq -c .
expect "$(req GET "/api/iot/cargo/$CA" 200 | jq -r .anchoredReadings)" 10 "anchored readings"
SEQ=$(req GET "/api/iot/cargo/$CA" 200 | jq -r .lastReading.seq)
expect "$(req GET "/api/iot/cargo/$CA/proof/$SEQ?verify=true" 200 | jq -r .verifiedOnLedger)" true "Merkle proof checked by the chaincode"

step "6. Cargo A travels Lab -> Dist; Dist closes the monitoring"
req POST "/api/cargo/$CA/dispatch" 200 '{"to":"DistMSP"}' | jq -c '{state, pendingTo}'
req POST "/api/cargo/$CA/receive" 200 | jq -c '{state, owner}'
expect "$(req POST /api/iot/monitoring/close 200 "{\"cargoId\":\"$CA\"}" | jq -r .verdict)" COMPLIANT "verdict of cargo A"
expect "$(req GET "/api/batches/$E1" 200 | jq -r '.owner + " " + .state')" "DistMSP IN_DISTRIBUTION" "$E1"

step "7. Cargo B ($E3) with a strict policy: a temperature excursion compromises it"
req POST /api/cargo 200 "$(jq -nc --arg c "$CB" --arg a "$E3" '{cargoId: $c, batchIds: [$a]}')" >/dev/null
PUB_B=$(simulate keygen --key "$WORK/b.pem" | sed -n 's/.*: \(0x[0-9a-f]*\)$/\1/p')
req POST /api/iot/devices 200 "$(jq -nc --arg d "VAL-$RUN-B" --arg k "$PUB_B" --argjson e $EXPIRY '{deviceId: $d, pubKey: $k, calibrationExpiry: $e}')" >/dev/null
req POST /api/iot/policies 200 "{\"policyId\":\"STRICT-$RUN\",\"minTemp\":200,\"maxTemp\":800,\"maxExcursionSeconds\":60}" >/dev/null
req POST /api/iot/monitoring/start 200 "{\"cargoId\":\"$CB\",\"deviceId\":\"VAL-$RUN-B\",\"policyId\":\"STRICT-$RUN\"}" >/dev/null
simulate run --key "$WORK/b.pem" --device-id "VAL-$RUN-B" --scenario excursion --count 12 --interval 60 --gateway "$API"
CLOSE=$(req POST /api/iot/monitoring/close 200 "{\"cargoId\":\"$CB\"}")
echo "$CLOSE" | jq -c .
expect "$(echo "$CLOSE" | jq -r .verdict)" COMPROMISED "verdict of cargo B"

step "8. $E1 goes Dist -> Farma on its own and is dispensed; $E2 is recalled at Dist"
req POST "/api/batches/$E1/dispatch" 200 '{"to":"FarmaMSP"}' >/dev/null
req POST "/api/batches/$E1/receive" 200 >/dev/null
expect "$(req POST "/api/batches/$E1/dispense" 200 '{"patientRef":"receta-0001"}' | jq -r .state)" DISPENSED "$E1"
expect "$(req GET "/api/batches/$E1" 200 | jq -r .patientRef)" "$(printf 'receta-0001' | sha256sum | cut -d' ' -f1)" "patientRef on the ledger (a hash)"
expect "$(req POST "/api/batches/$E2/recall" 200 '{"reason":"Desvío de calidad"}' | jq -r .state)" RECALLED "$E2"
req GET "/api/batches/$E1/history" 200 | jq -r '.[] | "  \(.timestamp)  \(.batch.owner)  \(.batch.state)  \(.batch.cargo)"'

step "9. Errors map to HTTP statuses"
req POST "/api/batches/$E2/recall" 409 '{"reason":"otra vez"}' | jq -c .
req GET /api/batches/NO-EXISTE 404 | jq -c .
req POST "/api/batches/$E3/dispense" 409 '{"patientRef":"x"}' | jq -c . # still at the lab
curl -s -o /dev/null -w '%{http_code}' -X POST "$API/api/batches/$E3/receive" | grep -q 401 && ok "no API key -> 401"

echo
ok "API end-to-end test passed"
