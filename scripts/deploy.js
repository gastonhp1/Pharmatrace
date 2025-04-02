const hre = require("hardhat");

async function main() {
    const DrugTracker = await hre.ethers.getContractFactory("DrugTracker");
    const drugTracker = await DrugTracker.deploy(); // deploy and broadcast transaction

    // ⚠️ NO usamos .deployed() en Ethers v6+
    console.log("✅ DrugTracker deployed at:", await drugTracker.getAddress());
}

main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
