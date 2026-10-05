require("./helpers/loadEnv");
const { ethers } = require("ethers");
const fs = require("fs");
const contractJson = require("./abi/DrugTracker.json");

async function main() {
    const batchNumber = process.argv[2];

    if (!batchNumber) {
        console.error("❌ Usage: node scripts/traceDrug.js <BATCH-ID>");
        process.exit(1);
    }

    const provider = new ethers.JsonRpcProvider(process.env.RPC_URL);
    const contractAddress = process.env.CONTRACT_ADDRESS;

    if (!contractAddress) {
        throw new Error("❌ CONTRACT_ADDRESS missing from .env");
    }

    const DrugTracker = new ethers.Contract(
        contractAddress,
        contractJson.abi,
        provider
    );

    const State = {
        0: "Registered",
        1: "InDistribution",
        2: "InTransit",
        3: "InPharmacy",
        4: "Delivered",
        5: "InUse"
    };

    console.log(`🔎 Fetching drug trace info for batch: ${batchNumber}...`);

    const info = await DrugTracker.getDrugInfo(batchNumber);
    const history = await DrugTracker.getDrugHistory(batchNumber);

    const productionTimestamp = Number(info[2]);

    console.log("\n📦 Drug Info:");
    console.log(`🧪 Name: ${info[0]}`);
    console.log(`🏭 Manufacturer: ${info[1]}`);
    console.log(`📆 Production Date: ${new Date(productionTimestamp * 1000).toLocaleDateString()}`);
    console.log(`🔁 Current State: ${State[info[3]] || "Unknown"}`);
    console.log(`👤 Current Owner: ${info[4]}`);

    console.log("\n📚 Transfer History:");
    history.forEach((addr, index) => {
        console.log(`  ${index + 1}. ${addr}`);
    });

    console.log("\n✅ Trace completed.\n");
}

main().catch((err) => {
    console.error("❌ Error:", err);
    process.exit(1);
});
