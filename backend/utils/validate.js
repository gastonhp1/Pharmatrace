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

function requireInteger(value, name, { min = Number.MIN_SAFE_INTEGER, max = Number.MAX_SAFE_INTEGER } = {}) {
    if (!Number.isInteger(value) || value < min || value > max) {
        throw new ApiError(400, `${name} must be an integer between ${min} and ${max}`);
    }
    return value;
}

// Hex string (with or without 0x) of exactly `bytes` bytes. Returns it with the 0x prefix.
function requireHexBytes(value, name, bytes) {
    const clean = typeof value === "string" && value.startsWith("0x") ? value.slice(2) : value;
    if (typeof clean !== "string" || !/^[0-9a-fA-F]*$/.test(clean) || clean.length !== bytes * 2) {
        throw new ApiError(400, `${name} must be ${bytes} bytes in hex`);
    }
    return `0x${clean}`;
}

module.exports = { requireString, requireAddress, requireState, requireInteger, requireHexBytes };
