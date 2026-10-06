require("dotenv").config();
const path = require("path");
const { ethers } = require("ethers");
const registryJson = require("../../scripts/abi/DeviceRegistry.json");
const monitorJson = require("../../scripts/abi/ColdChainMonitor.json");
const { provider, getManufacturerSigner, getAttestorSigner } = require("./chain");
const { ApiError, toApiError } = require("../utils/errors");
const { ReadingStore } = require("../iot/store");
const { createIngest } = require("../iot/ingest");
const { buildWindow, findEvents, payloadOf } = require("../iot/window");
const { buildTree } = require("../iot/merkle");
const { decodeReading, leafHash } = require("../iot/reading");

const VERDICTS = ["Unknown", "Monitoring", "Compliant", "Compromised"];

// ---------------------------------------------------------------- lazy wiring
// Everything is created on first use, so a backend whose IoT contracts are not deployed yet
// keeps working for batches and cargos, and only the IoT routes answer 503.

let contractsCache = null;
function contracts() {
    if (contractsCache) return contractsCache;

    const registryAddress = process.env.DEVICE_REGISTRY_ADDRESS;
    const monitorAddress = process.env.COLD_CHAIN_MONITOR_ADDRESS;
    if (!registryAddress || !monitorAddress) {
        throw new ApiError(
            503,
            "IoT contracts are not configured (DEVICE_REGISTRY_ADDRESS, COLD_CHAIN_MONITOR_ADDRESS)"
        );
    }

    contractsCache = {
        registry: new ethers.Contract(registryAddress, registryJson.abi, provider),
        monitor: new ethers.Contract(monitorAddress, monitorJson.abi, provider),
    };
    return contractsCache;
}

let storeCache = null;
function getStore() {
    if (!storeCache) {
        storeCache = new ReadingStore(
            process.env.IOT_DATA_DIR || path.join(__dirname, "../data/iot")
        );
    }
    return storeCache;
}

const sampleSeconds = () => Number(process.env.IOT_SAMPLE_SECONDS) || 60;
const maxClockSkewSeconds = () =>
    process.env.IOT_MAX_CLOCK_SKEW_SECONDS !== undefined
        ? Number(process.env.IOT_MAX_CLOCK_SKEW_SECONDS)
        : 30;

// Transactions from one wallet must go out one at a time or their nonces collide, so every
// chain write goes through this queue. Ingesting readings only reads the chain: it has its own
// queue, so that its checks against the stored log do not interleave.
function createQueue() {
    let tail = Promise.resolve();
    return (task) => {
        const result = tail.then(task);
        tail = result.catch(() => {});
        return result;
    };
}
const writeQueue = createQueue();
const ingestQueue = createQueue();

const chainReader = {
    async activeCargoOf(deviceId) {
        return contracts().monitor.activeCargoOf(deviceId);
    },
    async getDevice(deviceId) {
        try {
            const device = await contracts().registry.getDevice(deviceId);
            return {
                pubKey: device.pubKey,
                calibrationExpiry: Number(device.calibrationExpiry),
                active: device.active,
            };
        } catch (err) {
            const apiError = toApiError(err);
            if (apiError && apiError.status === 404) return null; // "Device does not exist"
            throw err;
        }
    },
};

let ingestFn = null;
function ingestReadings(deviceId, items) {
    return ingestQueue(() => {
        if (!ingestFn) {
            ingestFn = createIngest({
                store: getStore(),
                chain: chainReader,
                maxClockSkewSeconds: maxClockSkewSeconds(),
            });
        }
        return ingestFn(deviceId, items);
    });
}

// ---------------------------------------------------------------- administration

// Registry and policies belong to the contract owner (the manufacturer).
function registerDevice(deviceId, pubKey, calibrationExpiry) {
    return writeQueue(async () => {
        const { registry } = contracts();
        const tx = await registry.connect(getManufacturerSigner()).registerDevice(deviceId, pubKey, calibrationExpiry);
        await tx.wait();
        return { ok: true, message: `Device ${deviceId} registered`, deviceId };
    });
}

function setPolicy(policyId, minTemp, maxTemp, maxExcursionSeconds) {
    return writeQueue(async () => {
        const { monitor } = contracts();
        const tx = await monitor
            .connect(getManufacturerSigner())
            .setPolicy(policyId, minTemp, maxTemp, maxExcursionSeconds);
        await tx.wait();
        return { ok: true, message: `Policy ${policyId} created`, policyId };
    });
}

// ---------------------------------------------------------------- monitoring

function startMonitoring(cargoId, deviceId, policyId) {
    return writeQueue(async () => {
        const { monitor } = contracts();
        const tx = await monitor.connect(getAttestorSigner()).startMonitoring(cargoId, deviceId, policyId);
        await tx.wait();
        return { ok: true, message: `Cargo ${cargoId} is now monitored by ${deviceId}`, cargoId, deviceId, policyId };
    });
}

const lastWindowEnd = (state) =>
    state.windows.length > 0 ? state.windows[state.windows.length - 1].end : 0;

