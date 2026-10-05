require("./helpers/loadEnv");
const hre = require("hardhat");
const fs = require("fs");
const path = require("path");
const { upsertEnvVar } = require("./helpers/upsertEnvVar");

async function main() {
    const drugTrackerAddress = process.env.CONTRACT_ADDRESS;
    if (!drugTrackerAddress) {
        throw new Error("❌ Missing CONTRACT_ADDRESS (set it in .env or backend/.env)");
    }

    const CargoTracker = await hre.ethers.getContractFactory("CargoTracker");
    const cargoContract = await CargoTracker.deploy(drugTrackerAddress);
    await cargoContract.waitForDeployment();

    const cargoAddress = await cargoContract.getAddress();
    console.log(`🚚 CargoTracker deployed at: ${cargoAddress}`);

    // Keep both env files in sync: the root .env (scripts) and backend/.env (API), if it exists.
    const rootEnvPath = path.join(__dirname, "../.env");
    const backendEnvPath = path.join(__dirname, "../backend/.env");

    upsertEnvVar(rootEnvPath, "CARGO_CONTRACT_ADDRESS", cargoAddress);
    console.log("📄 CARGO_CONTRACT_ADDRESS saved to .env ✅");

    if (fs.existsSync(backendEnvPath)) {
        upsertEnvVar(backendEnvPath, "CARGO_CONTRACT_ADDRESS", cargoAddress);
        console.log("📄 CARGO_CONTRACT_ADDRESS saved to backend/.env ✅");
    }
}

main().catch((err) => {
    console.error("❌ Error deploying CargoTracker:", err);
    process.exit(1);
});
