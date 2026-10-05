# PharmaTrace

Trazabilidad de medicamentos sobre blockchain. Cada lote de un medicamento se registra en un
smart contract y queda con un historial inmutable de quién lo tuvo y en qué estado, desde el
laboratorio hasta el paciente. Los lotes se pueden agrupar en cargamentos para seguir el
transporte.

> Es un prototipo pensado para correr en una red local de Hardhat. No está listo para
> producción: ver [Limitaciones conocidas](#limitaciones-conocidas).

El proyecto tiene tres partes:

| Parte | Dónde | Qué hace |
| --- | --- | --- |
| Smart contracts | este repo, `contracts/` | `DrugTracker` (lotes) y `CargoTracker` (cargamentos). Solidity 0.8.20 + Hardhat |
| Backend | este repo, `backend/` | API REST (Express + ethers v6) que firma y envía las transacciones |
| Frontend | [PharmaTrace-UI](https://github.com/gastonhp1/PharmaTrace-UI) | Interfaz web (React + Vite) |

## Cómo funciona

### Actores

Fabricante (`manufacturer`), distribuidor (`distributor`), depósito (`warehouse`), farmacia
(`pharmacy`) y paciente (`patient`). Cada uno es una cuenta Ethereum.

### Estados de un lote y cadena de custodia

Cada actor tiene un **rol** registrado on-chain, y un lote solo puede pasar al rol siguiente de
la cadena. El estado que toma el lote lo define el rol del receptor:

| Valor | Estado | Cómo se llega |
| --- | --- | --- |
| 0 | `Registered` | El fabricante registra el lote |
| 1 | `InDistribution` | Fabricante → distribuidor |
| 2 | `InTransit` | Distribuidor → depósito |
| 3 | `InPharmacy` | Depósito → farmacia |
| 4 | `Delivered` | Farmacia → paciente |
| 5 | `InUse` | El paciente llama a `markInUse` |

### Reglas de `DrugTracker`

- El dueño del contrato (quien lo despliega) es el fabricante y el único que puede registrar
  lotes y dar roles a los demás con `registerActor(address, role)`.
- Solo el dueño actual de un lote puede transferirlo, y cada transferencia agrega al nuevo dueño
  al historial (`getDrugHistory`).
- El destinatario tiene que tener el rol siguiente al del que transfiere (no se saltean pasos ni
  se retrocede) y `newState` tiene que coincidir con ese rol; si no, la transacción revierte.
- `markInUse` solo lo puede hacer un paciente que sea dueño de un lote `Delivered`.
- Mientras un lote viaja en un cargamento (`inCargo`) no se puede transferir por fuera.
- `setCargoTracker` apunta el contrato a su `CargoTracker`, el único que puede bloquear,
  desbloquear y mover lotes de un cargamento. `forceUnlock` (solo el dueño) libera un lote que
  quedó bloqueado por un `CargoTracker` reemplazado.

### Reglas de `CargoTracker`

- Se despliega apuntando a un `DrugTracker`, que a su vez tiene que apuntarle con
  `setCargoTracker` (los scripts de deploy lo hacen).
- `createCargo` exige al menos un lote y un máximo de 100; quien lo crea tiene que ser dueño de
  todos, y un lote no puede estar en dos cargamentos ni repetido.
- `transferCargo(cargoId, to, newState)` mueve el cargamento **y todos sus lotes** juntos, con las
  mismas reglas de rol y estado de `DrugTracker`. Si un lote falla, no se mueve nada.
- `markDelivered` cierra el cargamento (una sola vez, emite `CargoDelivered`) y desbloquea los
  lotes, que quedan con el dueño actual y siguen la cadena de a uno. Un cargamento entregado no
  se puede transferir.

## Estructura

```
PharmaTrace/
├── contracts/              Smart contracts (DrugTracker.sol, CargoTracker.sol)
├── test/                   Tests de Hardhat de los contratos
├── scripts/                Deploy, interacción y exportación
│   ├── abi/                ABIs, metadata y historial de despliegues
│   └── helpers/            Balances, firmantes y carga de variables de entorno
├── backend/                API Node.js
│   ├── routes/             Rutas de cargamentos
│   ├── services/           Lógica con ethers (lotes, cargamentos, firmantes)
│   └── utils/              Validación y manejo de errores
├── hardhat.config.js       Configuración de Hardhat
└── README.md
```

## Requisitos

- Node.js (probado con la versión 22) y npm.
- Para el frontend, el repo [PharmaTrace-UI](https://github.com/gastonhp1/PharmaTrace-UI)
  clonado **al lado** de este (`../PharmaTrace-UI`), porque los scripts de deploy le exportan
  el ABI y la dirección del contrato.

## Instalación y tests

```bash
npm install
npm run compile
npm test
```

Los tests corren en la red en memoria de Hardhat, sin `.env`. Son 59, entre
`DrugTracker` y `CargoTracker`.

## Correr todo en local

### 1. Configurar las claves

Creá un `.env` en la raíz con una clave privada por actor. En local podés usar las cuentas que
imprime `npx hardhat node` (no uses nunca claves reales):

```bash
MANUFACTURER_KEY=0x...
DISTRIBUTOR_KEY=0x...
WAREHOUSE_KEY=0x...
PHARMACY_KEY=0x...
PATIENT_KEY=0x...
```

La clave del fabricante tiene que ser la de la primera cuenta de la red: es la que despliega
los contratos, así que queda como su dueño y como fabricante.

### 2. Levantar la red local

```bash
npx hardhat node
```

### 3. Desplegar los contratos

En otra terminal:

```bash
npm run deploy:all
```

Despliega `DrugTracker` y `CargoTracker`, registra el rol de cada actor (las direcciones salen
de las `*_KEY`), vincula ambos contratos con `setCargoTracker` y:

- escribe `backend/.env` con `CONTRACT_ADDRESS`, `CARGO_CONTRACT_ADDRESS`, `RPC_URL` y las cinco claves;
- exporta los ABIs, las direcciones y los datos de los actores a `../PharmaTrace-UI/src/`.

Los scripts de `scripts/` leen sus variables del `.env` de la raíz y, si falta alguna, de
`backend/.env`, así que después de este paso ya usan las direcciones sin copiarlas a mano.

Si solo necesitás volver a desplegar `CargoTracker` (también se lo vincula al `DrugTracker`;
los lotes que seguían bloqueados en el anterior se liberan con `forceUnlock`):

```bash
npx hardhat run scripts/deploy-cargo.js --network localhost
```

Actualiza `CARGO_CONTRACT_ADDRESS` en el `.env` de la raíz y en `backend/.env` (si existe), sin
duplicar la línea.

### 4. Levantar el backend

```bash
cd backend
npm install
npm start
```

Escucha en `http://localhost:3001` (o el `PORT` que definas). Hay una plantilla en
`backend/.env.example`.

### 5. Probar con ejemplos

```bash
node scripts/interact.js BATCH-001   # registra un lote y lo pasa por toda la cadena
node scripts/traceDrug.js BATCH-001  # muestra su trazabilidad
node scripts/cargo-interact.js       # crea un cargamento con 2 lotes, lo transfiere (los lotes lo siguen) y lo entrega
```

`interact.js` se puede volver a correr sobre el mismo lote: saltea lo que ya se hizo y sigue
desde donde quedó. `cargo-interact.js` registra sus propios lotes.

## API

Cada operación sobre un lote o cargamento existente se firma con la clave del **dueño actual**:
el backend consulta quién es en la blockchain y busca esa dirección entre las claves `*_KEY`
configuradas. Si el dueño no tiene clave configurada, responde 403.

| Método | Ruta | Body |
| --- | --- | --- |
| GET | `/api/drug/:batchId` | (la respuesta incluye `inCargo`) |
| POST | `/api/register` | `batchId`, `drugName`, `manufacturer` |
| POST | `/api/transfer` | `batchId`, `toAddress`, `newState` (el que corresponde al rol del receptor, 1 a 4) |
| POST | `/api/mark-in-use` | `batchId` (lo firma el paciente dueño del lote) |
| POST | `/api/cargo/create` | `cargoId`, `batchIds[]` |
| GET | `/api/cargo/:cargoId` | |
| POST | `/api/cargo/transfer` | `cargoId`, `toAddress`, `newState` (se aplica a todos sus lotes) |
| POST | `/api/cargo/deliver` | `cargoId` |

Ejemplo:

```bash
curl -X POST localhost:3001/api/register \
  -H 'content-type: application/json' \
  -d '{"batchId":"B-100","drugName":"Ibuprofeno 400mg","manufacturer":"Laboratorio X"}'

curl -X POST localhost:3001/api/transfer \
  -H 'content-type: application/json' \
  -d '{"batchId":"B-100","toAddress":"0x...distribuidor","newState":1}'
```

Errores (siempre `{"error": "<motivo>"}`):

| Código | Cuándo |
| --- | --- |
| 400 | Datos inválidos (campo vacío, dirección mal formada, `newState` fuera de 0 a 5) o que no coincide con el rol del receptor; cargamento vacío o de más de 100 lotes |
| 403 | No es el dueño actual, no es paciente (`mark-in-use`), o el dueño no tiene clave configurada |
| 404 | El lote o cargamento no existe |
| 409 | Ya existe, receptor con un rol que no es el siguiente, lote ya en un cargamento (o bloqueado en uno), cargamento ya entregado, o los lotes de un cargamento tienen distinto dueño |
| 500 | Error inesperado (red caída, configuración incompleta) |

## Scripts

| Script | Cómo se corre | Qué hace |
| --- | --- | --- |
| `deploy.js` | `npm run deploy` | Despliega `DrugTracker` y `CargoTracker`, registra los roles y los vincula |
| `deploy-to-env-and-frontend.js` | `npm run deploy:all` | Despliega `DrugTracker` y `CargoTracker` y exporta `backend/.env`, ABIs y archivos del frontend |
| `export-artifacts.js` | `npm run export:frontend` | Variante de `deploy:all` que además guarda metadata e historial de despliegues y escribe `.env.public` para Vite |
| `deploy-cargo.js` | `npx hardhat run scripts/deploy-cargo.js --network localhost` | Despliega solo `CargoTracker`, lo vincula al `DrugTracker` y actualiza `CARGO_CONTRACT_ADDRESS` en los `.env` |
| `full-trace.js` | `npx hardhat run scripts/full-trace.js --network localhost` | Registra y transfiere un lote de prueba por toda la cadena, con las cuentas de Hardhat |
| `traceDrug.js` | `node scripts/traceDrug.js <BATCH>` | Imprime la trazabilidad de un lote existente |
| `interact.js` | `node scripts/interact.js <BATCH>` | Registra un lote y lo pasa por toda la cadena hasta el paciente; se puede reanudar |
| `cargo-interact.js` | `node scripts/cargo-interact.js` | Registra 2 lotes, crea un cargamento, lo transfiere por 3 actores y lo entrega |

## Limitaciones conocidas

**Seguridad**

- La API no tiene autenticación y es custodial: quien llegue al servidor puede registrar lotes y
  mover la custodia con las claves configuradas. Los "actores" son variables de entorno, no
  entidades que firmen con su propia wallet.

**Contratos**

- La cadena es fija (fabricante → distribuidor → depósito → farmacia → paciente): no hay otro
  recorrido posible ni devoluciones.
- Los roles los asigna el dueño del contrato; no hay forma de quitarlos salvo reasignarlos.
- Un cargamento no se puede dividir ni modificar una vez creado, y `CargoTracker` no guarda
  historial propio (se reconstruye con los eventos `CargoTransferred`).
- Los números de lote son `string`, y en los eventos están indexados: el log guarda su hash, no
  se puede leer el valor original.

**Scripts y despliegue**

- Solo hay configuración para la red `localhost`.
