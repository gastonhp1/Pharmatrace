# Valija PharmaTrace: hardware propuesto (v0)

Primera propuesta para el nodo que viaja dentro de la valija. **No está probada con hardware real**: es el punto de
partida para armar el prototipo y para el repo del firmware. Se omiten precios a propósito (cambian rápido).

## Decisión: ESP32-S3, no Raspberry Pi

| | ESP32-S3 | Raspberry Pi |
| --- | --- | --- |
| Consumo | Muy bajo, con *deep sleep* | Alto: una batería razonable se agota en horas |
| Autonomía en una valija | Días a semanas, según el período de muestreo | Necesita power bank grande |
| Qué corre | Firmware que muestrea, firma y sube | Linux completo: cámara, ML en el borde, mucho cómputo |
| Cuándo conviene | **El nodo de la valija** | Un gateway fijo o de camión que agrupe varios nodos por BLE (fase 2) |

El nodo no necesita Linux: muestrea, firma con el secure element y sube lotes de lecturas.

## Lista de partes

Todo lo de sensado y seguridad comparte un solo bus I2C (las direcciones por defecto no chocan).

| Función | Parte sugerida | Interfaz | Notas |
| --- | --- | --- | --- |
| Microcontrolador | ESP32-S3 (módulo WROOM-1) | — | WiFi/BLE nativo; *secure boot* y *flash encryption* |
| Temperatura (principal) | TMP117 | I2C 0x48 | ±0.1 °C entre -20 y 50 °C. Para 2–8 °C la precisión importa |
| Temperatura (redundante) | TMP117 (2.º) | I2C 0x49 | Dirección por pin ADD0. Comparar los dos detecta una falla o una manipulación |
| Humedad | SHT45 | I2C 0x44 | Útil para ambiente y para detectar condensación |
| Apertura de tapa | Reed switch + imán, o sensor Hall | GPIO (interrupción) | Despierta al micro del *deep sleep* |
| Luz dentro de la caja | VEML7700 | I2C 0x10 | Segundo indicio de apertura (por si el reed se anula) |
| Golpes / inclinación | LIS3DH | I2C 0x18 | Con interrupción por umbral; sirve también para detectar caídas |
| Ubicación | u-blox NEO-M8N o Quectel L76K | UART | También da la hora para `ts`. Antena con vista al cielo (ver nota de ubicación) |
| Conectividad celular | SIMCom A7670 (LTE Cat-1) o SIM7080G (LTE-M/NB-IoT) | UART | **Verificar cobertura real de cada tecnología con el operador antes de elegir** |
| Identidad y firma | ATECC608B | I2C 0x60 | Clave P-256 que no sale del chip; firma SHA-256 por hardware |
| Batería | LiPo o 18650 + cargador con protección | — | Con medidor MAX17048 (I2C 0x36) para reportar el nivel |
| Lector NFC (opcional) | PN532 | I2C 0x24 | Traspasos de custodia y verificación del sello |
| Sello inviolable (opcional) | Tags NTAG 424 DNA | NFC | Autenticación criptográfica anti-clonado |
| Caja | Contenedor aislado + geles/PCM | — | La valija termina el trabajo pasivo; el nodo solo mide |

## Cosas a validar en el prototipo

1. **Cobertura celular en las rutas reales.** LTE-M/NB-IoT suele ser más escaso que Cat-1; Cat-1 consume más. No lo
   doy por sentado: probarlo en los recorridos y con el operador elegido.
2. **Ubicación de los sensores.** Las sondas de temperatura tienen que medir lo que sienten los medicamentos (cerca
   del lote), no el aire de la tapa. El GPS necesita ver el cielo: antena externa o ventana en la caja.
3. **Período de muestreo vs. autonomía.** Define `IOT_SAMPLE_SECONDS` y el tamaño de las ventanas. Medir el consumo
   real con el módem celular, que suele dominar.
4. **Calibración.** Los TMP117 vienen calibrados de fábrica, pero para una auditoría hace falta el certificado de un
   laboratorio acreditado; esa fecha es el `calibrationExpiry` que se registra on-chain.
5. **Almacenamiento sin conexión.** Guardar lecturas en flash (o una microSD) mientras no hay señal y subirlas al
   volver, conservando `seq` y `ts` originales.
6. **Aprovisionamiento seguro.** Generar la clave en el ATECC608B, leer solo la clave pública, bloquear la
   configuración del chip, y activar *secure boot* + *flash encryption* del ESP32 antes de entregar la valija.

## Pendiente (repo de firmware, aparte)

El firmware vive en otro repo. Tiene que producir exactamente el formato de `iot/docs/READING_FORMAT.md`; el vector
de prueba de ese documento es el contrato entre ambos.
