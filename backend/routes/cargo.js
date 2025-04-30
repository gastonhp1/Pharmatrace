const express = require("express");
const router = express.Router();
const { createCargo, getCargoInfo, markCargoDelivered } = require("../services/cargoService");

// 🆕 Crear un nuevo cargamento
router.post("/create", async (req, res) => {
    const { cargoId, batchIds } = req.body;

    if (!cargoId || !batchIds || !Array.isArray(batchIds) || batchIds.length === 0) {
        return res.status(400).json({ error: "Missing or invalid cargoId or batchIds" });
    }

    try {
        const result = await createCargo(cargoId, batchIds);
        res.json(result);
    } catch (err) {
        console.error("❌ Error creating cargo:", err);
        res.status(500).json({ error: "Error creating cargo" });
    }
});

// 🔍 Obtener info de un cargamento
router.get("/:cargoId", async (req, res) => {
    const { cargoId } = req.params;

    try {
        const result = await getCargoInfo(cargoId);
        res.json(result);
    } catch (err) {
        console.error("❌ Error getting cargo info:", err);
        res.status(500).json({ error: "Error getting cargo info" });
    }
});

// ✅ Marcar como entregado
router.post("/deliver", async (req, res) => {
    const { cargoId } = req.body;

    if (!cargoId) {
        return res.status(400).json({ error: "Missing cargoId" });
    }

    try {
        const result = await markCargoDelivered(cargoId);
        res.json(result);
    } catch (err) {
        console.error("❌ Error marking delivered:", err);
        res.status(500).json({ error: "Error marking delivered" });
    }
});

module.exports = router;
