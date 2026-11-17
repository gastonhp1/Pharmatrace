const { test, describe } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const http = require("http");
const os = require("os");
const path = require("path");
const { checkpointers } = require("@hyperledger/fabric-gateway");

const { createApp } = require("../app");
const { createPharmaService } = require("../services/pharmatrace");
const { fromEvent } = require("../notifications/notify");
const { NotificationStore } = require("../notifications/store");
const { createWebhooks, sign } = require("../notifications/webhook");
const { createEventListener } = require("../notifications/listener");

const quiet = { log() {}, warn() {} };
const tmpFile = (name) => path.join(fs.mkdtempSync(path.join(os.tmpdir(), "pt-notif-")), name);

// A chaincode event as the Gateway SDK delivers it.
let block = 10n;
const chaincodeEvent = (eventName, payload, transactionId) => ({
    eventName,
    transactionId: transactionId || `tx-${eventName}-${block}`,
    blockNumber: block++,
    chaincodeName: "pharmatrace",
    payload: Buffer.from(JSON.stringify(payload)),
});

describe("notifications: from chaincode events", () => {
    const event = (name, payload) => fromEvent({ name, payload, txId: "tx1", block: 7n });

    test("a broken cold chain warns the owner, the recipient and the regulator", () => {
        const n = event("ColdChainCompromised", {
            cargoId: "C1", verdict: "COMPROMISED", excursionSeconds: 2100, reason: "2100 seconds out of range, the policy allows 1800",
            owner: "LabMSP", to: "DistMSP", batchIds: ["B1", "B2"],
        });
        assert.equal(n.severity, "critical");
        assert.deepEqual(n.orgs, ["LabMSP", "DistMSP", "RegMSP"]);
        assert.deepEqual(n.batchIds, ["B1", "B2"]);
        assert.deepEqual([n.id, n.block, n.event, n.cargoId], ["tx1", "7", "ColdChainCompromised", "C1"]);
        assert.match(n.message, /cargo C1 was broken: 2100 seconds/);
        assert.equal(n.reason, "2100 seconds out of range, the policy allows 1800");
    });

    test("a cargo that arrives is only news when it leaves batches in quarantine", () => {
        assert.equal(event("CargoReceived", { cargoId: "C1", owner: "DistMSP", state: "DELIVERED", batchIds: ["B1"] }), null);
        const n = event("CargoReceived", { cargoId: "C1", owner: "DistMSP", state: "DELIVERED", batchIds: ["B1", "B2"], quarantined: ["B1"], reason: "seal broken at 1" });
        assert.equal(n.severity, "critical");
        assert.deepEqual(n.orgs, ["DistMSP", "RegMSP"]);
        assert.deepEqual(n.batchIds, ["B1"]);
        assert.match(n.message, /^1 batch of cargo C1 arrived QUARANTINED: seal broken/);
    });

    test("a recall reaches whoever holds the batch; the regulator is not listed twice", () => {
        const n = event("BatchRecalled", { batchId: "B1", owner: "LabMSP", to: "DistMSP", state: "RECALLED", reason: "desvío" });
        assert.deepEqual([n.severity, n.orgs], ["critical", ["LabMSP", "DistMSP", "RegMSP"]]);
        assert.deepEqual(event("BatchReleased", { batchId: "B1", owner: "RegMSP", state: "IN_DISTRIBUTION", reason: "ok" }).orgs, ["RegMSP"]);
    });

    test("a shipment on its way is for its recipient", () => {
        const n = event("CargoDispatched", { cargoId: "C1", owner: "LabMSP", to: "DistMSP", state: "IN_TRANSIT", batchIds: ["B1", "B2"] });
        assert.deepEqual([n.severity, n.orgs], ["info", ["DistMSP"]]);
        assert.match(n.message, /Cargo C1 \(2 batches\) is on its way from LabMSP/);
        assert.equal(n.from, "LabMSP");
    });

    test("the rest of the events are not notifications", () => {
        for (const name of ["BatchRegistered", "ReadingsAnchored", "MonitoringClosed", "CargoCreated", "SomethingElse"]) {
            assert.equal(event(name, { batchId: "B1", cargoId: "C1", owner: "LabMSP" }), null, name);
        }
    });
});

describe("notifications: store and feed", () => {
    const n = (id, severity, orgs) => ({ id, block: "1", event: "X", severity, orgs, batchIds: [], message: id });

    test("keeps them across restarts and drops duplicates", () => {
        const file = tmpFile("n.jsonl");
        const store = new NotificationStore(file);
        assert.ok(store.add(n("a", "info", ["LabMSP"])).at);
        assert.equal(store.add(n("a", "info", ["LabMSP"])), null);
        store.add(n("b", "critical", ["DistMSP", "RegMSP"]));

        const again = new NotificationStore(file);
        assert.deepEqual(again.list().map((x) => x.id), ["b", "a"], "newest first");
        assert.equal(again.add(n("b", "critical", ["DistMSP"])), null);
        assert.deepEqual(again.list({ org: "LabMSP" }).map((x) => x.id), ["a"]);
        assert.deepEqual(again.list({ severity: "warning" }).map((x) => x.id), ["b"]);
        assert.equal(again.list({ limit: 1 }).length, 1);
    });

    test("GET /api/notifications filters and validates", async () => {
        const store = new NotificationStore();
        store.add(n("a", "info", ["LabMSP"]));
        store.add(n("b", "critical", ["DistMSP", "RegMSP"]));
        const app = createApp({ pharma: createPharmaService({ ledger: {} }), iot: {}, notifications: store, env: { API_KEY: "k" } });
        const server = app.listen(0);
        const get = async (query) => {
            const res = await fetch(`http://127.0.0.1:${server.address().port}/api/notifications${query}`);
            return { status: res.status, body: await res.json() };
        };
        try {
            assert.deepEqual((await get("")).body.map((x) => x.id), ["b", "a"]);
            assert.deepEqual((await get("?org=DistMSP&severity=critical")).body.map((x) => x.id), ["b"]);
            assert.deepEqual((await get("?org=FarmaMSP")).body, []);
            assert.equal((await get("?severity=loud")).status, 400);
            assert.equal((await get("?limit=0")).status, 400);
        } finally {
            server.close();
        }
    });
});

