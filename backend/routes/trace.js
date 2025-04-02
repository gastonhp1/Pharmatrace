const express = require("express");
const router = express.Router();
const { traceDrug } = require("../services/traceDrugService");

router.post("/", async (req, res) => {
    const { batchNumber } = req.body;

    if (!batchNumber) {
        return res.status(400).json({ ok: false, error: "Missing batchNumber" });
    }

    try {
        const result = await traceDrug(batchNumber);
        res.json({ ok: true, ...result });
    } catch (error) {
        console.error("❌ Error in /trace:", error);
        res.status(500).json({ ok: false, error: error.message });
    }
});

module.exports = router;
