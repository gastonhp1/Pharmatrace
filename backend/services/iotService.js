const { ApiError } = require("../utils/errors");
const { createIngest } = require("../iot/ingest");
const { buildWindow, findEvents, payloadOf } = require("../iot/window");
const { buildTree } = require("../iot/merkle");
const { decodeReading, leafHash } = require("../iot/reading");

// The IoT gateway on Fabric. It verifies the valija's signed readings off-chain (iot/ingest.js),
// keeps them (iot/store.js) and anchors one Merkle root per window in the chaincode, which gives
// the verdict. It acts with its own identity (IOT_GATEWAY_IDENTITY), whose certificate carries
// pharmatrace.role=iot-gateway.
//
//   ledger      services/fabric.js createLedger() or a fake
//   store       ReadingStore
//   gateway     { mspId, user } of the gateway identity
//   now         () -> unix seconds

const REGULATOR = "RegMSP";

// One at a time: two anchors of the same cargo at once would conflict on its monitoring key
// (MVCC), and the checks of an upload against the stored log must not interleave either.
function createQueue() {
    let tail = Promise.resolve();
    return (task) => {
        const result = tail.then(task);
        tail = result.catch(() => {});
        return result;
    };
}

function createIotService({
    ledger,
    store,
    gateway,
    sampleSeconds = 60,
    maxClockSkewSeconds = 30,
    now = () => Math.floor(Date.now() / 1000),
}) {
    const writeQueue = createQueue();
    const ingestQueue = createQueue();
    const auditor = { mspId: REGULATOR };
    const endorsers = (mspId) => (mspId === REGULATOR ? [REGULATOR, gateway.mspId] : [mspId, REGULATOR]);
    const asGateway = (fn, args) => ledger.submit(gateway, fn, args, { endorsingOrgs: endorsers(gateway.mspId) });
    const read = (fn, ...args) => ledger.evaluate(auditor, fn, args);

    const chainReader = {
        async getDevice(deviceId) {
            try {
                const device = await read("GetDevice", deviceId);
                return { pubKey: device.pubKey, calibrationExpiry: device.calibrationExpiry, active: device.active, activeCargo: device.activeCargo };
            } catch (err) {
                if (err instanceof ApiError && err.status === 404) return null;
                throw err;
            }
        },
        async activeCargoOf(deviceId) {
            const device = await this.getDevice(deviceId);
            return device ? device.activeCargo : "";
        },
    };
    const ingest = createIngest({ store, chain: chainReader, now, maxClockSkewSeconds });

    const lastWindowEnd = (state) => (state.windows.length > 0 ? state.windows[state.windows.length - 1].end : 0);

    // Anchors every stored reading not anchored yet (and not from the future, which the
    // chaincode rejects) as one window, then reports the lid/shock/seal events that appeared in
    // it. Must run inside the write queue.
    async function anchorPendingNow(cargoId) {
        const monitoring = await read("GetMonitoring", cargoId);
        if (monitoring.closed) throw new ApiError(409, `the monitoring of cargo ${cargoId} is closed`);
        const policy = await read("GetColdChainPolicy", monitoring.policyId);

        const records = store.readAll(cargoId);
        const state = store.getState(cargoId);
        const start = lastWindowEnd(state);
        let end = start;
        while (end < records.length && records[end].ts <= now()) end++;

        if (end === start) {
            return { anchored: 0, pendingReadings: records.length - start, events: 0, verdict: monitoring.verdict };
        }

        const { window } = buildWindow(records.slice(start, end), policy, sampleSeconds);
        const anchored = await asGateway("AnchorWindow", [cargoId, window]);
        const anchorIndex = anchored.roots.length - 1;
        state.windows.push({ start, end, root: window.root, anchorIndex });
        store.setState(cargoId, state);

        // If reporting an event fails, eventsScanned stays behind and the next run retries it.
        const events = findEvents(records, state.eventsScanned || 0, end);
        let last = anchored;
        for (const event of events) {
            last = await asGateway("ReportDeviceEvent", [cargoId, event.kind, String(event.ts), event.payloadHash]);
        }
        state.eventsScanned = end;
        store.setState(cargoId, state);

        return {
            anchored: end - start,
            anchorIndex,
            root: window.root,
            excursionSeconds: window.excursionSeconds,
            events: events.length,
            pendingReadings: records.length - end,
            verdict: last.verdict,
        };
    }

    return {
        ingestReadings: (deviceId, items) => ingestQueue(() => ingest(deviceId, items)),

        // ------------------------------------------------------------ administration

        // A valija belongs to the org that registers it (by default the gateway's).
        registerDevice(deviceId, pubKey, calibrationExpiry, mspId = gateway.mspId) {
            return writeQueue(() =>
                ledger.submit({ mspId }, "RegisterDevice", [deviceId, pubKey, String(calibrationExpiry)], { endorsingOrgs: endorsers(mspId) })
            );
        },

        setPolicy(policyId, minTemp, maxTemp, maxExcursionSeconds) {
            return writeQueue(async () => {
                await ledger.submit({ mspId: REGULATOR }, "SetColdChainPolicy", [policyId, String(minTemp), String(maxTemp), String(maxExcursionSeconds)], {
                    endorsingOrgs: endorsers(REGULATOR),
                });
                return { ok: true, policyId };
            });
        },

        // The regulator accepts the IoT gateways of this API's gateway org. Which identities are
        // gateways is in their certificates (pharmatrace.role=iot-gateway), issued by the org's CA.
        authorizeGateway() {
            return writeQueue(async () => {
                const me = await ledger.evaluate(gateway, "WhoAmI", []);
                if (me.role !== "iot-gateway") {
                    throw new ApiError(409, `${me.mspId} identity ${gateway.user || ""} has no iot-gateway role in its certificate`);
                }
                await ledger.submit({ mspId: REGULATOR }, "AuthorizeGatewayOrg", [me.mspId], { endorsingOrgs: endorsers(REGULATOR) });
                return { ok: true, mspId: me.mspId, role: me.role };
            });
        },

        // ------------------------------------------------------------ monitoring

        startMonitoring(cargoId, deviceId, policyId) {
            return writeQueue(() => asGateway("StartMonitoring", [cargoId, deviceId, policyId]));
        },

        anchorPending(cargoId) {
            return writeQueue(() => anchorPendingNow(cargoId));
        },

        // Closing anchors whatever is still pending first, so no reading is left out.
        closeMonitoring(cargoId) {
            return writeQueue(async () => {
                const last = await anchorPendingNow(cargoId);
                const closed = await asGateway("CloseMonitoring", [cargoId]);
                return { ok: true, cargoId, verdict: closed.verdict, reason: closed.reason, lastAnchored: last.anchored };
            });
        },

        // ------------------------------------------------------------ reading

        getDevice: (deviceId) => read("GetDevice", deviceId),

        async getStatus(cargoId) {
            const m = await read("GetMonitoring", cargoId);
            const policy = await read("GetColdChainPolicy", m.policyId);
            const records = store.readAll(cargoId);
            const state = store.getState(cargoId);

            let lastReading = null;
            if (records.length > 0) {
                const r = decodeReading(payloadOf(records[records.length - 1]));
                lastReading = {
                    seq: r.seq,
                    timestamp: new Date(r.ts * 1000).toISOString(),
                    tempC: r.tempCenti / 100,
                    humidityPct: r.humCenti / 100,
                    lidOpened: Boolean(r.flags & 0x01),
                    shock: Boolean(r.flags & 0x02),
                    sealBroken: Boolean(r.flags & 0x04),
                    lat: r.latE5 / 1e5,
                    lon: r.lonE5 / 1e5,
                };
            }

            return {
                cargoId,
                verdict: m.verdict,
                reason: m.reason,
                deviceId: m.deviceId,
                policy: {
                    id: policy.id,
                    minTempC: policy.minTemp / 100,
                    maxTempC: policy.maxTemp / 100,
                    maxExcursionSeconds: policy.maxExcursionSeconds,
                },
                startedAt: m.startedAt,
                closed: m.closed,
                excursionSeconds: m.excursionSeconds,
                anchoredReadings: m.readingCount,
                anchorCount: m.roots.length,
                events: m.events,
                pendingReadings: records.length - lastWindowEnd(state),
                lastReading,
            };
        },

        // Everything an auditor needs to check one reading: the Merkle proof (the chaincode's
        // VerifyReading, or iot/merkle.js verifyProof against the root on the ledger), and the
        // payload and signature to re-check against the device's public key (GetDevice).
        async getProof(cargoId, seq) {
            const records = store.readAll(cargoId);
            const index = records.findIndex((record) => record.seq === seq);
            if (index < 0) throw new ApiError(404, "Reading not found");

            const state = store.getState(cargoId);
            const window = state.windows.find((w) => index >= w.start && index < w.end);
            if (!window) throw new ApiError(409, "Reading is not anchored yet");

            const tree = buildTree(records.slice(window.start, window.end).map((record) => leafHash(payloadOf(record))));
            if (tree.root.toLowerCase() !== window.root.toLowerCase()) {
                throw new Error(`Stored readings of cargo ${cargoId} no longer match the anchored root`);
            }

            const record = records[index];
            return {
                cargoId,
                seq,
                anchorIndex: window.anchorIndex,
                leaf: leafHash(payloadOf(record)),
                proof: tree.proof(index - window.start),
                root: window.root,
                payload: record.payload,
                signature: record.signature,
                reading: decodeReading(payloadOf(record)),
            };
        },

        // Asks the chaincode whether a proof holds against the anchored root.
        verifyOnLedger: (cargoId, anchorIndex, leaf, proof) => read("VerifyReading", cargoId, String(anchorIndex), leaf, proof),

        // Anchors the pending readings of every cargo that has some, every `seconds`.
        startAnchorLoop(seconds) {
            const timer = setInterval(async () => {
                for (const cargoId of store.listCargos()) {
                    if (store.readAll(cargoId).length === lastWindowEnd(store.getState(cargoId))) continue;
                    try {
                        await this.anchorPending(cargoId);
                    } catch (err) {
                        console.warn(`⚠️  Could not anchor cargo ${cargoId}: ${err.message}`);
                    }
                }
            }, seconds * 1000);
            timer.unref();
            return timer;
        },
    };
}

module.exports = { createIotService };
