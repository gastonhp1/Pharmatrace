require("dotenv").config();
const hre = require("hardhat");

async function main() {
    const drugTrackerAddress = process.env.CONTRACT_ADDRESS;
    if (!drugTrackerAddress) {
        throw new Error("❌ Missing CONTRACT_ADDRESS in .env");
    }

    const CargoTracker = await hre.ethers.getContractFactory("CargoTracker");
    const cargoContract = await CargoTracker.deploy(drugTrackerAddress);
    await cargoContract.waitForDeployment();

    const cargoAddress = await cargoContract.getAddress();
    console.log(`🚚 CargoTracker deployed at: ${cargoAddress}`);

    // Opcional: Guardamos en .env
    const fs = require("fs");
    fs.appendFileSync(".env", `CARGO_CONTRACT_ADDRESS=${cargoAddress}\n`);
    console.log("📄 CARGO_CONTRACT_ADDRESS appended to .env ✅");
}

main().catch((err) => {
    console.error("❌ Error deploying CargoTracker:", err);
    process.exit(1);
});
