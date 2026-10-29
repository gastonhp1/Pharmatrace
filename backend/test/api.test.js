const { test, describe } = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");
const grpc = require("@grpc/grpc-js");
const { CommitError, StatusCode } = require("@hyperledger/fabric-gateway");

const { createApp } = require("../app");
const { createPharmaService } = require("../services/pharmatrace");
const { createIotService } = require("../services/iotService");
const { toApiError } = require("../services/fabric");
const { ApiError } = require("../utils/errors");
const { ReadingStore } = require("../iot/store");
const reading = require("../iot/reading");
const { verifyProof } = require("../iot/merkle");
const { toHex } = require("../lib/hex");

// A ledger that records what the services ask for and answers from a script:
// responses["ReadBatch"] = (args, actor) => value, or a value. Unscripted calls return null.
function fakeLedger(responses = {}) {
    const calls = [];
    const answer = (kind) => async (actor, fn, args = [], opts = {}) => {
        calls.push({ kind, actor: actor.mspId, user: actor.user, fn, args, ...opts });
        const r = responses[fn];
        if (r instanceof Error) throw r;
        return typeof r === "function" ? r(args, actor) : r === undefined ? null : r;
    };
    return { calls, evaluate: answer("evaluate"), submit: answer("submit"), submits: () => calls.filter((c) => c.kind === "submit") };
}

const KEY = "test-key";
const env = { API_KEY: KEY };

async function withApp(ledger, fn, { iot } = {}) {
    const pharma = createPharmaService({ ledger, manufacturer: "LabMSP" });
    const app = createApp({ pharma, iot: iot || {}, env });
    const server = app.listen(0);
    const base = `http://127.0.0.1:${server.address().port}`;
    const call = async (method, url, body, { key = KEY } = {}) => {
        const res = await fetch(base + url, {
            method,
            headers: { "content-type": "application/json", ...(key ? { "x-api-key": key } : {}) },
            body: body === undefined ? undefined : JSON.stringify(body),
        });
        return { status: res.status, body: await res.json() };
    };
    try {
        await fn(call);
    } finally {
        server.close();
    }
}

