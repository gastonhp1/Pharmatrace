require("./helpers/loadEnv");
const hre = require("hardhat");
const fs = require("fs");
const path = require("path");
const { ethers } = require("ethers");
const { upsertEnvVar } = require("./helpers/upsertEnvVar");

// Example policies, in hundredths of a degree Celsius: [id, min, max, max seconds out of range].
// The real limits and the excursion budget of a product come from its stability data and its
// registration: set the ones you need with POST /api/iot/policies (policies are immutable).
const EXAMPLE_POLICIES = [
    ["pharma-2-8c", 200, 800, 1800],
    ["pharma-15-25c", 1500, 2500, 3600],
];

async function main() {
    const cargoAddress = process.env.CARGO_CONTRACT_ADDRESS;
    if (!cargoAddress) {
        throw new Error("❌ Missing CARGO_CONTRACT_ADDRESS (run npm run deploy:all first, or set it in .env)");
    }

    // The deployer owns both contracts, so it has to be the manufacturer (first account).
    const [deployer] = await hre.ethers.getSigners();

    const registry = await (await hre.ethers.getContractFactory("DeviceRegistry")).deploy();
    await registry.waitForDeployment();
    const registryAddress = await registry.getAddress();
    console.log(`🔖 DeviceRegistry deployed at: ${registryAddress}`);

    const monitor = await (await hre.ethers.getContractFactory("ColdChainMonitor")).deploy(
        registryAddress,
        cargoAddress
    );
    await monitor.waitForDeployment();
    const monitorAddress = await monitor.getAddress();
    console.log(`🌡️  ColdChainMonitor deployed at: ${monitorAddress}`);

    // The gateway attests on behalf of the devices. IOT_GATEWAY_KEY keeps that power apart from
    // the manufacturer's account; without it the manufacturer is the attestor.
    const gatewayAddress = process.env.IOT_GATEWAY_KEY
        ? new ethers.Wallet(process.env.IOT_GATEWAY_KEY).address
        : deployer.address;
    await (await registry.setAttestor(gatewayAddress, true)).wait();
    console.log(`📡 Attestor registered: ${gatewayAddress}`);

    if (gatewayAddress !== deployer.address) {
        const balance = await hre.ethers.provider.getBalance(gatewayAddress);
        if (balance === 0n) {
            console.log("⚠️  The gateway account has no funds: it needs some to pay for gas.");
        }
    }

    for (const [id, min, max, budget] of EXAMPLE_POLICIES) {
        await (await monitor.setPolicy(id, min, max, budget)).wait();
        console.log(`📋 Policy ${id}: ${min / 100} to ${max / 100} C, up to ${budget}s outside`);
    }

    // ABIs for the backend (same shape as the other files in scripts/abi).
    for (const name of ["DeviceRegistry", "ColdChainMonitor"]) {
        const artifact = await hre.artifacts.readArtifact(name);
        fs.writeFileSync(
            path.join(__dirname, `./abi/${name}.json`),
            JSON.stringify({ abi: artifact.abi }, null, 2)
        );
    }
    console.log("📦 ABIs exported to scripts/abi ✅");

    // Keep both env files in sync: the root .env (scripts) and backend/.env (API), if it exists.
    const envFiles = [path.join(__dirname, "../.env")];
    const backendEnvPath = path.join(__dirname, "../backend/.env");
    if (fs.existsSync(backendEnvPath)) envFiles.push(backendEnvPath);

    for (const file of envFiles) {
        upsertEnvVar(file, "DEVICE_REGISTRY_ADDRESS", registryAddress);
        upsertEnvVar(file, "COLD_CHAIN_MONITOR_ADDRESS", monitorAddress);
    }
    console.log("📄 DEVICE_REGISTRY_ADDRESS and COLD_CHAIN_MONITOR_ADDRESS saved to the .env files ✅");
}

main().catch((err) => {
    console.error("❌ Error deploying the IoT contracts:", err);
    process.exit(1);
});
