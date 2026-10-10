const { test, describe, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { ethers } = require("ethers");

const reading = require("../iot/reading");
const { buildTree, verifyProof } = require("../iot/merkle");
const { ReadingStore } = require("../iot/store");
const { createIngest } = require("../iot/ingest");
const { buildWindow, findEvents } = require("../iot/window");

// A fixed reading shared with the simulator's tests (iot/simulator/test_simulator.py) and meant
// for the firmware repo too: all of them have to agree on these bytes and on the digest the
// device signs.
const VECTOR = {
    reading: { ts: 1800000000, seq: 7, tempCenti: 450, humCenti: 5500, flags: 0x05, latE5: -3460000, lonE5: -5840000 },
    hex: "6b49d2000000000701c2157c05ffcb3460ffa6e380",
    sha256: "43ad8f8f0c31a6e3f656767b2bf00e225356013dc85e71f562b59a015ac0c455",
    keccak: "0xd9660574558f738b306ff80d9fb150ab4ca32763de0c5b746102f0f4d4bdb1a4",
};

// Device side: a P-256 key and a signer that works like the secure element (SHA-256 + raw r||s).
function newDevice() {
    const { publicKey, privateKey } = crypto.generateKeyPairSync("ec", { namedCurve: "prime256v1" });
    const jwk = publicKey.export({ format: "jwk" });
    const pubKey = ethers.hexlify(
        Buffer.concat([Buffer.from(jwk.x, "base64url"), Buffer.from(jwk.y, "base64url")])
    );
    const sign = (payload) =>
        ethers.hexlify(crypto.sign("sha256", payload, { key: privateKey, dsaEncoding: "ieee-p1363" }));
    return { pubKey, sign };
}

function signed(device, fields) {
    const payload = reading.encodeReading({
        ts: 1000,
        seq: 1,
        tempCenti: 500,
        humCenti: 5000,
        flags: 0,
        latE5: 0,
        lonE5: 0,
        ...fields,
    });
    return { payload: ethers.hexlify(payload), signature: device.sign(payload) };
}

describe("reading codec", () => {
    test("is 21 bytes, big-endian, and round-trips", () => {
        const buf = reading.encodeReading(VECTOR.reading);
        assert.equal(buf.length, reading.READING_SIZE);
        assert.equal(buf.readUInt32BE(0), 1800000000);
        assert.deepEqual(reading.decodeReading(buf), VECTOR.reading);
    });

    test("handles negative values (temperature below zero, southern hemisphere)", () => {
        const fields = { ...VECTOR.reading, tempCenti: -1850, latE5: -3460000 };
        assert.deepEqual(reading.decodeReading(reading.encodeReading(fields)), fields);
    });

    test("rejects payloads of the wrong size", () => {
        assert.throws(() => reading.decodeReading(Buffer.alloc(20)));
    });

    test("has a stable encoding and digests (shared vector with the simulator and firmware)", () => {
        const buf = reading.encodeReading(VECTOR.reading);
        assert.equal(buf.toString("hex"), VECTOR.hex);
        assert.equal(crypto.createHash("sha256").update(buf).digest("hex"), VECTOR.sha256);
        assert.equal(reading.leafHash(buf), VECTOR.keccak);
    });

    test("hexToBuffer checks length and characters", () => {
        assert.equal(reading.hexToBuffer("0x0102", 2).length, 2);
        assert.equal(reading.hexToBuffer("0102", 2).length, 2);
        assert.equal(reading.hexToBuffer("0102", 3), null);
        assert.equal(reading.hexToBuffer("zz02", 2), null);
        assert.equal(reading.hexToBuffer(undefined, 2), null);
    });
});

describe("signatures", () => {
    test("accepts a valid signature and rejects tampering and other keys", () => {
        const device = newDevice();
        const other = newDevice();
        const payload = reading.encodeReading(VECTOR.reading);
        const signature = Buffer.from(ethers.getBytes(device.sign(payload)));
        const key = reading.publicKeyFromRaw(Buffer.from(ethers.getBytes(device.pubKey)));
        const otherKey = reading.publicKeyFromRaw(Buffer.from(ethers.getBytes(other.pubKey)));

        assert.equal(reading.verifySignature(key, payload, signature), true);
        assert.equal(reading.verifySignature(otherKey, payload, signature), false);

        const tampered = Buffer.from(payload);
        tampered[9] ^= 0x01;
        assert.equal(reading.verifySignature(key, tampered, signature), false);
        assert.equal(reading.verifySignature(key, payload, signature.subarray(0, 63)), false);
    });
});

describe("merkle", () => {
    const leavesOf = (n) => Array.from({ length: n }, (_, i) => ethers.keccak256(ethers.toBeHex(i + 1, 4)));

    test("every proof verifies, for trees of any size", () => {
        for (let n = 1; n <= 17; n++) {
            const leaves = leavesOf(n);
            const tree = buildTree(leaves);
            for (let i = 0; i < n; i++) {
                assert.equal(verifyProof(leaves[i], tree.proof(i), tree.root), true, `n=${n} i=${i}`);
            }
        }
    });

    test("a single leaf is its own root", () => {
        const [leaf] = leavesOf(1);
        const tree = buildTree([leaf]);
        assert.equal(tree.root, leaf);
        assert.deepEqual(tree.proof(0), []);
    });

    test("a wrong leaf or a wrong proof does not verify", () => {
        const leaves = leavesOf(6);
        const tree = buildTree(leaves);
        assert.equal(verifyProof(leaves[0], tree.proof(1), tree.root), false);
        assert.equal(verifyProof(ethers.keccak256("0x99"), tree.proof(1), tree.root), false);
    });

    test("rejects empty trees and out-of-range indexes", () => {
        assert.throws(() => buildTree([]));
        assert.throws(() => buildTree(leavesOf(3)).proof(3));
    });
});

describe("ingest", () => {
    let dir;
    let store;
    let device;
    let clock;
    let calibrationExpiry;
    let chain;
    let ingest;

    beforeEach(() => {
        dir = fs.mkdtempSync(path.join(os.tmpdir(), "pharmatrace-iot-"));
        store = new ReadingStore(dir);
        device = newDevice();
        clock = 10_000;
        calibrationExpiry = 1_000_000;
        chain = {
            cargo: "C-1",
            active: true,
            async activeCargoOf() {
                return this.cargo;
            },
            async getDevice(deviceId) {
                if (deviceId === "UNKNOWN") return null;
                return { pubKey: device.pubKey, calibrationExpiry, active: this.active };
            },
        };
        ingest = createIngest({ store, chain, now: () => clock, maxClockSkewSeconds: 30 });
    });

    afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

    test("stores valid readings under the cargo the device is monitoring", async () => {
        const result = await ingest("VAL-001", [
            signed(device, { seq: 1, ts: 1000 }),
            signed(device, { seq: 2, ts: 1060 }),
        ]);

        assert.deepEqual(result, { cargoId: "C-1", accepted: 2, duplicates: 0, rejected: [] });
        assert.deepEqual(store.readAll("C-1").map((r) => r.seq), [1, 2]);
    });

    test("rejects forged and corrupted readings without stopping the others", async () => {
        const forger = newDevice();
        const good = signed(device, { seq: 1, ts: 1000 });
        const forged = signed(forger, { seq: 2, ts: 1060 });
        const corrupted = { ...signed(device, { seq: 3, ts: 1120 }), payload: "0x1234" };

        const result = await ingest("VAL-001", [good, forged, corrupted, signed(device, { seq: 4, ts: 1180 })]);

        assert.equal(result.accepted, 2);
        assert.deepEqual(result.rejected, [
            { index: 1, reason: "Invalid signature" },
            { index: 2, reason: "Malformed reading" },
        ]);
    });

    test("a temperature edited after signing fails verification", async () => {
        const original = signed(device, { seq: 1, ts: 1000, tempCenti: 900 });
        const payload = Buffer.from(ethers.getBytes(original.payload));
        payload.writeInt16BE(500, 8); // "fix" the excursion
        const result = await ingest("VAL-001", [{ ...original, payload: ethers.hexlify(payload) }]);

        assert.equal(result.accepted, 0);
        assert.equal(result.rejected[0].reason, "Invalid signature");
    });

    test("an exact retry is a duplicate, not an error and not stored twice", async () => {
        const item = signed(device, { seq: 1, ts: 1000 });
        await ingest("VAL-001", [item]);
        const retry = await ingest("VAL-001", [item, signed(device, { seq: 2, ts: 1060 })]);

        assert.equal(retry.duplicates, 1);
        assert.equal(retry.accepted, 1);
        assert.equal(store.readAll("C-1").length, 2);
    });

    test("rejects a reused sequence number with different content (replay or fork)", async () => {
        await ingest("VAL-001", [signed(device, { seq: 1, ts: 1000, tempCenti: 500 })]);
        const result = await ingest("VAL-001", [signed(device, { seq: 1, ts: 1000, tempCenti: 450 })]);

        assert.deepEqual(result.rejected, [{ index: 0, reason: "Sequence number already used" }]);
    });

    test("rejects out-of-order sequence numbers and timestamps", async () => {
        await ingest("VAL-001", [signed(device, { seq: 5, ts: 1000 })]);
        const result = await ingest("VAL-001", [
            signed(device, { seq: 4, ts: 1100 }),
            signed(device, { seq: 6, ts: 1000 }),
        ]);

        assert.deepEqual(result.rejected, [
            { index: 0, reason: "Sequence number is not increasing" },
            { index: 1, reason: "Timestamp is not increasing" },
        ]);
    });

    test("rejects timestamps in the future, with some tolerance for clock skew", async () => {
        const result = await ingest("VAL-001", [
            signed(device, { seq: 1, ts: clock + 30 }),
            signed(device, { seq: 2, ts: clock + 31 }),
        ]);

        assert.equal(result.accepted, 1);
        assert.deepEqual(result.rejected, [{ index: 1, reason: "Timestamp is in the future" }]);
    });

    test("rejects readings taken after the calibration expired", async () => {
        clock = calibrationExpiry + 1000;
        const result = await ingest("VAL-001", [
            signed(device, { seq: 1, ts: calibrationExpiry - 10 }),
            signed(device, { seq: 2, ts: calibrationExpiry + 10 }),
        ]);

        assert.equal(result.accepted, 1);
        assert.deepEqual(result.rejected, [{ index: 1, reason: "Device was not calibrated at that time" }]);
    });

    test("refuses devices that are free, unknown or revoked", async () => {
        const item = signed(device, { seq: 1 });

        chain.cargo = "";
        await assert.rejects(ingest("VAL-001", [item]), { status: 409 });
        chain.cargo = "C-1";

        chain.active = false;
        await assert.rejects(ingest("VAL-001", [item]), { status: 403 });
        chain.active = true;

        const unknownChain = { ...chain, activeCargoOf: async () => "C-1" };
        await assert.rejects(
            createIngest({ store, chain: unknownChain, now: () => clock })("UNKNOWN", [item]),
            { status: 403 }
        );
    });

    test("validates the request itself", async () => {
        await assert.rejects(ingest("VAL-001", []), { status: 400 });
        await assert.rejects(ingest("VAL-001", "nope"), { status: 400 });
        await assert.rejects(ingest("VAL-001", Array(201).fill(signed(device, {}))), { status: 400 });
    });
});

describe("windows", () => {
    const POLICY = { minTemp: 200, maxTemp: 800 };

    // Stored records as the gateway writes them (no signature needed here).
    const record = (fields) => {
        const payload = reading.encodeReading({
            ts: 1000,
            seq: 1,
            tempCenti: 500,
            humCenti: 5000,
            flags: 0,
            latE5: 0,
            lonE5: 0,
            ...fields,
        });
        return { seq: fields.seq, ts: fields.ts, payload: ethers.hexlify(payload) };
    };

    test("an in-range window has no excursion", () => {
        const { window } = buildWindow(
            [record({ seq: 1, ts: 1000, tempCenti: 400 }), record({ seq: 2, ts: 1060, tempCenti: 600 })],
            POLICY,
            60
        );
        assert.equal(window.count, 2);
        assert.equal(window.from, 1000);
        assert.equal(window.to, 1060);
        assert.equal(window.minTemp, 400);
        assert.equal(window.maxTemp, 600);
        assert.equal(window.excursionSeconds, 0);
    });

    test("time outside the range is held until the next reading", () => {
        const { window } = buildWindow(
            [
                record({ seq: 1, ts: 1000, tempCenti: 500 }),
                record({ seq: 2, ts: 1060, tempCenti: 950 }), // out for 120 s
                record({ seq: 3, ts: 1180, tempCenti: 500 }),
            ],
            POLICY,
            60
        );
        assert.equal(window.excursionSeconds, 120);
        assert.equal(window.maxTemp, 950);
    });

    test("an out-of-range last reading counts one sampling period, so the contract's check holds", () => {
        const { window } = buildWindow(
            [record({ seq: 1, ts: 1000, tempCenti: 500 }), record({ seq: 2, ts: 1060, tempCenti: 100 })],
            POLICY,
            60
        );
        assert.equal(window.excursionSeconds, 60);
        assert.ok(window.minTemp < POLICY.minTemp && window.excursionSeconds > 0);
    });

    test("the range limits themselves are inside", () => {
        const { window } = buildWindow(
            [record({ seq: 1, ts: 1000, tempCenti: 200 }), record({ seq: 2, ts: 1060, tempCenti: 800 })],
            POLICY,
            60
        );
        assert.equal(window.excursionSeconds, 0);
    });

    test("the root matches the tree of the readings, in order", () => {
        const records = [1, 2, 3].map((n) => record({ seq: n, ts: 1000 + n * 60 }));
        const { window, leaves } = buildWindow(records, POLICY, 60);
        assert.equal(window.root, buildTree(leaves).root);
        assert.equal(leaves[0], reading.leafHash(Buffer.from(ethers.getBytes(records[0].payload))));
    });

    test("events are the rising edges of the flags", () => {
        const records = [
            record({ seq: 1, ts: 1000, flags: 0 }),
            record({ seq: 2, ts: 1060, flags: reading.FLAG_LID_OPENED }),
            record({ seq: 3, ts: 1120, flags: reading.FLAG_LID_OPENED }), // still open: no new event
            record({ seq: 4, ts: 1180, flags: 0 }),
            record({ seq: 5, ts: 1240, flags: reading.FLAG_LID_OPENED | reading.FLAG_SEAL_BROKEN }),
        ];

        assert.deepEqual(
            findEvents(records, 0, records.length).map((e) => [e.kind, e.ts]),
            [
                ["LidOpened", 1060],
                ["LidOpened", 1240],
                ["SealBroken", 1240],
            ]
        );
    });

    test("events look at the reading before the range, so a flag is not reported twice", () => {
        const records = [
            record({ seq: 1, ts: 1000, flags: reading.FLAG_SHOCK }),
            record({ seq: 2, ts: 1060, flags: reading.FLAG_SHOCK }),
        ];
        assert.equal(findEvents(records, 0, 1).length, 1);
        assert.equal(findEvents(records, 1, 2).length, 0);
    });
});

describe("store", () => {
    test("keeps readings and state per cargo, with any characters in the id", () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pharmatrace-iot-"));
        try {
            const store = new ReadingStore(dir);
            const id = "C/1 ../x";
            assert.deepEqual(store.readAll(id), []);
            assert.deepEqual(store.getState(id), { windows: [], eventsScanned: 0 });

            store.append(id, { seq: 1 });
            store.append(id, { seq: 2 });
            store.setState(id, { windows: [{ start: 0, end: 2 }], eventsScanned: 2 });

            assert.deepEqual(store.readAll(id), [{ seq: 1 }, { seq: 2 }]);
            assert.equal(store.getState(id).windows[0].end, 2);
            assert.deepEqual(store.listCargos(), [id]);
            // The slash is encoded, so the id cannot climb out of the folder or create subfolders.
            const files = fs.readdirSync(dir);
            assert.equal(files.length, 2);
            assert.ok(files.every((name) => !name.includes("/") && !name.includes(path.sep)));
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });
});
