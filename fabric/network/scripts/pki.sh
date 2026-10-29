#!/usr/bin/env bash
# PKI of the PharmaTrace network: one Fabric CA per organization. Also the runbook, as commands.
#
#   pki.sh bootstrap                       register and enroll every identity (./network.sh up runs it)
#   pki.sh status                          every certificate with its expiry, soonest first
#   pki.sh renew-peer <org>                new enrollment and TLS certificates (and keys) for peer0 of <org>
#   pki.sh rotate-orderer-tls <0|1|2>      new TLS certificate for an orderer, updated in the Raft consenter set
#   pki.sh register-gateway <org> <Name>   a new IoT gateway: a certificate with pharmatrace.role=iot-gateway
#   pki.sh revoke <org> <Name>             revoke users/<Name>@<org> in its CA and publish the CRL in the channel
#
# The why of each step is in fabric/docs/PKI.md.
set -euo pipefail
# shellcheck source=scripts/env.sh
source "$(dirname "$0")/env.sh"
cd "$NETWORK_DIR"
command -v fabric-ca-client >/dev/null || fatal "fabric-ca-client is missing: run ./network.sh prereq"

WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT
STAMP=$(date +%Y%m%d-%H%M%S)

# ---------------------------------------------------------------- layout

# org -> its domain and its folder (the same layout cryptogen used, so nothing else changes)
org_domain() {
  if [[ $1 == orderer ]]; then echo "$ORDERER_DOMAIN"; else domain "$1"; fi
}
org_dir() {
  if [[ $1 == orderer ]]; then echo "$ORGS_DIR/ordererOrganizations/$ORDERER_DOMAIN"; else echo "$ORGS_DIR/peerOrganizations/$(domain "$1")"; fi
}
ca_cert() { echo "$CA_DIR/$1/ca-cert.pem"; }
ca_container() { echo "ca.$(org_domain "$1")"; }

# Runs fabric-ca-client as the CA's bootstrap admin (register, revoke, identity modify...).
ca_admin() {
  local org=$1
  shift
  FABRIC_CA_CLIENT_HOME="$CA_DIR/$org/admin" fabric-ca-client "$@" \
    -u "https://localhost:${CA_PORT[$org]}" --caname "ca-$org" --tls.certfiles "$(ca_cert "$org")"
}

# NodeOUs: the OU that Fabric CA writes from the identity type (peer, client, admin, orderer) is
# what lets policies say 'LabMSP.peer' or 'RegMSP.admin'.
write_nodeous() {
  local msp=$1 cert
  cert=$(basename "$(find "$msp/cacerts" -type f | head -1)")
  cat >"$msp/config.yaml" <<EOF
NodeOUs:
  Enable: true
  ClientOUIdentifier: { Certificate: cacerts/$cert, OrganizationalUnitIdentifier: client }
  PeerOUIdentifier: { Certificate: cacerts/$cert, OrganizationalUnitIdentifier: peer }
  AdminOUIdentifier: { Certificate: cacerts/$cert, OrganizationalUnitIdentifier: admin }
  OrdererOUIdentifier: { Certificate: cacerts/$cert, OrganizationalUnitIdentifier: orderer }
EOF
}

# A one-time enrollment secret: random, never stored. Re-enrollments get a new one from the CA admin.
new_secret() { openssl rand -hex 16; }

# register <org> <id> <type> [attrs]: prints the enrollment secret
register() {
  local org=$1 id=$2 type=$3 attrs=${4:-} secret extra=()
  secret=$(new_secret)
  [[ -n "$attrs" ]] && extra=(--id.attrs "$attrs")
  ca_admin "$org" register --id.name "$id" --id.secret "$secret" --id.type "$type" "${extra[@]}" >/dev/null
  echo "$secret"
}

# enroll <org> <id> <secret> <msp dir>: an identity (signing certificate + key)
enroll() {
  local org=$1 id=$2 secret=$3 dir=$4
  FABRIC_CA_CLIENT_HOME="$WORK" fabric-ca-client enroll -u "https://$id:$secret@localhost:${CA_PORT[$org]}" \
    --caname "ca-$org" --tls.certfiles "$(ca_cert "$org")" -M "$dir" 2>"$WORK/enroll.log" ||
    { cat "$WORK/enroll.log" >&2; fatal "could not enroll $id in ca-$org"; }
  write_nodeous "$dir"
}

