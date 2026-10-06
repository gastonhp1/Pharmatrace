const crypto = require("crypto");
const { ethers } = require("ethers");

// Wire format of one reading, 21 bytes, big-endian (see iot/docs/READING_FORMAT.md):
//
//   offset  size  field
//        0     4  ts         uint32  unix seconds, from the device's GPS/RTC
//        4     4  seq        uint32  per-device counter, strictly increasing
//        8     2  tempCenti  int16   temperature in hundredths of a degree Celsius
//       10     2  humCenti   uint16  relative humidity in hundredths of a percent
//       12     1  flags      uint8   bit0 lid opened, bit1 shock, bit2 seal broken
//       13     4  latE5      int32   latitude  * 1e5
//       17     4  lonE5      int32   longitude * 1e5
//
// The device signs SHA-256(payload) with its P-256 key (what an ATECC608 does natively); the
// signature is the raw 64 bytes r || s. The Merkle leaf is keccak256(payload).
const READING_SIZE = 21;
const SIGNATURE_SIZE = 64;
const PUBLIC_KEY_SIZE = 64;

const FLAG_LID_OPENED = 0x01;
const FLAG_SHOCK = 0x02;
const FLAG_SEAL_BROKEN = 0x04;

function encodeReading({ ts, seq, tempCenti, humCenti, flags, latE5, lonE5 }) {
    const buf = Buffer.alloc(READING_SIZE);
    buf.writeUInt32BE(ts, 0);
    buf.writeUInt32BE(seq, 4);
    buf.writeInt16BE(tempCenti, 8);
    buf.writeUInt16BE(humCenti, 10);
    buf.writeUInt8(flags, 12);
    buf.writeInt32BE(latE5, 13);
    buf.writeInt32BE(lonE5, 17);
    return buf;
}

function decodeReading(buf) {
    if (!Buffer.isBuffer(buf) || buf.length !== READING_SIZE) {
        throw new Error(`A reading must be exactly ${READING_SIZE} bytes`);
    }
    return {
        ts: buf.readUInt32BE(0),
        seq: buf.readUInt32BE(4),
        tempCenti: buf.readInt16BE(8),
        humCenti: buf.readUInt16BE(10),
        flags: buf.readUInt8(12),
        latE5: buf.readInt32BE(13),
        lonE5: buf.readInt32BE(17),
    };
}

// Merkle leaf of a reading. This is the value that verifyReading checks on-chain.
function leafHash(payload) {
    return ethers.keccak256(payload);
}

// Accepts hex with or without 0x. Returns null if it is not hex or has the wrong length.
function hexToBuffer(hex, expectedSize) {
    if (typeof hex !== "string") return null;
    const clean = hex.startsWith("0x") ? hex.slice(2) : hex;
    if (!/^[0-9a-fA-F]*$/.test(clean) || clean.length !== expectedSize * 2) return null;
    return Buffer.from(clean, "hex");
}

// Raw X || Y (64 bytes) -> Node KeyObject for ECDSA P-256 verification.
function publicKeyFromRaw(raw) {
    if (!Buffer.isBuffer(raw) || raw.length !== PUBLIC_KEY_SIZE) {
        throw new Error(`A public key must be exactly ${PUBLIC_KEY_SIZE} bytes (X || Y)`);
    }
    return crypto.createPublicKey({
        key: {
            kty: "EC",
            crv: "P-256",
            x: raw.subarray(0, 32).toString("base64url"),
            y: raw.subarray(32, 64).toString("base64url"),
        },
        format: "jwk",
    });
}

// True only if `signature` (raw r || s) is a valid P-256 signature of SHA-256(payload).
function verifySignature(publicKey, payload, signature) {
    if (!Buffer.isBuffer(signature) || signature.length !== SIGNATURE_SIZE) return false;
    try {
        return crypto.verify(
            "sha256",
            payload,
            { key: publicKey, dsaEncoding: "ieee-p1363" },
            signature
        );
    } catch {
        return false;
    }
}

module.exports = {
    READING_SIZE,
    SIGNATURE_SIZE,
    PUBLIC_KEY_SIZE,
    FLAG_LID_OPENED,
    FLAG_SHOCK,
    FLAG_SEAL_BROKEN,
    encodeReading,
    decodeReading,
    leafHash,
    hexToBuffer,
    publicKeyFromRaw,
    verifySignature,
};
