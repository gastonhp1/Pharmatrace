const crypto = require("crypto");
const { ApiError } = require("../utils/errors");

// Batches, cargoes and commercial terms on the PharmaTrace chaincode.
//
// Each operation acts with the identity of the org the chaincode expects (the owner of the
// batch, its recipient, the regulator) and asks for the endorsements its policy needs:
//
//   batch and cargo writes   the holder + the regulator   (state-based endorsement per batch)
//   other public writes      the actor + the regulator    (chaincode policy)
//   commercial terms         the seller + the buyer       (private data collection policy)
//
// `ledger` is services/fabric.js createLedger() or a fake in the tests.

const REGULATOR = "RegMSP";

function createPharmaService({ ledger, manufacturer = "LabMSP", auditor = REGULATOR }) {
    const as = (mspId) => ({ mspId });
    // Every write is co-endorsed by the regulator. When the regulator itself acts, any org of
    // the chain completes the chaincode policy.
    const withRegulator = (mspId) => (mspId === REGULATOR ? [REGULATOR, manufacturer] : [mspId, REGULATOR]);

    const read = (fn, ...args) => ledger.evaluate(as(auditor), fn, args);
    const write = (mspId, fn, args, endorsingOrgs = withRegulator(mspId), transient) =>
        ledger.submit(as(mspId), fn, args, { endorsingOrgs, transient });

    const getBatch = (batchId) => read("ReadBatch", batchId);
    const getCargo = (cargoId) => read("ReadCargo", cargoId);

    return {
        // ------------------------------------------------------------ organizations
        getOrg: (mspId) => read("GetOrg", mspId),
        registerOrg: (mspId, role) => write(REGULATOR, "RegisterOrg", [mspId, role]),

        // ------------------------------------------------------------ batches
        getBatch,
        getBatchHistory: (batchId) => read("GetBatchHistory", batchId),
        batchesByOwner: (mspId) => read("BatchesByOwner", mspId),

        registerBatch({ batchId, gtin, product, lot, expiryDate }) {
            return write(manufacturer, "RegisterBatch", [batchId, gtin, product, lot, expiryDate]);
        },

        async dispatchBatch(batchId, toMsp) {
            const batch = await getBatch(batchId);
            return write(batch.owner, "DispatchBatch", [batchId, toMsp]);
        },

        async receiveBatch(batchId) {
            const batch = await getBatch(batchId);
            if (!batch.pendingTo) throw new ApiError(409, `batch ${batchId} is not in transit`);
            return write(batch.pendingTo, "ReceiveBatch", [batchId]);
        },

        // Only a hash of the patient reference (a prescription number, for example) reaches the
        // ledger. The plain reference goes through the API but is not stored anywhere.
        async dispenseBatch(batchId, patientRef) {
            const batch = await getBatch(batchId);
            const hash = crypto.createHash("sha256").update(patientRef).digest("hex");
            return write(batch.owner, "DispenseBatch", [batchId, hash]);
        },

        // The regulator recalls; the org that physically holds the batch co-signs (its batch
        // key requires it).
        async recallBatch(batchId, reason) {
            const batch = await getBatch(batchId);
            const holder = batch.pendingTo || batch.owner;
            return write(REGULATOR, "RecallBatch", [batchId, reason], [holder, REGULATOR]);
        },

        // ------------------------------------------------------------ cargoes
        getCargo,

        async createCargo(cargoId, batchIds) {
            const first = await getBatch(batchIds[0]);
            return write(first.owner, "CreateCargo", [cargoId, batchIds]);
        },

        async dispatchCargo(cargoId, toMsp) {
            const cargo = await getCargo(cargoId);
            return write(cargo.owner, "DispatchCargo", [cargoId, toMsp]);
        },

        async receiveCargo(cargoId) {
            const cargo = await getCargo(cargoId);
            if (!cargo.pendingTo) throw new ApiError(409, `cargo ${cargoId} is not in transit`);
            return write(cargo.pendingTo, "ReceiveCargo", [cargoId]);
        },

        async dissolveCargo(cargoId) {
            const cargo = await getCargo(cargoId);
            return write(cargo.owner, "DissolveCargo", [cargoId]);
        },

        // ------------------------------------------------------------ commercial terms
        // The terms go in the transient map: they reach the peers of the seller and the buyer,
        // which store them in their private collection, and never the ledger.
        async setCommercialTerms(batchId, { buyer, unitPrice, currency, quantity }) {
            const batch = await getBatch(batchId);
            const terms = { batchId, seller: batch.owner, buyer, unitPrice, currency, quantity };
            await write(batch.owner, "SetCommercialTerms", [batchId], [batch.owner, buyer], { terms });
            return { ok: true, batchId, seller: batch.owner, buyer };
        },

        // `leg` is the seller's role: "manufacturer" or "distributor". `asMsp` is who reads: only
        // the seller and the buyer can.
        readCommercialTerms: (batchId, leg, asMsp) => ledger.evaluate(as(asMsp), "ReadCommercialTerms", [batchId, leg]),

        // Anyone can check that some terms are the stored ones: the chaincode compares hashes.
        verifyCommercialTerms: (batchId, leg, terms) =>
            ledger.evaluate(as(auditor), "VerifyCommercialTerms", [batchId, leg], { transient: { terms: { ...terms, batchId } } }),
    };
}

module.exports = { createPharmaService, REGULATOR };