# enroll_tls <org> <id> <secret> <tls dir> <hosts>: a TLS server certificate for those hostnames,
# copied to the file names the peer and orderer configs point at.
enroll_tls() {
  local org=$1 id=$2 secret=$3 dir=$4 hosts=$5
  FABRIC_CA_CLIENT_HOME="$WORK" fabric-ca-client enroll -u "https://$id:$secret@localhost:${CA_PORT[$org]}" \
    --caname "ca-$org" --tls.certfiles "$(ca_cert "$org")" -M "$dir" \
    --enrollment.profile tls --csr.hosts "$hosts" 2>"$WORK/enroll.log" ||
    { cat "$WORK/enroll.log" >&2; fatal "could not enroll the TLS certificate of $id in ca-$org"; }
  cp "$dir"/tlscacerts/* "$dir/ca.crt"
  cp "$dir"/signcerts/* "$dir/server.crt"
  cp "$dir"/keystore/* "$dir/server.key"
}

# Keeps a copy of a folder before replacing its certificates, and empties its keystore so the new
# key is the only one.
backup_and_clear() {
  local dir=$1 dest
  dest="$ORGS_DIR/backup/$STAMP/${dir#"$ORGS_DIR"/}"
  mkdir -p "$(dirname "$dest")"
  cp -r "$dir" "$dest"
  rm -f "$dir"/keystore/* "$dir"/signcerts/*
  info "backup of the old certificates in ${dest#"$NETWORK_DIR"/}"
}

# ---------------------------------------------------------------- bootstrap

wait_for_ca() {
  local org=$1
  mkdir -p "$CA_DIR/$org"
  # The CA creates its root certificate on first start, inside its volume: copy it out.
  retry 20 docker cp "$(ca_container "$org"):/etc/hyperledger/fabric-ca-server/ca-cert.pem" "$(ca_cert "$org")" 2>/dev/null ||
    fatal "ca-$org did not create its certificate"
  retry 20 fabric-ca-client getcainfo -u "https://localhost:${CA_PORT[$org]}" --caname "ca-$org" \
    --tls.certfiles "$(ca_cert "$org")" -H "$WORK/getcainfo" >/dev/null 2>&1 || fatal "ca-$org is not answering"
}

bootstrap_org() {
  local org=$1 dir d
  dir=$(org_dir "$org")
  d=$(org_domain "$org")
  info "ca-$org: CA admin, org MSP and identities"
  wait_for_ca "$org"
  FABRIC_CA_CLIENT_HOME="$CA_DIR/$org/admin" fabric-ca-client enroll \
    -u "https://admin:$CA_ADMIN_SECRET@localhost:${CA_PORT[$org]}" --caname "ca-$org" --tls.certfiles "$(ca_cert "$org")" 2>"$WORK/enroll.log" ||
    { cat "$WORK/enroll.log" >&2; fatal "could not enroll the admin of ca-$org"; }

  # The org's MSP in the channel: only public certificates (its root CA, also its TLS root).
  mkdir -p "$dir/msp/cacerts" "$dir/msp/tlscacerts" "$dir/tlsca" "$dir/ca"
  cp "$(ca_cert "$org")" "$dir/msp/cacerts/ca.crt"
  cp "$(ca_cert "$org")" "$dir/msp/tlscacerts/ca.crt"
  cp "$(ca_cert "$org")" "$dir/tlsca/tlsca.$d-cert.pem"
  cp "$(ca_cert "$org")" "$dir/ca/ca.$d-cert.pem"
  write_nodeous "$dir/msp"

  local secret node hosts
  if [[ $org == orderer ]]; then
    for i in 0 1 2; do
      node="orderer$i.$d"
      secret=$(register "$org" "orderer$i" orderer)
      enroll "$org" "orderer$i" "$secret" "$dir/orderers/$node/msp"
      enroll_tls "$org" "orderer$i" "$secret" "$dir/orderers/$node/tls" "$node,localhost,127.0.0.1"
    done
  else
    node="peer0.$d"
    hosts="$node,localhost,127.0.0.1"
    secret=$(register "$org" peer0 peer)
    enroll "$org" peer0 "$secret" "$dir/peers/$node/msp"
    enroll_tls "$org" peer0 "$secret" "$dir/peers/$node/tls" "$hosts"
    enroll "$org" user1 "$(register "$org" user1 client)" "$dir/users/User1@$d/msp"
  fi
  enroll "$org" orgadmin "$(register "$org" orgadmin admin)" "$dir/users/Admin@$d/msp"

  # The droguería carries the valijas: its IoT gateway gets the role in its certificate.
  if [[ $org == dist ]]; then
    enroll "$org" iotgateway "$(register "$org" iotgateway client "$ATTR_GATEWAY")" "$dir/users/IotGateway@$d/msp"
  fi
}

ATTR_GATEWAY='pharmatrace.role=iot-gateway:ecert'

cmd_bootstrap() {
  [[ -n "${CA_ADMIN_SECRET:-}" ]] || fatal "CA_ADMIN_SECRET is not set (./network.sh up generates it)"
  local org
  for org in orderer "${ALL_ORGS[@]}"; do bootstrap_org "$org"; done
  ok "identities issued by 5 Fabric CAs"
}

# ---------------------------------------------------------------- status

cmd_status() {
  local now f end days cn
  now=$(date +%s)
  printf '%-6s %-12s %-22s %s\n' DAYS EXPIRES CN FILE
  while IFS= read -r f; do
    end=$(openssl x509 -in "$f" -noout -enddate | cut -d= -f2)
    days=$((($(date -d "$end" +%s) - now) / 86400))
    cn=$(openssl x509 -in "$f" -noout -subject -nameopt multiline | sed -n 's/^ *commonName *= //p')
    printf '%-6s %-12s %-22s %s\n' "$days" "$(date -d "$end" +%F)" "$cn" "${f#"$ORGS_DIR"/}"
  done < <(find "$ORGS_DIR" -path "$ORGS_DIR/backup" -prune -o \( -path '*/signcerts/*' -o -name server.crt -o -name ca-cert.pem \) -type f -print) |
    sort -n -k1,1
}

# ---------------------------------------------------------------- renewals

# A fresh enrollment, not `fabric-ca-client reenroll`: reenroll authenticates with the current
# certificate, so it stops working the day it expires. Setting a new one-time secret works with an
# expired certificate too, and issues a new key.
cmd_renew_peer() {
  local org=$1 d dir secret
  [[ -n "${MSP[$org]:-}" ]] || fatal "unknown org $org"
  d=$(domain "$org")
  dir="$(org_dir "$org")/peers/peer0.$d"
  info "Renewing the certificates and keys of peer0.$d"
  secret=$(new_secret)
  ca_admin "$org" identity modify peer0 --secret "$secret" >/dev/null
  backup_and_clear "$dir/msp"
  enroll "$org" peer0 "$secret" "$dir/msp"
  backup_and_clear "$dir/tls"
  enroll_tls "$org" peer0 "$secret" "$dir/tls" "peer0.$d,localhost,127.0.0.1"
  docker restart "peer0.$d" >/dev/null
  use_org "$org" Admin
  retry 20 peer channel getinfo -c "$CHANNEL" >/dev/null 2>&1 || fatal "peer0.$d did not come back"
  ok "peer0.$d is running with new certificates (serial $(openssl x509 -in "$dir/msp/signcerts/cert.pem" -noout -serial | cut -d= -f2))"
}

# ---------------------------------------------------------------- channel config updates

# update_channel_config <jq filter> [jq args...]: fetches the channel config, applies the filter,
# and submits the difference signed by whoever the CORE_PEER_* variables point at. The policy that
# governs the changed part decides who that has to be.
update_channel_config() {
  local filter=$1
  shift
  # shellcheck disable=SC2046
  peer channel fetch config "$WORK/block.pb" $(orderer_args) -c "$CHANNEL" 2>"$WORK/fetch.log" ||
    { cat "$WORK/fetch.log" >&2; fatal "could not fetch the channel config"; }
  configtxlator proto_decode --input "$WORK/block.pb" --type common.Block | jq '.data.data[0].payload.data.config' >"$WORK/config.json"
  jq "$@" "$filter" "$WORK/config.json" >"$WORK/modified.json"
  configtxlator proto_encode --input "$WORK/config.json" --type common.Config --output "$WORK/config.pb"
  configtxlator proto_encode --input "$WORK/modified.json" --type common.Config --output "$WORK/modified.pb"
  configtxlator compute_update --channel_id "$CHANNEL" --original "$WORK/config.pb" --updated "$WORK/modified.pb" --output "$WORK/update.pb"
  configtxlator proto_decode --input "$WORK/update.pb" --type common.ConfigUpdate |
    jq --arg ch "$CHANNEL" '{payload: {header: {channel_header: {channel_id: $ch, type: 2}}, data: {config_update: .}}}' >"$WORK/envelope.json"
  configtxlator proto_encode --input "$WORK/envelope.json" --type common.Envelope --output "$WORK/envelope.pb"
  # shellcheck disable=SC2046
  peer channel update -f "$WORK/envelope.pb" -c "$CHANNEL" $(orderer_args) 2>"$WORK/update.log" ||
    { cat "$WORK/update.log" >&2; fatal "the channel config update was rejected"; }
}

orderer_admin_port() { echo $((7053 + $1 * 1000)); }

# Raft orderers authenticate each other with their TLS certificates, and the channel config pins
# them (the consenter set). So a new TLS certificate has to be in the config before the orderer
# starts using it: update the config, then restart. One orderer at a time: the other two keep
# the quorum meanwhile.
cmd_rotate_orderer_tls() {
  local n=$1 host dir secret cert other
  [[ $n =~ ^[012]$ ]] || fatal "orderer has to be 0, 1 or 2"
  host="orderer$n.$ORDERER_DOMAIN"
  dir="$(org_dir orderer)/orderers/$host/tls"
  info "Rotating the TLS certificate of $host"

  secret=$(new_secret)
  ca_admin orderer identity modify "orderer$n" --secret "$secret" >/dev/null
  backup_and_clear "$dir"
  enroll_tls orderer "orderer$n" "$secret" "$dir" "$host,localhost,127.0.0.1"
  cert=$(base64 -w0 <"$dir/server.crt")

  # Talk to another orderer: this one is about to be cut off until it restarts.
  other=$(((n + 1) % 3))
  ORDERER_ADDR="localhost:$((7050 + other * 1000))" ORDERER_HOST="orderer$other.$ORDERER_DOMAIN"
  use_orderer_admin
  # shellcheck disable=SC2016 # $host and $cert are jq variables
  update_channel_config \
    '(.channel_group.groups.Orderer.values.ConsensusType.value.metadata.consenters[] | select(.host == $host)) |= (.client_tls_cert = $cert | .server_tls_cert = $cert)' \
    --arg host "$host" --arg cert "$cert"
  ok "consenter $host updated in the channel config"

  docker restart "$host" >/dev/null
  local port
  port=$(orderer_admin_port "$n")
  retry 30 bash -c "osnadmin channel info --channelID '$CHANNEL' -o 'localhost:$port' --ca-file '$ORDERER_CA' \
    --client-cert '$dir/server.crt' --client-key '$dir/server.key' 2>/dev/null | grep -q '\"consensusRelation\": \"consenter\"'" ||
    fatal "$host did not rejoin the channel as a consenter"
  ok "$host is back in the consenter set with its new certificate"
}

# ---------------------------------------------------------------- identities

cmd_register_gateway() {
  local org=$1 name=$2 d id
  [[ -n "${MSP[$org]:-}" ]] || fatal "unknown org $org"
  d=$(domain "$org")
  id=$(echo "$name" | tr '[:upper:]' '[:lower:]')
  enroll "$org" "$id" "$(register "$org" "$id" client "$ATTR_GATEWAY")" "$(org_dir "$org")/users/$name@$d/msp"
  ok "${MSP[$org]} $name: a certificate with pharmatrace.role=iot-gateway (users/$name@$d)"
}

# Revoking in the CA is not enough: peers do not ask the CA. The CRL has to be published in the
# org's MSP in the channel config, which only that org's admins can change.
cmd_revoke() {
  local org=$1 name=$2 d cert id crl msp
  [[ -n "${MSP[$org]:-}" ]] || fatal "unknown org $org"
  d=$(domain "$org")
  msp=${MSP[$org]}
  cert="$(org_dir "$org")/users/$name@$d/msp/signcerts/cert.pem"
  [[ -f "$cert" ]] || fatal "no certificate at $cert"
  id=$(openssl x509 -in "$cert" -noout -subject -nameopt multiline | sed -n 's/^ *commonName *= //p')
  info "Revoking $id ($msp) and publishing the CRL"
  ca_admin "$org" revoke -e "$id" -r keycompromise --gencrl >/dev/null
  crl=$(base64 -w0 <"$CA_DIR/$org/admin/msp/crls/crl.pem")

  use_org "$org" Admin
  # shellcheck disable=SC2016 # $msp and $crl are jq variables
  update_channel_config \
    '.channel_group.groups.Application.groups[$msp].values.MSP.value.config.revocation_list = [$crl]' \
    --arg msp "$msp" --arg crl "$crl"
  ok "$msp now publishes a CRL that revokes $id"
}

case "${1:-}" in
  bootstrap) cmd_bootstrap ;;
  status) cmd_status ;;
  renew-peer) cmd_renew_peer "${2:?org}" ;;
  rotate-orderer-tls) cmd_rotate_orderer_tls "${2:?orderer number}" ;;
  register-gateway) cmd_register_gateway "${2:?org}" "${3:?Name}" ;;
  revoke) cmd_revoke "${2:?org}" "${3:?Name}" ;;
  *) sed -n '2,10p' "$NETWORK_DIR/scripts/pki.sh" | sed 's/^# \{0,1\}//'; exit 1 ;;
esac
