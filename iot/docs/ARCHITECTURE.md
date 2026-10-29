# Arquitectura IoT de PharmaTrace

La **valija** (caja de transporte con sensores) viaja con un **cargamento**: un grupo de lotes que va de una
organización a la siguiente. Mide el estado de los lotes, firma cada medición y un gateway las verifica y deja
evidencia en el ledger de Fabric.

```
 valija (ESP32 + sensores + ATECC608)
   │  lecturas firmadas (21 B + firma 64 B)
   ▼
 gateway  ──  POST /api/iot/readings  (backend/, Express)
   │  1. verifica la firma con la clave pública registrada en el ledger (GetDevice)
   │  2. rechaza repeticiones, desorden y relojes en el futuro
   │  3. guarda la lectura (hoy: archivo; en producción: base de datos)
   │
   │  cada tanto (o a pedido): POST /api/iot/cargo/:id/anchor
   ▼  Fabric Gateway, con la identidad del gateway IoT (DistMSP IotGateway), endosado por su org + el regulador
 chaincode AnchorWindow        raíz de Merkle + mín/máx + segundos fuera de rango
 chaincode ReportDeviceEvent   tapa abierta / golpe / sello roto
   │
   ▼
 veredicto:  MONITORING → COMPLIANT | COMPROMISED
```

## Qué va al ledger y qué no

| Dato | Dónde | Por qué |
| --- | --- | --- |
| Clave pública de la valija, org dueña, vencimiento de calibración | `RegisterDevice` | Cualquiera puede re-verificar una firma |
| Política (rango y presupuesto de excursión) | `SetColdChainPolicy` (solo el regulador) | Inmutable: un cargamento se juzga con las reglas con las que salió |
| Raíz de Merkle por ventana de lecturas | `AnchorWindow` | Una sola raíz prueba cientos de lecturas |
| Segundos fuera de rango, mín/máx por ventana | `AnchorWindow` | El chaincode decide el veredicto con esto |
| Eventos (tipo, hora, hash de la lectura) | `ReportDeviceEvent` | Quedan en el registro de monitoreo para la auditoría |
| Lecturas crudas | Backend (archivo/BD) | No aportan nada que la raíz no pruebe, y engordarían el ledger de todas las orgs |

Para auditar una lectura: `GET /api/iot/cargo/:id/proof/:seq?verify=true` devuelve la prueba, el payload y la firma,
y le pide al chaincode (`VerifyReading`) que compruebe la prueba contra la raíz anclada. La firma se verifica contra
la clave de `GetDevice`.

## Quién puede qué

- **Cada org** registra sus valijas (`RegisterDevice`) y las da de baja (`SetDeviceActive`). El regulador también.
- **El regulador** fija las políticas y acepta los gateways de una org (`AuthorizeGatewayOrg`). Qué identidad es un
  gateway lo dice su certificado: el atributo `pharmatrace.role=iot-gateway`, que solo puede poner la CA de esa org.
  Para dar de baja un gateway, la org revoca su certificado y publica la CRL ([`fabric/docs/PKI.md`](../../fabric/docs/PKI.md)).
- **El dueño del cargamento o un gateway autorizado** empieza el monitoreo (`StartMonitoring`). La valija tiene que
  estar activa, calibrada y libre.
- **Solo un gateway autorizado** ancla ventanas y reporta eventos.
- **El tenedor del cargamento** (el dueño, o el destinatario mientras viaja) **o un gateway** lo cierra
  (`CloseMonitoring`), y la valija queda libre.

Los lotes del cargamento comparten el veredicto. Un veredicto `COMPROMISED` no bloquea los lotes: es evidencia para
que el regulador decida un recall (`RecallBatch`).

## Reglas de veredicto

- Segundos acumulados fuera de rango **>** presupuesto de la política → `COMPROMISED`.
- Evento `SEAL_BROKEN` → `COMPROMISED` en el acto.
- `LID_OPENED` y `SHOCK` se registran para la auditoría pero no son fatales (la tapa se abre en cada traspaso).
- `CloseMonitoring` sin problemas → `COMPLIANT`. Después de cerrar el veredicto es final.

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
- **Valores y exigencias regulatorias:** los límites y presupuestos de ejemplo no son de ningún producto. Los
  reales salen de los datos de estabilidad, y hay que validar con calidad/regulatorio (ANMAT, BPD/GDP) qué evidencia
  se exige y durante cuánto tiempo.
- **Calibración trazable:** el vencimiento en el ledger es la fecha que carga la org; el certificado de calibración
  del sensor (laboratorio acreditado) es el que le da valor.
- **Custodia de claves:** ver `THREAT_MODEL.md`.
- **Reloj del dispositivo:** se espera GPS o RTC sincronizado. El gateway rechaza lo que está en el futuro, pero no
  detecta un reloj atrasado de forma consistente.
