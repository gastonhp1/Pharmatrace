# Formato de una lectura (v1)

Contrato entre el firmware, el simulador y el gateway. Si cambia, cambia en los tres.

Una lectura son **21 bytes, big-endian**:

| Offset | Tamaño | Campo | Tipo | Notas |
| --- | --- | --- | --- | --- |
| 0 | 4 | `ts` | uint32 | Segundos Unix. Sale del GPS o de un RTC sincronizado |
| 4 | 4 | `seq` | uint32 | Contador del dispositivo, estrictamente creciente. Tiene que sobrevivir a un reinicio (NVS) |
| 8 | 2 | `tempCenti` | int16 | Centésimas de °C: 4.50 °C = `450`, -18.50 °C = `-1850` |
| 10 | 2 | `humCenti` | uint16 | Centésimas de % de humedad relativa |
| 12 | 1 | `flags` | uint8 | bit0 tapa abierta, bit1 golpe, bit2 sello roto |
| 13 | 4 | `latE5` | int32 | Latitud × 10⁵ (≈ 1 m de resolución) |
| 17 | 4 | `lonE5` | int32 | Longitud × 10⁵ |

## Firma

El dispositivo firma **SHA-256(payload)** con ECDSA sobre P-256 (secp256r1). Es lo que hace nativamente un
ATECC608: calcula el hash y firma sin que la clave privada salga del chip. La firma va como los 64 bytes
crudos `r || s` (no DER).

La clave pública son 64 bytes `X || Y` (sin el prefijo `0x04`). Es la que se registra en
`DeviceRegistry.registerDevice`.

## Hoja del árbol de Merkle

`leaf = keccak256(payload)`. Es lo que recibe `ColdChainMonitor.verifyReading`. Los pares se hashean en
orden (el menor primero), así que una prueba es solo la lista de hermanos. Si un nivel tiene cantidad
impar de nodos, el último sube sin duplicarse.

## Vector de prueba

Lo usan los tests del backend (`backend/test/iot.test.js`) y del simulador
(`iot/simulator/test_simulator.py`). El firmware tiene que producir exactamente lo mismo:

```
ts=1800000000 seq=7 tempCenti=450 humCenti=5500 flags=0x05 latE5=-3460000 lonE5=-5840000

payload  6b49d2000000000701c2157c05ffcb3460ffa6e380
sha256   43ad8f8f0c31a6e3f656767b2bf00e225356013dc85e71f562b59a015ac0c455
keccak   0xd9660574558f738b306ff80d9fb150ab4ca32763de0c5b746102f0f4d4bdb1a4
```

## Por qué así

- **P-256 y no secp256k1:** es lo que soporta el ATECC608 en hardware. El costo es que el contrato no verifica
  la firma (hacerlo en Solidity puro es carísimo, y depender de un precompile P-256 ata el proyecto a las redes
  que lo tengan; la EVM local de Hardhat no): la verifica el gateway y el contrato guarda la clave pública para
  que cualquiera pueda volver a verificarla fuera de la cadena.
- **`seq` además de `ts`:** permite detectar repeticiones y huecos aunque el reloj del dispositivo se
  desajuste.
- **Enteros y no floats:** el mismo byte en el chip, en Node y en Python, sin sorpresas de redondeo.
