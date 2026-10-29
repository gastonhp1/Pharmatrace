const { ApiError } = require("../utils/errors");
const { buildToken, publicKeyXY, actorTag } = require("../box/token");
const { canUnlock, REGULATOR } = require("../box/policy");

// Authenticated opening of the PharmaBox (option A: token over BLE).
//
// The box shows a QR with a fresh nonce; the app sends it here with the user's session; this
// service reads the box and its cargo from the ledger, applies box/policy.js, audits the decision
// and, if allowed, signs a token bound to that box and that nonce. The box checks the signature
// offline with the public key it was flashed with and opens. A nonce is single-use on the box, so
// asking twice for the same QR gives two tokens of which only one can ever work.
//
// `iot` and `pharma` are the services of the same name (ledger reads only).
function createBoxService({ iot, pharma, privateKey, audit, ttlSeconds = 120, now = () => Math.floor(Date.now() / 1000) }) {
    const publicKey = privateKey ? publicKeyXY(privateKey) : null;

    return {
        publicKey: () => {
            if (!publicKey) throw new ApiError(503, "UNLOCK_KEY_FILE is not configured on the server");
            return { publicKey: publicKey.toString("hex"), curve: "P-256", format: "X||Y" };
        },

        async requestUnlock({ user, deviceId, nonce }) {
            if (!privateKey) throw new ApiError(503, "UNLOCK_KEY_FILE is not configured on the server");
            const base = { deviceId, username: user.username, mspId: user.mspId, actor: actorTag(user.mspId, user.username).toString("hex") };

            const device = await iot.getDevice(deviceId);
            let cargo = null;
            if (device.activeCargo) {
                try {
                    cargo = await pharma.getCargo(device.activeCargo);
                } catch (err) {
                    if (!(err instanceof ApiError) || err.status !== 404) throw err;
                }
            }

            let decision;
            if (!device.active && user.mspId !== REGULATOR) {
                decision = { allowed: false, reason: "the box is deactivated: only the regulator can open it" };
            } else {
                decision = canUnlock({ mspId: user.mspId, device, cargo });
            }

            const context = { cargoId: device.activeCargo || null, cargoState: cargo ? cargo.state : null };
            if (!decision.allowed) {
                audit.record({ ...base, ...context, granted: false, reason: decision.reason });
                throw new ApiError(403, decision.reason);
            }

            const { token, iat, exp } = buildToken({ deviceId, nonce, mspId: user.mspId, username: user.username, privateKey, ttlSeconds, now: now() });
            audit.record({ ...base, ...context, granted: true, reason: decision.reason, iat, exp });
            return {
                deviceId,
                token: token.toString("hex"),
                issuedAt: new Date(iat * 1000).toISOString(),
                expiresAt: new Date(exp * 1000).toISOString(),
                cargoId: context.cargoId,
                cargoState: context.cargoState,
                reason: decision.reason,
            };
        },

        recentDecisions: ({ user, deviceId, limit }) => {
            if (user.mspId !== REGULATOR) throw new ApiError(403, "only the regulator can read the unlock audit");
            return audit.recent({ deviceId, limit });
        },
    };
}

module.exports = { createBoxService };
