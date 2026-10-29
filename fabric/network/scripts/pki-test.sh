#!/usr/bin/env bash
# Runs the PKI runbook (scripts/pki.sh) against the running network and checks that the network
# keeps working after each operation. It revokes Dist's IoT gateway, so run it last.
set -euo pipefail
# shellcheck source=scripts/env.sh
source "$(dirname "$0")/env.sh"
cd "$NETWORK_DIR"

RUN=$(date +%s)
pki() { bash scripts/pki.sh "$@"; }
call() { jq -nc --arg f "$1" '{function: $f, Args: $ARGS.positional}' --args "${@:2}"; }
step() { echo; info "$*"; }
expect() { [[ "$1" == "$2" ]] || fatal "expected '$2', got '$1'"; ok "$3 = $1"; }

# invoke <org> <user> "<endorsing orgs>" <json>
invoke() {
  use_org "$1" "$2"
  # shellcheck disable=SC2046,SC2086
  peer chaincode invoke $(orderer_args) -C "$CHANNEL" -n "$CC_NAME" $(peer_args $3) --waitForEvent -c "$4" 2>&1
}
query() {
  use_org "$1" "$2"
  peer chaincode query -C "$CHANNEL" -n "$CC_NAME" -c "$3" 2>&1
}
register_batch() { call RegisterBatch "$1" 07791234567890 "Insulina NPH 100 UI/ml" L-PKI 2028-01-31; }

step "1. Certificate status (soonest expiry first)"
# (to a file first: head closing the pipe early would kill `pki status` with SIGPIPE under pipefail)
pki status >"/tmp/pki-status-$RUN.txt"
head -12 "/tmp/pki-status-$RUN.txt"

step "2. Renew peer0.dist: new keys and certificates, restart, and it still endorses"
OLD_SERIAL=$(openssl x509 -in "$ORGS_DIR/peerOrganizations/dist.pharmatrace.ar/peers/peer0.dist.pharmatrace.ar/msp/signcerts/cert.pem" -noout -serial)
pki renew-peer dist
NEW_SERIAL=$(openssl x509 -in "$ORGS_DIR/peerOrganizations/dist.pharmatrace.ar/peers/peer0.dist.pharmatrace.ar/msp/signcerts/cert.pem" -noout -serial)
[[ "$OLD_SERIAL" != "$NEW_SERIAL" ]] || fatal "the peer certificate did not change"
retry 10 invoke dist User1 "dist reg" "$(call RegisterDevice "valija-pki-$RUN" "$(head -c 64 /dev/urandom | od -An -tx1 | tr -d ' \n')" $((RUN + 86400)))" >/dev/null ||
  fatal "peer0.dist does not endorse after the renewal"
ok "a transaction endorsed by the renewed peer0.dist committed"

step "3. Rotate orderer1's TLS certificate (channel config update of the Raft consenters)"
pki rotate-orderer-tls 1
# With orderer0 down, ordering needs orderer1 and orderer2: it only works if orderer2 accepts
# orderer1's new certificate.
docker stop orderer0.orderer.pharmatrace.ar >/dev/null
export ORDERER_ADDR=localhost:8050 ORDERER_HOST=orderer1.orderer.pharmatrace.ar
retry 10 invoke lab User1 "lab reg" "$(register_batch "PKI-$RUN-1")" >/dev/null ||
  fatal "no quorum with orderer0 down: orderer1's new certificate is not working"
ok "committed by orderer1 + orderer2, with orderer1 on its new certificate"
docker start orderer0.orderer.pharmatrace.ar >/dev/null
export ORDERER_ADDR=localhost:7050 ORDERER_HOST=orderer0.orderer.pharmatrace.ar

step "4. A second IoT gateway is only a CA operation: no transaction"
pki register-gateway dist IotGateway2
expect "$(query dist IotGateway2 "$(call IsAttestor)")" true "IotGateway2 is an attestor"
expect "$(query dist User1 "$(call IsAttestor)")" false "User1 (no role in its certificate) is an attestor"

step "5. Revoke the first gateway: CA + CRL in the channel"
expect "$(query dist IotGateway "$(call IsAttestor)")" true "IotGateway before the revocation"
pki revoke dist IotGateway
# The peers apply the new CRL when they commit the config block.
for _ in $(seq 1 10); do
  out=$(query dist IotGateway "$(call IsAttestor)" || true)
  [[ "$out" != "true" ]] && break
  sleep 2
done
echo "$out" | tail -1
[[ "$out" != "true" ]] || fatal "the revoked certificate is still accepted"
ok "the revoked IotGateway is rejected by the peer"
expect "$(query dist IotGateway2 "$(call IsAttestor)")" true "IotGateway2 after the revocation"

echo
ok "PKI runbook test passed"
