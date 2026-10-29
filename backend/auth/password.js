const crypto = require("crypto");

// Password hashes with scrypt (Node's crypto, no extra dependency).
// Stored as "scrypt$<N>$<r>$<p>$<salt b64>$<hash b64>" so the cost can be raised later without
// invalidating existing users.

const DEFAULTS = { N: 1 << 15, r: 8, p: 1, keyLen: 32 };
const maxmem = (N, r) => 256 * N * r; // a bit over the 128*N*r scrypt needs

function scrypt(password, salt, { N, r, p, keyLen }) {
    return new Promise((resolve, reject) =>
        crypto.scrypt(password, salt, keyLen, { N, r, p, maxmem: maxmem(N, r) }, (err, key) => (err ? reject(err) : resolve(key)))
    );
}

async function hashPassword(password, params = DEFAULTS) {
    if (typeof password !== "string" || password.length < 8) throw new Error("password must have at least 8 characters");
    const salt = crypto.randomBytes(16);
    const key = await scrypt(password, salt, params);
    return ["scrypt", params.N, params.r, params.p, salt.toString("base64"), key.toString("base64")].join("$");
}

async function verifyPassword(password, stored) {
    const parts = String(stored).split("$");
    if (parts.length !== 6 || parts[0] !== "scrypt") return false;
    const [N, r, p] = parts.slice(1, 4).map(Number);
    const salt = Buffer.from(parts[4], "base64");
    const expected = Buffer.from(parts[5], "base64");
    if (![N, r, p].every(Number.isInteger) || expected.length === 0) return false;
    const key = await scrypt(String(password), salt, { N, r, p, keyLen: expected.length });
    return crypto.timingSafeEqual(key, expected);
}

module.exports = { hashPassword, verifyPassword };
