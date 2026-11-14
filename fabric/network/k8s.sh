#!/usr/bin/env bash
# PharmaTrace on Kubernetes (kind), with the chart in fabric/helm/pharmatrace-network.
#
#   ./k8s.sh cluster       create the kind cluster "pharmatrace" (if it does not exist)
#   ./k8s.sh up            CAs, identities (as Secrets), orderers and peers; then port-forwards
#   ./k8s.sh forward       (re)start the port-forwards: every node on the same local port as on Docker
#   ./k8s.sh channel       create the channel and join everyone to it
#   ./k8s.sh deploy        build the chaincode image, load it into kind (or minikube) and deploy it
#   ./k8s.sh smoke|api|pki-test   the same tests as on Docker, against the cluster
#   ./k8s.sh pki ...       the certificate runbook (scripts/pki.sh), against the cluster
#   ./k8s.sh all           cluster + up + channel + deploy + smoke
#   ./k8s.sh down [--cluster]   remove the release, the namespace and organizations/ (and the cluster)
#
# Needs kind, kubectl, helm and Docker, plus what network.sh needs (./network.sh prereq).
# On another cluster, skip `cluster` and point kubectl at it. K8S_NS picks the namespace (default
# pharmatrace) and MINIKUBE_PROFILE=<profile> loads the chaincode image into minikube instead of kind.
set -euo pipefail
cd "$(dirname "$0")"
export RUNTIME=k8s
# shellcheck source=scripts/env.sh
source scripts/env.sh

STATE_DIR="$NETWORK_DIR/.k8s"
mkdir -p "$STATE_DIR"

need() {
  local tool
  for tool in "$@"; do command -v "$tool" >/dev/null || fatal "$tool is not installed"; done
}

kc() { kubectl -n "$K8S_NS" "$@"; }

cluster() {
  need kind kubectl
  if kind get clusters 2>/dev/null | grep -qx "$KIND_CLUSTER"; then
    ok "kind cluster $KIND_CLUSTER already exists"
  else
    info "Creating the kind cluster $KIND_CLUSTER"
    kind create cluster --name "$KIND_CLUSTER" --wait 120s
  fi
  kubectl config use-context "kind-$KIND_CLUSTER" >/dev/null
}

# ---------------------------------------------------------------- port-forwards

# local port -> Service and its ports. The local ports are the ones Docker Compose publishes, so
# env.sh, the API and the tests need no changes.
CA_FORWARDS=("ca-orderer 11054:7054" "ca-lab 7054:7054" "ca-dist 8054:7054" "ca-farma 9054:7054" "ca-reg 10054:7054")
NODE_FORWARDS=(
  "orderer0 7050:7050 7053:7053" "orderer1 8050:7050 8053:7053" "orderer2 9050:7050 9053:7053"
  "peer0-lab 7051:7051" "peer0-dist 8051:7051" "peer0-farma 9051:7051" "peer0-reg 10051:7051"
)

# Each forward runs in a loop: when its pod restarts (a certificate renewal, a stopped orderer)
# kubectl port-forward exits and the loop brings it back.
start_forwards() {
  local spec svc ports
  for spec in "$@"; do
    read -r svc ports <<<"$spec"
    # shellcheck disable=SC2086 # ports is a list
    nohup bash -c "while true; do kubectl -n '$K8S_NS' port-forward 'svc/$svc' $ports >>'$STATE_DIR/forward.log' 2>&1; sleep 1; done" \
      >/dev/null 2>&1 &
    echo $! >>"$STATE_DIR/forward.pids"
  done
  for spec in "$@"; do
    read -r svc ports <<<"$spec"
    local first=${ports%%:*}
    retry 30 bash -c "exec 3<>/dev/tcp/127.0.0.1/$first" 2>/dev/null || fatal "the port-forward to $svc (localhost:$first) is not working"
  done
}

stop_forwards() {
  if [[ -f "$STATE_DIR/forward.pids" ]]; then
    xargs kill <"$STATE_DIR/forward.pids" 2>/dev/null || true
    rm -f "$STATE_DIR/forward.pids"
  fi
  pkill -f "kubectl -n $K8S_NS port-forward" 2>/dev/null || true
}

forward() {
  stop_forwards
  local specs=("${CA_FORWARDS[@]}")
  if kc get statefulset orderer0 >/dev/null 2>&1; then specs+=("${NODE_FORWARDS[@]}"); fi
  start_forwards "${specs[@]}"
  ok "port-forwards up (log in .k8s/forward.log)"
}

# ---------------------------------------------------------------- install

