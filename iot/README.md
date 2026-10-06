# PharmaTrace IoT: cadena de frío

Una **valija** con sensores viaja con un cargamento, mide el estado del lote y firma cada lectura. Un gateway (en
`backend/`) verifica las firmas y deja evidencia en la cadena: una raíz de Merkle por ventana de lecturas, el
tiempo fuera de rango y los eventos (tapa, golpe, sello roto). El resultado es un veredicto por cargamento:
`Compliant` o `Compromised`.

| Carpeta | Qué hay |
| --- | --- |
| [`docs/`](docs) | [Arquitectura](docs/ARCHITECTURE.md), [formato de lectura](docs/READING_FORMAT.md) y [modelo de amenazas](docs/THREAT_MODEL.md) |
| [`hardware/`](hardware) | [Lista de partes propuesta](hardware/BOM.md) (ESP32-S3 + sensores + ATECC608B) |
| [`simulator/`](simulator) | Valija virtual en Python: genera lecturas firmadas igual que el dispositivo real |

Los contratos están en `../contracts/` (`DeviceRegistry.sol`, `ColdChainMonitor.sol`) y el gateway en
`../backend/` (`routes/iot.js`, `services/iotService.js` y `iot/`). El firmware irá en un repo aparte.

## Probarlo sin hardware

Con la red local y los contratos de lotes y cargamentos desplegados (ver el README de la raíz):

```bash
# 1. Desplegar los contratos IoT (guarda las direcciones en los .env y exporta los ABIs)
npm run deploy:iot

# 2. Levantar el backend
cd backend && npm start        # http://localhost:3001

# 3. Instalar el simulador y crear la clave del dispositivo (imprime la clave pública)
pip install -r iot/simulator/requirements.txt
python3 iot/simulator/simulator.py keygen --key valija.pem
```

Después, con un cargamento ya creado (`POST /api/cargo/create`), por ejemplo `C-1`:

```bash
# 4. Registrar la valija (la clave pública es la que imprimió keygen) y empezar a monitorear
curl -X POST localhost:3001/api/iot/devices -H 'content-type: application/json' \
  -d '{"deviceId":"VAL-001","pubKey":"0x...","calibrationExpiry":1893456000}'
curl -X POST localhost:3001/api/iot/monitoring/start -H 'content-type: application/json' \
  -d '{"cargoId":"C-1","deviceId":"VAL-001","policyId":"pharma-2-8c"}'

# 5. Simular el viaje: normal | excursion | tamper
python3 iot/simulator/simulator.py run --key valija.pem --device-id VAL-001 --scenario excursion --count 120

# 6. Anclar las lecturas, ver el veredicto y cerrar
curl -X POST localhost:3001/api/iot/cargo/C-1/anchor
curl localhost:3001/api/iot/cargo/C-1
curl -X POST localhost:3001/api/iot/monitoring/close -H 'content-type: application/json' -d '{"cargoId":"C-1"}'
```

Qué esperar con la política de ejemplo `pharma-2-8c` (2–8 °C, hasta 30 min fuera de rango en total):

| Escenario | Resultado |
| --- | --- |
| `normal` | `Compliant` al cerrar |
| `excursion --count 60` | Un tercio del viaje a ~10 °C: 20 min fuera de rango, dentro del presupuesto. `Compliant` |
| `excursion --count 120` | 40 min fuera de rango: supera el presupuesto, `Compromised` al anclar |
| `tamper` | Tapa abierta y sello roto: `Compromised` por el sello |

Para auditar una lectura: `GET /api/iot/cargo/C-1/proof/77` devuelve la prueba de Merkle, el payload y la firma.
La prueba se verifica con `ColdChainMonitor.verifyReading` y la firma contra la clave de `DeviceRegistry`.

## Tests

```bash
npm test                                      # contratos (incluye DeviceRegistry y ColdChainMonitor)
npm run test:backend                          # formato, firmas, Merkle, ingesta y ventanas
python3 -m unittest discover -s iot/simulator # simulador (mismo vector de prueba que el backend)
```

## Configuración del gateway

Variables opcionales en `backend/.env` (ver `backend/.env.example`): `IOT_GATEWAY_KEY` (cuenta que atesta,
separada del fabricante), `IOT_API_KEY` (protege las rutas que mandan transacciones), `IOT_DATA_DIR`,
`IOT_SAMPLE_SECONDS`, `IOT_MAX_CLOCK_SKEW_SECONDS` e `IOT_ANCHOR_INTERVAL_SECONDS` (anclaje automático).
Sin `DEVICE_REGISTRY_ADDRESS` y `COLD_CHAIN_MONITOR_ADDRESS` las rutas IoT responden 503 y el resto de la API
funciona igual.
