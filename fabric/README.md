# Red y chaincode de PharmaTrace

El detalle de la red de Fabric y del chaincode. La visión general del proyecto, la API y cómo correr todo están
en el [README principal](../README.md).

> Si recién arrancás con Fabric, leé primero [docs/APRENDER.md](docs/APRENDER.md): explica cada
> concepto apuntando al archivo donde se usa.

## Qué hay

| Parte | Dónde | Qué hace |
| --- | --- | --- |
| Chaincode | `chaincode/pharmatrace/` | Contrato en Go: lotes, cargamentos, dispensa, recall, condiciones comerciales privadas, valijas y cadena de frío |
| Red local | `network/` | 4 organizaciones, 3 orderers Raft, chaincode como servicio; `network.sh` la levanta y la prueba |
| CI | `.github/workflows/fabric.yml` | Tests del chaincode y la red completa de punta a punta (CLI y API) en cada PR que toque `fabric/`, `backend/` o `iot/` |

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
| Un lote (también al moverlo dentro de un cargamento) | Su tenedor actual **y** el regulador | Endorsement por estado: `setBatchEndorsement` en `contract/helpers.go` |
| Cargamentos, registro de orgs, valijas, políticas de frío, ventanas IoT | El regulador **y** una org de la cadena | `CC_POLICY` en `network/scripts/env.sh` |
| Precio entre laboratorio y droguería | Laboratorio **y** droguería | `network/collections_config.json` |
| Precio entre droguería y farmacia | Droguería **y** farmacia | `network/collections_config.json` |

## El recorrido de un lote

| Estado | Quién lo deja así | Función |
| --- | --- | --- |
| `REGISTERED` | Laboratorio | `RegisterBatch` |
| `IN_TRANSIT` | El que despacha (laboratorio → droguería → farmacia, sin saltear) | `DispatchBatch` |
| `IN_DISTRIBUTION` | La droguería al recibirlo | `ReceiveBatch` |
| `IN_PHARMACY` | La farmacia al recibirlo | `ReceiveBatch` |
| `DISPENSED` | La farmacia, al dispensar la última unidad | `DispenseUnits`, `DispenseBatch` |
| `RECALLED` | Solo el regulador, en cualquier momento antes de la dispensa; alcanza a los lotes divididos | `RecallBatch` |
| `QUARANTINED` | El chaincode, cuando el lote sale de un cargamento con la cadena de frío rota | `ReceiveCargo`, `DissolveCargo` |

El despacho tiene dos pasos (despacho y recepción) porque en Fabric el lote cambia de quién
endosa en el momento del despacho: desde ahí lo controla el destinatario. Un lote al que el regulador
le hace recall en viaje igual llega: el destinatario lo recibe (queda `RECALLED`) para apartarlo.

**Unidades** (`contract/quantity.go`). `RegisterBatch` recibe la cantidad de unidades. Quien tiene
un lote en la mano (no en viaje ni en un cargamento) puede pasar unidades a un lote nuevo con
`SplitBatch`: mismo GTIN, número de lote y vencimiento, mismo dueño y estado, y `parentId` apuntando
al original. Cada parte tiene su propia política de endorsement y viaja por su cuenta. La farmacia
dispensa con `DispenseUnits` (algunas unidades, cada vez con el hash de la receta) o `DispenseBatch`
(todas las que quedan); cada entrega queda como registro aparte (`Dispensations`), y el lote pasa a
`DISPENSED` cuando no quedan unidades. `BatchSplits` y `BatchDescendants` recorren las divisiones.

`RecallBatch` retira el lote y todo lo que se dividió de él (hasta 200 lotes por transacción), sin
tocar lo ya dispensado. Como cada lote lo tiene que endosar quien lo tiene, el recall de un lote
repartido lo endosan todas esas orgs más el regulador; la API calcula quiénes son con
`BatchDescendants`. Los lotes registrados antes de que existieran las cantidades tienen `quantity` 0:
se mueven y se dispensan enteros, pero no se dividen.

**Cuarentena.** Un lote `QUARANTINED` no se despacha, no entra en otro cargamento y no se dispensa.
Solo el regulador lo saca de ahí: con `ReleaseBatch` (revisó la evidencia y el lote sigue siendo
apto; vuelve al estado que tenía) o con `RecallBatch`. Como cualquier cambio a un lote, lo endosan
el peer de quien lo tiene y el del regulador.

