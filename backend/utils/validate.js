const { ethers } = require("ethers");
const { ApiError } = require("./errors");

// Highest value of the State enum in DrugTracker.sol (InUse).
const MAX_STATE = 5;

function requireString(value, name) {
    if (typeof value !== "string" || value.trim() === "") {
        throw new ApiError(400, `Missing or invalid ${name}`);
    }
    return value;
}

function requireAddress(value, name) {
    if (typeof value !== "string" || !ethers.isAddress(value)) {
        throw new ApiError(400, `Missing or invalid ${name}`);
    }
    return value;
}

function requireState(value) {
    const state = typeof value === "string" && value.trim() !== "" ? Number(value) : value;
    if (!Number.isInteger(state) || state < 0 || state > MAX_STATE) {
        throw new ApiError(400, `newState must be an integer between 0 and ${MAX_STATE}`);
    }
    return state;
}

module.exports = { requireString, requireAddress, requireState };
