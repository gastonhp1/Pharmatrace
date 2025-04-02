require("dotenv").config();
const { ethers } = require("ethers");
const contractJson = require("./abi/DrugTracker.json");

async function main() {
    const batchNumber = process.argv[2];
    if (!batchNumber) {
        console.error("❌ You must provide a batch number:\n");
        console.error("   node scripts/interact.js BATCH-INT-001\n");
        process.exit(1);
    }

    const provider = new ethers.JsonRpcProvider(process.env.RPC_URL);
    const contractAddress = process.env.CONTRACT_ADDRESS;

    if (!contractAddress) throw new Error("❌ CONTRACT_ADDRESS missing from .env");

    const DrugTracker = new ethers.Contract(contractAddress, contractJson.abi, provider);

    // ✅ Crear wallets desde claves privadas
    const roles = {
        manufacturer: new ethers.Wallet(process.env.MANUFACTURER_KEY, provider),
        distributor: new ethers.Wallet(process.env.DISTRIBUTOR_KEY, provider),
        warehouse: new ethers.Wallet(process.env.WAREHOUSE_KEY, provider),
        pharmacy: new ethers.Wallet(process.env.PHARMACY_KEY, provider),
        patient: new ethers.Wallet(process.env.PATIENT_KEY, provider),
    };

    const addresses = {
        manufacturer: roles.manufacturer.address,
        distributor: roles.distributor.address,
        warehouse: roles.warehouse.address,
        pharmacy: roles.pharmacy.address,
        patient: roles.patient.address,
    };

    const drugName = "Amoxicillin 500mg";
    const productionDate = Math.floor(Date.now() / 1000);
    console.log("🆔 Batch number:", batchNumber);

    const State = {
        Registered: 0,
        InDistribution: 1,
        InTransit: 2,
        InPharmacy: 3,
        Delivered: 4,
        InUse: 5,
    };

    // 🔍 Check si ya está registrado
    const existing = await DrugTracker.getDrugInfo(batchNumber);
    const alreadyRegistered = existing[1] !== ethers.ZeroAddress;

    if (alreadyRegistered) {
        console.warn(`⚠️ Drug with batch ${batchNumber} already registered by ${existing[1]}. Skipping registration.`);
    } else {
        console.log("📌 Step 1: Registering the drug...");
        const tx = await DrugTracker.connect(roles.manufacturer).registerDrug(
            batchNumber,
            drugName,
            "Global Medics Inc.",
            productionDate
        );
        await tx.wait();
        console.log("✅ Drug registered by:", addresses.manufacturer);
    }

    // Transfer to Distributor
    console.log("📦 Step 2: Transferring to distributor...");
    await DrugTracker.connect(roles.manufacturer).transferDrug(
        batchNumber,
        addresses.distributor,
        State.InDistribution
    );

    // Transfer to Warehouse
    console.log("🚚 Step 3: Transferring to warehouse...");
    await DrugTracker.connect(roles.distributor).transferDrug(
        batchNumber,
        addresses.warehouse,
        State.InTransit
    );

    // Transfer to Pharmacy
    console.log("🏪 Step 4: Transferring to pharmacy...");
    await DrugTracker.connect(roles.warehouse).transferDrug(
        batchNumber,
        addresses.pharmacy,
        State.InPharmacy
    );

    // Transfer to Patient
    console.log("👨‍⚕️ Step 5: Delivering to patient...");
    await DrugTracker.connect(roles.pharmacy).transferDrug(
        batchNumber,
        addresses.patient,
        State.Delivered
    );

    // Get drug info
    const info = await DrugTracker.getDrugInfo(batchNumber);
    const history = await DrugTracker.getDrugHistory(batchNumber);
    const productionTimestamp = Number(info[2]);

    console.log("\n📦 Drug Info:");
    console.log(`Name: ${info[0]}`);
    console.log(`Manufacturer: ${info[1]}`);
    console.log(`Production Date: ${new Date(productionTimestamp * 1000).toLocaleDateString()}`);
    console.log(`Current State: ${Object.keys(State)[info[3]]}`);
    console.log(`Current Owner: ${info[4]}`);

    console.log("\n📚 Transfer History:");
    history.forEach((addr, index) => {
        console.log(`  ${index + 1}. ${addr}`);
    });
}

main().catch((err) => {
    console.error("❌ Error:", err);
    process.exit(1);
});
