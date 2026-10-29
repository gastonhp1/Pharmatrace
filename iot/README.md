# PharmaTrace IoT: cadena de frío

Una **valija** con sensores viaja con un cargamento, mide el estado de los lotes y firma cada lectura. Un gateway
(en `backend/`) verifica las firmas y deja evidencia en el ledger de Fabric: una raíz de Merkle por ventana de
lecturas, el tiempo fuera de rango y los eventos (tapa, golpe, sello roto). El chaincode da un veredicto por
cargamento: `COMPLIANT` o `COMPROMISED`.

| Carpeta | Qué hay |
| --- | --- |
| [`docs/`](docs) | [Arquitectura](docs/ARCHITECTURE.md), [formato de lectura](docs/READING_FORMAT.md) y [modelo de amenazas](docs/THREAT_MODEL.md) |
| [`hardware/`](hardware) | [Lista de partes propuesta](hardware/BOM.md) (ESP32-S3 + sensores + ATECC608B) |
| [`simulator/`](simulator) | Valija virtual en Python: genera lecturas firmadas igual que el dispositivo real |

La lógica on-chain está en el chaincode (`../fabric/chaincode/pharmatrace/contract/coldchain.go`) y el gateway en
`../backend/` (`routes/iot.js`, `services/iotService.js` e `iot/`). El firmware va en
[gastonhp1/Pharmatrace-firmware](https://github.com/gastonhp1/Pharmatrace-firmware).

## Probarlo sin hardware

Con la red levantada y el chaincode desplegado (`fabric/network/network.sh all`) y la API corriendo
(`cd backend && npm start`, con `API_KEY` en `backend/.env`):

```bash
export API=http://localhost:3001 KEY=<tu API_KEY>
h=(-H "x-api-key: $KEY" -H 'content-type: application/json')

# 1. Una sola vez: el regulador acepta los gateways de la org del gateway (IOT_GATEWAY_IDENTITY, por defecto dist:IotGateway)
curl -X POST $API/api/iot/gateway/authorize "${h[@]}"

# 2. Política (2–8 °C, hasta 30 min fuera de rango) y la clave de la valija
curl -X POST $API/api/iot/policies "${h[@]}" -d '{"policyId":"pharma-2-8c","minTemp":200,"maxTemp":800,"maxExcursionSeconds":1800}'
pip install -r iot/simulator/requirements.txt
python3 iot/simulator/simulator.py keygen --key valija.pem      # imprime la clave pública

# 3. Registrar la valija y monitorear un cargamento existente (POST /api/cargo), por ejemplo C-1
curl -X POST $API/api/iot/devices "${h[@]}" -d '{"deviceId":"VAL-001","pubKey":"0x...","calibrationExpiry":1893456000}'
curl -X POST $API/api/iot/monitoring/start "${h[@]}" -d '{"cargoId":"C-1","deviceId":"VAL-001","policyId":"pharma-2-8c"}'

# 4. Simular el viaje: normal | excursion | tamper
python3 iot/simulator/simulator.py run --key valija.pem --device-id VAL-001 --scenario excursion --count 120 --gateway $API

# 5. Anclar, ver el veredicto y cerrar
curl -X POST $API/api/iot/cargo/C-1/anchor "${h[@]}"
curl $API/api/iot/cargo/C-1
curl -X POST $API/api/iot/monitoring/close "${h[@]}" -d '{"cargoId":"C-1"}'
```

Qué esperar con esa política:

| Escenario | Resultado |
| --- | --- |
| `normal` | `COMPLIANT` al cerrar |
| `excursion --count 60` | Un tercio del viaje a ~10 °C: 20 min fuera de rango, dentro del presupuesto. `COMPLIANT` |
| `excursion --count 120` | 40 min fuera de rango: supera el presupuesto, `COMPROMISED` al anclar |
| `tamper` | Tapa abierta y sello roto: `COMPROMISED` por el sello |

Para auditar una lectura: `GET /api/iot/cargo/C-1/proof/77?verify=true` devuelve la prueba de Merkle, el payload y
la firma, y le pide al chaincode (`VerifyReading`) que la compruebe contra la raíz anclada. La firma se verifica
contra la clave pública de la valija (`GET /api/iot/devices/VAL-001`).

Todo este recorrido está automatizado en `fabric/network/scripts/api-e2e.sh` (`./network.sh api`), que corre en la CI.

## Tests

```bash
cd backend && npm test                         # formato, firmas, Merkle, ingesta, ventanas y API
cd fabric/chaincode/pharmatrace && go test ./... # chaincode, incluida la cadena de frío
python3 -m unittest discover -s iot/simulator  # simulador (mismo vector de prueba que el backend)
```

## Configuración del gateway

En `backend/.env` (ver `backend/.env.example`): `IOT_GATEWAY_IDENTITY` (identidad que ancla, `<org>:<usuario>`),
`IOT_API_KEY` (clave propia de las rutas que mandan transacciones; si falta se usa `API_KEY`), `IOT_DATA_DIR`,
`IOT_SAMPLE_SECONDS`, `IOT_MAX_CLOCK_SKEW_SECONDS` e `IOT_ANCHOR_INTERVAL_SECONDS` (anclaje automático).
