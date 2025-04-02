require("dotenv").config();
const { ethers } = require("ethers");
const contractJson = require("../../scripts/abi/DrugTracker.json");

const provider = new ethers.JsonRpcProvider(process.env.RPC_URL);  // ✅ Tomamos del .env
const contractAddress = process.env.CONTRACT_ADDRESS;

const DrugTracker = new ethers.Contract(contractAddress, contractJson.abi, provider);

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

module.exports = { registerDrug, transferDrug };
