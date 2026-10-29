const express = require("express");
const { requireUser } = require("../middleware/auth");
const { handle } = require("./batches");
const { parseQr, requireDeviceId, decodeNonce } = require("../box/token");

// /api/box: authenticated opening of the PharmaBox (see services/boxService.js and
// iot/docs/BOX_UNLOCK.md). Needs a user session (POST /api/auth/login), not the API key.
function boxRoutes(box, env = process.env) {
    const router = express.Router();
    const user = requireUser(env);

    // 🔓 { qr: "PB1:<deviceId>:<nonce>" } or { deviceId, nonce } -> { token (106 bytes hex), expiresAt, ... }
    router.post(
        "/unlock",
        user,
        handle("Error requesting unlock", (req) => {
            const body = req.body || {};
            const { deviceId, nonce } =
                body.qr !== undefined ? parseQr(body.qr) : { deviceId: requireDeviceId(body.deviceId), nonce: decodeNonce(body.nonce) };
            return box.requestUnlock({ user: req.user, deviceId, nonce });
        })
    );

    // 🔑 Public key to flash into the box (Pharmatrace-firmware include/unlock_key.h). Public.
    router.get("/unlock-key", handle("Error reading unlock key", () => box.publicKey()));

    // 🧾 Last decisions, granted and denied (regulator only). ?deviceId=&limit=
    router.get(
        "/audit",
        user,
        handle("Error reading unlock audit", (req) =>
            box.recentDecisions({
                user: req.user,
                deviceId: req.query.deviceId ? requireDeviceId(req.query.deviceId) : undefined,
                limit: Math.min(Math.max(Number(req.query.limit) || 50, 1), 500),
            })
        )
    );

    return router;
}

module.exports = { boxRoutes };
