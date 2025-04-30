require("dotenv").config();
const { ethers } = require("ethers");
const contractJson = require("../../scripts/abi/CargoTracker.json");

const provider = new ethers.JsonRpcProvider(process.env.RPC_URL);
const contractAddress = process.env.CARGO_CONTRACT_ADDRESS;

const CargoTracker = new ethers.Contract(contractAddress, contractJson.abi, provider);

// 🆕 Crear cargamento
async function createCargo(cargoId, batchIds) {
    const signer = new ethers.Wallet(process.env.MANUFACTURER_KEY, provider);
    const contract = CargoTracker.connect(signer);

    const tx = await contract.createCargo(cargoId, batchIds);
    await tx.wait();

    return {
        ok: true,
        message: "Cargo created successfully",
        cargoId,
        batchIds
    };
}

// 🔍 Obtener info de cargamento
async function getCargoInfo(cargoId) {
    const result = await CargoTracker.getCargoInfo(cargoId);

    return {
        cargoId,
        batchIds: result[0],
        createdBy: result[1],
        currentOwner: result[2],
        createdAt: new Date(Number(result[3]) * 1000).toISOString(),
        delivered: result[4],
    };
}

// ✅ Marcar cargamento como entregado
async function markCargoDelivered(cargoId) {
    const signer = new ethers.Wallet(process.env.DISTRIBUTOR_KEY, provider);
    const contract = CargoTracker.connect(signer);

    const tx = await contract.markDelivered(cargoId);
    await tx.wait();

    return {
        ok: true,
        message: `Cargo ${cargoId} marked as delivered`
    };
}

module.exports = {
    createCargo,
    getCargoInfo,
    markCargoDelivered
};
