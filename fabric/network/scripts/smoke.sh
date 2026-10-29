#!/usr/bin/env bash
# End-to-end scenario against the running network. Each step says who acts and whose peers
# endorse, because that is the interesting part: the same call can be valid or rejected
# depending on which orgs signed it.
set -euo pipefail
# shellcheck source=scripts/env.sh
source "$(dirname "$0")/env.sh"
cd "$NETWORK_DIR"

RUN=$(date +%s) # unique IDs, so the scenario can run more than once on the same network
B1="LOTE-$RUN-1"
B2="LOTE-$RUN-2"
POLICY="2-8C-$RUN"
CARGO="CARGA-$RUN"
DEVICE="valija-$RUN"

# invoke <org> <user> "<endorsing orgs>" <json> [transient json]
invoke() {
  local org=$1 user=$2 endorsers=$3 json=$4 transient=${5:-} extra=()
  use_org "$org" "$user"
  [[ -n "$transient" ]] && extra=(--transient "$transient")
  # shellcheck disable=SC2046,SC2086
  peer chaincode invoke $(orderer_args) -C "$CHANNEL" -n "$CC_NAME" $(peer_args $endorsers) \
    --waitForEvent -c "$json" "${extra[@]}" 2>&1
}

# query <org> <user> <json> [transient json]: runs on the org's own peer, nothing is ordered.
query() {
  local org=$1 user=$2 json=$3 transient=${4:-} extra=()
  use_org "$org" "$user"
  [[ -n "$transient" ]] && extra=(--transient "$transient")
  peer chaincode query -C "$CHANNEL" -n "$CC_NAME" -c "$json" "${extra[@]}"
}

call() { jq -nc --arg f "$1" '{function: $f, Args: $ARGS.positional}' --args "${@:2}"; }
b64() { printf '%s' "$1" | base64 | tr -d '\n'; }

step() { echo; info "$*"; }
must() {
  local out
  out=$("$@") || { echo "$out"; fatal "step failed"; }
  echo "$out" | grep -o 'status:[0-9]*' | head -1 || true
}
must_fail() {
  local want=$1 out
  shift
  if out=$("$@"); then
    echo "$out"
    fatal "expected a failure containing '$want'"
  fi
  echo "$out" | grep -q "$want" || { echo "$out"; fatal "failed, but not with '$want'"; }
  ok "rejected as expected ($want)"
}
expect() { [[ "$1" == "$2" ]] || fatal "expected '$2', got '$1'"; ok "$3 = $1"; }

TERMS=$(jq -nc --arg b "$B1" '{batchId: $b, seller: "LabMSP", buyer: "DistMSP", unitPrice: "15230.50", currency: "ARS", quantity: 1200}')
TERMS_T="{\"terms\":\"$(b64 "$TERMS")\"}"

step "1. Lab registers $B1 (endorsed by Lab + Reg)"
must invoke lab User1 "lab reg" "$(call RegisterBatch "$B1" 07791234567890 "Insulina NPH 100 UI/ml" L2026-10 2028-03-31)"

step "2. Lab stores the price for Dist in a private collection (endorsed by Lab + Dist, the only members)"
must invoke lab User1 "lab dist" "$(call SetCommercialTerms "$B1")" "$TERMS_T"

step "3. Lab dispatches $B1 to Dist (the batch now needs Dist + Reg to change)"
must invoke lab User1 "lab reg" "$(call DispatchBatch "$B1" DistMSP)"

step "4. Dist tries to receive it with Lab's peer instead of its own: state-based endorsement says no"
must_fail ENDORSEMENT_POLICY_FAILURE invoke dist User1 "lab reg" "$(call ReceiveBatch "$B1")"

step "5. Dist receives it with its own peer"
must invoke dist User1 "dist reg" "$(call ReceiveBatch "$B1")"
expect "$(query reg User1 "$(call ReadBatch "$B1")" | jq -r .state)" IN_DISTRIBUTION "state"

step "6. Private data: Dist reads the price, the pharmacy cannot, the regulator verifies it by hash"
expect "$(query dist User1 "$(call ReadCommercialTerms "$B1" manufacturer)" | jq -r .unitPrice)" 15230.50 "price seen by Dist"
must_fail "" query farma User1 "$(call ReadCommercialTerms "$B1" manufacturer)"
expect "$(query reg User1 "$(call VerifyCommercialTerms "$B1" manufacturer)" "$TERMS_T")" true "regulator verification"
FAKE_T="{\"terms\":\"$(b64 "$(echo "$TERMS" | jq -c '.unitPrice = "9999.00"')")\"}"
expect "$(query reg User1 "$(call VerifyCommercialTerms "$B1" manufacturer)" "$FAKE_T")" false "verification of a fake price"

