require("dotenv").config();
const hre = require("hardhat");
const fs = require("fs");
const path = require("path");

async function main() {
    const signers = await hre.ethers.getSigners();

    const roles = {
        laboratory: signers[0],
        distributor: signers[1],
        warehouse: signers[2],
        pharmacy: signers[3],
        patient: signers[4],
    };

    const DrugTracker = await hre.ethers.getContractFactory("DrugTracker");
    const contract = await DrugTracker.deploy();
    const address = await contract.getAddress();

    console.log(`✅ DrugTracker deployed at: ${address}\n`);

    // 🔐 Export backend/.env con las private keys
    const backendEnvPath = path.join(__dirname, "../backend/.env");

    const backendEnv = [
        `CONTRACT_ADDRESS=${address}`,
        `RPC_URL=http://127.0.0.1:8545`,
        `MANUFACTURER_KEY=${process.env.MANUFACTURER_KEY}`,
        `DISTRIBUTOR_KEY=${process.env.DISTRIBUTOR_KEY}`,
        `WAREHOUSE_KEY=${process.env.WAREHOUSE_KEY}`,
        `PHARMACY_KEY=${process.env.PHARMACY_KEY}`,
        `PATIENT_KEY=${process.env.PATIENT_KEY}`,
    ];

    fs.writeFileSync(backendEnvPath, backendEnv.join("\n") + "\n");
    console.log("🔐 backend/.env exported with private keys ✅");

    // 📤 ABI export
    const artifact = await hre.artifacts.readArtifact("DrugTracker");

    // ➕ ABI to frontend
    const frontendAbiPath = path.join(__dirname, "../../pharmatrace-ui/src/abi/DrugTracker.json");
    fs.mkdirSync(path.dirname(frontendAbiPath), { recursive: true });
    fs.writeFileSync(frontendAbiPath, JSON.stringify({ abi: artifact.abi }, null, 2));

    // ➕ ABI to backend (for CLI use)
    const backendAbiPath = path.join(__dirname, "./abi/DrugTracker.json");
    fs.mkdirSync(path.dirname(backendAbiPath), { recursive: true });
    fs.writeFileSync(backendAbiPath, JSON.stringify({ abi: artifact.abi }, null, 2));

    console.log("📦 ABI exported to frontend + backend ✅");

    // ➕ Contract address to frontend
    const frontendAddressPath = path.join(__dirname, "../../pharmatrace-ui/src/config/contract-address.js");
    fs.mkdirSync(path.dirname(frontendAddressPath), { recursive: true });
    fs.writeFileSync(frontendAddressPath, `export const CONTRACT_ADDRESS = "${address}";\n`);
    console.log("📬 Contract address exported to frontend ✅");

    // ➕ Actor info to frontend
    const actorData = {};
    for (const [role, signer] of Object.entries(roles)) {
        const balance = await signer.provider.getBalance(signer.address);
        actorData[role] = {
            address: signer.address,
            balance: hre.ethers.formatEther(balance),
        };
    }

    const actorInfoPath = path.join(__dirname, "../../pharmatrace-ui/src/config/actor-info.js");
    fs.writeFileSync(actorInfoPath, `export const ACTORS = ${JSON.stringify(actorData, null, 2)};\n`);
    console.log("🧠 Actor info exported to frontend ✅");
}

main().catch((err) => {
    console.error("❌ Error:", err);
    process.exit(1);
});
