const { ethers } = require("ethers");
const { ApiError } = require("../utils/errors");
const {
    READING_SIZE,
    SIGNATURE_SIZE,
    PUBLIC_KEY_SIZE,
    decodeReading,
    hexToBuffer,
    publicKeyFromRaw,
    verifySignature,
} = require("./reading");

const MAX_READINGS_PER_REQUEST = 200;

// Verifies and stores the signed readings a device uploads.
//
//   store  ReadingStore (see store.js)
//   chain  { activeCargoOf(deviceId) -> cargoId | "", getDevice(deviceId) -> device | null }
//          where device is { pubKey: hex, calibrationExpiry: number, active: boolean }
//   now    () -> unix seconds (injectable for tests)
//
// A reading is accepted only if the signature checks against the public key registered
// on-chain for that device, its timestamp is not in the future and both its sequence number
// and timestamp are higher than the previous accepted reading of the cargo. Readings that are
// rejected do not stop the others: the response lists each one with its reason. Uploading the
// exact same reading again (a device retrying after a timeout) is not an error.
function createIngest({ store, chain, now = () => Math.floor(Date.now() / 1000), maxClockSkewSeconds = 30 }) {
    return async function ingest(deviceId, items) {
        if (!Array.isArray(items) || items.length === 0) {
            throw new ApiError(400, "Missing or invalid readings");
        }
        if (items.length > MAX_READINGS_PER_REQUEST) {
            throw new ApiError(400, `Too many readings in one request (max ${MAX_READINGS_PER_REQUEST})`);
        }

        const cargoId = await chain.activeCargoOf(deviceId);
        if (!cargoId) {
            throw new ApiError(409, "Device is not monitoring any cargo");
        }

        const device = await chain.getDevice(deviceId);
        if (!device || !device.active) {
            throw new ApiError(403, "Device is not operational");
        }
        const publicKey = publicKeyFromRaw(hexToBuffer(device.pubKey, PUBLIC_KEY_SIZE));

        const stored = store.readAll(cargoId);
        const bySeq = new Map(stored.map((record) => [record.seq, record.payload]));
        let last = stored.length > 0 ? stored[stored.length - 1] : { seq: -1, ts: -1 };

        const rejected = [];
        let accepted = 0;
        let duplicates = 0;

        items.forEach((item, index) => {
            const reject = (reason) => rejected.push({ index, reason });

            const payload = hexToBuffer(item && item.payload, READING_SIZE);
            const signature = hexToBuffer(item && item.signature, SIGNATURE_SIZE);
            if (!payload || !signature) return reject("Malformed reading");

            if (!verifySignature(publicKey, payload, signature)) return reject("Invalid signature");

            const reading = decodeReading(payload);
            const payloadHex = ethers.hexlify(payload);

            if (bySeq.has(reading.seq)) {
                if (bySeq.get(reading.seq) === payloadHex) {
                    duplicates++;
                    return;
                }
                return reject("Sequence number already used");
            }
            if (reading.seq <= last.seq) return reject("Sequence number is not increasing");
            if (reading.ts <= last.ts) return reject("Timestamp is not increasing");
            if (reading.ts > now() + maxClockSkewSeconds) return reject("Timestamp is in the future");
            if (reading.ts > device.calibrationExpiry) return reject("Device was not calibrated at that time");

            const record = {
                seq: reading.seq,
                ts: reading.ts,
                payload: payloadHex,
                signature: ethers.hexlify(signature),
                receivedAt: now(),
            };
            store.append(cargoId, record);
            bySeq.set(record.seq, record.payload);
            last = record;
            accepted++;
        });

        return { cargoId, accepted, duplicates, rejected };
    };
}

module.exports = { createIngest, MAX_READINGS_PER_REQUEST };
