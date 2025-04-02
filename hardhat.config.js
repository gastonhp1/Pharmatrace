require("@nomicfoundation/hardhat-toolbox");
require("dotenv").config(); // <--- important

//console.log("PRIVATE_KEY:", process.env.PRIVATE_KEY);

[
    "MANUFACTURER_KEY",
    "DISTRIBUTOR_KEY",
    "WAREHOUSE_KEY",
    "PHARMACY_KEY",
    "PATIENT_KEY"
].forEach((key) => {
    if (!process.env[key]) {
        throw new Error(`❌ Missing ${key} in .env file`);
    }
});

module.exports = {
    solidity: "0.8.20",
    networks: {
        localhost: {
            url: "http://127.0.0.1:8545",
            accounts: [
                process.env.MANUFACTURER_KEY,
                process.env.DISTRIBUTOR_KEY,
                process.env.WAREHOUSE_KEY,
                process.env.PHARMACY_KEY,
                process.env.PATIENT_KEY
            ]
        }
    }
};