describe("batches: who acts and who endorses", () => {
    test("register acts as the manufacturer, endorsed with the regulator", async () => {
        const ledger = fakeLedger({ RegisterBatch: (args) => ({ id: args[0], owner: "LabMSP" }) });
        await withApp(ledger, async (call) => {
            const res = await call("POST", "/api/batches", { batchId: "B1", gtin: "07791234567890", product: "Insulina", lot: "L1", expiryDate: "2028-01-31" });
            assert.equal(res.status, 200);
            const [submit] = ledger.submits();
            assert.equal(submit.actor, "LabMSP");
            assert.deepEqual(submit.args, ["B1", "07791234567890", "Insulina", "L1", "2028-01-31"]);
            assert.deepEqual(submit.endorsingOrgs, ["LabMSP", "RegMSP"]);
        });
    });

    test("dispatch acts as the owner; receive as the recipient", async () => {
        const batch = { id: "B1", owner: "LabMSP", pendingTo: "DistMSP", state: "IN_TRANSIT" };
        const ledger = fakeLedger({ ReadBatch: batch });
        await withApp(ledger, async (call) => {
            assert.equal((await call("POST", "/api/batches/B1/dispatch", { to: "DistMSP" })).status, 200);
            assert.equal((await call("POST", "/api/batches/B1/receive")).status, 200);
            const [dispatch, receive] = ledger.submits();
            assert.deepEqual([dispatch.actor, dispatch.fn, dispatch.args, dispatch.endorsingOrgs], ["LabMSP", "DispatchBatch", ["B1", "DistMSP"], ["LabMSP", "RegMSP"]]);
            assert.deepEqual([receive.actor, receive.fn, receive.endorsingOrgs], ["DistMSP", "ReceiveBatch", ["DistMSP", "RegMSP"]]);
        });
    });

    test("recall acts as the regulator and the holder co-endorses", async () => {
        const ledger = fakeLedger({ ReadBatch: { id: "B1", owner: "LabMSP", pendingTo: "DistMSP" } });
        await withApp(ledger, async (call) => {
            await call("POST", "/api/batches/B1/recall", { reason: "desvío de calidad" });
            const [recall] = ledger.submits();
            assert.equal(recall.actor, "RegMSP");
            assert.deepEqual(recall.endorsingOrgs, ["DistMSP", "RegMSP"]);
        });
    });

    test("dispense sends only a hash of the patient reference", async () => {
        const ledger = fakeLedger({ ReadBatch: { id: "B1", owner: "FarmaMSP", pendingTo: "" } });
        await withApp(ledger, async (call) => {
            await call("POST", "/api/batches/B1/dispense", { patientRef: "receta-123" });
            const [dispense] = ledger.submits();
            assert.equal(dispense.args[1], crypto.createHash("sha256").update("receta-123").digest("hex"));
            assert.ok(!JSON.stringify(ledger.calls).includes("receta-123"));
        });
    });

    test("commercial terms travel in the transient map, endorsed by seller and buyer", async () => {
        const ledger = fakeLedger({ ReadBatch: { id: "B1", owner: "LabMSP", pendingTo: "" } });
        await withApp(ledger, async (call) => {
            const res = await call("PUT", "/api/batches/B1/terms", { buyer: "DistMSP", unitPrice: "15230.50", currency: "ARS", quantity: 1200 });
            assert.equal(res.status, 200);
            const [set] = ledger.submits();
            assert.deepEqual(set.args, ["B1"], "the terms must not go as arguments: those are written to the ledger");
            assert.deepEqual(set.transient.terms, { batchId: "B1", seller: "LabMSP", buyer: "DistMSP", unitPrice: "15230.50", currency: "ARS", quantity: 1200 });
            assert.deepEqual(set.endorsingOrgs, ["LabMSP", "DistMSP"]);

            // Reading them is not public.
            assert.equal((await call("GET", "/api/batches/B1/terms?leg=manufacturer&as=DistMSP", undefined, { key: null })).status, 401);
            await call("GET", "/api/batches/B1/terms?leg=manufacturer&as=DistMSP");
            const read = ledger.calls.find((c) => c.fn === "ReadCommercialTerms");
            assert.equal(read.actor, "DistMSP");
        });
    });

    test("cargo operations act as the cargo's owner or recipient", async () => {
        const ledger = fakeLedger({
            ReadBatch: { id: "B1", owner: "LabMSP", pendingTo: "" },
            ReadCargo: { id: "C1", owner: "LabMSP", pendingTo: "DistMSP" },
        });
        await withApp(ledger, async (call) => {
            await call("POST", "/api/cargo", { cargoId: "C1", batchIds: ["B1", "B2"] });
            await call("POST", "/api/cargo/C1/dispatch", { to: "DistMSP" });
            await call("POST", "/api/cargo/C1/receive");
            const [create, dispatch, receive] = ledger.submits();
            assert.deepEqual([create.actor, create.args], ["LabMSP", ["C1", ["B1", "B2"]]]);
            assert.equal(dispatch.actor, "LabMSP");
            assert.deepEqual([receive.actor, receive.endorsingOrgs], ["DistMSP", ["DistMSP", "RegMSP"]]);
            assert.equal((await call("POST", "/api/cargo", { cargoId: "C2", batchIds: [] })).status, 400);
        });
    });
});

describe("errors", () => {
    test("coded chaincode errors map to HTTP statuses", () => {
        const gatewayError = (message) => ({ message: "10 ABORTED: failed to endorse transaction", code: 10, details: [{ address: "peer0", mspId: "LabMSP", message }] });
        assert.deepEqual(
            [404, 403, 409, 400].map((s, i) => toApiError(gatewayError(`chaincode response 500, ${["NOT_FOUND", "FORBIDDEN", "CONFLICT", "INVALID"][i]}: nope`)).status),
            [404, 403, 409, 400]
        );
        assert.equal(toApiError(gatewayError("chaincode response 500, NOT_FOUND: batch B9 does not exist")).message, "batch B9 does not exist");
        assert.equal(toApiError({ message: "unavailable", code: grpc.status.UNAVAILABLE, details: [] }).status, 503);
        assert.equal(toApiError(new CommitError({ code: StatusCode.MVCC_READ_CONFLICT, transactionId: "tx1" })).status, 409);
        assert.equal(toApiError(new Error("boom")), null);
    });

    test("an ApiError from the ledger reaches the client; anything else is a 500", async () => {
        const ledger = fakeLedger({ ReadBatch: new ApiError(404, "batch B9 does not exist") });
        await withApp(ledger, async (call) => {
            assert.deepEqual(await call("GET", "/api/batches/B9"), { status: 404, body: { error: "batch B9 does not exist" } });
        });
        const broken = fakeLedger({ ReadBatch: new Error("connection reset") });
        await withApp(broken, async (call) => {
            const res = await call("GET", "/api/batches/B9");
            assert.equal(res.status, 500);
            assert.ok(!res.body.error.includes("connection reset"), "internal details must not leak");
        });
    });

    test("writes need the API key, reads do not", async () => {
        await withApp(fakeLedger({ ReadBatch: { id: "B1" } }), async (call) => {
            assert.equal((await call("POST", "/api/batches/B1/receive", undefined, { key: null })).status, 401);
            assert.equal((await call("POST", "/api/batches/B1/receive", undefined, { key: "wrong" })).status, 401);
            assert.equal((await call("GET", "/api/batches/B1", undefined, { key: null })).status, 200);
        });
    });
});

