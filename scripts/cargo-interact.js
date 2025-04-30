require("dotenv").config();
const { ethers } = require("ethers");
const contractJson = require("./abi/CargoTracker.json");

async function main() {
    const provider = new ethers.JsonRpcProvider(process.env.RPC_URL);
    const contractAddress = process.env.CONTRACT_ADDRESS_CARGO;

    if (!contractAddress) {
        throw new Error("❌ CONTRACT_ADDRESS_CARGO not found in .env");
    }

    const CargoTracker = new ethers.Contract(contractAddress, contractJson.abi, provider);

    // 🧠 Cargamos los actores como wallets
    const roles = {
        origin: new ethers.Wallet(process.env.MANUFACTURER_KEY, provider),
        transport1: new ethers.Wallet(process.env.DISTRIBUTOR_KEY, provider),
        warehouse: new ethers.Wallet(process.env.WAREHOUSE_KEY, provider),
        pharmacy: new ethers.Wallet(process.env.PHARMACY_KEY, provider),
    };

    const cargoId = `CARGO-${Date.now()}`;
    const description = "Refrigerated medical supply - Ibuprofen + Vaccines";

    console.log(`🆕 Creating cargo: ${cargoId}`);
    const createTx = await CargoTracker.connect(roles.origin).createCargo(cargoId, description);
    await createTx.wait();
    console.log(`✅ Cargo created by: ${roles.origin.address}`);

    // 🔁 Transferencias
    const steps = [
        { from: roles.origin, to: roles.transport1, name: "Transport Company" },
        { from: roles.transport1, to: roles.warehouse, name: "Central Warehouse" },
        { from: roles.warehouse, to: roles.pharmacy, name: "Pharmacy" },
    ];

    for (const step of steps) {
        console.log(`🚚 Transferring cargo to ${step.name} (${step.to.address})`);
        const tx = await CargoTracker.connect(step.from).transferCargo(cargoId, step.to.address);
        await tx.wait();
    }

    // ✅ Entrega final
    console.log("📦 Marking cargo as delivered...");
    const deliverTx = await CargoTracker.connect(roles.pharmacy).markDelivered(cargoId);
    await deliverTx.wait();
    console.log("✅ Cargo marked as delivered!");

    // 🔍 Mostrar info final
    const [desc, owner, delivered, history] = await CargoTracker.getCargo(cargoId);

    console.log("\n🔎 Final Cargo Info:");
    console.log(`Description: ${desc}`);
    console.log(`Delivered: ${delivered ? "✅ Yes" : "❌ No"}`);
    console.log(`Current Owner: ${owner}`);
    console.log("Transfer History:");
    history.forEach((addr, i) => {
        console.log(`  ${i + 1}. ${addr}`);
    });
}

main().catch((err) => {
    console.error("❌ Error:", err);
    process.exit(1);
});
