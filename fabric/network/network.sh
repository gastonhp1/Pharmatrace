#!/usr/bin/env bash
# PharmaTrace local Fabric network.
#
#   ./network.sh prereq    download the Fabric CLI binaries (peer, osnadmin, configtxgen, cryptogen)
#   ./network.sh up        generate the identities and start orderers and peers
#   ./network.sh channel   create the "pharmatrace" channel and join everyone to it
#   ./network.sh deploy    build, install, approve and commit the chaincode; register the orgs
#   ./network.sh smoke     run the end-to-end scenario with the peer CLI (scripts/smoke.sh)
#   ./network.sh api       start the REST API and run the scenario over HTTP (scripts/api-e2e.sh)
#   ./network.sh all       up + channel + deploy + smoke
#   ./network.sh down      stop everything and delete the generated material
#
# Needs bash 4+, Docker with Compose v2, curl and jq. On Windows, run it inside WSL2.
set -euo pipefail
cd "$(dirname "$0")"
# shellcheck source=scripts/env.sh
source scripts/env.sh

FABRIC_VERSION="${FABRIC_VERSION:-3.1.5}"
export FABRIC_VERSION
COMPOSE=(docker compose -f compose.yaml)

prereq() {
  if [[ -x bin/peer && -f config/core.yaml ]] && bin/peer version | grep -q "Version: v\?$FABRIC_VERSION"; then
    ok "Fabric $FABRIC_VERSION binaries already in bin/"
    return
  fi
  local os arch
  os=$(uname -s | tr '[:upper:]' '[:lower:]')
  arch=$(uname -m)
  case "$arch" in x86_64) arch=amd64 ;; aarch64 | arm64) arch=arm64 ;; esac
  local url="https://github.com/hyperledger/fabric/releases/download/v$FABRIC_VERSION/hyperledger-fabric-$os-$arch-$FABRIC_VERSION.tar.gz"
  info "Downloading $url"
  rm -rf bin config
  curl -fsSL --retry 3 "$url" | tar xz bin config
  ok "$(bin/peer version | head -2 | tail -1)"
}

up() {
  command -v peer >/dev/null || fatal "the Fabric binaries are missing: run ./network.sh prereq"
  if [[ ! -d organizations ]]; then
    info "Generating identities with cryptogen"
    cryptogen generate --config=crypto-config.yaml --output=organizations
  fi
  info "Starting orderers and peers (Fabric $FABRIC_VERSION)"
  "${COMPOSE[@]}" up -d
  "${COMPOSE[@]}" ps
}

channel() {
  mkdir -p channel-artifacts
  info "Creating the genesis block of channel $CHANNEL"
  FABRIC_CFG_PATH="$NETWORK_DIR" configtxgen -profile PharmaTraceChannel \
    -outputBlock "channel-artifacts/$CHANNEL.block" -channelID "$CHANNEL"

  # Fabric 2.3+ has no system channel: each orderer joins the channel through its admin API.
  local i port tls
  for i in 0 1 2; do
    port=$((7053 + i * 1000))
    tls="$ORGS_DIR/ordererOrganizations/$ORDERER_DOMAIN/orderers/orderer$i.$ORDERER_DOMAIN/tls"
    info "orderer$i joins $CHANNEL"
    retry 10 osnadmin channel join --channelID "$CHANNEL" --config-block "channel-artifacts/$CHANNEL.block" \
      -o "localhost:$port" --ca-file "$ORDERER_CA" --client-cert "$tls/server.crt" --client-key "$tls/server.key" \
      || fatal "orderer$i could not join the channel"
  done

  local org
  for org in "${ALL_ORGS[@]}"; do
    info "peer0.$org joins $CHANNEL"
    use_org "$org" Admin
    retry 10 peer channel join -b "channel-artifacts/$CHANNEL.block" || fatal "peer0.$org could not join"
  done
  ok "channel $CHANNEL ready with ${#ALL_ORGS[@]} orgs and 3 Raft orderers"
}

package_chaincode() {
  # A chaincode-as-a-service package holds no code, only where to find the running chaincode.
  # {{.peername}} is filled in by each peer from CHAINCODE_AS_A_SERVICE_BUILDER_CONFIG.
  local tmp
  tmp=$(mktemp -d)
  mkdir -p "$tmp/src" "$tmp/pkg"
  cat >"$tmp/src/connection.json" <<EOF
{ "address": "{{.peername}}_${CC_NAME}:9999", "dial_timeout": "10s", "tls_required": false }
EOF
  cat >"$tmp/pkg/metadata.json" <<EOF
{ "type": "ccaas", "label": "${CC_NAME}_${CC_VERSION}" }
EOF
  tar -C "$tmp/src" -czf "$tmp/pkg/code.tar.gz" .
  tar -C "$tmp/pkg" -czf "channel-artifacts/$CC_NAME.tar.gz" metadata.json code.tar.gz
  rm -rf "$tmp"
}

