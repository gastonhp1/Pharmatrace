# PharmaTrace

**English** · [Español](README.md)

Drug traceability on **Hyperledger Fabric**, from the manufacturer to the patient, with IoT cold-chain
monitoring. Every batch keeps an immutable record of who held it and in what state, and every shipment keeps
signed evidence of the temperature it travelled at.

It is a **permissioned** network: manufacturers, distributors, pharmacies and the regulator are known
organizations, each with its own certificate authority, its own peer and its own copy of the chaincode. Nobody
pays gas, prices agreed between two parties are not published, and the regulator co-signs every operation.

> Prototype: it runs on a local Docker network and in CI. It is not production ready, see
> [Limitations](#limitations). The first version, on Ethereum (Solidity + Hardhat), lives in
> [gastonhp1/Pharmatrace-evm](https://github.com/gastonhp1/Pharmatrace-evm).

| Part | Where | What it does |
| --- | --- | --- |
| Chaincode | [`fabric/chaincode/pharmatrace`](fabric/chaincode/pharmatrace) | Go contract: batches, cargoes, dispensing, recalls, private prices and cold chain |
| Network | [`fabric/network`](fabric/network) | 4 organizations, each with its Fabric CA, 3 Raft orderers, chaincode as a service. `network.sh` starts and tests it |
| PKI | [`fabric/docs/PKI.md`](fabric/docs/PKI.md) | Identity issuance and runbook: expiry, renewal, rotating an orderer's TLS certificate, revocation with CRLs |
| Kubernetes | [`fabric/helm/pharmatrace-network`](fabric/helm/pharmatrace-network) | Helm chart of the network; `k8s.sh` runs it on kind (see [`fabric/docs/KUBERNETES.md`](fabric/docs/KUBERNETES.md)) |
| API | [`backend/`](backend) | REST (Express) on the Fabric Gateway SDK; it is also the IoT gateway |
| IoT | [`iot/`](iot) | Sensor case ("valija"): reading format, simulator, hardware and threat model |
| Firmware | [Pharmatrace-firmware](https://github.com/gastonhp1/Pharmatrace-firmware) | ESP32 firmware of the case |
| Web | [PharmaTrace-UI](https://github.com/gastonhp1/PharmaTrace-UI) | React app on this API |
| Mobile | [PharmaTrace-mobile](https://github.com/gastonhp1/PharmaTrace-mobile) | Android (Kotlin): login, QR scan and unlocking the PharmaBox over BLE |

The deeper docs (`fabric/`, `iot/`) are in Spanish.

## How it works

```
 Manufacturer ──dispatch──▶ Distributor ──dispatch──▶ Pharmacy ──dispense──▶ patient (only a hash)
    LabMSP                    DistMSP                  FarmaMSP
       └─────────── the Regulator (RegMSP) co-signs everything and is the only one that recalls ───────────┘
```

- **Batches.** The manufacturer registers them (GTIN, lot, expiry date, units). They only move to the next role,
  in two steps: the holder **dispatches** and the recipient **receives**. Each batch has its own endorsement policy
  (*state-based endorsement*): changing it takes the signatures of the holder's peer and the regulator's peer.
- **Units.** The holder can **split** a batch: 300 of its 1,000 units go into a new batch with the same lot, which
  travels on its own and points to the batch it came from. A pharmacy **dispenses** a few units at a time; the
  batch is `DISPENSED` when none are left.
- **Cargoes.** Batches of the same owner travel together from one org to the next, with a sensor case. While in
  a cargo they only move with it.
- **Prices.** What the distributor paid the manufacturer is visible only to those two orgs (*private data
  collection*); the rest of the channel sees a hash, and the regulator can check a price without seeing it.
- **Recalls.** Only the regulator, at any point before dispensing. A recall reaches the batch and every batch
  split from it, wherever they are: recalling the batch the manufacturer registered recalls the whole lot. A
  recalled batch never moves again.
- **Cold chain.** The case signs every reading (ECDSA P-256 in a secure element). The gateway verifies the
  signatures against the key registered in the ledger and anchors one Merkle root per window; the chaincode
  gives the verdict (`COMPLIANT` or `COMPROMISED`). Details in [`iot/`](iot/README.md).
- **Quarantine.** The batches of a cargo that arrived with a broken cold chain are blocked (`QUARANTINED`): they
  cannot be dispatched or dispensed until the regulator releases or recalls them.
- **Notifications.** The chaincode emits an event for every change; the API listens to them and tells the orgs
  involved (a recall, a cargo that lost its cold chain, batches in quarantine, a shipment on its way) through a
  feed and webhooks.
- **Identities.** Each organization issues its certificates with its own Fabric CA. The IoT gateway is
  recognized by an attribute in its certificate (`pharmatrace.role=iot-gateway`), which only its org's CA can
  set (attribute-based access control).

The full rules (who endorses what, states, chaincode functions) are in [`fabric/README.md`](fabric/README.md).
To learn Fabric through the project: [`fabric/docs/APRENDER.md`](fabric/docs/APRENDER.md).

## Running it

You need Linux or WSL2, Docker with Compose v2, `curl`, `jq`, Node 22 and Python 3. On Windows: Docker Desktop
with the WSL2 integration, everything from the Ubuntu terminal and with the repo cloned inside WSL (not under
`/mnt/c`).

```bash
cd fabric/network
./network.sh prereq    # Fabric 3.1.5 binaries and fabric-ca-client into bin/
./network.sh all       # CAs + network + channel + chaincode + smoke test with the Fabric CLI

cd ../../backend
npm ci
cp .env.example .env   # and set an API_KEY
npm start              # http://localhost:3001
```

`./network.sh api` runs the whole trip over HTTP (batches, cargoes, private prices, two simulated cases, a
recall) against the running network. It is the same thing CI runs. `./network.sh pki ...` is the certificate
runbook (see [`fabric/docs/PKI.md`](fabric/docs/PKI.md)). `./network.sh down` removes everything.

On Kubernetes, `./k8s.sh all` does the same on a local kind cluster with the Helm chart; `./k8s.sh api` and
`./k8s.sh pki-test` run the same tests against it. See [`fabric/docs/KUBERNETES.md`](fabric/docs/KUBERNETES.md).

## API

Reads (`GET`) are public, except prices. Everything else needs the `x-api-key` header with `API_KEY`, except
`/api/auth` and `/api/box`, which use per-user sessions (the mobile app).

The API is **custodial**: it holds one identity per org (the certificates the network issues) and acts with the
right one. It dispatches as the batch owner, receives as the recipient and recalls as the regulator. In a real
consortium each org runs its own API with only its own identity.

| Method | Route | Body / query |
| --- | --- | --- |
| POST | `/api/batches` | `batchId`, `gtin`, `product`, `lot`, `expiryDate` (YYYY-MM-DD), `quantity` (units) |
| GET | `/api/batches/:id` | |
| GET | `/api/batches/:id/history` | Every version of the batch: the chain of custody |
| POST | `/api/batches/:id/split` | `newBatchId`, `quantity`. The owner takes units out into a new batch |
| GET | `/api/batches/:id/splits` | Batches split from it; `?all=true`: and from those (what a recall reaches) |
| POST | `/api/batches/:id/dispatch` | `to` (MSP ID: `DistMSP`, `FarmaMSP`) |
| POST | `/api/batches/:id/receive` | |
| POST | `/api/batches/:id/dispense` | `patientRef` (only its SHA-256 is stored), `quantity` (optional: every unit left) |
| GET | `/api/batches/:id/dispensations` | Units handed to patients, oldest first |
| POST | `/api/batches/:id/recall` | `reason`. Also recalls every batch split from it |
| POST | `/api/batches/:id/release` | `reason`. The regulator lifts a quarantine |
| PUT | `/api/batches/:id/terms` | `buyer`, `unitPrice` (string, `"1234.50"`), `currency`, `quantity` |
| GET | `/api/batches/:id/terms` | `?leg=manufacturer\|distributor&as=<MSP>` (needs `x-api-key`) |
| POST | `/api/batches/:id/terms/verify` | `leg`, `seller`, `buyer`, `unitPrice`, `currency`, `quantity` → `{ matches }` |
| POST | `/api/cargo` | `cargoId`, `batchIds[]` |
| GET | `/api/cargo/:id` | |
| POST | `/api/cargo/:id/dispatch` | `to` |
| POST | `/api/cargo/:id/receive` | A monitored cargo needs its monitoring closed first |
| POST | `/api/cargo/:id/dissolve` | Undoes a cargo that has not left yet |
| POST | `/api/orgs` | `mspId`, `role` (`manufacturer`, `distributor`, `pharmacy`) |
| GET | `/api/orgs/:msp` · `/api/orgs/:msp/batches` | |
| GET | `/api/notifications` | `?org=<MSP>&severity=info\|warning\|critical&limit=50`, newest first |
| | `/api/iot/...` | Cases, policies, readings, anchoring and proofs: see [`iot/`](iot/README.md) |
| | `/api/auth/...` · `/api/box/...` | User login (Bearer session) and PharmaBox unlock tokens for the mobile app: see [`iot/docs/BOX_UNLOCK.md`](iot/docs/BOX_UNLOCK.md) |

Errors are always `{"error": "<reason>"}`. The chaincode tags its errors with a code and the API maps it:

| HTTP | Chaincode code | Examples |
| --- | --- | --- |
| 400 | `INVALID` | Malformed GTIN or date, negative price |
| 401 | | Missing or wrong `x-api-key`, or missing/expired session on `/api/box` |
| 403 | `FORBIDDEN` | Not the owner, not the regulator, not a member of the private collection |
| 404 | `NOT_FOUND` | The batch, cargo or org does not exist |
| 409 | `CONFLICT` | Already exists, the batch travels in a cargo or is quarantined, the recipient does not have the next role, the cargo is still being monitored, another transaction touched the same data (MVCC) |
| 503 | | The network is unreachable, the Fabric identities are missing, or `API_KEY` is not set |

## Notifications

The API listens to the chaincode events of the channel (with the regulator's identity) and keeps the ones someone
has to act on:

| Event | Severity | Who it is for |
| --- | --- | --- |
| `ColdChainCompromised` | critical | The cargo's owner, its recipient and the regulator |
| `CargoReceived` / `CargoDissolved` with quarantined batches | critical | Whoever holds them and the regulator |
| `BatchRecalled` | critical | Whoever holds the batch and the regulator |
| `BatchReleased` | info | Whoever holds the batch and the regulator |
| `CargoDispatched` / `BatchDispatched` | info | The recipient |

```bash
curl "localhost:3001/api/notifications?org=DistMSP&severity=critical"
```

With `WEBHOOK_URLS` every notification is also sent as a JSON POST; with `WEBHOOK_SECRET` the body is signed in
`x-pharmatrace-signature: sha256=<HMAC-SHA256>`. The listener keeps a checkpoint of the last event it handled, so
after a restart or a lost connection it resumes where it was; a repeated event is not notified twice. Webhook
delivery is best effort (three attempts): the feed is the record.

## Tests

```bash
cd fabric/chaincode/pharmatrace && go test ./...   # chaincode
cd backend && npm test                             # API, IoT gateway, signatures, Merkle
python3 -m unittest discover -s iot/simulator      # simulator
cd fabric/network && ./network.sh all && ./network.sh api   # real network, through the CLI and over HTTP
```

In CI, [`fabric.yml`](.github/workflows/fabric.yml) brings up the whole network on every PR and runs the smoke
test, the HTTP trip, a chaincode upgrade and the certificate runbook (renew a peer, rotate an orderer's TLS
certificate, revoke with a CRL). [`ci.yml`](.github/workflows/ci.yml) builds the API image, scans it with Trivy,
signs it and promotes it through GitOps. A third job installs the Helm chart on kind and runs the smoke test, the
HTTP trip and the certificate runbook there too.

## Limitations

- **Identities:** each org has its own Fabric CA, but the API holds the identities of all of them. The right
  setup is one API per org; and the CAs are online roots without an HSM. See [`fabric/docs/PKI.md`](fabric/docs/PKI.md).
- **Notifications:** the feed is a file read by a single API process, and it tells orgs apart only by a query
  parameter: anyone can read any org's notifications (they repeat what is public on the channel). There is no
  mobile push yet.
- **IoT:** the gateway stores readings in files (single process); it does not detect data gaps; the evidence
  proves what was measured, not that the sensor was not tampered with. Details in
  [`iot/docs/THREAT_MODEL.md`](iot/docs/THREAT_MODEL.md).
- **Model:** the chain is fixed (manufacturer → distributor → pharmacy), with no returns. Batches are counted in
  units and can be split, but units have no serial numbers, which Argentina's ANMAT traceability system requires.
  A recall reaches up to 200 batches of one lot in a single transaction; past that it has to go by parts.
- **Deployment:** Docker Compose and kind (Helm). AKS with GitOps is the next step: it needs the chaincode image in
  a registry, gRPC exposed with TLS passthrough and the identity Secrets loaded from Key Vault
  ([`fabric/docs/KUBERNETES.md`](fabric/docs/KUBERNETES.md)). Until then the API deployed in the cluster has no
  network to connect to.
- **Hardware:** the mobile app and the PharmaBox firmware have not been tested on real devices yet.
