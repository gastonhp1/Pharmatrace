// From chaincode events to notifications: what happened, how serious it is and which orgs
// should hear about it. Only the events someone has to act on (or wait for) become a
// notification; the rest (a batch registered, readings anchored...) are just history.
//
// The event payloads are defined in fabric/chaincode/pharmatrace/contract/model.go.

const REGULATOR = "RegMSP";

const uniq = (list) => [...new Set(list.filter(Boolean))];
const batches = (n) => (n === 1 ? "1 batch" : `${n} batches`);

const quarantined = (p, how) => ({
    severity: "critical",
    orgs: uniq([p.owner, REGULATOR]),
    cargoId: p.cargoId,
    batchIds: p.quarantined,
    message: `${batches(p.quarantined.length)} of cargo ${p.cargoId} ${how} QUARANTINED: ${p.reason}`,
});

const RULES = {
    BatchRecalled: (p) => ({
        severity: "critical",
        orgs: uniq([p.owner, p.to, REGULATOR]),
        batchIds: [p.batchId],
        message: `Batch ${p.batchId} was recalled: ${p.reason}`,
    }),
    BatchReleased: (p) => ({
        severity: "info",
        orgs: uniq([p.owner, REGULATOR]),
        batchIds: [p.batchId],
        message: `Batch ${p.batchId} was released from quarantine: ${p.reason}`,
    }),
    BatchDispatched: (p) => ({
        severity: "info",
        orgs: uniq([p.to]),
        batchIds: [p.batchId],
        message: `Batch ${p.batchId} is on its way from ${p.owner}`,
    }),
    CargoDispatched: (p) => ({
        severity: "info",
        orgs: uniq([p.to]),
        cargoId: p.cargoId,
        batchIds: p.batchIds || [],
        message: `Cargo ${p.cargoId} (${batches((p.batchIds || []).length)}) is on its way from ${p.owner}`,
    }),
    ColdChainCompromised: (p) => ({
        severity: "critical",
        orgs: uniq([p.owner, p.to, REGULATOR]),
        cargoId: p.cargoId,
        batchIds: p.batchIds || [],
        message: `The cold chain of cargo ${p.cargoId} was broken: ${p.reason}`,
    }),
    // A cargo that arrives (or is dissolved) is only news when it leaves batches in quarantine.
    CargoReceived: (p) => (p.quarantined && p.quarantined.length ? quarantined(p, "arrived") : null),
    CargoDissolved: (p) => (p.quarantined && p.quarantined.length ? quarantined(p, "left it") : null),
};

// event: { name, payload (object), txId, block }. Returns a notification or null.
// Fabric allows one event per transaction, so the transaction ID identifies the notification.
function fromEvent({ name, payload, txId, block }) {
    const rule = RULES[name];
    const body = rule && payload ? rule(payload) : null;
    if (!body) return null;
    return { id: txId, block: String(block), event: name, ...body };
}

module.exports = { fromEvent, REGULATOR };