next_sequence() {
  local current
  current=$(peer lifecycle chaincode querycommitted -C "$CHANNEL" -n "$CC_NAME" 2>/dev/null |
    sed -n 's/.*Sequence: \([0-9]*\).*/\1/p' | head -1 || true)
  echo $((${current:-0} + 1))
}

deploy() {
  mkdir -p channel-artifacts
  info "Building the chaincode image pharmatrace-chaincode:$CC_VERSION"
  docker build -q -t "pharmatrace-chaincode:$CC_VERSION" ../chaincode/pharmatrace

  package_chaincode
  local pkg_id org seq
  pkg_id=$(peer lifecycle chaincode calculatepackageid "channel-artifacts/$CC_NAME.tar.gz")
  info "Package ID $pkg_id"

  for org in "${ALL_ORGS[@]}"; do
    use_org "$org" Admin
    if peer lifecycle chaincode queryinstalled 2>/dev/null | grep -q "$pkg_id"; then
      ok "already installed on peer0.$org"
    else
      info "Installing on peer0.$org"
      peer lifecycle chaincode install "channel-artifacts/$CC_NAME.tar.gz"
    fi
  done

  # Each org runs its own chaincode container, identified by the package ID.
  info "Starting the chaincode containers"
  CHAINCODE_ID="$pkg_id" CHAINCODE_VERSION="$CC_VERSION" "${COMPOSE[@]}" --profile chaincode up -d \
    peer0lab_pharmatrace peer0dist_pharmatrace peer0farma_pharmatrace peer0reg_pharmatrace

  use_org reg Admin
  seq=$(next_sequence)
  local definition=(--channelID "$CHANNEL" --name "$CC_NAME" --version "$CC_VERSION" --sequence "$seq"
    --signature-policy "$CC_POLICY" --collections-config collections_config.json)

  # Every org approves the same definition for itself...
  for org in "${ALL_ORGS[@]}"; do
    use_org "$org" Admin
    info "${MSP[$org]} approves $CC_NAME v$CC_VERSION (sequence $seq)"
    # shellcheck disable=SC2046
    peer lifecycle chaincode approveformyorg $(orderer_args) "${definition[@]}" --package-id "$pkg_id"
  done
  peer lifecycle chaincode checkcommitreadiness "${definition[@]}" --output json

  # ...and once a majority approved (LifecycleEndorsement), anyone can commit it.
  info "Committing the definition"
  # shellcheck disable=SC2046
  peer lifecycle chaincode commit $(orderer_args) "${definition[@]}" $(peer_args "${ALL_ORGS[@]}")
  peer lifecycle chaincode querycommitted -C "$CHANNEL" -n "$CC_NAME"

  register_orgs
  ok "chaincode $CC_NAME v$CC_VERSION deployed"
}

# The regulator gives each org its role. Writes to plain keys follow the chaincode policy:
# the regulator's peer plus one more.
register_orgs() {
  use_org reg User1
  local org role
  declare -A roles=([lab]=manufacturer [dist]=distributor [farma]=pharmacy)
  for org in lab dist farma; do
    role=${roles[$org]}
    info "RegisterOrg ${MSP[$org]} as $role"
    # shellcheck disable=SC2046
    retry 10 peer chaincode invoke $(orderer_args) -C "$CHANNEL" -n "$CC_NAME" $(peer_args reg lab) --waitForEvent \
      -c "{\"function\":\"RegisterOrg\",\"Args\":[\"${MSP[$org]}\",\"$role\"]}" \
      || fatal "could not register ${MSP[$org]}"
  done
}

down() {
  info "Stopping the network and deleting volumes and generated material"
  "${COMPOSE[@]}" --profile chaincode down -v --remove-orphans || true
  rm -rf organizations channel-artifacts
}

case "${1:-}" in
  prereq) prereq ;;
  up) up ;;
  channel) channel ;;
  deploy) deploy ;;
  smoke) bash scripts/smoke.sh ;;
  api) bash scripts/api-e2e.sh ;;
  all) up && channel && deploy && bash scripts/smoke.sh ;;
  down) down ;;
  *) sed -n '2,13p' network.sh | sed 's/^# \{0,1\}//'; exit 1 ;;
esac
