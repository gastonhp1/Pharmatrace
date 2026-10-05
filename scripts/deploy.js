require("./helpers/loadEnv");
const hre = require("hardhat");
const { deployAll } = require("./helpers/setupContracts");

// Deploys DrugTracker and CargoTracker, registers the actors' roles and links both contracts.
async function main() {
    const { drugAddress, cargoAddress, addresses } = await deployAll(hre);

    console.log("✅ DrugTracker deployed at:", drugAddress);
    console.log("🚚 CargoTracker deployed at:", cargoAddress);
    console.log("👥 Actors registered:");
    for (const [name, address] of Object.entries(addresses)) {
        console.log(`   ${name.padEnd(12)} ${address}`);
    }
}

main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
