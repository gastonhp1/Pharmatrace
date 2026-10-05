require("./helpers/loadEnv");
const hre = require("hardhat");
const fs = require("fs");
const path = require("path");
const { deployAll } = require("./helpers/setupContracts");

async function main() {
    const { drugAddress: address, cargoAddress } = await deployAll(hre);

    console.log(`✅ DrugTracker deployed at: ${address}`);
    console.log(`🚚 CargoTracker deployed at: ${cargoAddress}`);

    // 📂 Exportar ABI al frontend
    const contractArtifact = await hre.artifacts.readArtifact("DrugTracker");
    const abiOutputPath = path.join(__dirname, "../../PharmaTrace-UI/src/abi/DrugTracker.json");

    fs.mkdirSync(path.dirname(abiOutputPath), { recursive: true });
    fs.writeFileSync(abiOutputPath, JSON.stringify({ abi: contractArtifact.abi }, null, 2));
    console.log("📦 ABI exported to frontend ✅");

    // 📍 Exportar address al frontend
    const addressOutputPath = path.join(__dirname, "../../PharmaTrace-UI/src/config/contract-address.js");
    fs.mkdirSync(path.dirname(addressOutputPath), { recursive: true });
    fs.writeFileSync(addressOutputPath, `export const CONTRACT_ADDRESS = "${address}";\nexport const CARGO_CONTRACT_ADDRESS = "${cargoAddress}";\n`);
    console.log("📬 Contract address exported to frontend ✅");
}

main().catch((err) => {
    console.error("❌ Error:", err);
    process.exit(1);
});