NODES=(orderer0.orderer.pharmatrace.ar orderer1.orderer.pharmatrace.ar orderer2.orderer.pharmatrace.ar
  peer0.lab.pharmatrace.ar peer0.dist.pharmatrace.ar peer0.farma.pharmatrace.ar peer0.reg.pharmatrace.ar)

helm_install() {
  helm upgrade --install "$K8S_RELEASE" "$CHART_DIR" -n "$K8S_NS" --reuse-values "$@" --wait --timeout 10m >/dev/null
}

up() {
  need kubectl helm fabric-ca-client peer
  kubectl get namespace "$K8S_NS" >/dev/null 2>&1 || kubectl create namespace "$K8S_NS" >/dev/null

  if [[ ! -d organizations ]]; then
    mkdir -p "$CA_DIR"
    (umask 077 && openssl rand -hex 16 >"$CA_DIR/admin.secret")
    CA_ADMIN_SECRET=$(cat "$CA_DIR/admin.secret")
    export CA_ADMIN_SECRET
  fi
  [[ -n "${CA_ADMIN_SECRET:-}" ]] || fatal "organizations/ exists but has no CA admin secret; run ./k8s.sh down first"
  kc create secret generic ca-admin --from-literal=password="$CA_ADMIN_SECRET" --dry-run=client -o yaml | kubectl apply -f - >/dev/null

  # Phase 1: the CAs. The orderers and peers need Secrets that only exist once the CAs issued them.
  info "Phase 1: the Fabric CAs"
  helm_install --set nodes.enabled=false
  stop_forwards
  start_forwards "${CA_FORWARDS[@]}"
  if [[ ! -f "$ORGS_DIR/peerOrganizations/reg.pharmatrace.ar/users/Admin@reg.pharmatrace.ar/msp/signcerts/cert.pem" ]]; then
    bash scripts/pki.sh bootstrap
  fi
  local node
  for node in "${NODES[@]}"; do node_sync_certs "$node"; done
  ok "identities stored as Secrets (<node>-msp, <node>-tls)"

  # Phase 2: orderers and peers.
  info "Phase 2: orderers and peers"
  helm_install --set nodes.enabled=true
  kc get pods
  forward
}

# The same channel profile, with the cluster's names: orderer0:7050 instead of
# orderer0.orderer.pharmatrace.ar:7050, peer0-lab:7051 instead of peer0.lab.pharmatrace.ar:7051...
k8s_configtx() {
  mkdir -p "$STATE_DIR"
  sed -E \
    -e 's#MSPDir: organizations/#MSPDir: ../organizations/#' \
    -e 's#(Cert: )organizations/#\1../organizations/#' \
    -e 's#- (orderer[0-9])\.orderer\.pharmatrace\.ar:[0-9]+#- \1:7050#' \
    -e 's#Host: (orderer[0-9])\.orderer\.pharmatrace\.ar#Host: \1#' \
    -e 's#Host: peer0\.([a-z]+)\.pharmatrace\.ar#Host: peer0-\1#' \
    -e 's#Port: (8050|9050)$#Port: 7050#' \
    -e 's#Port: (8051|9051|10051)$#Port: 7051#' \
    configtx.yaml >"$STATE_DIR/configtx.yaml"
}

down() {
  stop_forwards
  if command -v helm >/dev/null && kubectl get namespace "$K8S_NS" >/dev/null 2>&1; then
    helm uninstall "$K8S_RELEASE" -n "$K8S_NS" >/dev/null 2>&1 || true
    kubectl delete namespace "$K8S_NS" --wait=true >/dev/null 2>&1 || true
  fi
  rm -rf organizations channel-artifacts "$STATE_DIR"
  if [[ "${1:-}" == --cluster ]]; then kind delete cluster --name "$KIND_CLUSTER"; fi
  ok "removed"
}

case "${1:-}" in
  cluster) cluster ;;
  up) up ;;
  forward) forward ;;
  channel) k8s_configtx && CONFIGTX_DIR="$STATE_DIR" bash network.sh channel ;;
  deploy) bash network.sh deploy ;;
  smoke) bash scripts/smoke.sh ;;
  api) bash scripts/api-e2e.sh ;;
  pki-test) bash scripts/pki-test.sh ;;
  pki) shift && bash scripts/pki.sh "$@" ;;
  all) cluster && up && k8s_configtx && CONFIGTX_DIR="$STATE_DIR" bash network.sh channel && bash network.sh deploy && bash scripts/smoke.sh ;;
  down) down "${2:-}" ;;
  *) sed -n '2,13p' k8s.sh | sed 's/^# \{0,1\}//'; exit 1 ;;
esac