describe("IoT gateway on the ledger", () => {
    function device() {
        const { publicKey, privateKey } = crypto.generateKeyPairSync("ec", { namedCurve: "prime256v1" });
        const jwk = publicKey.export({ format: "jwk" });
        const pubKey = Buffer.concat([Buffer.from(jwk.x, "base64url"), Buffer.from(jwk.y, "base64url")]).toString("hex");
        const sign = (fields) => {
            const payload = reading.encodeReading({ humCenti: 5000, flags: 0, latE5: 0, lonE5: 0, ...fields });
            return { payload: toHex(payload), signature: toHex(crypto.sign("sha256", payload, { key: privateKey, dsaEncoding: "ieee-p1363" })) };
        };
        return { pubKey, sign };
    }

    test("readings are verified against the ledger's key, anchored as one window, and provable", async () => {
        const valija = device();
        const monitoring = { cargoId: "C1", deviceId: "V1", policyId: "2-8C", closed: false, verdict: "MONITORING", roots: [], events: [] };
        const ledger = fakeLedger({
            GetDevice: { id: "V1", pubKey: valija.pubKey, calibrationExpiry: 2000000000, active: true, activeCargo: "C1" },
            GetMonitoring: monitoring,
            GetColdChainPolicy: { id: "2-8C", minTemp: 200, maxTemp: 800, maxExcursionSeconds: 1800 },
            AnchorWindow: (args) => ({ ...monitoring, roots: [JSON.parse(args[1]).root] }),
            ReportDeviceEvent: (args) => ({ ...monitoring, verdict: args[1] === "SEAL_BROKEN" ? "COMPROMISED" : "MONITORING" }),
        });
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), "iot-"));
        const iot = createIotService({ ledger: { evaluate: ledger.evaluate, submit: (a, f, args, o) => ledger.submit(a, f, args.map((x) => (typeof x === "string" ? x : JSON.stringify(x))), o) }, store: new ReadingStore(dir), gateway: { mspId: "DistMSP", user: "User2" }, now: () => 2000 });

        const upload = await iot.ingestReadings("V1", [
            valija.sign({ ts: 1000, seq: 1, tempCenti: 500 }),
            valija.sign({ ts: 1060, seq: 2, tempCenti: 950, flags: 0x01 }), // out of range, lid opened
            valija.sign({ ts: 1120, seq: 3, tempCenti: 400 }),
        ]);
        assert.deepEqual([upload.cargoId, upload.accepted, upload.rejected.length], ["C1", 3, 0]);

        const forged = device().sign({ ts: 1180, seq: 4, tempCenti: 400 });
        assert.equal((await iot.ingestReadings("V1", [forged])).rejected[0].reason, "Invalid signature");

        const result = await iot.anchorPending("C1");
        assert.deepEqual([result.anchored, result.anchorIndex, result.excursionSeconds, result.events], [3, 0, 60, 1]);

        const [anchor, event] = ledger.submits();
        assert.deepEqual([anchor.actor, anchor.user, anchor.fn, anchor.endorsingOrgs], ["DistMSP", "User2", "AnchorWindow", ["DistMSP", "RegMSP"]]);
        const window = JSON.parse(anchor.args[1]);
        assert.deepEqual([window.count, window.from, window.to, window.minTemp, window.maxTemp], [3, 1000, 1120, 400, 950]);
        assert.deepEqual([event.fn, event.args[1], event.args[2]], ["ReportDeviceEvent", "LID_OPENED", "1060"]);

        const proof = await iot.getProof("C1", 2);
        assert.equal(proof.root, window.root);
        assert.equal(verifyProof(proof.leaf, proof.proof, proof.root), true);

        await iot.verifyOnLedger("C1", 0, proof.leaf, proof.proof);
        const verify = ledger.calls.find((c) => c.fn === "VerifyReading");
        assert.deepEqual(verify.args, ["C1", "0", proof.leaf, proof.proof]);
    });

    test("a device that is not monitoring anything cannot upload", async () => {
        const valija = device();
        const ledger = fakeLedger({ GetDevice: { id: "V1", pubKey: valija.pubKey, calibrationExpiry: 2000000000, active: true, activeCargo: "" } });
        const iot = createIotService({ ledger, store: new ReadingStore(fs.mkdtempSync(path.join(os.tmpdir(), "iot-"))), gateway: { mspId: "DistMSP" }, now: () => 2000 });
        await assert.rejects(iot.ingestReadings("V1", [valija.sign({ ts: 1000, seq: 1, tempCenti: 500 })]), { status: 409 });
    });
});
