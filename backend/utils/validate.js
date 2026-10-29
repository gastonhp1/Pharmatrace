const { ApiError } = require("./errors");

function requireString(value, name) {
    if (typeof value !== "string" || value.trim() === "") {
        throw new ApiError(400, `Missing or invalid ${name}`);
    }
    return value;
}

function requireStringArray(value, name) {
    if (!Array.isArray(value) || value.length === 0 || value.some((v) => typeof v !== "string" || v.trim() === "")) {
        throw new ApiError(400, `${name} must be a non-empty array of strings`);
    }
    return value;
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

module.exports = { requireString, requireStringArray, requireInteger, requireHexBytes };
