const express = require("express");
const { requireString, requireStringArray } = require("../utils/validate");
const { handle } = require("./batches");

// /api/cargo
function cargoRoutes(pharma) {
    const router = express.Router();

    // { cargoId, batchIds[] }: batches of one owner that will travel together
    router.post(
        "/",
        handle("Error creating cargo", (req) => {
            const { cargoId, batchIds } = req.body || {};
            return pharma.createCargo(requireString(cargoId, "cargoId"), requireStringArray(batchIds, "batchIds"));
        })
    );
    router.get("/:cargoId", handle("Error reading cargo", (req) => pharma.getCargo(req.params.cargoId)));
    router.post(
        "/:cargoId/dispatch",
        handle("Error dispatching cargo", (req) => pharma.dispatchCargo(req.params.cargoId, requireString((req.body || {}).to, "to")))
    );
    router.post("/:cargoId/receive", handle("Error receiving cargo", (req) => pharma.receiveCargo(req.params.cargoId)));
    router.post("/:cargoId/dissolve", handle("Error dissolving cargo", (req) => pharma.dissolveCargo(req.params.cargoId)));

    return router;
}

module.exports = { cargoRoutes };
