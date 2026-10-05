const express = require("express");
const router = express.Router();
const { createCargo, getCargoInfo, transferCargo, markCargoDelivered } = require("../services/cargoService");
const { sendError } = require("../utils/errors");
const { requireString, requireAddress } = require("../utils/validate");

const isNonEmptyString = (value) => typeof value === "string" && value.trim() !== "";

// 🆕 Crear un nuevo cargamento
router.post("/create", async (req, res) => {
    const { cargoId, batchIds } = req.body || {};

    if (
        !isNonEmptyString(cargoId) ||
        !Array.isArray(batchIds) ||
        batchIds.length === 0 ||
        !batchIds.every(isNonEmptyString)
    ) {
        return res.status(400).json({ error: "Missing or invalid cargoId or batchIds" });
    }

    try {
        const result = await createCargo(cargoId, batchIds);
        res.json(result);
    } catch (err) {
        sendError(res, err, "Error creating cargo");
    }
});

// 🔍 Obtener info de un cargamento
router.get("/:cargoId", async (req, res) => {
    const { cargoId } = req.params;

    try {
        const result = await getCargoInfo(cargoId);
        res.json(result);
    } catch (err) {
        sendError(res, err, "Error getting cargo info");
    }
});

// 🚚 Transferir un cargamento a otro actor
router.post("/transfer", async (req, res) => {
    try {
        const { cargoId, toAddress } = req.body || {};
        const result = await transferCargo(
            requireString(cargoId, "cargoId"),
            requireAddress(toAddress, "toAddress")
        );
        res.json(result);
    } catch (err) {
        sendError(res, err, "Error transferring cargo");
    }
});

// ✅ Marcar como entregado
router.post("/deliver", async (req, res) => {
    const { cargoId } = req.body || {};

    if (!isNonEmptyString(cargoId)) {
        return res.status(400).json({ error: "Missing cargoId" });
    }

    try {
        const result = await markCargoDelivered(cargoId);
        res.json(result);
    } catch (err) {
        sendError(res, err, "Error marking delivered");
    }
});

module.exports = router;