describe("notifications: webhooks", () => {
    // A receiver that answers with the scripted statuses, one per request.
    async function receiver(statuses, fn) {
        const got = [];
        const server = http.createServer((req, res) => {
            let body = "";
            req.on("data", (c) => (body += c));
            req.on("end", () => {
                got.push({ headers: req.headers, body });
                res.statusCode = statuses[got.length - 1] || 200;
                res.end();
            });
        });
        await new Promise((r) => server.listen(0, r));
        try {
            await fn(`http://127.0.0.1:${server.address().port}/hook`, got);
        } finally {
            server.close();
        }
    }
    const notification = { id: "tx1", event: "BatchRecalled", severity: "critical", orgs: ["RegMSP"], message: "m" };

    test("posts the notification, signed with the secret", async () => {
        await receiver([200], async (url, got) => {
            const hooks = createWebhooks({ urls: [url], secret: "s3cret", log: quiet });
            assert.equal(await hooks.send(notification), 1);
            assert.equal(got.length, 1);
            assert.deepEqual(JSON.parse(got[0].body), notification);
            assert.equal(got[0].headers["x-pharmatrace-event"], "BatchRecalled");
            assert.equal(got[0].headers["x-pharmatrace-signature"], sign("s3cret", got[0].body));
        });
    });

    test("retries a failing receiver and gives up without throwing", async () => {
        await receiver([500, 200], async (url, got) => {
            const hooks = createWebhooks({ urls: [url], backoffMs: 1, log: quiet });
            assert.equal(await hooks.send(notification), 1);
            assert.equal(got.length, 2);
            assert.equal(got[0].headers["x-pharmatrace-signature"], undefined, "no secret, no signature");
        });
        await receiver([500, 500, 500], async (url, got) => {
            const hooks = createWebhooks({ urls: [url], attempts: 3, backoffMs: 1, log: quiet });
            assert.equal(await hooks.send(notification), 0);
            assert.equal(got.length, 3);
        });
        assert.equal(await createWebhooks({ urls: ["http://127.0.0.1:9/closed"], attempts: 1, log: quiet }).send(notification), 0);
    });
});

describe("notifications: the event listener", () => {
    // A stream that delivers `events` and then fails, like a peer that goes away.
    const failingStream = (events) => ({
        async *[Symbol.asyncIterator]() {
            yield* events;
            throw new Error("14 UNAVAILABLE: peer is gone");
        },
        close() {},
    });
    // A stream that delivers `events` and then stays open until it is closed.
    function openStream(events) {
        let release;
        const closed = new Promise((r) => (release = r));
        return {
            async *[Symbol.asyncIterator]() {
                yield* events;
                await closed;
            },
            close: release,
        };
    }
    const recall = (id) => chaincodeEvent("BatchRecalled", { batchId: id, owner: "DistMSP", state: "RECALLED", reason: "desvío" }, `tx-${id}`);

    test("stores what matters, rings the webhooks, checkpoints, and survives a lost connection", async () => {
        const store = new NotificationStore();
        const checkpointer = checkpointers.inMemory();
        const sent = [];
        const seen = [];
        const first = [recall("B1"), chaincodeEvent("ReadingsAnchored", { cargoId: "C1" }), { ...recall("B9"), payload: Buffer.from("not json") }];
        // After the reconnection the peer repeats B1 (not checkpointed there in real life only
        // for the last block, but the listener must not care) and delivers B2.
        const second = [recall("B1"), recall("B2")];
        const streams = [failingStream(first), openStream(second)];
        let done;
        const finished = new Promise((r) => (done = r));

        const listener = createEventListener({
            source: async ({ checkpoint }) => {
                seen.push(checkpoint.getTransactionId());
                if (streams.length === 0) throw new Error("no more streams");
                return streams.shift();
            },
            checkpointer,
            store,
            webhooks: { send: (n) => { sent.push(n.id); if (n.id === "tx-B2") done(); } },
            log: quiet,
            retryMs: 1,
        });
        listener.start();
        await finished;
        await listener.stop();

        assert.deepEqual(store.list().map((n) => n.id), ["tx-B2", "tx-B1"]);
        assert.deepEqual(sent, ["tx-B1", "tx-B2"], "the repeated event rings no webhook");
        assert.equal(seen[0], undefined, "first connection: nothing checkpointed yet");
        assert.equal(seen[1], "tx-B9", "it reconnects from the last event it handled, notification or not");
        assert.equal(checkpointer.getTransactionId(), "tx-B2");
    });

    test("keeps retrying while the network is down and stops cleanly", async () => {
        let attempts = 0;
        const listener = createEventListener({
            source: async () => {
                attempts++;
                throw new Error("14 UNAVAILABLE");
            },
            checkpointer: checkpointers.inMemory(),
            store: new NotificationStore(),
            log: quiet,
            retryMs: 1,
            maxRetryMs: 2,
        });
        listener.start();
        await new Promise((r) => setTimeout(r, 40));
        await listener.stop();
        const after = attempts;
        assert.ok(after >= 3, `retried ${after} times`);
        await new Promise((r) => setTimeout(r, 15));
        assert.equal(attempts, after, "no retries after stop");
    });
});
