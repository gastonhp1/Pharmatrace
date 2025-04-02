require("dotenv").config();
const hre = require("hardhat");
const fs = require("fs");
const path = require("path");

async function main() {
    const DrugTracker = await hre.ethers.getContractFactory("DrugTracker");
    const contract = await DrugTracker.deploy();
    const address = await contract.getAddress();

    console.log(`✅ DrugTracker deployed at: ${address}`);

    // 📂 Exportar ABI al frontend
    const contractArtifact = await hre.artifacts.readArtifact("DrugTracker");
    const abiOutputPath = path.join(__dirname, "../../pharmatrace-ui/src/abi/DrugTracker.json");

    fs.mkdirSync(path.dirname(abiOutputPath), { recursive: true });
    fs.writeFileSync(abiOutputPath, JSON.stringify({ abi: contractArtifact.abi }, null, 2));
    console.log("📦 ABI exported to frontend ✅");

    // 📍 Exportar address al frontend
    const addressOutputPath = path.join(__dirname, "../../pharmatrace-ui/src/config/contract-address.js");
    fs.mkdirSync(path.dirname(addressOutputPath), { recursive: true });
    fs.writeFileSync(addressOutputPath, `export const CONTRACT_ADDRESS = "${address}";\n`);
    console.log("📬 Contract address exported to frontend ✅");
}

main().catch((err) => {
    console.error("❌ Error:", err);
    process.exit(1);
});
