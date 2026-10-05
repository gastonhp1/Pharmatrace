require("./helpers/loadEnv");
const hre = require("hardhat");
const fs = require("fs");
const path = require("path");
const { deployAll } = require("./helpers/setupContracts");

async function main() {
    const { drugAddress: address, cargoAddress, signers } = await deployAll(hre);

    console.log(`✅ DrugTracker deployed at: ${address}`);
    console.log(`🚚 CargoTracker deployed at: ${cargoAddress}\n`);

    // 📄 .env backend
    const envLines = [
        `CONTRACT_ADDRESS=${address}`,
        `CARGO_CONTRACT_ADDRESS=${cargoAddress}`,
        `RPC_URL=${process.env.RPC_URL || "http://127.0.0.1:8545"}`,
        `MANUFACTURER_KEY=${process.env.MANUFACTURER_KEY}`,
        `DISTRIBUTOR_KEY=${process.env.DISTRIBUTOR_KEY}`,
        `WAREHOUSE_KEY=${process.env.WAREHOUSE_KEY}`,
        `PHARMACY_KEY=${process.env.PHARMACY_KEY}`,
        `PATIENT_KEY=${process.env.PATIENT_KEY}`
    ];

    const backendEnvPath = path.join(__dirname, "../backend/.env");
    fs.writeFileSync(backendEnvPath, envLines.join("\n") + "\n");
    console.log("📄 .env backend updated ✅");

    // 📤 ABI export
    const artifact = await hre.artifacts.readArtifact("DrugTracker");

    // ➕ ABI to frontend
    const frontendAbiPath = path.join(__dirname, "../../PharmaTrace-UI/src/abi/DrugTracker.json");
    fs.mkdirSync(path.dirname(frontendAbiPath), { recursive: true });
    fs.writeFileSync(frontendAbiPath, JSON.stringify({ abi: artifact.abi }, null, 2));

    // ➕ ABI to backend (for CLI use)
    const backendAbiPath = path.join(__dirname, "./abi/DrugTracker.json");
    fs.mkdirSync(path.dirname(backendAbiPath), { recursive: true });
    fs.writeFileSync(backendAbiPath, JSON.stringify({ abi: artifact.abi }, null, 2));

    console.log("📦 ABI exported to frontend + backend ✅");

    // 📦 CargoTracker ABI (frontend + backend)
    const cargoArtifact = await hre.artifacts.readArtifact("CargoTracker");
    const cargoAbiJson = JSON.stringify({ abi: cargoArtifact.abi }, null, 2);

    const frontendCargoAbiPath = path.join(__dirname, "../../PharmaTrace-UI/src/abi/CargoTracker.json");
    fs.mkdirSync(path.dirname(frontendCargoAbiPath), { recursive: true });
    fs.writeFileSync(frontendCargoAbiPath, cargoAbiJson);
    fs.writeFileSync(path.join(__dirname, "./abi/CargoTracker.json"), cargoAbiJson);
    console.log("📦 CargoTracker ABI exported to frontend + backend ✅");

    // ➕ Contract address to frontend
    const frontendAddressPath = path.join(__dirname, "../../PharmaTrace-UI/src/config/contract-address.js");
    fs.mkdirSync(path.dirname(frontendAddressPath), { recursive: true });
    fs.writeFileSync(frontendAddressPath, `export const CONTRACT_ADDRESS = "${address}";\nexport const CARGO_CONTRACT_ADDRESS = "${cargoAddress}";\n`);
    console.log("📬 Contract address exported to frontend ✅");

    // 🌐 .env.public para Vite frontend
    const publicEnvPath = path.join(__dirname, "../../PharmaTrace-UI/.env.public");
    const publicEnv = [
        `VITE_CONTRACT_ADDRESS=${address}`,
        `VITE_CARGO_CONTRACT_ADDRESS=${cargoAddress}`,
        `VITE_RPC_URL=${process.env.RPC_URL || "http://127.0.0.1:8545"}`
    ];

    fs.writeFileSync(publicEnvPath, publicEnv.join("\n") + "\n");
    console.log("🌐 .env.public exported for Vite frontend ✅");

    // 🧠 Build metadata
    const network = hre.network.name;
    const blockNumber = await signers[0].provider.getBlockNumber();

    const metadata = {
        contract: "DrugTracker",
        address,
        cargoAddress,
        network,
        blockNumber,
        exportedAt: new Date().toISOString()
    };

    const abiFolder = path.join(__dirname, "./abi");
    fs.mkdirSync(abiFolder, { recursive: true });

    // Save metadata individual (last build)
    const metaPath = path.join(abiFolder, "build-metadata.json");
    fs.writeFileSync(metaPath, JSON.stringify(metadata, null, 2));
    console.log("🗃️  Build metadata exported ✅");

    // Save history
    const historyPath = path.join(abiFolder, "deploy-history.json");

    let history = [];
    if (fs.existsSync(historyPath)) {
        history = JSON.parse(fs.readFileSync(historyPath, "utf8"));
    }

    history.push(metadata);
    fs.writeFileSync(historyPath, JSON.stringify(history, null, 2));
    console.log("🗂️  Deploy history updated ✅");
}

main().catch((err) => {
    console.error("❌ Error:", err);
    process.exit(1);
});
