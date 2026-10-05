require("@nomicfoundation/hardhat-toolbox");
require("dotenv").config(); // <--- important

const ACTOR_KEYS = [
    "MANUFACTURER_KEY",
    "DISTRIBUTOR_KEY",
    "WAREHOUSE_KEY",
    "PHARMACY_KEY",
    "PATIENT_KEY"
];

// The actor keys are only needed for the localhost network (deploy/interact scripts).
// Without them, `hardhat compile` and `hardhat test` still work on the in-process
// Hardhat network, which uses its own default accounts.
const missingKeys = ACTOR_KEYS.filter((key) => !process.env[key]);
const localhost = { url: "http://127.0.0.1:8545" };

if (missingKeys.length === 0) {
    localhost.accounts = ACTOR_KEYS.map((key) => process.env[key]);
} else if (process.argv.includes("localhost")) {
    throw new Error(`❌ Missing ${missingKeys.join(", ")} in .env file`);
}

module.exports = {
    solidity: "0.8.20",
    networks: {
        localhost
    }
};
