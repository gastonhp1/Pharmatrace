require("dotenv").config();
const { ethers } = require("ethers");
const contractJson = require("../../scripts/abi/CargoTracker.json");
const drugContractJson = require("../../scripts/abi/DrugTracker.json");
const { provider, getSignerForAddress } = require("./chain");
const { ApiError } = require("../utils/errors");

const contractAddress = process.env.CARGO_CONTRACT_ADDRESS;

const CargoTracker = new ethers.Contract(contractAddress, contractJson.abi, provider);

// 🆕 Crear cargamento
// The contract requires the sender to own every batch in the cargo, so the transaction
// is signed with the key of the batches' current owner.
async function createCargo(cargoId, batchIds) {
    const drugTracker = new ethers.Contract(
        await CargoTracker.drugContract(),
        drugContractJson.abi,
        provider
    );

    const owners = await Promise.all(
        batchIds.map(async (batchId) => (await drugTracker.getDrugInfo(batchId))[4])
    );

    if (new Set(owners.map((owner) => owner.toLowerCase())).size !== 1) {
        throw new ApiError(409, "All batches in a cargo must have the same current owner");
    }

    const signer = getSignerForAddress(owners[0]);
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

// 🚚 Transferir cargamento a otro actor (signed by the cargo's current owner)
async function transferCargo(cargoId, toAddress) {
    const info = await CargoTracker.getCargoInfo(cargoId);
    const signer = getSignerForAddress(info[2]);
    const contract = CargoTracker.connect(signer);

    const tx = await contract.transferCargo(cargoId, toAddress);
    await tx.wait();

    return {
        ok: true,
        message: `Cargo ${cargoId} transferred to ${toAddress}`
    };
}

// ✅ Marcar cargamento como entregado (signed by the cargo's current owner)
async function markCargoDelivered(cargoId) {
    const info = await CargoTracker.getCargoInfo(cargoId);
    const signer = getSignerForAddress(info[2]);
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
    transferCargo,
    markCargoDelivered
};
