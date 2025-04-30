require("dotenv").config();
const { ethers } = require("ethers");
const contractJson = require("../../scripts/abi/DrugTracker.json");

const provider = new ethers.JsonRpcProvider(process.env.RPC_URL);
const contractAddress = process.env.CONTRACT_ADDRESS;

const DrugTracker = new ethers.Contract(contractAddress, contractJson.abi, provider);

// ✅ TRAZAR un batch por ID
async function traceDrug(batchId) {
    const info = await DrugTracker.getDrugInfo(batchId);
    const history = await DrugTracker.getDrugHistory(batchId);

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
        history
    };
}

// 📌 Registrar una droga
async function registerDrug(batchId, drugName, manufacturer) {
    const signer = new ethers.Wallet(process.env.MANUFACTURER_KEY, provider);
    const contractWithSigner = DrugTracker.connect(signer);

    const productionDate = Math.floor(Date.now() / 1000);
    const tx = await contractWithSigner.registerDrug(batchId, drugName, manufacturer, productionDate);
    await tx.wait();

    return { success: true, message: "Drug registered successfully." };
}

// 📦 Transferir droga a otro actor
async function transferDrug(batchId, toAddress, newState) {
    const signer = new ethers.Wallet(process.env.DISTRIBUTOR_KEY, provider);
    const contractWithSigner = DrugTracker.connect(signer);

    const tx = await contractWithSigner.transferDrug(batchId, toAddress, newState);
    await tx.wait();

    return { success: true, message: "Drug transferred successfully." };
}

module.exports = { traceDrug, registerDrug, transferDrug };
