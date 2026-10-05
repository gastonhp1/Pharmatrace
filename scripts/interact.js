require("./helpers/loadEnv");
const { ethers } = require("ethers");
const contractJson = require("./abi/DrugTracker.json");

const State = {
    Registered: 0,
    InDistribution: 1,
    InTransit: 2,
    InPharmacy: 3,
    Delivered: 4,
    InUse: 5,
};

function walletFor(envName, provider) {
    if (!process.env[envName]) throw new Error(`❌ ${envName} missing from .env`);
    return new ethers.Wallet(process.env[envName], provider);
}

async function main() {
    const batchNumber = process.argv[2];
    if (!batchNumber) {
        console.error("❌ You must provide a batch number:\n");
        console.error("   node scripts/interact.js BATCH-INT-001\n");
        process.exit(1);
    }

    const contractAddress = process.env.CONTRACT_ADDRESS;
    if (!contractAddress) throw new Error("❌ CONTRACT_ADDRESS missing from .env");

    // cacheTimeout -1: do not reuse cached nonces between consecutive transactions.
    const provider = new ethers.JsonRpcProvider(
        process.env.RPC_URL || "http://127.0.0.1:8545",
        undefined,
        { cacheTimeout: -1 }
    );
    const DrugTracker = new ethers.Contract(contractAddress, contractJson.abi, provider);

    // ✅ Crear wallets desde claves privadas
    const roles = {
        manufacturer: walletFor("MANUFACTURER_KEY", provider),
        distributor: walletFor("DISTRIBUTOR_KEY", provider),
        warehouse: walletFor("WAREHOUSE_KEY", provider),
        pharmacy: walletFor("PHARMACY_KEY", provider),
        patient: walletFor("PATIENT_KEY", provider),
    };

    const drugName = "Amoxicillin 500mg";
    const productionDate = Math.floor(Date.now() / 1000);
    console.log("🆔 Batch number:", batchNumber);

    // 🔍 getDrugInfo reverts for unknown batches, so that is how we tell if it is registered.
    let alreadyRegistered = true;
    try {
        await DrugTracker.getDrugInfo(batchNumber);
    } catch (err) {
        if (err.reason !== "Drug does not exist.") throw err;
        alreadyRegistered = false;
    }

    if (alreadyRegistered) {
        console.warn(`⚠️ Drug with batch ${batchNumber} is already registered. Skipping registration.`);
    } else {
        console.log("📌 Step 1: Registering the drug...");
        const tx = await DrugTracker.connect(roles.manufacturer).registerDrug(
            batchNumber,
            drugName,
            "Global Medics Inc.",
            productionDate
        );
        await tx.wait();
        console.log("✅ Drug registered by:", roles.manufacturer.address);
    }

    // Each step hands the batch from one actor to the next. Steps whose recipient is already
    // in the batch history are skipped, so the script can be re-run to resume a batch.
    const steps = [
        { label: "📦 Step 2: Transferring to distributor...", from: "manufacturer", to: "distributor", state: State.InDistribution },
        { label: "🚚 Step 3: Transferring to warehouse...", from: "distributor", to: "warehouse", state: State.InTransit },
        { label: "🏪 Step 4: Transferring to pharmacy...", from: "warehouse", to: "pharmacy", state: State.InPharmacy },
        { label: "👨‍⚕️ Step 5: Delivering to patient...", from: "pharmacy", to: "patient", state: State.Delivered },
    ];

    for (const step of steps) {
        console.log(step.label);

        const history = await DrugTracker.getDrugHistory(batchNumber);
        if (history.includes(roles[step.to].address)) {
            console.log(`   ↪ ${step.to} already received this batch, skipping.`);
            continue;
        }

        const tx = await DrugTracker.connect(roles[step.from]).transferDrug(
            batchNumber,
            roles[step.to].address,
            step.state
        );
        await tx.wait();
    }

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
