# Aprender Fabric con PharmaTrace

Una guía corta para entender Hyperledger Fabric a partir de este proyecto. Cada concepto apunta al
archivo donde se usa, así lo leés en la teoría y lo ves en el código. Si venís de Ethereum, la
columna de la derecha de la primera tabla es la traducción rápida.

## 1. El cambio de modelo

| En Ethereum ([Pharmatrace-evm](https://github.com/gastonhp1/Pharmatrace-evm)) | En Fabric (este repo) |
| --- | --- |
| Cualquiera puede tener una cuenta | Cada participante es una **organización** con su CA; las identidades son certificados X.509 |
| Una dirección `0x...` | Un **MSP ID** (`LabMSP`) y un certificado; ver `clientMSP` y `clientID` en `contract/helpers.go` |
| Todos los nodos ejecutan todo | Solo los **peers endosantes** ejecutan; los demás validan firmas |
| El minero ordena y ejecuta | El **orderer** solo ordena; no ve ni ejecuta el código |
| Gas | No hay: los costos son la infraestructura de cada org |
| Datos públicos para todos | Canales y **private data collections** |
| `require(msg.sender == owner)` | Lo mismo en el chaincode **más** las políticas de endorsement, que se chequean al validar |

## 2. El flujo de una transacción (execute → order → validate)

Es lo más importante de Fabric y lo que más preguntan en entrevistas:

1. **Execute (endorse).** El cliente manda la propuesta a los peers que eligió. Cada peer ejecuta
   el chaincode contra su copia del estado, **sin escribir nada**, y devuelve el resultado (el
   *read/write set*) firmado. Por eso el chaincode no puede usar `time.Now()` ni azar: todos tienen
   que llegar a lo mismo. Ver `txTime` en `contract/helpers.go`.
2. **Order.** El cliente junta los endosos y manda la transacción a los orderers, que la meten en un
   bloque. Con Raft (`network/configtx.yaml`, perfil `PharmaTraceChannel`) hay un líder y la red
   tolera la caída de 1 de 3 orderers. El paso 11 del smoke test lo prueba.
3. **Validate.** Cada peer recibe el bloque y, por cada transacción, revisa dos cosas: que los
   endosos cumplan la política, y que lo que leyó no haya cambiado desde la ejecución (MVCC). Si
   falla, la transacción queda en el bloque marcada como inválida y no toca el estado.

Para verlo fallar: el paso 4 de `network/scripts/smoke.sh` manda una recepción firmada por los
peers equivocados. El chaincode la ejecuta sin quejarse, el orderer la ordena, y recién al validar
queda `ENDORSEMENT_POLICY_FAILURE`.

## 3. Políticas de endorsement, de lo general a lo particular

- **Del chaincode** (`CC_POLICY` en `network/scripts/env.sh`): regulador y una org de la cadena.
  Rige para cualquier clave que no tenga una política propia.
- **Por estado (state-based endorsement)**: una política pegada a una clave. Cada lote la tiene, y
  cambia con el lote: al registrarlo es laboratorio + regulador, al despacharlo pasa a ser el
  destinatario + regulador. Es lo que hace que "el dueño" sea un concepto que Fabric hace cumplir
  al validar, no solo un `if` en el código. Ver `setBatchEndorsement` y cómo la usa `saveBatch`.
- **De la colección privada** (`network/collections_config.json`): las escrituras de precios
  necesitan a las dos orgs de ese tramo.

Pregunta para pensar: ¿por qué el chaincode igual chequea que quien llama sea el dueño, si la
política ya lo exige? (Pista: la política habla de qué **peers** firman; el chequeo del código, de
qué **cliente** pidió la operación. Son cosas distintas.)

## 4. Private data collections

Los precios entre laboratorio y droguería viajan en el **transient map**: llegan a los peers pero
no se escriben en la transacción. Solo los peers de las dos orgs guardan el dato; el resto del
canal guarda su hash. Ver `contract/terms.go`:

- `SetCommercialTerms` no devuelve nada a propósito: el valor de retorno queda en el bloque.
- `VerifyCommercialTerms` permite que el regulador compruebe un precio que le mostraron por fuera
  sin tener acceso al dato, comparando hashes.

## 5. Lo que guarda Fabric por vos

- **Historial:** cada versión de una clave queda en el ledger. `GetBatchHistory` usa
  `GetHistoryForKey` y así sale la cadena de custodia sin guardarla a mano.
- **Claves compuestas:** `BatchesByOwner` busca por prefijo en un índice `owner~batch`. Funciona
  con LevelDB, sin CouchDB.
- **Eventos:** uno por transacción (`emit` en `helpers.go`). Un cliente los puede escuchar con
  `network.getChaincodeEvents` del Fabric Gateway SDK; la API todavía no lo hace.

## 6. Ciclo de vida del chaincode

Mirá `deploy` en `network/network.sh`:

1. **Package:** con chaincode como servicio el paquete no tiene código, solo `connection.json` con
   la dirección del contenedor.
2. **Install** en cada peer → da un *package ID*.
3. **Approve:** cada org aprueba la definición (nombre, versión, secuencia, política, colecciones).
4. **Commit:** cuando aprobó la mayoría (política `LifecycleEndorsement` del canal).

Actualizar es lo mismo con la secuencia siguiente. Ninguna org puede cambiar el código de las demás:
cada una aprueba lo que va a correr.

## 7. Del lado del cliente: el Fabric Gateway

`backend/services/fabric.js` es todo lo que la API necesita para hablar con la red:

- Se conecta a **un solo peer** (el de su org). Ese peer hace de *gateway*: pide los endosos a los peers de las
  otras orgs, arma la transacción y la manda a los orderers. El cliente no conoce a los orderers.
- `evaluate` es una consulta: corre en un peer y no se ordena. `submit` es una transacción: endoso, orden y
  espera del commit.
- `endorsingOrganizations` dice qué orgs tienen que firmar. `backend/services/pharmatrace.js` las elige según la
  política de cada operación (tenedor + regulador, vendedor + comprador...).
- `transientData` es por donde viajan los precios privados: llegan a los peers pero no a la transacción.
- Los errores vuelven con el mensaje de cada peer; la API busca el código (`NOT_FOUND: ...`) y lo traduce a HTTP.
  Si dos transacciones tocan la misma clave a la vez, la segunda falla al validar (`MVCC_READ_CONFLICT`) y la API
  responde 409.

## 8. Ejercicios sugeridos

1. Levantá la red, corré el smoke y después hacé a mano un despacho de la droguería a la farmacia
   con `peer chaincode invoke` (copiá la función `invoke` del smoke).
2. Pará `orderer0` y `orderer1` a la vez e intentá una transacción. ¿Qué pasa y por qué?
3. Cambiá `CC_POLICY` para que el regulador no sea obligatorio, redesplegá con
   `CC_VERSION=0.2 ./network.sh deploy` y probá registrar una org endosando solo con `lab`.
4. Agregá al chaincode una función `ExpiredBatches` que liste los lotes vencidos usando la fecha
   de la transacción, con su test en `contract/batch_test.go`.
5. Mirá las métricas de un peer: `curl localhost:9451/metrics | grep ledger_blockchain_height`.

## 9. Referencias

- Documentación oficial: https://hyperledger-fabric.readthedocs.io (sección *Key Concepts*)
- Endorsement policies y SBE: https://hyperledger-fabric.readthedocs.io/en/latest/endorsement-policies.html
- Private data: https://hyperledger-fabric.readthedocs.io/en/latest/private-data/private-data.html
- Chaincode as a service: https://hyperledger-fabric.readthedocs.io/en/latest/cc_service.html
- `fabric-samples/test-network`, de donde salen muchas de las ideas de `network/`.