step "7. Cold chain: Dist packs $B1 in a cargo with its valija; the regulator authorizes Dist's IoT gateway (User2)"
must invoke reg User1 "reg lab" "$(call SetColdChainPolicy "$POLICY" 200 800 1800)"
GATEWAY_ID=$(query dist User2 "$(call WhoAmI)" | jq -r .clientId)
must invoke reg User1 "reg lab" "$(call RegisterAttestor DistMSP "$GATEWAY_ID")"
PUBKEY=$(head -c 64 /dev/urandom | od -An -tx1 | tr -d ' \n')
must invoke dist User1 "dist reg" "$(call RegisterDevice "$DEVICE" "$PUBKEY" $(($(date +%s) + 31536000)))"
must invoke dist User1 "dist reg" "$(jq -nc --arg c "$CARGO" --arg b "$B1" '{function: "CreateCargo", Args: [$c, ([$b] | tojson)]}')"
must invoke dist User2 "dist reg" "$(call StartMonitoring "$CARGO" "$DEVICE" "$POLICY")"
NOW=$(date +%s)
WINDOW=$(jq -nc --argjson f $((NOW - 600)) --argjson t $((NOW - 60)) \
  '{root: "7d1f0b7c4a3e2d1c0b9a8f7e6d5c4b3a2918f7e6d5c4b3a291807f6e5d4c3b2a", count: 10, from: $f, to: $t, minTemp: 380, maxTemp: 520, excursionSeconds: 0}')
must invoke dist User2 "dist reg" "$(call AnchorWindow "$CARGO" "$WINDOW")"
must_fail "authorized IoT gateway" invoke dist User1 "dist reg" "$(call AnchorWindow "$CARGO" "$WINDOW")"
expect "$(query reg User1 "$(call VerifyReading "$CARGO" 0 7d1f0b7c4a3e2d1c0b9a8f7e6d5c4b3a2918f7e6d5c4b3a291807f6e5d4c3b2a '[]')")" true "one-leaf proof"

step "8. The cargo goes Dist -> Farma; Farma opens the valija, closes the monitoring and dispenses"
must invoke dist User1 "dist reg" "$(call DispatchCargo "$CARGO" FarmaMSP)"
must invoke farma User1 "farma reg" "$(call ReceiveCargo "$CARGO")"
must invoke farma User1 "farma reg" "$(call CloseMonitoring "$CARGO")"
expect "$(query reg User1 "$(call GetMonitoring "$CARGO")" | jq -r .verdict)" COMPLIANT "cold-chain verdict"
expect "$(query reg User1 "$(call GetDevice "$DEVICE")" | jq -r .activeCargo)" "" "valija free again"
PATIENT=$(printf 'receta-%s' "$RUN" | sha256sum | cut -d' ' -f1)
must invoke farma User1 "farma reg" "$(call DispenseBatch "$B1" "$PATIENT")"

step "9. Custody history from the ledger (GetHistoryForKey)"
query reg User1 "$(call GetBatchHistory "$B1")" | jq -r '.[] | "  \(.timestamp)  \(.batch.owner)  \(.batch.state)  \(.batch.cargo)"'
expect "$(query reg User1 "$(call GetBatchHistory "$B1")" | jq length)" 7 "versions of $B1"

step "10. Recall: only the regulator, and the holder's peer co-signs"
must invoke lab User1 "lab reg" "$(call RegisterBatch "$B2" 07791234567890 "Insulina NPH 100 UI/ml" L2026-11 2028-04-30)"
must_fail "only the regulator" invoke lab User1 "lab reg" "$(call RecallBatch "$B2" "test")"
must invoke reg User1 "lab reg" "$(call RecallBatch "$B2" "Desvío de calidad informado por el laboratorio")"
expect "$(query lab User1 "$(call ReadBatch "$B2")" | jq -r .state)" RECALLED "state of $B2"

step "11. Raft: with one orderer down, the channel keeps ordering (2 of 3 is a quorum)"
docker stop orderer1.orderer.pharmatrace.ar >/dev/null
must retry 5 invoke lab User1 "lab reg" "$(call RegisterBatch "$B2-raft" 07791234567890 "Insulina" L1 2028-01-31)"
docker start orderer1.orderer.pharmatrace.ar >/dev/null
ok "transaction committed with orderer1 stopped"

echo
ok "smoke test passed"
