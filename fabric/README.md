# PharmaTrace sobre Hyperledger Fabric

La misma trazabilidad de medicamentos que el resto del repo, pero sobre una red **permisionada**:
cada actor es una organización con su propia autoridad certificante, su peer y su copia del
chaincode. Es el modelo que tiene sentido para un consorcio de actores conocidos (laboratorios,
droguerías, farmacias y el regulador), donde nadie quiere una red pública ni pagar gas.

La versión Solidity (`contracts/`) sigue en pie; esta vive al lado, en `fabric/`.

> Si recién arrancás con Fabric, leé primero [docs/APRENDER.md](docs/APRENDER.md): explica cada
> concepto apuntando al archivo donde se usa.

## Qué hay

| Parte | Dónde | Qué hace |
| --- | --- | --- |
| Chaincode | `chaincode/pharmatrace/` | Contrato en Go: lotes, despacho y recepción, dispensa, recall, condiciones comerciales privadas y cadena de frío |
| Red local | `network/` | 4 organizaciones, 3 orderers Raft, chaincode como servicio; `network.sh` la levanta y la prueba |
| CI | `.github/workflows/fabric.yml` | Tests del chaincode y la red completa de punta a punta en cada PR que toque `fabric/` |

## La red

```
                    orderer0 ─ orderer1 ─ orderer2        (Raft, OrdererMSP)
                         │  ordenan, no ejecutan
    ┌──────────────┬─────┴────────┬───────────────┐
 peer0.lab     peer0.dist     peer0.farma      peer0.reg
 LabMSP        DistMSP        FarmaMSP         RegMSP
 laboratorio   droguería      farmacia         regulador
    │              │              │                │
 chaincode      chaincode      chaincode        chaincode     (un contenedor por org)
```

Todos en un canal, `pharmatrace`. Las reglas de quién firma qué:

| Qué se escribe | Quién tiene que endosar | Dónde se define |
| --- | --- | --- |
| Un lote | Su tenedor actual **y** el regulador | Endorsement por estado: `setBatchEndorsement` en `contract/helpers.go` |
| Registro de orgs, políticas de frío, ventanas IoT | El regulador **y** una org de la cadena | `CC_POLICY` en `network/scripts/env.sh` |
| Precio entre laboratorio y droguería | Laboratorio **y** droguería | `network/collections_config.json` |
| Precio entre droguería y farmacia | Droguería **y** farmacia | `network/collections_config.json` |

## El recorrido de un lote

| Estado | Quién lo deja así | Función |
| --- | --- | --- |
| `REGISTERED` | Laboratorio | `RegisterBatch` |
| `IN_TRANSIT` | El que despacha (laboratorio → droguería → farmacia, sin saltear) | `DispatchBatch` |
| `IN_DISTRIBUTION` | La droguería al recibirlo | `ReceiveBatch` |
| `IN_PHARMACY` | La farmacia al recibirlo | `ReceiveBatch` |
| `DISPENSED` | La farmacia, con el hash de la receta | `DispenseBatch` |
| `RECALLED` | Solo el regulador, en cualquier momento antes de la dispensa | `RecallBatch` |

El despacho tiene dos pasos (despacho y recepción) porque en Fabric el lote cambia de quién
endosa en el momento del despacho: desde ahí lo controla el destinatario.

**Cadena de frío.** Es la lógica de `ColdChainMonitor.sol`: el gateway IoT ancla una raíz de
Merkle por ventana de lecturas, con mín/máx y segundos fuera de rango, y el chaincode da el
veredicto (`MONITORING`, `COMPLIANT` o `COMPROMISED`). El gateway se autoriza por su certificado
(`RegisterAttestor`) en vez de por dirección.

## Correrlo

Necesitás Linux o WSL2, Docker con Compose v2, `curl` y `jq`. En Windows: Docker Desktop con la
integración WSL2 activada, y todo esto desde la terminal de Ubuntu (no desde PowerShell), con el
repo clonado **dentro** de WSL (`~/repos/...`, no `/mnt/c/...`, que es lento y rompe permisos).

```bash
cd fabric/network
./network.sh prereq    # baja peer, osnadmin, configtxgen y cryptogen (Fabric 3.1.5) a bin/
./network.sh all       # up + channel + deploy + smoke
./network.sh down      # para todo y borra certificados, bloques y volúmenes
```

`smoke` recorre el caso completo y muestra los endosos que fallan a propósito (por ejemplo, la
droguería intentando recibir un lote con el peer del laboratorio). Para jugar a mano:

```bash
source scripts/env.sh
use_org lab User1
peer chaincode query -C pharmatrace -n pharmatrace -c '{"function":"BatchesByOwner","Args":["LabMSP"]}'
```

Para actualizar el chaincode después de cambiarlo: `CC_VERSION=0.2 ./network.sh deploy`. Arma la
imagen nueva, la aprueban las 4 orgs con la secuencia siguiente y los datos quedan.

Los tests del chaincode no necesitan la red:

```bash
cd fabric/chaincode/pharmatrace
go test ./...
```

## Qué sigue

Lo que se hizo es el paso 1. El orden propuesto:

1. ~~Chaincode y red local con docker compose.~~
2. **API gateway** con el Fabric Gateway SDK (Go o Node) que reemplace a ethers en el backend, y
   que el gateway IoT (`backend/iot`) ancle en Fabric.
3. **PKI de verdad**: Fabric CA por organización en vez de cryptogen, atributos en los
   certificados (`pharmatrace.role=iot-gateway`) para el control de acceso, y un runbook de
   renovación de certificados.
4. **Kubernetes**: la red en kind y después en AKS, con el operador de Fabric o charts de Helm,
   sincronizada por ArgoCD desde el repo de GitOps.
5. **Operación**: métricas de peers y orderers en Prometheus/Grafana (ya exponen `/metrics` en
   los puertos 9443–9454), y experimentos de caos documentados.

## Limitaciones de este paso

- cryptogen genera todas las claves en una máquina: sirve para desarrollo, nunca para producción.
- Un peer por organización; sin CouchDB (las consultas por dueño usan claves compuestas).
- Entre peer y chaincode no hay TLS (el contenedor de chaincode lo soporta; se activa en el paso de K8s).
- Un lote se sigue entero; la serialización por unidad (como pide el sistema de trazabilidad de
  ANMAT) y los cargamentos de `CargoTracker` todavía no están portados.
- El chaincode usa `fabric-contract-api-go` v2.2.1, la última que compila con Go 1.24.
