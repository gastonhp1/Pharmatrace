#!/usr/bin/env bash
# shellcheck disable=SC2034 # variables used by the scripts that source this file
# Where the nodes run: Docker Compose (RUNTIME=docker, the default) or Kubernetes (RUNTIME=k8s,
# set by k8s.sh). Everything else in the scripts is the same in both: on Kubernetes, k8s.sh
# port-forwards every node to the same local ports Docker publishes, so the CLI, the API and the
# tests talk to localhost either way. Only starting, stopping and feeding certificates to a node
# differ, and that is all this file does. Sourced by env.sh.

RUNTIME="${RUNTIME:-docker}"
K8S_NS="${K8S_NS:-pharmatrace}"

# How each peer finds its chaincode container (chaincode as a service). Kubernetes names cannot
# have underscores, so the Services are cc-<peername>.
if [[ $RUNTIME == k8s ]]; then
  CCAAS_ADDRESS='cc-{{.peername}}:9999'
else
  CCAAS_ADDRESS="{{.peername}}_${CC_NAME:-pharmatrace}:9999"
fi

# Docker container name -> Kubernetes StatefulSet: peer0.lab.pharmatrace.ar -> peer0-lab,
# orderer1.orderer.pharmatrace.ar -> orderer1, ca.dist.pharmatrace.ar -> ca-dist.
k8s_name() {
  local c=$1 rest
  case "$c" in
    peer0.*) rest=${c#peer0.} && echo "peer0-${rest%%.*}" ;;
    ca.*) rest=${c#ca.} && echo "ca-${rest%%.*}" ;;
    orderer*) echo "${c%%.*}" ;;
    *) echo "$c" ;;
  esac
}

# Folder of a peer or orderer under organizations/.
node_dir() {
  local c=$1 rest
  case "$c" in
    peer0.*) rest=${c#peer0.} && echo "$ORGS_DIR/peerOrganizations/$rest/peers/$c" ;;
    orderer*) echo "$ORGS_DIR/ordererOrganizations/${c#*.}/orderers/$c" ;;
  esac
}

# The root certificate a CA created on its first start, copied to <dest>.
ca_root_cert() {
  local c=$1 dest=$2 path=/etc/hyperledger/fabric-ca-server/ca-cert.pem
  if [[ $RUNTIME == k8s ]]; then
    kubectl -n "$K8S_NS" exec "$(k8s_name "$c")-0" -- cat "$path" >"$dest.tmp" 2>/dev/null && [[ -s "$dest.tmp" ]] &&
      mv "$dest.tmp" "$dest"
  else
    docker cp "$c:$path" "$dest" 2>/dev/null
  fi
}

# Publishes a node's certificates and keys to where the node reads them. On Docker they are bind
# mounted, so there is nothing to do; on Kubernetes they live in two Secrets per node.
node_sync_certs() {
  [[ $RUNTIME == k8s ]] || return 0
  local c=$1 dir name tmp
  dir=$(node_dir "$c")
  name=$(k8s_name "$c")
  tmp=$(mktemp -d)
  # The Secret flattens the MSP, so its config.yaml points at the CA certificate's new name.
  sed -E 's#cacerts/[^ ,}]+#cacerts/ca.pem#g' "$dir/msp/config.yaml" >"$tmp/config.yaml"
  kubectl -n "$K8S_NS" create secret generic "$name-msp" \
    --from-file=cert.pem="$(find "$dir/msp/signcerts" -type f | head -1)" \
    --from-file=key.pem="$(find "$dir/msp/keystore" -type f | head -1)" \
    --from-file=ca.pem="$(find "$dir/msp/cacerts" -type f | head -1)" \
    --from-file=config.yaml="$tmp/config.yaml" \
    --dry-run=client -o yaml | kubectl apply -f - >/dev/null
  kubectl -n "$K8S_NS" create secret generic "$name-tls" \
    --from-file=server.crt="$dir/tls/server.crt" --from-file=server.key="$dir/tls/server.key" \
    --from-file=ca.crt="$dir/tls/ca.crt" \
    --dry-run=client -o yaml | kubectl apply -f - >/dev/null
  rm -rf "$tmp"
}

# Waits until pod <name>-0 exists again and is Ready (readiness probes in the chart).
k8s_wait_ready() {
  local i
  for ((i = 0; i < 60; i++)); do
    kubectl -n "$K8S_NS" wait --for=condition=Ready "pod/$1-0" --timeout=5s >/dev/null 2>&1 && return 0
    sleep 2
  done
  kubectl -n "$K8S_NS" describe "pod/$1-0" >&2 || true
  return 1
}

node_stop() {
  if [[ $RUNTIME == k8s ]]; then
    local name
    name=$(k8s_name "$1")
    kubectl -n "$K8S_NS" scale statefulset "$name" --replicas=0 >/dev/null
    kubectl -n "$K8S_NS" wait --for=delete "pod/$name-0" --timeout=120s >/dev/null 2>&1 || true
  else
    docker stop "$1" >/dev/null
  fi
}

node_start() {
  if [[ $RUNTIME == k8s ]]; then
    local name
    name=$(k8s_name "$1")
    kubectl -n "$K8S_NS" scale statefulset "$name" --replicas=1 >/dev/null
    k8s_wait_ready "$name"
  else
    docker start "$1" >/dev/null
  fi
}

# Kubernetes release of the chart (fabric/helm/pharmatrace-network) and the kind cluster.
K8S_RELEASE="${K8S_RELEASE:-pharmatrace}"
KIND_CLUSTER="${KIND_CLUSTER:-pharmatrace}"
CHART_DIR="$NETWORK_DIR/../helm/pharmatrace-network"

# The chaincode containers on Kubernetes: one Deployment per org, all running the package ID the
# peers installed. The image is loaded into the cluster's node, nothing is pushed anywhere: into
# kind by default, or into minikube when MINIKUBE_PROFILE is set (e.g. MINIKUBE_PROFILE=platform-local).
k8s_chaincode_up() {
  local pkg=$1 image="pharmatrace-chaincode:$CC_VERSION"
  if [[ -n "${MINIKUBE_PROFILE:-}" ]]; then
    minikube -p "$MINIKUBE_PROFILE" image load --overwrite "$image" >/dev/null
  else
    kind load docker-image "$image" --name "$KIND_CLUSTER" >/dev/null
  fi
  helm upgrade "$K8S_RELEASE" "$CHART_DIR" -n "$K8S_NS" --reuse-values \
    --set chaincode.enabled=true --set-string chaincode.packageId="$pkg" --set-string chaincode.image.tag="$CC_VERSION" \
    --wait --timeout 5m >/dev/null
}

# A restart that picks up new certificates.
node_restart() {
  if [[ $RUNTIME == k8s ]]; then
    local name
    name=$(k8s_name "$1")
    kubectl -n "$K8S_NS" delete pod "$name-0" --wait=true >/dev/null
    k8s_wait_ready "$name"
  else
    docker restart "$1" >/dev/null
  fi
}
