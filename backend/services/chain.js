require("dotenv").config();
const { ethers } = require("ethers");
const { ApiError } = require("../utils/errors");

// cacheTimeout -1 turns off ethers' 250 ms response cache. With it, two transactions sent
// back to back by the same wallet (easy on a local chain that mines instantly) get the same,
// stale nonce and the second one fails with "nonce has already been used".
const provider = new ethers.JsonRpcProvider(process.env.RPC_URL, undefined, { cacheTimeout: -1 });

const ACTOR_KEYS = [
    "MANUFACTURER_KEY",
    "DISTRIBUTOR_KEY",
    "WAREHOUSE_KEY",
    "PHARMACY_KEY",
    "PATIENT_KEY",
];

// Wallets for every actor key present in the environment.
const walletsByName = new Map(); // "MANUFACTURER_KEY" -> Wallet
const walletsByAddress = new Map(); // lowercase address -> Wallet

for (const name of ACTOR_KEYS) {
    if (process.env[name]) {
        const wallet = new ethers.Wallet(process.env[name], provider);
        walletsByName.set(name, wallet);
        walletsByAddress.set(wallet.address.toLowerCase(), wallet);
    }
}

// The contract owner: the only account allowed to register new batches.
function getManufacturerSigner() {
    const wallet = walletsByName.get("MANUFACTURER_KEY");
    if (!wallet) throw new Error("MANUFACTURER_KEY is not configured");
    return wallet;
}

// Contract rules are "only the current owner can act", so operations on an existing
// batch or cargo have to be signed by whoever owns it right now.
function getSignerForAddress(address) {
    const wallet = walletsByAddress.get(String(address).toLowerCase());
    if (!wallet) {
        throw new ApiError(403, `No signing key is configured for the current owner (${address})`);
    }
    return wallet;
}

// The account the IoT gateway attests with (it has to be an attestor in DeviceRegistry).
// IOT_GATEWAY_KEY keeps it separate from the manufacturer; without it the manufacturer signs.
let gatewayWallet = null;
function getAttestorSigner() {
    if (!process.env.IOT_GATEWAY_KEY) return getManufacturerSigner();
    if (!gatewayWallet) gatewayWallet = new ethers.Wallet(process.env.IOT_GATEWAY_KEY, provider);
    return gatewayWallet;
}

module.exports = { provider, getManufacturerSigner, getSignerForAddress, getAttestorSigner };
