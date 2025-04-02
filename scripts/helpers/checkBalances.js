const { getReadableBalance } = require("./getReadableBalance");
const { ethers } = require("hardhat");

async function checkBalances(actors, minEth = 0.01) {
    console.log("\n🧾 Checking actor balances...");

    const threshold = ethers.parseEther(minEth.toString());
    let allGood = true;

    for (const [role, signer] of Object.entries(actors)) {
        const { address, balance, formatted } = await getReadableBalance(signer);

        if (balance < threshold) {
            console.warn(`❌ ${role.toUpperCase()} (${address}) has LOW balance: ${formatted} ETH`);
            allGood = false;
        } else {
            console.log(`✅ ${role.padEnd(12)} → ${address} (${formatted} ETH)`);
        }
    }

    if (!allGood) {
        throw new Error("🚨 One or more actors have insufficient balance.");
    }

    console.log("🟢 All actor balances are OK.\n");
}

module.exports = { checkBalances };
