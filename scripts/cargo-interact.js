require("./helpers/loadEnv");
const { ethers } = require("ethers");
const cargoJson = require("./abi/CargoTracker.json");
const drugJson = require("./abi/DrugTracker.json");

function walletFor(envName, provider) {
    if (!process.env[envName]) throw new Error(`❌ ${envName} missing from .env`);
    return new ethers.Wallet(process.env[envName], provider);
}

async function main() {
    const cargoAddress = process.env.CARGO_CONTRACT_ADDRESS;
    const drugAddress = process.env.CONTRACT_ADDRESS;

    if (!cargoAddress) throw new Error("❌ CARGO_CONTRACT_ADDRESS not found in .env");
    if (!drugAddress) throw new Error("❌ CONTRACT_ADDRESS not found in .env");

    // cacheTimeout -1: do not reuse cached nonces between consecutive transactions.
    const provider = new ethers.JsonRpcProvider(
        process.env.RPC_URL || "http://127.0.0.1:8545",
        undefined,
        { cacheTimeout: -1 }
    );
    const CargoTracker = new ethers.Contract(cargoAddress, cargoJson.abi, provider);
    const DrugTracker = new ethers.Contract(drugAddress, drugJson.abi, provider);

    // 🧠 Cargamos los actores como wallets
    const roles = {
        origin: walletFor("MANUFACTURER_KEY", provider),
        transport1: walletFor("DISTRIBUTOR_KEY", provider),
        warehouse: walletFor("WAREHOUSE_KEY", provider),
        pharmacy: walletFor("PHARMACY_KEY", provider),
    };
    const roleOf = (address) =>
        Object.entries(roles).find(([, wallet]) => wallet.address === address)?.[0] ?? "unknown";

    const stamp = Date.now();
    const cargoId = `CARGO-${stamp}`;
    const batches = [
        { id: `BATCH-${stamp}-A`, name: "Ibuprofen 400mg" },
        { id: `BATCH-${stamp}-B`, name: "Vaccine (refrigerated)" },
    ];

    // 📌 CargoTracker only accepts batches that exist and belong to the cargo creator.
    for (const batch of batches) {
        console.log(`📌 Registering batch ${batch.id} (${batch.name})`);
        const tx = await DrugTracker.connect(roles.origin).registerDrug(
            batch.id,
            batch.name,
            "Global Medics Inc.",
            Math.floor(Date.now() / 1000)
        );
        await tx.wait();
    }

    console.log(`🆕 Creating cargo: ${cargoId}`);
    const createTx = await CargoTracker.connect(roles.origin).createCargo(
        cargoId,
        batches.map((batch) => batch.id)
    );
    await createTx.wait();
    console.log(`✅ Cargo created by: ${roles.origin.address}`);

    // 🔁 Transferencias
    const steps = [
        { from: roles.origin, to: roles.transport1, name: "Transport Company", state: 1 },
        { from: roles.transport1, to: roles.warehouse, name: "Central Warehouse", state: 2 },
        { from: roles.warehouse, to: roles.pharmacy, name: "Pharmacy", state: 3 },
    ];

    for (const step of steps) {
        console.log(`🚚 Transferring cargo to ${step.name} (${step.to.address})`);
        const tx = await CargoTracker.connect(step.from).transferCargo(cargoId, step.to.address, step.state);
        await tx.wait();
    }

    // ✅ Entrega final
    console.log("📦 Marking cargo as delivered...");
    const deliverTx = await CargoTracker.connect(roles.pharmacy).markDelivered(cargoId);
    await deliverTx.wait();
    console.log("✅ Cargo marked as delivered!");

    // 🔍 Mostrar info final
    const info = await CargoTracker.getCargoInfo(cargoId);

    console.log("\n🔎 Final Cargo Info:");
    console.log(`Batches: ${info.batchIds.join(", ")}`);
    console.log(`Created by: ${info.createdBy} (${roleOf(info.createdBy)})`);
    console.log(`Created at: ${new Date(Number(info.createdAt) * 1000).toISOString()}`);
    console.log(`Delivered: ${info.delivered ? "✅ Yes" : "❌ No"}`);
    console.log(`Current Owner: ${info.currentOwner} (${roleOf(info.currentOwner)})`);

    // The contract does not keep a history array: it is rebuilt from the CargoTransferred events.
    const events = await CargoTracker.queryFilter(CargoTracker.filters.CargoTransferred());
    console.log("Transfer History:");
    events
        .filter((event) => event.args.cargoId === cargoId)
        .forEach((event, i) => {
            console.log(`  ${i + 1}. ${roleOf(event.args.from)} → ${roleOf(event.args.to)}`);
        });

    // Transferring a cargo moves its batches too; delivering it unlocks them.
    const stateNames = ["Registered", "InDistribution", "InTransit", "InPharmacy", "Delivered", "InUse"];
    console.log("\nℹ️  Batches in DrugTracker (they follow the cargo):");
    for (const batch of batches) {
        const drug = await DrugTracker.getDrugInfo(batch.id);
        const locked = await DrugTracker.inCargo(batch.id);
        console.log(
            `  ${batch.id}: ${drug.currentOwner} (${roleOf(drug.currentOwner)}), ` +
                `${stateNames[Number(drug.currentState)]}, ${locked ? "locked in cargo" : "free"}`
        );
    }
}

main().catch((err) => {
    console.error("❌ Error:", err);
    process.exit(1);
});
