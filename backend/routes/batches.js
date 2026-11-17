const express = require("express");
const { sendError } = require("../utils/errors");
const { requireString, requireInteger } = require("../utils/validate");
const { requireApiKey } = require("../middleware/auth");

// The chaincode's limit (MaxBatchQuantity).
const MAX_QUANTITY = 10_000_000;

// Wraps an async handler: the result goes out as JSON, errors through sendError.
const handle = (message, fn) => async (req, res) => {
    try {
        res.json(await fn(req));
    } catch (err) {
        sendError(res, err, message);
    }
};

// /api/batches
function batchRoutes(pharma, env = process.env) {
    const router = express.Router();
    // Commercial terms are private: reading them needs the API key too.
    const privateRead = requireApiKey(env, { reads: true });

    router.post(
        "/",
        handle("Error registering batch", (req) => {
            const { batchId, gtin, product, lot, expiryDate, quantity } = req.body || {};
            return pharma.registerBatch({
                batchId: requireString(batchId, "batchId"),
                gtin: requireString(gtin, "gtin"),
                product: requireString(product, "product"),
                lot: requireString(lot, "lot"),
                expiryDate: requireString(expiryDate, "expiryDate"),
                quantity: requireInteger(quantity, "quantity", { min: 1, max: MAX_QUANTITY }),
            });
        })
    );

    router.get("/:batchId", handle("Error reading batch", (req) => pharma.getBatch(req.params.batchId)));
    router.get("/:batchId/history", handle("Error reading batch history", (req) => pharma.getBatchHistory(req.params.batchId)));
    // ?all=true: every batch split from it, and from those (what a recall reaches); otherwise
    // only the direct splits.
    router.get(
        "/:batchId/splits",
        handle("Error reading splits", (req) =>
            req.query.all === "true" ? pharma.getBatchDescendants(req.params.batchId) : pharma.getBatchSplits(req.params.batchId)
        )
    );
    router.get("/:batchId/dispensations", handle("Error reading dispensations", (req) => pharma.getDispensations(req.params.batchId)));

    // { newBatchId, quantity } -> the new batch
    router.post(
        "/:batchId/split",
        handle("Error splitting batch", (req) => {
            const { newBatchId, quantity } = req.body || {};
            return pharma.splitBatch(
                req.params.batchId,
                requireString(newBatchId, "newBatchId"),
                requireInteger(quantity, "quantity", { min: 1, max: MAX_QUANTITY })
            );
        })
    );

    router.post(
        "/:batchId/dispatch",
        handle("Error dispatching batch", (req) => pharma.dispatchBatch(req.params.batchId, requireString((req.body || {}).to, "to")))
    );
    router.post("/:batchId/receive", handle("Error receiving batch", (req) => pharma.receiveBatch(req.params.batchId)));
    router.post(
        "/:batchId/dispense",
        handle("Error dispensing batch", (req) => {
            const { patientRef, quantity } = req.body || {};
            return pharma.dispenseBatch(
                req.params.batchId,
                requireString(patientRef, "patientRef"),
                quantity === undefined ? undefined : requireInteger(quantity, "quantity", { min: 1, max: MAX_QUANTITY })
            );
        })
    );
    router.post(
        "/:batchId/recall",
        handle("Error recalling batch", (req) => pharma.recallBatch(req.params.batchId, requireString((req.body || {}).reason, "reason")))
    );

    // The regulator lifts a cold-chain quarantine.
    router.post(
        "/:batchId/release",
        handle("Error releasing batch", (req) => pharma.releaseBatch(req.params.batchId, requireString((req.body || {}).reason, "reason")))
    );

    // Commercial terms of the leg that starts with the current owner: { buyer, unitPrice, currency, quantity }
    router.put(
        "/:batchId/terms",
        handle("Error setting commercial terms", (req) => {
            const { buyer, unitPrice, currency, quantity } = req.body || {};
            return pharma.setCommercialTerms(req.params.batchId, {
                buyer: requireString(buyer, "buyer"),
                unitPrice: requireString(unitPrice, "unitPrice"),
                currency: requireString(currency, "currency"),
                quantity: requireInteger(quantity, "quantity", { min: 1 }),
            });
        })
    );

    // ?leg=manufacturer|distributor&as=<MSP of the seller or the buyer>
    router.get(
        "/:batchId/terms",
        privateRead,
        handle("Error reading commercial terms", (req) =>
            pharma.readCommercialTerms(req.params.batchId, requireString(req.query.leg, "leg"), requireString(req.query.as, "as"))
        )
    );

    // { leg, seller, buyer, unitPrice, currency, quantity } -> { matches: true|false }
    router.post(
        "/:batchId/terms/verify",
        handle("Error verifying commercial terms", async (req) => {
            const { leg, seller, buyer, unitPrice, currency, quantity } = req.body || {};
            const matches = await pharma.verifyCommercialTerms(req.params.batchId, requireString(leg, "leg"), {
                seller: requireString(seller, "seller"),
                buyer: requireString(buyer, "buyer"),
                unitPrice: requireString(unitPrice, "unitPrice"),
                currency: requireString(currency, "currency"),
                quantity: requireInteger(quantity, "quantity", { min: 1 }),
            });
            return { matches };
        })
    );

    return router;
}

// /api/orgs
function orgRoutes(pharma) {
    const router = express.Router();
    router.post(
        "/",
        handle("Error registering org", async (req) => {
            const { mspId, role } = req.body || {};
            await pharma.registerOrg(requireString(mspId, "mspId"), requireString(role, "role"));
            return pharma.getOrg(mspId);
        })
    );
    router.get("/:mspId", handle("Error reading org", (req) => pharma.getOrg(req.params.mspId)));
    router.get("/:mspId/batches", handle("Error listing batches", (req) => pharma.batchesByOwner(req.params.mspId)));
    return router;
}

module.exports = { batchRoutes, orgRoutes, handle };
