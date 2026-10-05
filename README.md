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

### Estados de un lote

| Valor | Estado | En el flujo de ejemplo (`scripts/full-trace.js`) |
| --- | --- | --- |
| 0 | `Registered` | El fabricante registra el lote |
| 1 | `InDistribution` | Pasa del fabricante al distribuidor |
| 2 | `InTransit` | Del distribuidor al depósito |
| 3 | `InPharmacy` | Del depósito a la farmacia |
| 4 | `Delivered` | De la farmacia al paciente |
| 5 | `InUse` | Último estado posible |

### Reglas de `DrugTracker`

- Solo el dueño del contrato (quien lo despliega, el fabricante) puede registrar lotes.
- Solo el dueño actual de un lote puede transferirlo, y cada transferencia agrega al nuevo dueño
  al historial (`getDrugHistory`).
- El estado solo puede avanzar: el nuevo estado tiene que ser mayor que el actual.

### Reglas de `CargoTracker`

- Se despliega apuntando a la dirección de un `DrugTracker`.
- `createCargo` exige que quien lo crea sea dueño de todos los lotes que incluye.
- El cargamento tiene su propio dueño: se transfiere con `transferCargo` y se cierra con
  `markDelivered`, ambos solo por el dueño actual del cargamento.

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

Los tests corren en la red en memoria de Hardhat, sin `.env`. Son 37, entre
`DrugTracker` y `CargoTracker`. Los que empiezan con `KNOWN ISSUE` fijan un comportamiento
actual que conviene corregir (ver [Limitaciones conocidas](#limitaciones-conocidas)): cuando se
arregle el contrato hay que invertir sus asserts.

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

La clave del fabricante es la que despliega los contratos, así que queda como su dueño.

### 2. Levantar la red local

```bash
npx hardhat node
```

### 3. Desplegar los contratos

En otra terminal:

```bash
npm run deploy:all
```

Despliega `DrugTracker` y `CargoTracker` y:

- escribe `backend/.env` con `CONTRACT_ADDRESS`, `CARGO_CONTRACT_ADDRESS`, `RPC_URL` y las cinco claves;
- exporta los ABIs, las direcciones y los datos de los actores a `../PharmaTrace-UI/src/`.

Los scripts de `scripts/` leen sus variables del `.env` de la raíz y, si falta alguna, de
`backend/.env`, así que después de este paso ya usan las direcciones sin copiarlas a mano.

Si solo necesitás volver a desplegar `CargoTracker`:

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
node scripts/cargo-interact.js       # crea un cargamento con 2 lotes, lo transfiere y lo entrega
```

`interact.js` se puede volver a correr sobre el mismo lote: saltea lo que ya se hizo y sigue
desde donde quedó. `cargo-interact.js` registra sus propios lotes.

## API

Cada operación sobre un lote o cargamento existente se firma con la clave del **dueño actual**:
el backend consulta quién es en la blockchain y busca esa dirección entre las claves `*_KEY`
configuradas. Si el dueño no tiene clave configurada, responde 403.

| Método | Ruta | Body |
| --- | --- | --- |
| GET | `/api/drug/:batchId` | |
| POST | `/api/register` | `batchId`, `drugName`, `manufacturer` |
| POST | `/api/transfer` | `batchId`, `toAddress`, `newState` (0 a 5) |
| POST | `/api/cargo/create` | `cargoId`, `batchIds[]` |
| GET | `/api/cargo/:cargoId` | |
| POST | `/api/cargo/transfer` | `cargoId`, `toAddress` |
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
| 400 | Datos inválidos (campo vacío, dirección mal formada, `newState` fuera de 0 a 5) |
| 403 | No es el dueño actual, o el dueño no tiene clave configurada |
| 404 | El lote o cargamento no existe |
| 409 | Ya existe, transición de estado inválida, o los lotes de un cargamento tienen distinto dueño |
| 500 | Error inesperado (red caída, configuración incompleta) |

## Scripts

| Script | Cómo se corre | Qué hace |
| --- | --- | --- |
| `deploy.js` | `npm run deploy` | Despliega solo `DrugTracker` |
| `deploy-to-env-and-frontend.js` | `npm run deploy:all` | Despliega `DrugTracker` y `CargoTracker` y exporta `backend/.env`, ABIs y archivos del frontend |
| `export-artifacts.js` | `npm run export:frontend` | Variante anterior de `deploy:all` (ver limitaciones): despliega solo `DrugTracker` y exporta ABIs, dirección, metadata e historial de despliegues |
| `deploy-cargo.js` | `npx hardhat run scripts/deploy-cargo.js --network localhost` | Despliega solo `CargoTracker` y actualiza `CARGO_CONTRACT_ADDRESS` en los `.env` |
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

- `CargoTracker` y `DrugTracker` llevan la propiedad por separado. Transferir un cargamento no
  mueve los lotes que contiene; un mismo lote puede estar en varios cargamentos a la vez o
  transferirse por fuera mientras sigue en uno.
- El estado de un lote solo tiene que aumentar: se pueden saltear estados (de `Registered` a
  `InUse`) y el destinatario puede ser cualquier dirección, sin importar su rol. No hay registro
  de roles on-chain.
- Un cargamento entregado se puede seguir transfiriendo (incluso a la dirección cero),
  `markDelivered` no emite evento y se puede llamar varias veces.
- Los números de lote son `string`, y en los eventos están indexados: el log guarda su hash, no
  se puede leer el valor original.

**Scripts y despliegue**

- `export-artifacts.js` (`npm run export:frontend`) es una variante anterior de `deploy:all`: no
  despliega `CargoTracker` y reescribe `backend/.env` sin `CARGO_CONTRACT_ADDRESS`. Para el flujo
  completo usá `deploy:all`.
- Solo hay configuración para la red `localhost`.
