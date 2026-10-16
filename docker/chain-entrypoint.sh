#!/bin/sh
# Boots the in-memory Hardhat chain and deploys the contracts once it answers.
# If the deploy fails the container exits, so Kubernetes restarts it on a fresh chain
# (a half-done deploy would shift the contract addresses).
set -eu

hardhat node --hostname 0.0.0.0 --port 8545 &
node_pid=$!
trap 'kill -TERM "$node_pid" 2>/dev/null' TERM INT

node -e '
const body = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_chainId", params: [] });
const ping = () => fetch("http://127.0.0.1:8545", { method: "POST", headers: { "content-type": "application/json" }, body })
  .then((r) => r.ok || Promise.reject())
  .catch(() => new Promise((r) => setTimeout(r, 500)).then(ping));
ping();
'

# Already compiled in the image (and the root filesystem is read-only).
hardhat run --no-compile scripts/deploy.js --network localhost
touch /tmp/ready # readiness probe: contracts are deployed

wait "$node_pid"
