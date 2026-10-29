const express = require("express");
const { requireAdminKey } = require("../middleware/auth");
const { requireString, requireInteger, requireHexBytes } = require("../utils/validate");
const { handle } = require("./batches");

// /api/iot
//
// Everything that submits a transaction (devices, policies, monitoring, anchors) requires the
// x-api-key header: IOT_API_KEY, or API_KEY if there is no separate one (see middleware/auth.js;
// without either it answers 503). Uploading readings never does: a device has no way to hold an
// admin secret, and a reading is only accepted if its signature checks against the public key
// registered in the ledger for that device.
function iotRoutes(iot, env = process.env) {
    const router = express.Router();
    const admin = requireAdminKey(env);

    // 📡 Signed readings: { deviceId, readings: [{ payload, signature }] } (hex)
    router.post(
        "/readings",
        handle("Error ingesting readings", (req) => {
            const { deviceId, readings } = req.body || {};
            return iot.ingestReadings(requireString(deviceId, "deviceId"), readings);
        })
    );

    // 🔖 { deviceId, pubKey (64 bytes hex, P-256 X||Y), calibrationExpiry (unix s), org? (MSP) }
    router.post(
        "/devices",
        admin,
        handle("Error registering device", (req) => {
            const { deviceId, pubKey, calibrationExpiry, org } = req.body || {};
            return iot.registerDevice(
                requireString(deviceId, "deviceId"),
                requireHexBytes(pubKey, "pubKey", 64),
                requireInteger(calibrationExpiry, "calibrationExpiry", { min: 1 }),
                org === undefined ? undefined : requireString(org, "org")
            );
        })
    );

    // 📟 A registered valija: its org, public key, calibration and the cargo it is monitoring
    router.get("/devices/:deviceId", handle("Error reading device", (req) => iot.getDevice(req.params.deviceId)));

    // 🪪 The regulator authorizes this API's gateway identity (IOT_GATEWAY_IDENTITY) to anchor.
    router.post("/gateway/authorize", admin, handle("Error authorizing the gateway", () => iot.authorizeGateway()));

    // 🌡️ Temperatures in hundredths of a degree (2.00 C = 200)
    router.post(
        "/policies",
        admin,
        handle("Error creating policy", (req) => {
            const { policyId, minTemp, maxTemp, maxExcursionSeconds } = req.body || {};
            return iot.setPolicy(
                requireString(policyId, "policyId"),
                requireInteger(minTemp, "minTemp", { min: -32768, max: 32767 }),
                requireInteger(maxTemp, "maxTemp", { min: -32768, max: 32767 }),
                requireInteger(maxExcursionSeconds, "maxExcursionSeconds", { min: 0 })
            );
        })
    );

    // ▶️ { cargoId, deviceId, policyId }
    router.post(
        "/monitoring/start",
        admin,
        handle("Error starting monitoring", (req) => {
            const { cargoId, deviceId, policyId } = req.body || {};
            return iot.startMonitoring(requireString(cargoId, "cargoId"), requireString(deviceId, "deviceId"), requireString(policyId, "policyId"));
        })
    );

    // ⏹️ Anchors what is pending and closes: the verdict is final after this
    router.post(
        "/monitoring/close",
        admin,
        handle("Error closing monitoring", (req) => iot.closeMonitoring(requireString((req.body || {}).cargoId, "cargoId")))
    );

    // ⚓ Anchor the pending readings of a cargo now
    router.post("/cargo/:cargoId/anchor", admin, handle("Error anchoring readings", (req) => iot.anchorPending(req.params.cargoId)));

    // 🔍 Status and verdict of a cargo's cold chain
    router.get("/cargo/:cargoId", handle("Error getting cold chain status", (req) => iot.getStatus(req.params.cargoId)));

    // 🧾 Merkle proof of one anchored reading; ?verify=true also asks the chaincode to check it
    router.get(
        "/cargo/:cargoId/proof/:seq",
        handle("Error getting reading proof", async (req) => {
            const seq = requireInteger(Number(req.params.seq), "seq", { min: 0 });
            const proof = await iot.getProof(req.params.cargoId, seq);
            if (req.query.verify === "true") {
                proof.verifiedOnLedger = await iot.verifyOnLedger(proof.cargoId, proof.anchorIndex, proof.leaf, proof.proof);
            }
            return proof;
        })
    );

    return router;
}

module.exports = { iotRoutes };
