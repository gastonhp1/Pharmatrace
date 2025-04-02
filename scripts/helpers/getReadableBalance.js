const { ethers } = require("hardhat");

async function getReadableBalance(signer) {
    const provider = signer.provider || ethers.provider;
    const address = signer.address || await signer.getAddress?.();

    if (!address || !provider) throw new Error("❌ Invalid signer or missing provider.");

    const balance = await provider.getBalance(address);
    const formatted = ethers.formatEther(balance);
    return { address, balance, formatted };
}

module.exports = { getReadableBalance };
