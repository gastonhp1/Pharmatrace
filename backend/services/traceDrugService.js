require("dotenv").config();
const { ethers } = require("ethers");
const contractJson = require("../../scripts/abi/DrugTracker.json");
const { provider, getManufacturerSigner, getSignerForAddress } = require("./chain");

const contractAddress = process.env.CONTRACT_ADDRESS;

const DrugTracker = new ethers.Contract(contractAddress, contractJson.abi, provider);

// ✅ TRAZAR un batch por ID
async function traceDrug(batchId) {
    const info = await DrugTracker.getDrugInfo(batchId);
    const history = await DrugTracker.getDrugHistory(batchId);
    const inCargo = await DrugTracker.inCargo(batchId);

    const productionTimestamp = Number(info[2]);
    const stateLabels = [
        "Registered",
        "InDistribution",
        "InTransit",
        "InPharmacy",
        "Delivered",
        "InUse"
    ];

    return {
        name: info[0],
        manufacturer: info[1],
        productionDate: new Date(productionTimestamp * 1000).toLocaleDateString(),
        currentState: stateLabels[info[3]] || "Unknown",
        currentOwner: info[4],
        inCargo,
        history
    };
}

// 📌 Registrar una droga
async function registerDrug(batchId, drugName, manufacturer) {
    const signer = getManufacturerSigner();
    const contractWithSigner = DrugTracker.connect(signer);

    const productionDate = Math.floor(Date.now() / 1000);
    const tx = await contractWithSigner.registerDrug(batchId, drugName, manufacturer, productionDate);
    await tx.wait();

    return { success: true, message: "Drug registered successfully." };
}

// 📦 Transferir droga a otro actor
// Only the current owner can transfer a batch, so the transaction is signed with the
// owner's key (looked up on-chain) instead of a fixed role.
async function transferDrug(batchId, toAddress, newState) {
    const info = await DrugTracker.getDrugInfo(batchId);
    const signer = getSignerForAddress(info[4]);
    const contractWithSigner = DrugTracker.connect(signer);

    const tx = await contractWithSigner.transferDrug(batchId, toAddress, newState);
    await tx.wait();

    return { success: true, message: "Drug transferred successfully." };
}

// 💊 The patient marks a delivered batch as in use (signed with the owner's key)
async function markInUse(batchId) {
    const info = await DrugTracker.getDrugInfo(batchId);
    const signer = getSignerForAddress(info[4]);
    const contractWithSigner = DrugTracker.connect(signer);

    const tx = await contractWithSigner.markInUse(batchId);
    await tx.wait();

    return { success: true, message: "Drug marked as in use." };
}

module.exports = { traceDrug, registerDrug, transferDrug, markInUse };