**Cargamentos** (`contract/cargo.go`). Lotes del mismo dueño que viajan juntos un tramo:
`CreateCargo` los bloquea, `DispatchCargo` los despacha a todos o a ninguno, `ReceiveCargo` los
entrega y libera, y `DissolveCargo` deshace uno que no salió (por ejemplo, para sacar un lote con
recall). Un cargamento monitoreado se recibe (o se disuelve) con el veredicto firme: primero hay
que cerrar el monitoreo. Si el veredicto es `COMPROMISED`, sus lotes salen en cuarentena.

**Cadena de frío** (`contract/coldchain.go`). Cada org registra sus valijas con su clave pública
(`RegisterDevice`); el regulador fija las políticas y acepta los gateways IoT de una org
(`AuthorizeGatewayOrg`). Es gateway la identidad cuyo certificado trae `pharmatrace.role=iot-gateway`
(control de acceso por atributo, ver [`docs/PKI.md`](docs/PKI.md)). El gateway ancla una raíz de
Merkle por ventana de lecturas, con mín/máx y
segundos fuera de rango, y el chaincode da el veredicto del cargamento (`MONITORING`, `COMPLIANT`
o `COMPROMISED`). `VerifyReading` comprueba una prueba de Merkle contra una raíz anclada. Detalle
en [`iot/docs/ARCHITECTURE.md`](../iot/docs/ARCHITECTURE.md).

**Eventos.** Cada transacción que cambia algo emite un evento (`BatchRecalled`,
`ColdChainCompromised`, `CargoReceived` con los lotes que quedaron en cuarentena...; la lista está
en `contract/model.go`). Fabric permite uno por transacción. La API los escucha y los convierte en
notificaciones: ver [Notificaciones](../README.md#notificaciones).

**Errores.** Los que el cliente puede resolver empiezan con un código (`NOT_FOUND`, `FORBIDDEN`,
`CONFLICT`, `INVALID`, ver `contract/errors.go`) que la API traduce a un estado HTTP.

## Correrlo

Necesitás Linux o WSL2, Docker con Compose v2, `curl` y `jq`. En Windows: Docker Desktop con la
integración WSL2 activada, y todo esto desde la terminal de Ubuntu (no desde PowerShell), con el
repo clonado **dentro** de WSL (`~/repos/...`, no `/mnt/c/...`, que es lento y rompe permisos).

```bash
cd fabric/network
./network.sh prereq    # baja peer, osnadmin, configtxgen (Fabric 3.1.5) y fabric-ca-client (1.5.22) a bin/
./network.sh all       # up + channel + deploy + smoke
./network.sh api       # levanta la API y hace el recorrido por HTTP con dos valijas simuladas
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

1. ~~Chaincode y red local con docker compose.~~
2. ~~API con el Fabric Gateway SDK (`backend/`), con el gateway IoT anclando en el chaincode.~~
3. ~~PKI: una Fabric CA por organización, el gateway IoT por atributo del certificado y el runbook
   de certificados (renovar, rotar el TLS de un orderer, revocar con CRL). Ver [`docs/PKI.md`](docs/PKI.md).~~
4. Kubernetes: ~~chart de Helm propio y la red en kind, probada en CI (ver [`docs/KUBERNETES.md`](docs/KUBERNETES.md))~~.
   Falta AKS: imagen del chaincode en un registro, gRPC expuesto con TLS passthrough, Secrets desde Key Vault y
   ArgoCD desde el repo de GitOps.
5. **Operación**: métricas de peers y orderers en Prometheus/Grafana (ya exponen `/metrics` en
   los puertos 9443–9454), y experimentos de caos documentados.

## Limitaciones

- Cada CA es raíz y está online, sin HSM y con SQLite; lo que falta para producción está en [`docs/PKI.md`](docs/PKI.md).
- Un peer por organización; sin CouchDB (las consultas por dueño usan claves compuestas).
- Entre peer y chaincode no hay TLS (el contenedor de chaincode lo soporta; se activa en el paso de K8s).
- Un lote se sigue entero; falta la serialización por unidad que pide el sistema de trazabilidad de ANMAT.
- El chaincode usa `fabric-contract-api-go` v2.2.1, la última que compila con Go 1.24.
