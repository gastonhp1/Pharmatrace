# Modelo de amenazas (v1)

La pregunta de fondo: la blockchain garantiza que un dato **no se modifica después de escrito**, no que el
sensor **midió bien**. Todo esto trata de achicar esa brecha. Qué cubre el diseño actual y qué no:

| Amenaza | Qué pasa hoy | Qué falta |
| --- | --- | --- |
| Alguien inventa lecturas | Se rechazan: la firma tiene que verificar contra la clave registrada del dispositivo | — |
| Se edita una lectura guardada en el gateway | La prueba de Merkle deja de verificar contra la raíz anclada | — |
| Se repite una lectura vieja (replay) | Se rechaza por `seq` y `ts` no crecientes. Un reenvío exacto cuenta como duplicado, no como error | — |
| Se borran lecturas del gateway | Lo anclado se puede detectar (la raíz no cuadra), pero las lecturas **se pierden** | Base de datos con respaldo. Hoy es un punto único de falla |
| Se descarta el tramo malo y solo se envía el bueno | No se detecta | Detección de huecos (`seq` salteado, hueco de tiempo) |
| Se clona o extrae la clave del dispositivo | Con secure element la clave no sale del chip | Aprovisionar con secure boot + flash encryption, bloquear el chip, y dar de baja con `revokeDevice` |
| Se manipula el sensor físicamente (por ejemplo, se lo enfría artificialmente) | No se detecta | Dos sensores redundantes y comparar; sensor de tapa/luz; sello NFC inviolable; inspección |
| Sensor descalibrado | `anchorReadings` y el gateway rechazan lecturas de un dispositivo sin calibración vigente | Certificado de calibración trazable detrás de la fecha |
| Reloj adelantado | El gateway rechaza timestamps del futuro (con tolerancia) y el contrato rechaza ventanas del futuro | Reloj atrasado: no se detecta de forma consistente |
| El gateway miente | Es el attestor: puede anclar lo que quiera. Por eso `IOT_GATEWAY_KEY` va separada del fabricante y hay una clave de API para las rutas que mandan transacciones | Varios attestors o verificación independiente; auditar con `proof` (las firmas del dispositivo se pueden volver a verificar sin confiar en el gateway) |
| Spam de lecturas al gateway | Solo se aceptan firmas válidas de dispositivos con monitoreo activo | Límite de tasa |
| Quien llegue a la API administra | Las rutas que mandan transacciones piden `x-api-key` (`IOT_API_KEY`, o `API_KEY` si no hay otra; sin ninguna responden 503) | El resto de las escrituras usa la misma clave compartida y es custodial, como dice el README |

## Notas

- La clave del dispositivo **nunca** se guarda ni se transmite. El simulador la deja en un archivo `.pem` con
  permisos `600` solo porque simula; en el ESP32 vive en el ATECC608.
- Las claves privadas del `.env` son del backend (custodial). `IOT_GATEWAY_KEY` hace que el poder de attestar no
  sea el del fabricante, pero sigue siendo una clave en un servidor.
- Una raíz anclada prueba **qué** se midió y **cuándo se registró**, no que el mundo físico fuera así. Es evidencia
  para una auditoría, no un sustituto de ella.
