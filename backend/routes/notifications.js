const express = require("express");
const { ApiError } = require("../utils/errors");
const { handle } = require("./batches");
const { SEVERITIES } = require("../notifications/store");

// /api/notifications?org=DistMSP&severity=critical&limit=20
// What the chaincode events mean for each org, newest first. Like the other reads it is public:
// it only repeats what any member of the channel can see in the ledger.
function notificationRoutes(store) {
    const router = express.Router();
    router.get(
        "/",
        handle("Error reading notifications", (req) => {
            const { org, severity, limit } = req.query;
            if (severity !== undefined && !SEVERITIES.includes(severity)) {
                throw new ApiError(400, `severity has to be one of ${SEVERITIES.join(", ")}`);
            }
            const n = limit === undefined ? 50 : Number(limit);
            if (!Number.isInteger(n) || n < 1 || n > 200) throw new ApiError(400, "limit has to be between 1 and 200");
            return store.list({ org: org === undefined ? undefined : String(org), severity, limit: n });
        })
    );
    return router;
}

module.exports = { notificationRoutes };