// Anchors every stored reading that is not anchored yet (and not from the future, which the
// contract would reject) as one window, then reports the lid/shock/seal events that appeared in
// it. Must run inside the write queue.
async function anchorPendingNow(cargoId) {
    const { monitor } = contracts();
    const store = getStore();

    const session = await monitor.getSession(cargoId); // reverts "Monitoring not found"
    if (session.closed) throw new ApiError(409, "Monitoring already closed");

    const rawPolicy = await monitor.getPolicy(session.policyId);
    const policy = { minTemp: Number(rawPolicy.minTemp), maxTemp: Number(rawPolicy.maxTemp) };

    const records = store.readAll(cargoId);
    const state = store.getState(cargoId);
    const start = lastWindowEnd(state);

    // The contract rejects windows from the future of the block that includes the transaction.
    // That block will be stamped about "now", not with the latest block's time (on a dev chain
    // blocks only appear with transactions, so the latest one can be minutes old), so the
    // gateway's clock is the bound. If the chain's clock is ahead, it is the one that counts.
    const latestBlock = await provider.getBlock("latest");
    const bound = Math.max(latestBlock.timestamp, Math.floor(Date.now() / 1000));
    let end = start;
    while (end < records.length && records[end].ts <= bound) end++;

    if (end === start) {
        return { anchored: 0, pendingReadings: records.length - start, events: 0 };
    }

    const { window } = buildWindow(records.slice(start, end), policy, sampleSeconds());
    const contract = monitor.connect(getAttestorSigner());

    await (await contract.anchorReadings(cargoId, window)).wait();
    const anchorIndex = Number(session.anchorCount);
    state.windows.push({ start, end, root: window.root, anchorIndex });
    store.setState(cargoId, state);

    // If sending an event fails, eventsScanned stays behind and the next run retries it.
    const events = findEvents(records, state.eventsScanned || 0, end);
    for (const event of events) {
        await (await contract.reportEvent(cargoId, event.kindIndex, event.ts, event.payloadHash)).wait();
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
        verdict: VERDICTS[Number(await monitor.getVerdict(cargoId))],
    };
}

function anchorPending(cargoId) {
    return writeQueue(() => anchorPendingNow(cargoId));
}

// Closing anchors whatever is still pending first, so no reading is left out of the record.
function closeMonitoring(cargoId) {
    return writeQueue(async () => {
        const { monitor } = contracts();

        let last = { anchored: 0 };
        const session = await monitor.getSession(cargoId); // reverts "Monitoring not found"
        if (!session.closed) last = await anchorPendingNow(cargoId);

        await (await monitor.connect(getAttestorSigner()).closeMonitoring(cargoId)).wait();
        const verdict = VERDICTS[Number(await monitor.getVerdict(cargoId))];

        return {
            ok: true,
            message: `Monitoring of cargo ${cargoId} closed`,
            cargoId,
            verdict,
            lastAnchored: last.anchored,
        };
    });
}

// ---------------------------------------------------------------- reading

async function getStatus(cargoId) {
    const { monitor } = contracts();
    const store = getStore();

    const verdict = Number(await monitor.getVerdict(cargoId));
    if (verdict === 0) throw new ApiError(404, "Monitoring not found");

    const session = await monitor.getSession(cargoId);
    const policy = await monitor.getPolicy(session.policyId);

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
        verdict: VERDICTS[verdict],
        deviceId: session.deviceId,
        policy: {
            id: session.policyId,
            minTempC: Number(policy.minTemp) / 100,
            maxTempC: Number(policy.maxTemp) / 100,
            maxExcursionSeconds: Number(policy.maxExcursionSeconds),
        },
        startedAt: new Date(Number(session.startedAt) * 1000).toISOString(),
        closed: session.closed,
        excursionSeconds: Number(session.excursionSeconds),
        anchoredReadings: Number(session.readingCount),
        anchorCount: Number(session.anchorCount),
        pendingReadings: records.length - lastWindowEnd(state),
        lastReading,
    };
}

// Everything an auditor needs to check one reading: the Merkle proof (ColdChainMonitor.
// verifyReading), and the payload and signature to re-check against the key in DeviceRegistry.
async function getProof(cargoId, seq) {
    const store = getStore();

    const records = store.readAll(cargoId);
    const index = records.findIndex((record) => record.seq === seq);
    if (index < 0) throw new ApiError(404, "Reading not found");

    const state = store.getState(cargoId);
    const window = state.windows.find((w) => index >= w.start && index < w.end);
    if (!window) throw new ApiError(409, "Reading is not anchored yet");

    const windowRecords = records.slice(window.start, window.end);
    const tree = buildTree(windowRecords.map((record) => leafHash(payloadOf(record))));
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
}

// ---------------------------------------------------------------- background anchoring

// Anchors the pending readings of every cargo that has some, every `seconds`. Meant for the
// gateway process; off unless IOT_ANCHOR_INTERVAL_SECONDS is set.
function startAnchorLoop(seconds) {
    const timer = setInterval(async () => {
        let cargoIds;
        try {
            contracts();
            cargoIds = getStore().listCargos();
        } catch {
            return; // not configured yet
        }

        for (const cargoId of cargoIds) {
            const store = getStore();
            if (store.readAll(cargoId).length === lastWindowEnd(store.getState(cargoId))) continue;
            try {
                await anchorPending(cargoId);
            } catch (err) {
                const apiError = toApiError(err);
                console.warn(`⚠️  Could not anchor cargo ${cargoId}: ${apiError ? apiError.message : err.message}`);
            }
        }
    }, seconds * 1000);
    timer.unref();
    return timer;
}

module.exports = {
    ingestReadings,
    registerDevice,
    setPolicy,
    startMonitoring,
    anchorPending,
    closeMonitoring,
    getStatus,
    getProof,
    startAnchorLoop,
};
