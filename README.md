# PharmaTrace

Trazabilidad de medicamentos sobre **Hyperledger Fabric**, desde el laboratorio hasta el paciente, con
monitoreo de la cadena de frío por IoT. Cada lote queda con un historial inmutable de quién lo tuvo y en qué
estado, y cada cargamento con la evidencia firmada de la temperatura a la que viajó.

Es una red **permisionada**: laboratorios, droguerías, farmacias y el regulador son organizaciones conocidas, cada
una con su autoridad certificante, su peer y su copia del chaincode. Nadie paga gas, los precios entre las partes
no se publican, y el regulador co-firma cada operación.

> Prototipo: corre en una red local de Docker y en la CI. No está listo para producción, ver
> [Limitaciones](#limitaciones). La primera versión, sobre Ethereum (Solidity + Hardhat), quedó en
> [gastonhp1/Pharmatrace-evm](https://github.com/gastonhp1/Pharmatrace-evm).

| Parte | Dónde | Qué hace |
| --- | --- | --- |
| Chaincode | [`fabric/chaincode/pharmatrace`](fabric/chaincode/pharmatrace) | Contrato en Go: lotes, cargamentos, dispensa, recall, precios privados y cadena de frío |
| Red | [`fabric/network`](fabric/network) | 4 organizaciones, 3 orderers Raft, chaincode como servicio. `network.sh` la levanta y la prueba |
| API | [`backend/`](backend) | REST (Express) sobre el Fabric Gateway SDK; también es el gateway IoT |
| IoT | [`iot/`](iot) | Valija con sensores: formato de lectura, simulador, hardware y modelo de amenazas |
| Firmware | [Pharmatrace-firmware](https://github.com/gastonhp1/Pharmatrace-firmware) | ESP32 de la valija |
| Frontend | [PharmaTrace-UI](https://github.com/gastonhp1/PharmaTrace-UI) | React. Todavía habla con la versión EVM |

## Cómo funciona

```
 Laboratorio ──despacha──▶ Droguería ──despacha──▶ Farmacia ──dispensa──▶ paciente (solo un hash)
   LabMSP                    DistMSP                 FarmaMSP
      └──────────── el Regulador (RegMSP) co-firma todo y es el único que hace recalls ────────────┘
```

- **Lotes.** El laboratorio los registra (GTIN, lote, vencimiento). Solo avanzan al rol siguiente, en dos pasos:
  quien lo tiene lo **despacha** y el destinatario lo **recibe**. Cada lote tiene su propia política de endorsement
  (*state-based endorsement*): para cambiarlo tienen que firmar los peers de quien lo tiene y del regulador.
- **Cargamentos.** Varios lotes del mismo dueño viajan juntos de una org a la siguiente, con una valija. Mientras
  están en el cargamento solo se mueven con él.
- **Precios.** Lo que pagó la droguería al laboratorio lo ven solo esas dos orgs (*private data collection*); el
  resto del canal ve un hash, y el regulador puede comprobar un precio sin verlo.
- **Recall.** Solo el regulador, en cualquier punto antes de la dispensa. El lote no se mueve más.
- **Cadena de frío.** La valija firma cada lectura (ECDSA P-256 en un secure element). El gateway verifica las
  firmas contra la clave registrada en el ledger y ancla una raíz de Merkle por ventana; el chaincode da el
  veredicto (`COMPLIANT` o `COMPROMISED`). Detalle en [`iot/`](iot/README.md).

Las reglas completas (quién endosa qué, estados, funciones del chaincode) están en
[`fabric/README.md`](fabric/README.md). Para aprender Fabric con el proyecto: [`fabric/docs/APRENDER.md`](fabric/docs/APRENDER.md).

## Correrlo

Necesitás Linux o WSL2, Docker con Compose v2, `curl`, `jq`, Node 22 y Python 3. En Windows: Docker Desktop con la
integración WSL2, todo desde la terminal de Ubuntu y con el repo clonado dentro de WSL (no en `/mnt/c`).

```bash
cd fabric/network
./network.sh prereq    # binarios de Fabric 3.1.5 en bin/
./network.sh all       # red + canal + chaincode + smoke test con el CLI de Fabric

cd ../../backend
npm ci
cp .env.example .env   # y poné un API_KEY
npm start              # http://localhost:3001
```

`./network.sh api` hace todo el recorrido por HTTP (lotes, cargamentos, precios privados, dos valijas simuladas,
recall) contra la red levantada. Es lo mismo que corre la CI. `./network.sh down` borra todo.

## API

Las lecturas (`GET`) son públicas, salvo los precios. Todo lo demás pide el header `x-api-key` con `API_KEY`.

La API es **custodial**: tiene una identidad de cada org (los certificados que genera la red) y actúa con la que
corresponde. Despacha como el dueño del lote, recibe como el destinatario y hace el recall como el regulador. En un
consorcio real cada org corre su propia API con solo su identidad.

| Método | Ruta | Body / query |
| --- | --- | --- |
| POST | `/api/batches` | `batchId`, `gtin`, `product`, `lot`, `expiryDate` (YYYY-MM-DD) |
| GET | `/api/batches/:id` | |
| GET | `/api/batches/:id/history` | Todas las versiones del lote: la cadena de custodia |
| POST | `/api/batches/:id/dispatch` | `to` (MSP ID: `DistMSP`, `FarmaMSP`) |
| POST | `/api/batches/:id/receive` | |
| POST | `/api/batches/:id/dispense` | `patientRef` (se guarda solo su SHA-256) |
| POST | `/api/batches/:id/recall` | `reason` |
| PUT | `/api/batches/:id/terms` | `buyer`, `unitPrice` (texto, `"1234.50"`), `currency`, `quantity` |
| GET | `/api/batches/:id/terms` | `?leg=manufacturer\|distributor&as=<MSP>` (pide `x-api-key`) |
| POST | `/api/batches/:id/terms/verify` | `leg`, `seller`, `buyer`, `unitPrice`, `currency`, `quantity` → `{ matches }` |
| POST | `/api/cargo` | `cargoId`, `batchIds[]` |
| GET | `/api/cargo/:id` | |
| POST | `/api/cargo/:id/dispatch` | `to` |
| POST | `/api/cargo/:id/receive` | |
| POST | `/api/cargo/:id/dissolve` | Deshace un cargamento que no salió |
| POST | `/api/orgs` | `mspId`, `role` (`manufacturer`, `distributor`, `pharmacy`) |
| GET | `/api/orgs/:msp` · `/api/orgs/:msp/batches` | |
| | `/api/iot/...` | Valijas, políticas, lecturas, anclaje y pruebas: ver [`iot/`](iot/README.md) |

Errores, siempre `{"error": "<motivo>"}`. El chaincode marca sus errores con un código y la API lo traduce:

| HTTP | Código del chaincode | Ejemplos |
| --- | --- | --- |
| 400 | `INVALID` | GTIN o fecha mal formados, precio negativo |
| 401 | | Falta `x-api-key` o es incorrecta |
| 403 | `FORBIDDEN` | No es el dueño, no es el regulador, no es miembro de la colección privada |
| 404 | `NOT_FOUND` | El lote, el cargamento o la org no existen |
| 409 | `CONFLICT` | Ya existe, el lote viaja en un cargamento, el destinatario no tiene el rol siguiente, otra transacción tocó lo mismo (MVCC) |
| 503 | | La red no responde, o faltan las identidades de Fabric, o falta `API_KEY` |

## Tests

```bash
cd fabric/chaincode/pharmatrace && go test ./...   # chaincode
cd backend && npm test                             # API, gateway IoT, firmas, Merkle
python3 -m unittest discover -s iot/simulator      # simulador
cd fabric/network && ./network.sh all && ./network.sh api   # red real, por CLI y por HTTP
```

En la CI, [`fabric.yml`](.github/workflows/fabric.yml) levanta la red completa en cada PR y corre el smoke test,
el recorrido por HTTP y una actualización del chaincode. [`ci.yml`](.github/workflows/ci.yml) construye la imagen
de la API, la escanea con Trivy, la firma y la promueve por GitOps.

## Limitaciones

- **Identidades:** cryptogen genera todas las claves en una máquina, y la API las tiene todas. Sirve para
  desarrollo. Lo siguiente es una Fabric CA por org y una API por org.
- **IoT:** el gateway guarda las lecturas en archivos (un solo proceso); no detecta huecos de datos; la evidencia
  prueba qué se midió, no que el sensor no fuera manipulado. Detalle en [`iot/docs/THREAT_MODEL.md`](iot/docs/THREAT_MODEL.md).
- **Modelo:** la cadena es fija (laboratorio → droguería → farmacia), sin devoluciones; un lote se sigue entero,
  sin serialización por unidad como pide el sistema de trazabilidad de ANMAT.
- **Despliegue:** la red corre en Docker Compose. El paso a Kubernetes (kind y después AKS, con GitOps) está en el
  plan de [`fabric/README.md`](fabric/README.md); hasta entonces la API desplegada en el cluster no tiene una red a
  la que conectarse.
- **Frontend:** PharmaTrace-UI todavía usa los ABIs de la versión EVM y tiene que pasar a esta API.
