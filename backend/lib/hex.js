// Hex helpers: values on the wire and in the ledger are 0x-prefixed lowercase hex.

const toHex = (buf) => `0x${Buffer.from(buf).toString("hex")}`;

// "0x..." or "..." -> Buffer. Throws on anything that is not hex.
function fromHex(hex) {
    const clean = typeof hex === "string" && hex.startsWith("0x") ? hex.slice(2) : hex;
    if (typeof clean !== "string" || clean.length % 2 !== 0 || !/^[0-9a-fA-F]*$/.test(clean)) {
        throw new Error(`Not a hex string: ${hex}`);
    }
    return Buffer.from(clean, "hex");
}

module.exports = { toHex, fromHex };
