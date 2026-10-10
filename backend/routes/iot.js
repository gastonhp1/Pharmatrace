const express = require("express");
const router = express.Router();
const iot = require("../services/iotService");
const { sendError } = require("../utils/errors");
const { requireAdminKey: adminKeyGuard } = require("../middleware/auth");
const { requireString, requireInteger, requireHexBytes } = require("../utils/validate");

// Everything that sends a transaction (registering devices, starting, anchoring and closing a
// monitoring) requires the x-api-key header: IOT_API_KEY, or API_KEY if there is no separate one
// (see middleware/auth.js; without either it answers 503). Uploading readings never does: a device
// has no way to hold an admin secret, and a reading is only accepted if its signature checks
// against the key registered on-chain for that device.
const requireAdminKey = adminKeyGuard();

// 📡 Upload signed readings: { deviceId, readings: [{ payload, signature }] } (hex)
router.post("/readings", async (req, res) => {
    try {
        const { deviceId, readings } = req.body || {};
        const result = await iot.ingestReadings(requireString(deviceId, "deviceId"), readings);
        res.json(result);
    } catch (err) {
        sendError(res, err, "Error ingesting readings");
    }
});

// 🔖 Register a device: { deviceId, pubKey (64 bytes hex, P-256 X||Y), calibrationExpiry (unix s) }
router.post("/devices", requireAdminKey, async (req, res) => {
    try {
        const { deviceId, pubKey, calibrationExpiry } = req.body || {};
        const result = await iot.registerDevice(
            requireString(deviceId, "deviceId"),
            requireHexBytes(pubKey, "pubKey", 64),
            requireInteger(calibrationExpiry, "calibrationExpiry", { min: 1 })
        );
        res.json(result);
    } catch (err) {
        sendError(res, err, "Error registering device");
    }
});

// 🌡️ Create a policy. Temperatures are in hundredths of a degree (2.00 C = 200).
router.post("/policies", requireAdminKey, async (req, res) => {
    try {
        const { policyId, minTemp, maxTemp, maxExcursionSeconds } = req.body || {};
        const result = await iot.setPolicy(
            requireString(policyId, "policyId"),
            requireInteger(minTemp, "minTemp", { min: -32768, max: 32767 }),
            requireInteger(maxTemp, "maxTemp", { min: -32768, max: 32767 }),
            requireInteger(maxExcursionSeconds, "maxExcursionSeconds", { min: 0 })
        );
        res.json(result);
    } catch (err) {
        sendError(res, err, "Error creating policy");
    }
});

// ▶️ Bind a device to a cargo under a policy
router.post("/monitoring/start", requireAdminKey, async (req, res) => {
    try {
        const { cargoId, deviceId, policyId } = req.body || {};
        const result = await iot.startMonitoring(
            requireString(cargoId, "cargoId"),
            requireString(deviceId, "deviceId"),
            requireString(policyId, "policyId")
        );
        res.json(result);
    } catch (err) {
        sendError(res, err, "Error starting monitoring");
    }
});

// ⏹️ Anchor what is pending and close: the verdict is final after this
router.post("/monitoring/close", requireAdminKey, async (req, res) => {
    try {
        const { cargoId } = req.body || {};
        const result = await iot.closeMonitoring(requireString(cargoId, "cargoId"));
        res.json(result);
    } catch (err) {
        sendError(res, err, "Error closing monitoring");
    }
});

// ⚓ Anchor the pending readings of a cargo now
router.post("/cargo/:cargoId/anchor", requireAdminKey, async (req, res) => {
    try {
        const result = await iot.anchorPending(req.params.cargoId);
        res.json(result);
    } catch (err) {
        sendError(res, err, "Error anchoring readings");
    }
});

// 🔍 Status and verdict of a cargo's cold chain
router.get("/cargo/:cargoId", async (req, res) => {
    try {
        res.json(await iot.getStatus(req.params.cargoId));
    } catch (err) {
        sendError(res, err, "Error getting cold chain status");
    }
});

// 🧾 Merkle proof of one anchored reading
router.get("/cargo/:cargoId/proof/:seq", async (req, res) => {
    try {
        const seq = Number(req.params.seq);
        res.json(await iot.getProof(req.params.cargoId, requireInteger(seq, "seq", { min: 0 })));
    } catch (err) {
        sendError(res, err, "Error getting reading proof");
    }
});

module.exports = router;
