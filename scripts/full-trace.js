require("dotenv").config();
const { ethers } = require("hardhat");
const { getSmartSigners } = require("./helpers/getSmartSigners");
const { checkBalances } = require("./helpers/checkBalances");

async function main() {
    const {
        laboratory,
        distributor,
        warehouse,
        pharmacy,
        patient
    } = await getSmartSigners();

    await checkBalances(
        { laboratory, distributor, warehouse, pharmacy, patient },
        0.01
    );

    const DrugTracker = await ethers.getContractAt(
        "DrugTracker",
        process.env.CONTRACT_ADDRESS
    );

    const batchNumber = `BATCH-${Date.now()}`;
    const productionDate = Math.floor(Date.now() / 1000);

    await DrugTracker.connect(laboratory).registerDrug(
        batchNumber,
        "TestDrug 500mg",
        "Test Labs Inc.",
        productionDate
    );

    await DrugTracker.connect(laboratory).transferDrug(batchNumber, distributor.address, 1);
    await DrugTracker.connect(distributor).transferDrug(batchNumber, warehouse.address, 2);
    await DrugTracker.connect(warehouse).transferDrug(batchNumber, pharmacy.address, 3);
    await DrugTracker.connect(pharmacy).transferDrug(batchNumber, patient.address, 4);

    console.log("✅ Full trace for:", batchNumber);
}

main().catch((e) => {
    console.error("❌ Error:", e);
    process.exit(1);
});
