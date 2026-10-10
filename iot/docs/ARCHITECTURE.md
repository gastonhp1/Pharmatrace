# Arquitectura IoT de PharmaTrace

La **valija** (caja de transporte con sensores) viaja con un **cargamento** de `CargoTracker`. Mide el estado
del lote, firma cada medición y un gateway las verifica y deja evidencia en la cadena.

```
 valija (ESP32 + sensores + ATECC608)
   │  lecturas firmadas (21 B + firma 64 B)
   ▼
 gateway  ──  POST /api/iot/readings  (backend/, Express)
   │  1. verifica la firma con la clave pública registrada on-chain
   │  2. rechaza repeticiones, desorden y relojes en el futuro
   │  3. guarda la lectura (hoy: archivo; en producción: base de datos)
   │
   │  cada tanto (o a pedido): POST /api/iot/cargo/:id/anchor
   ▼
 ColdChainMonitor.anchorReadings   raíz de Merkle + mín/máx + segundos fuera de rango
 ColdChainMonitor.reportEvent      tapa abierta / golpe / sello roto
   │
   ▼
 veredicto:  Monitoring → Compliant | Compromised
```

## Qué va on-chain y qué no

| Dato | Dónde | Por qué |
| --- | --- | --- |
| Clave pública del dispositivo, vencimiento de calibración | `DeviceRegistry` | Cualquiera puede re-verificar una firma |
| Política (rango y presupuesto de excursión) | `ColdChainMonitor` | Inmutable: un cargamento se juzga con las reglas con las que salió |
| Raíz de Merkle por ventana de lecturas | `ColdChainMonitor` | Una sola raíz prueba cientos de lecturas |
| Segundos fuera de rango, mín/máx por ventana | `ColdChainMonitor` | El contrato decide el veredicto con esto |
| Lecturas crudas | Backend (archivo/BD) | Costarían gas por cada punto y no aportan nada que la raíz no pruebe |

Para auditar una lectura: `GET /api/iot/cargo/:id/proof/:seq` devuelve la prueba, el payload y la firma. Con eso
se verifica en `ColdChainMonitor.verifyReading` que la lectura pertenece a una ventana anclada, y contra la clave
de `DeviceRegistry` que la firmó el dispositivo.

## Contratos

- **`DeviceRegistry`**: dueño (el fabricante) registra dispositivos y *attestors* (las cuentas del gateway).
  `isOperationalAt(deviceId, ts)` dice si el dispositivo estaba activo y calibrado en ese momento: así se puede
  anclar una ventana tarde (tras un corte de conectividad) siempre que el dispositivo estuviera calibrado cuando midió.
- **`ColdChainMonitor`**: vincula un dispositivo a un cargamento bajo una política (`startMonitoring`), recibe
  ventanas (`anchorReadings`) y eventos (`reportEvent`) solo de attestors, y cierra con un veredicto
  (`closeMonitoring`). Chequea que las ventanas vengan en orden, sin solaparse y sin ser del futuro, y que una
  ventana con temperatura fuera de rango informe tiempo fuera de rango.

`DrugTracker` y `CargoTracker` **no se tocaron**. Un lote avanza por estados y no retrocede, así que un cargamento
comprometido se informa en `ColdChainMonitor.getVerdict` y con el evento `CargoCompromised`, en vez de agregar un
estado a los lotes. Los lotes del cargamento comparten el veredicto (se obtienen de `CargoTracker.getCargoInfo`).

## Reglas de veredicto

- Segundos acumulados fuera de rango **>** presupuesto de la política → `Compromised`.
- Evento `SealBroken` → `Compromised` en el acto.
- `LidOpened` y `Shock` se registran para la auditoría pero no son fatales (la tapa se abre en cada traspaso).
- `closeMonitoring` sin problemas → `Compliant`. Después de cerrar el veredicto es final y el dispositivo queda libre.

### Cómo se cuenta el tiempo fuera de rango

Se mantiene el último valor hasta la siguiente lectura (*sample-and-hold*): una lectura fuera de rango cuenta hasta
la próxima. La última lectura de una ventana todavía no tiene próxima, así que cuenta un período de muestreo
(`IOT_SAMPLE_SECONDS`, 60 por defecto). Es una aproximación conservadora y determinista.

## Qué falta para producción

Es un prototipo. Lo que hay que resolver antes de usarlo con medicamentos reales:

- **Persistencia:** el gateway guarda las lecturas en archivos y asume un solo proceso. Hay que pasarlas a una
  base de datos con respaldo: son la evidencia que la raíz de Merkle prueba, y si se pierden la prueba no sirve.
- **Huecos de datos:** si el dispositivo se apaga o pierde lecturas, hoy no se detecta. Una ventana con un hueco
  mayor a N períodos debería marcarse (y quizá contar como excursión).
- **Valores y exigencias regulatorias:** los límites y presupuestos de `deploy-iot.js` son de ejemplo. Los reales
  salen de los datos de estabilidad del producto, y hay que validar con calidad/regulatorio (ANMAT, BPD/GDP) qué
  evidencia se exige y durante cuánto tiempo.
- **Calibración trazable:** el vencimiento on-chain es la fecha que cargue el dueño; el certificado de calibración
  del sensor (laboratorio acreditado) es el que le da valor.
- **Autenticación de la API y custodia de claves:** ver `THREAT_MODEL.md`.
- **Reloj del dispositivo:** se espera GPS o RTC sincronizado. El gateway rechaza lo que está en el futuro, pero no
  detecta un reloj atrasado de forma consistente.
