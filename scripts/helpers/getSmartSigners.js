require("dotenv").config();
const { ethers, network } = require("hardhat");
const { getReadableBalance } = require("./getReadableBalance");


function getSignerFromPrivateKey(privateKey) {
    if (!privateKey) throw new Error("Missing private key");
    const provider = new ethers.JsonRpcProvider(process.env.RPC_URL || "http://127.0.0.1:8545");
    return new ethers.Wallet(privateKey, provider);
}

async function logBalances(actors) {
    console.log("\n⛽ Checking balances:");
    for (const [role, signer] of Object.entries(actors)) {
        const { address, formatted } = await getReadableBalance(signer);
        console.log(`  🔹 ${role.padEnd(12)} → ${address} (${formatted} ETH)`);
    }
    console.log("");
}

async function getSmartSigners() {
    let signers = {};

    if (network.name === "localhost" || network.name === "hardhat") {
        console.log("🔍 Using Hardhat Network – loading default signers...");
        const accounts = await ethers.getSigners();

        signers = {
            laboratory: accounts[0],
            distributor: accounts[1],
            warehouse: accounts[2],
            pharmacy: accounts[3],
            patient: accounts[4],
        };
    } else {
        console.log("🔍 Using external network – loading signers from .env...");
        signers = {
            laboratory: getSignerFromPrivateKey(process.env.LABORATORY_KEY),
            distributor: getSignerFromPrivateKey(process.env.DISTRIBUTOR_KEY),
            warehouse: getSignerFromPrivateKey(process.env.WAREHOUSE_KEY),
            pharmacy: getSignerFromPrivateKey(process.env.PHARMACY_KEY),
            patient: getSignerFromPrivateKey(process.env.PATIENT_KEY),
        };
    }

    await logBalances(signers);
    return signers;
}

module.exports = { getSmartSigners };
