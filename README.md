PharmaTrace/
├── contracts/              → Smart contracts (Solidity)
├── test/                   → Tests de Hardhat de los contratos
├── scripts/                → Scripts de deploy, interacción, exportación
│   └── abi/                → ABI y metadata de despliegues
├── backend/                → Backend Node.js (Express + ethers)
├── .env                    → Claves privadas y configuración de Hardhat
├── hardhat.config.js       → Configuración principal de Hardhat
└── README.md               → Documentación del proyecto

## Tests

```bash
npm install
npm test
```

Corren en la red en memoria de Hardhat, no hace falta `.env`. Los tests marcados como
`KNOWN ISSUE` fijan el comportamiento actual de los contratos que está pendiente de
endurecer (ownership de cargo vs. drogas, saltos de estado); cuando se corrijan hay que
invertir sus asserts.

## Backend

Copiá `backend/.env.example` a `backend/.env`, completalo y levantalo con `npm start` dentro de `backend/`.

Cada operación sobre un lote o cargamento existente se firma con la clave del **dueño actual**
(se consulta on-chain y se busca entre las claves `*_KEY` configuradas). Si el dueño no tiene
clave configurada, la API responde 403.

| Método | Ruta | Body |
| --- | --- | --- |
| GET | `/api/drug/:batchId` | |
| POST | `/api/register` | `batchId`, `drugName`, `manufacturer` |
| POST | `/api/transfer` | `batchId`, `toAddress`, `newState` (0-5) |
| POST | `/api/cargo/create` | `cargoId`, `batchIds[]` |
| GET | `/api/cargo/:cargoId` | |
| POST | `/api/cargo/transfer` | `cargoId`, `toAddress` |
| POST | `/api/cargo/deliver` | `cargoId` |

Errores: 400 validación, 403 sin permiso (no es el dueño / sin clave), 404 no existe,
409 conflicto (ya existe, transición de estado inválida).

> La API todavía no tiene autenticación: quien llegue al servidor puede operar con las claves configuradas.
